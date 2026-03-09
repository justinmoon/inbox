import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

import type { RepositoryRecord, RevisionRef, WorkspaceRecord } from '../shared/workspaces.ts';

type EnsureRepositoryOptions = {
  id?: string;
  source: string;
  tags?: string[];
  metadata?: Record<string, string>;
};

type EnsureRepositoryResult = {
  repository: RepositoryRecord;
  trunkWorkspace: WorkspaceRecord;
  defaultRef: RevisionRef;
};

type CreateWorkspaceOptions = {
  repository: RepositoryRecord;
  sourceRef: RevisionRef;
  resolvedRevision: string;
  nameHint?: string;
  tags?: string[];
  metadata?: Record<string, string>;
};

function timestamp() {
  return new Date().toISOString();
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

function isRemoteSource(source: string) {
  return /^(https?:\/\/|ssh:\/\/|git@|file:\/\/)/.test(source);
}

function resolveSourcePath(source: string) {
  return isRemoteSource(source) ? source : path.resolve(process.cwd(), source);
}

async function pathExists(targetPath: string) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function runCommand(command: string, args: string[], cwd?: string): Promise<string> {
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

async function git(args: string[], cwd?: string) {
  return await runCommand('git', args, cwd);
}

async function tryGit(args: string[], cwd?: string) {
  try {
    return await git(args, cwd);
  } catch {
    return null;
  }
}

async function resolveHeadCommit(cwd: string) {
  return await git(['rev-parse', 'HEAD'], cwd);
}

async function isGitRepository(source: string) {
  const topLevel = (await tryGit(['rev-parse', '--show-toplevel'], source))?.trim();
  if (!topLevel) {
    return false;
  }

  return path.resolve(topLevel) === path.resolve(source);
}

async function seedBackingStoreFromDirectory(source: string, backingStorePath: string) {
  await fs.mkdir(path.dirname(backingStorePath), { recursive: true });
  await fs.cp(source, backingStorePath, { recursive: true });
  await git(['init', '--initial-branch=main'], backingStorePath);
  await git(['config', 'user.name', 'Inbox'], backingStorePath);
  await git(['config', 'user.email', 'inbox@example.invalid'], backingStorePath);
  await git(['add', '--all'], backingStorePath);
  await git(['commit', '-m', 'Seed backing store'], backingStorePath);
}

async function detectDefaultRef(backingStorePath: string, source: string): Promise<RevisionRef> {
  const localSourcePath =
    !isRemoteSource(source) && (await isGitRepository(resolveSourcePath(source)))
      ? resolveSourcePath(source)
      : null;
  if (localSourcePath) {
    const branch = (await tryGit(['branch', '--show-current'], localSourcePath))?.trim();
    if (branch && branch !== 'HEAD') {
      return { kind: 'branch', branch };
    }
  }

  const branch = (await tryGit(['branch', '--show-current'], backingStorePath))?.trim();
  if (branch && branch !== 'HEAD') {
    return { kind: 'branch', branch };
  }

  const commit = await resolveHeadCommit(backingStorePath);
  return { kind: 'commit', commit };
}

function revisionToGitSpec(sourceRef: RevisionRef, fallbackCommit: string) {
  switch (sourceRef.kind) {
    case 'branch':
      return sourceRef.branch;
    case 'ref':
      return sourceRef.ref;
    case 'commit':
      return sourceRef.commit;
    case 'workspace':
      return fallbackCommit;
  }
}

export class SharedStoreWorktreeProvider {
  #storesRoot: string;
  #visibleRoot: string;

  constructor(runtimeRoot: string) {
    this.#storesRoot = path.join(runtimeRoot, 'repositories');
    this.#visibleRoot = path.join(runtimeRoot, 'workspaces');
  }

  async ensureRepository(options: EnsureRepositoryOptions): Promise<EnsureRepositoryResult> {
    const source = resolveSourcePath(options.source);
    const repoId =
      options.id && slugify(options.id)
        ? slugify(options.id)
        : `${slugify(path.basename(source).replace(/\.git$/i, '')) || 'repo'}-${createHash('sha1').update(source).digest('hex').slice(0, 8)}`;
    const backingStorePath = path.join(this.#storesRoot, repoId, 'store');
    const visibleRootPath = path.join(this.#visibleRoot, repoId);
    const visibleTrunkPath = path.join(visibleRootPath, 'trunk');

    await fs.mkdir(path.dirname(backingStorePath), { recursive: true });
    await fs.mkdir(visibleRootPath, { recursive: true });

    if (!(await pathExists(path.join(backingStorePath, '.git')))) {
      if (await isGitRepository(source)) {
        await git(['clone', '--quiet', source, backingStorePath]);
      } else {
        await seedBackingStoreFromDirectory(source, backingStorePath);
      }
    } else {
      if (await isGitRepository(source)) {
        await git(['fetch', '--all', '--prune'], backingStorePath);
      }
    }

    const defaultRef = await detectDefaultRef(backingStorePath, source);

    if (!(await pathExists(path.join(visibleTrunkPath, '.git')))) {
      const targetSpec =
        defaultRef.kind === 'commit'
          ? defaultRef.commit
          : revisionToGitSpec(defaultRef, await resolveHeadCommit(backingStorePath));
      await git(['worktree', 'add', '--detach', visibleTrunkPath, targetSpec], backingStorePath);
    }

    const now = timestamp();
    const trunkWorkspaceId = `${repoId}--trunk`;
    const repository: RepositoryRecord = {
      id: repoId,
      provider: 'shared-store-worktree',
      source,
      backing_store_path: backingStorePath,
      visible_root_path: visibleRootPath,
      visible_trunk_path: visibleTrunkPath,
      trunk_workspace_id: trunkWorkspaceId,
      created_at: now,
      updated_at: now,
      tags: options.tags ?? [],
      metadata: options.metadata ?? {},
    };

    const trunkWorkspace: WorkspaceRecord = {
      id: trunkWorkspaceId,
      repo_id: repoId,
      provider: 'shared-store-worktree',
      strategy: 'shared-store-worktree',
      name: 'trunk',
      path: visibleTrunkPath,
      source_ref: defaultRef,
      current_head: await resolveHeadCommit(visibleTrunkPath),
      created_at: now,
      updated_at: now,
      tags: ['trunk', ...(options.tags ?? [])],
      metadata: {
        ...(options.metadata ?? {}),
        visible_role: 'trunk',
      },
    };

    return { repository, trunkWorkspace, defaultRef };
  }

  async createWorkspace(options: CreateWorkspaceOptions): Promise<WorkspaceRecord> {
    const now = timestamp();
    const headCommit = await resolveHeadCommit(options.repository.visible_trunk_path);
    const targetSpec = revisionToGitSpec(options.sourceRef, options.resolvedRevision || headCommit);
    const baseName = slugify(options.nameHint ?? 'workspace') || 'workspace';
    const suffix = now.replace(/[-:.TZ]/g, '').slice(0, 14);
    const workspaceName = `${baseName}-${suffix}`;
    const workspaceId = `${options.repository.id}--${workspaceName}`;
    const workspacePath = path.join(options.repository.visible_root_path, workspaceName);

    await git(
      ['worktree', 'add', '--detach', workspacePath, options.resolvedRevision || targetSpec],
      options.repository.backing_store_path,
    );

    return {
      id: workspaceId,
      repo_id: options.repository.id,
      provider: 'shared-store-worktree',
      strategy: 'shared-store-worktree',
      name: workspaceName,
      path: workspacePath,
      source_ref: options.sourceRef,
      current_head: await resolveHeadCommit(workspacePath),
      created_at: now,
      updated_at: now,
      tags: options.tags ?? [],
      metadata: options.metadata ?? {},
    };
  }
}
