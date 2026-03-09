import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawn } from 'node:child_process';

import { WorkspaceService } from './workspaceService.ts';

async function run(command: string, args: string[], cwd: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }

      reject(new Error(stderr.trim() || `${command} ${args.join(' ')} exited with code ${code}`));
    });
  });
}

async function git(args: string[], cwd: string) {
  return await run('git', args, cwd);
}

async function createSourceRepo(rootDir: string) {
  const repoPath = path.join(rootDir, 'source-repo');
  await fs.mkdir(repoPath, { recursive: true });
  await git(['init', '--initial-branch=main'], repoPath);
  await git(['config', 'user.name', 'Workspace Test'], repoPath);
  await git(['config', 'user.email', 'workspace-test@example.invalid'], repoPath);
  await fs.writeFile(path.join(repoPath, 'README.md'), 'seed\n', 'utf8');
  await git(['add', 'README.md'], repoPath);
  await git(['commit', '-m', 'Initial commit'], repoPath);
  return repoPath;
}

async function commitFile(repoPath: string, relativePath: string, content: string, message: string) {
  const filePath = path.join(repoPath, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf8');
  await git(['add', relativePath], repoPath);
  await git(['commit', '-m', message], repoPath);
  return await git(['rev-parse', 'HEAD'], repoPath);
}

async function branchName(repoPath: string) {
  return await git(['rev-parse', '--abbrev-ref', 'HEAD'], repoPath);
}

async function upstream(repoPath: string) {
  return await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], repoPath);
}

test('ensureRepository creates a usable trunk workspace', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'inbox-workspace-test-'));
  try {
    const sourceRepo = await createSourceRepo(rootDir);
    const service = new WorkspaceService(path.join(rootDir, 'runtime'));
    const result = await service.ensureRepository({
      id: 'sample-repo',
      source: sourceRepo,
    });

    assert.equal(await branchName(result.trunk_workspace.path), 'trunk');
    assert.equal(await upstream(result.trunk_workspace.path), 'origin/main');
    assert.equal(
      await git(['rev-parse', 'HEAD'], result.trunk_workspace.path),
      await git(['rev-parse', 'HEAD'], sourceRepo),
    );
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test('re-ensure syncs trunk when the source branch advances', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'inbox-workspace-test-'));
  try {
    const sourceRepo = await createSourceRepo(rootDir);
    const service = new WorkspaceService(path.join(rootDir, 'runtime'));
    const first = await service.ensureRepository({
      id: 'sample-repo',
      source: sourceRepo,
    });

    const nextHead = await commitFile(sourceRepo, 'README.md', 'seed\nsecond\n', 'Advance source');
    const second = await service.ensureRepository({
      id: 'sample-repo',
      source: sourceRepo,
    });

    assert.equal(await branchName(second.trunk_workspace.path), 'trunk');
    assert.equal(await upstream(second.trunk_workspace.path), 'origin/main');
    assert.equal(await git(['rev-parse', 'HEAD'], second.trunk_workspace.path), nextHead);
    assert.notEqual(first.trunk_workspace.current_head, second.trunk_workspace.current_head);
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test('createWorkspace creates a non-detached peer workspace', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'inbox-workspace-test-'));
  try {
    const sourceRepo = await createSourceRepo(rootDir);
    const service = new WorkspaceService(path.join(rootDir, 'runtime'));
    const ensured = await service.ensureRepository({
      id: 'sample-repo',
      source: sourceRepo,
    });
    const created = await service.createWorkspace({
      repo_id: ensured.repository.id,
      name_hint: 'peer',
    });

    assert.notEqual(await branchName(created.workspace.path), 'HEAD');
    assert.equal(path.dirname(created.workspace.path), path.dirname(ensured.repository.visible_trunk_path));
    assert.equal(await upstream(created.workspace.path), 'origin/main');
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test('createWorkspace from another workspace resolves the source workspace head commit', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'inbox-workspace-test-'));
  try {
    const sourceRepo = await createSourceRepo(rootDir);
    const service = new WorkspaceService(path.join(rootDir, 'runtime'));
    const ensured = await service.ensureRepository({
      id: 'sample-repo',
      source: sourceRepo,
    });
    const first = await service.createWorkspace({
      repo_id: ensured.repository.id,
      name_hint: 'authoring',
    });

    await git(['config', 'user.name', 'Workspace Test'], first.workspace.path);
    await git(['config', 'user.email', 'workspace-test@example.invalid'], first.workspace.path);
    const expectedHead = await commitFile(
      first.workspace.path,
      'notes.txt',
      'workspace commit\n',
      'Commit inside peer workspace',
    );

    const second = await service.createWorkspace({
      source_workspace_id: first.workspace.id,
      name_hint: 'followup',
    });

    assert.equal(await git(['rev-parse', 'HEAD'], second.workspace.path), expectedHead);
    assert.notEqual(await branchName(second.workspace.path), 'HEAD');
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test('plain directories are rejected honestly', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'inbox-workspace-test-'));
  try {
    const plainDir = path.join(rootDir, 'plain-directory');
    await fs.mkdir(plainDir, { recursive: true });
    await fs.writeFile(path.join(plainDir, 'README.md'), 'not a repo\n', 'utf8');
    const service = new WorkspaceService(path.join(rootDir, 'runtime'));

    await assert.rejects(
      async () =>
        await service.ensureRepository({
          id: 'plain-dir',
          source: plainDir,
        }),
      /real git repo or worktree root source/i,
    );
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});
