import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

import type { ChangeUnitBundle } from '../shared/changeUnitBundle.ts';
import type { CreateLiveChangeUnitResponse } from '../shared/liveChangeUnit.ts';
import { createCodex } from '../server/codexRuntime.ts';

type RunOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  capture?: boolean;
};

type ReviewPayload = {
  verdict: 'approve' | 'needs_revision' | 'comment' | 'blocked';
  summary: string;
  details_markdown: string;
};

type PlannerPayload = {
  title: string;
  executive_summary_hint: string;
  implementation_prompt: string;
};

type PacketPayload = {
  title: string;
  executive_summary: string;
  tutorial_markdown: string;
  next_prompt: string;
};

type Scenario = {
  slug: string;
  title: string;
  focus: string;
  files: Record<string, string>;
};

type ScenarioResult = {
  scenario: Scenario;
  repoName: string;
  repoSlug: string;
  worktreeRoot: string;
  bundleRoot: string;
  plannerThreadId: string;
  implementerThreadId: string;
  reviewerAThreadId: string;
  reviewerBThreadId: string;
  planner: PlannerPayload;
  packet: PacketPayload;
  reviewA: ReviewPayload;
  reviewB: ReviewPayload;
  branchName: string;
  prNumber: number | null;
  prUrl: string | null;
  changeUnitId: string;
  bundlePath: string;
  importedTitle: string;
  importedStatus: ChangeUnitBundle['change_unit']['status'];
  importedValidationState: ChangeUnitBundle['change_unit']['validation']['state'];
  importedValidationSummary: string;
  importedPrUrl: string | null;
  importedPrStatus: string;
};

const runId = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-').toLowerCase();
const keepRepos = process.env.INBOX_E2E_KEEP_REPOS === '1';
const codexSdkPath = process.env.INBOX_CODEX_SDK_PATH ?? '/Users/justin/code/codex/sdk/typescript/src/index.ts';
let remoteDeleteSupported: boolean | null = null;

const plannerSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'executive_summary_hint', 'implementation_prompt'],
  properties: {
    title: { type: 'string' },
    executive_summary_hint: { type: 'string' },
    implementation_prompt: { type: 'string' },
  },
} as const;

const packetSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'executive_summary', 'tutorial_markdown', 'next_prompt'],
  properties: {
    title: { type: 'string' },
    executive_summary: { type: 'string' },
    tutorial_markdown: { type: 'string' },
    next_prompt: { type: 'string' },
  },
} as const;

const reviewSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'summary', 'details_markdown'],
  properties: {
    verdict: {
      type: 'string',
      enum: ['approve', 'needs_revision', 'comment', 'blocked'],
    },
    summary: { type: 'string' },
    details_markdown: { type: 'string' },
  },
} as const;

const scenarios: Scenario[] = [
  {
    slug: 'validation-rollup',
    title: 'Validation rollup formatter',
    focus: 'validation formatter summaries and inspectable test coverage',
    files: {
      'README.md': [
        '# Inbox Codex E2E Repo',
        '',
        'Tiny validation utility used to prove the inbox app against a real Codex workflow.',
        '',
      ].join('\n'),
      'package.json': JSON.stringify(
        {
          name: `inbox-e2e-validation-rollup-${runId}`,
          private: true,
          type: 'module',
          scripts: {
            test: 'node --test',
          },
        },
        null,
        2,
      ),
      'src/validation.js': [
        'export function formatValidationChecks(checks) {',
        "  return checks.map((check) => `${check.label}: ${check.state}`).join('\\n');",
        '}',
        '',
      ].join('\n'),
      'test/validation.test.js': [
        "import test from 'node:test';",
        "import assert from 'node:assert/strict';",
        '',
        "import { formatValidationChecks } from '../src/validation.js';",
        '',
        "test('formats validation checks line by line', () => {",
        '  const checks = [',
        "    { label: 'bundle import', state: 'passed' },",
        "    { label: 'browser smoke', state: 'warning' },",
        '  ];',
        '',
        "  assert.equal(formatValidationChecks(checks), 'bundle import: passed\\nbrowser smoke: warning');",
        '});',
        '',
        "test('formats an empty list as an empty string', () => {",
        "  assert.equal(formatValidationChecks([]), '');",
        '});',
        '',
      ].join('\n'),
    },
  },
  {
    slug: 'frontmatter-summary',
    title: 'Frontmatter summary helper',
    focus: 'frontmatter parsing and concise markdown metadata summaries',
    files: {
      'README.md': [
        '# Inbox Codex E2E Repo',
        '',
        'Tiny frontmatter helper used to prove the inbox app against a second real repo shape.',
        '',
      ].join('\n'),
      'package.json': JSON.stringify(
        {
          name: `inbox-e2e-frontmatter-summary-${runId}`,
          private: true,
          type: 'module',
          scripts: {
            test: 'node --test',
          },
        },
        null,
        2,
      ),
      'src/frontmatter.js': [
        'export function summarizeFrontmatter(block) {',
        "  const lines = block.trim().split('\\n').filter(Boolean);",
        '  const entries = lines',
        "    .filter((line) => line.includes(':'))",
        "    .map((line) => line.split(':'))",
        "    .map(([key, value]) => `${key.trim()}=${value.trim()}`);",
        "  return entries.join(', ');",
        '}',
        '',
      ].join('\n'),
      'test/frontmatter.test.js': [
        "import test from 'node:test';",
        "import assert from 'node:assert/strict';",
        '',
        "import { summarizeFrontmatter } from '../src/frontmatter.js';",
        '',
        "test('summarizes key/value frontmatter lines', () => {",
        "  const block = 'title: Inbox\\nauthor: Justin';",
        "  assert.equal(summarizeFrontmatter(block), 'title=Inbox, author=Justin');",
        '});',
        '',
        "test('ignores blank lines', () => {",
        "  const block = 'title: Inbox\\n\\nauthor: Justin';",
        "  assert.equal(summarizeFrontmatter(block), 'title=Inbox, author=Justin');",
        '});',
        '',
      ].join('\n'),
    },
  },
  {
    slug: 'priority-buckets',
    title: 'Priority bucket summary',
    focus: 'priority bucket summaries for review queues',
    files: {
      'README.md': [
        '# Inbox Codex E2E Repo',
        '',
        'Tiny priority summary helper used to prove the inbox app against a third real repo shape.',
        '',
      ].join('\n'),
      'package.json': JSON.stringify(
        {
          name: `inbox-e2e-priority-buckets-${runId}`,
          private: true,
          type: 'module',
          scripts: {
            test: 'node --test',
          },
        },
        null,
        2,
      ),
      'src/priority.js': [
        'export function summarizePriorityBuckets(items) {',
        "  const counts = { high: 0, medium: 0, low: 0 };",
        '  for (const item of items) {',
        '    counts[item.priority] += 1;',
        '  }',
        "  return `${counts.high} high / ${counts.medium} medium / ${counts.low} low`;",
        '}',
        '',
      ].join('\n'),
      'test/priority.test.js': [
        "import test from 'node:test';",
        "import assert from 'node:assert/strict';",
        '',
        "import { summarizePriorityBuckets } from '../src/priority.js';",
        '',
        "test('summarizes the three priority buckets', () => {",
        '  const items = [',
        "    { priority: 'high' },",
        "    { priority: 'high' },",
        "    { priority: 'medium' },",
        '  ];',
        '',
        "  assert.equal(summarizePriorityBuckets(items), '2 high / 1 medium / 0 low');",
        '});',
        '',
        "test('handles an empty list', () => {",
        "  assert.equal(summarizePriorityBuckets([]), '0 high / 0 medium / 0 low');",
        '});',
        '',
      ].join('\n'),
    },
  },
];

async function run(command: string, args: string[], options: RunOptions = {}): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? process.cwd(),
      env: options.env ?? process.env,
      stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
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

function parseJson<T>(raw: string): T {
  return JSON.parse(raw) as T;
}

async function readImportedBundleSnapshot(bundlePath: string) {
  const raw = await fs.readFile(bundlePath, 'utf8');
  const bundle = parseJson<ChangeUnitBundle>(raw);
  return {
    title: bundle.change_unit.title,
    status: bundle.change_unit.status,
    validationState: bundle.change_unit.validation.state,
    validationSummary: bundle.change_unit.validation.summary,
    prUrl: bundle.change_unit.pr.url ?? null,
    prStatus: bundle.change_unit.pr.status,
  };
}

async function waitForHealth(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch('http://127.0.0.1:8787/health');
      if (response.ok) return;
    } catch {
      // still starting
    }
    await delay(500);
  }
  throw new Error('Timed out waiting for local app server.');
}

async function createRemoteRepo(repoSlug: string) {
  await run('gh', [
    'repo',
    'create',
    repoSlug,
    '--private',
    '--disable-issues',
    '--disable-wiki',
    '--description',
    'Temporary Codex E2E repo for inbox app validation',
  ]);
}

async function seedRepo(scenario: Scenario, repoName: string, worktreeRoot: string, repoSlug: string) {
  await fs.rm(worktreeRoot, { recursive: true, force: true });
  await fs.mkdir(path.join(worktreeRoot, 'src'), { recursive: true });
  await fs.mkdir(path.join(worktreeRoot, 'test'), { recursive: true });
  await fs.mkdir(path.join(worktreeRoot, '.github', 'workflows'), { recursive: true });

  for (const [relativePath, content] of Object.entries(scenario.files)) {
    const absolutePath = path.join(worktreeRoot, relativePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(
      absolutePath,
      relativePath.endsWith('.json') ? `${content}\n` : content,
      'utf8',
    );
  }

  await fs.writeFile(
    path.join(worktreeRoot, '.github', 'workflows', 'test.yml'),
    [
      'name: test',
      '',
      'on:',
      '  push:',
      '  pull_request:',
      '',
      'jobs:',
      '  test:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - uses: actions/checkout@v4',
      '      - uses: actions/setup-node@v4',
      '        with:',
      '          node-version: 22',
      '      - run: npm test',
      '',
    ].join('\n'),
    'utf8',
  );

  await run('git', ['init', '-b', 'main'], { cwd: worktreeRoot });
  await run('git', ['config', 'user.name', 'Justin Moon'], { cwd: worktreeRoot });
  await run('git', ['config', 'user.email', 'justinmoon@users.noreply.github.com'], {
    cwd: worktreeRoot,
  });
  await run('git', ['remote', 'add', 'origin', `git@github.com:${repoSlug}.git`], { cwd: worktreeRoot });
  await run('git', ['add', '.'], { cwd: worktreeRoot });
  await run('git', ['commit', '-m', `Initial ${scenario.slug} helper`], { cwd: worktreeRoot });
  await run('git', ['push', '-u', 'origin', 'main'], { cwd: worktreeRoot });

  const repoInfoPath = path.join(worktreeRoot, 'README.md');
  await fs.appendFile(
    repoInfoPath,
    `\nSeeded for ${repoName} to exercise ${scenario.focus}.\n`,
    'utf8',
  );
}

async function runLiveCodexPlan(
  worktreeRoot: string,
  focus: string,
): Promise<{
  plannerThreadId: string;
  implementerThreadId: string;
  reviewerAThreadId: string;
  reviewerBThreadId: string;
  planner: PlannerPayload;
  packet: PacketPayload;
  reviewA: ReviewPayload;
  reviewB: ReviewPayload;
}> {
  const runtimeCodex = await createCodex(codexSdkPath);

  const planner = runtimeCodex.startThread({
    workingDirectory: worktreeRoot,
    approvalPolicy: 'never',
    sandboxMode: 'read-only',
    networkAccessEnabled: false,
  });

  const plannerResult = await planner.run(
    [
      'Inspect this repository and propose one small but real coding change.',
      `Prefer a change around ${focus}.`,
      'Keep the patch inspectable and small.',
      'Return JSON only.',
      'The implementation prompt should tell a separate implementer to make the change, run tests, and leave the diff uncommitted.',
    ].join('\n\n'),
    { outputSchema: plannerSchema },
  );
  const plannerPayload = parseJson<PlannerPayload>(plannerResult.finalResponse);

  const implementer = runtimeCodex.startThread({
    workingDirectory: worktreeRoot,
    approvalPolicy: 'never',
    sandboxMode: 'workspace-write',
    networkAccessEnabled: false,
  });

  await implementer.run(
    [
      'You are the implementer for a tiny repository used to validate an inbox review app.',
      plannerPayload.implementation_prompt,
      'Do the work now.',
      'Run `npm test` yourself before finishing.',
      'Leave the changes uncommitted in the worktree.',
    ].join('\n\n'),
  );

  await run('npm', ['test'], { cwd: worktreeRoot });

  const packetResult = await implementer.run(
    [
      'Now summarize the actual change you just made for an inbox review packet.',
      'Return JSON only.',
      'The tutorial markdown should explain what changed, why it matters, and what a reviewer should inspect.',
      'The next prompt should propose the immediate next chunk after this change.',
    ].join('\n\n'),
    { outputSchema: packetSchema },
  );
  const packetPayload = parseJson<PacketPayload>(packetResult.finalResponse);

  const reviewerA = runtimeCodex.startThread({
    workingDirectory: worktreeRoot,
    approvalPolicy: 'never',
    sandboxMode: 'read-only',
    networkAccessEnabled: false,
  });
  const reviewerAResult = await reviewerA.run(
    [
      'Review the current changes in this repository.',
      'Focus on correctness, edge cases, and test coverage.',
      'Do not modify files.',
      'Return JSON only.',
    ].join('\n\n'),
    { outputSchema: reviewSchema },
  );
  const reviewAPayload = parseJson<ReviewPayload>(reviewerAResult.finalResponse);

  const reviewerB = runtimeCodex.startThread({
    workingDirectory: worktreeRoot,
    approvalPolicy: 'never',
    sandboxMode: 'read-only',
    networkAccessEnabled: false,
  });
  const reviewerBResult = await reviewerB.run(
    [
      'Review the current changes in this repository.',
      'Focus on maintainability, naming, and whether the change is easy to inspect as a small packet.',
      'Do not modify files.',
      'Return JSON only.',
    ].join('\n\n'),
    { outputSchema: reviewSchema },
  );
  const reviewBPayload = parseJson<ReviewPayload>(reviewerBResult.finalResponse);

  if (!planner.id || !implementer.id || !reviewerA.id || !reviewerB.id) {
    throw new Error('Codex did not return thread ids for one or more sessions.');
  }

  return {
    plannerThreadId: planner.id,
    implementerThreadId: implementer.id,
    reviewerAThreadId: reviewerA.id,
    reviewerBThreadId: reviewerB.id,
    planner: plannerPayload,
    packet: packetPayload,
    reviewA: reviewAPayload,
    reviewB: reviewBPayload,
  };
}

async function publishReviewBranch(
  worktreeRoot: string,
  repoSlug: string,
  branchName: string,
  packetTitle: string,
) {
  await run('git', ['switch', '-c', branchName], { cwd: worktreeRoot });
  await run('git', ['add', '.'], { cwd: worktreeRoot });
  await run('git', ['commit', '-m', packetTitle], { cwd: worktreeRoot });
  await run('git', ['push', '-u', 'origin', branchName], { cwd: worktreeRoot });

  await run(
    'gh',
    [
      'pr',
      'create',
      '--repo',
      repoSlug,
      '--base',
      'main',
      '--head',
      branchName,
      '--title',
      packetTitle,
      '--body',
      'Automated Codex E2E PR used to validate the inbox review cockpit.',
    ],
    { cwd: worktreeRoot },
  );

  const prViewRaw = await run(
    'gh',
    [
      'pr',
      'list',
      '--repo',
      repoSlug,
      '--head',
      branchName,
      '--json',
      'number,url',
      '--limit',
      '1',
    ],
    { cwd: worktreeRoot, capture: true },
  );
  const pr = parseJson<Array<{ number?: number; url?: string }>>(prViewRaw)[0] ?? {};

  if (typeof pr.number === 'number') {
    await run('gh', ['pr', 'checks', String(pr.number), '--repo', repoSlug, '--watch', '--interval', '5'], {
      cwd: worktreeRoot,
    }).catch(() => undefined);
  }

  return {
    branchName,
    prNumber: typeof pr.number === 'number' ? pr.number : null,
    prUrl: typeof pr.url === 'string' ? pr.url : null,
  };
}

async function startLocalAppServer() {
  const server = spawn('npm', ['run', 'start'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: '8787',
    },
    stdio: 'inherit',
  });
  await waitForHealth();
  return server;
}

async function createPacketViaApi(input: {
  repo_path: string;
  github_repo: string;
  branch_name: string;
  planner_thread_id: string;
  implementer_thread_id: string;
  reviewer_a_thread_id: string;
  reviewer_b_thread_id: string;
}): Promise<CreateLiveChangeUnitResponse> {
  const response = await fetch('http://127.0.0.1:8787/api/live/change-units', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      repo_path: input.repo_path,
      github_repo: input.github_repo,
      branch_name: input.branch_name,
      thread_ids: {
        planner: input.planner_thread_id,
        implementer: input.implementer_thread_id,
        reviewer_a: input.reviewer_a_thread_id,
        reviewer_b: input.reviewer_b_thread_id,
      },
    }),
  });

  const body = (await response.json().catch(() => null)) as
    | CreateLiveChangeUnitResponse
    | { message?: string }
    | null;
  if (!response.ok || !body || !('imported' in body)) {
    throw new Error((body && 'message' in body && body.message) || 'Failed to create packet via API.');
  }
  return body;
}

async function refreshLiveSession(changeUnitId: string) {
  const response = await fetch(
    `http://127.0.0.1:8787/api/change-units/${changeUnitId}/sessions/${changeUnitId}_implementer/refresh-codex`,
    { method: 'POST' },
  );
  if (!response.ok) {
    throw new Error(await response.text());
  }
}

async function writeScenarioArtifact(result: ScenarioResult) {
  const payload = {
    scenario: result.scenario.slug,
    repo: result.repoSlug,
    repoUrl: `https://github.com/${result.repoSlug}`,
    worktree: result.worktreeRoot,
    branchName: result.branchName,
    prNumber: result.prNumber,
    prUrl: result.prUrl,
    changeUnitId: result.changeUnitId,
    bundlePath: result.bundlePath,
    importedTitle: result.importedTitle,
    importedStatus: result.importedStatus,
    importedValidationState: result.importedValidationState,
    importedValidationSummary: result.importedValidationSummary,
    importedPrUrl: result.importedPrUrl,
    importedPrStatus: result.importedPrStatus,
    plannerThreadId: result.plannerThreadId,
    implementerThreadId: result.implementerThreadId,
    reviewerAThreadId: result.reviewerAThreadId,
    reviewerBThreadId: result.reviewerBThreadId,
  };
  await fs.mkdir(result.bundleRoot, { recursive: true });
  await fs.writeFile(path.join(result.bundleRoot, 'run.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

async function runScenario(scenario: Scenario): Promise<ScenarioResult> {
  const repoName = `inbox-e2e-${scenario.slug}-${runId}`;
  const repoSlug = `justinmoon/${repoName}`;
  const worktreeRoot = path.resolve('/Users/justin/code', repoName);
  const bundleRoot = path.resolve(process.cwd(), 'artifacts/e2e', repoName);
  const branchName = `codex/${scenario.slug}-${runId}`;

  console.log(`Creating private GitHub repo ${repoSlug}`);
  await createRemoteRepo(repoSlug);
  await seedRepo(scenario, repoName, worktreeRoot, repoSlug);

  const live = await runLiveCodexPlan(worktreeRoot, scenario.focus);
  const pr = await publishReviewBranch(worktreeRoot, repoSlug, branchName, live.packet.title);

  return {
    scenario,
    repoName,
    repoSlug,
    worktreeRoot,
    bundleRoot,
    plannerThreadId: live.plannerThreadId,
    implementerThreadId: live.implementerThreadId,
    reviewerAThreadId: live.reviewerAThreadId,
    reviewerBThreadId: live.reviewerBThreadId,
    planner: live.planner,
    packet: live.packet,
    reviewA: live.reviewA,
    reviewB: live.reviewB,
    branchName: pr.branchName,
    prNumber: pr.prNumber,
    prUrl: pr.prUrl,
    changeUnitId: '',
    bundlePath: '',
    importedTitle: '',
    importedStatus: 'awaiting_review',
    importedValidationState: 'not_run',
    importedValidationSummary: '',
    importedPrUrl: null,
    importedPrStatus: '',
  };
}

async function validateImportedBundles(results: ScenarioResult[]) {
  const primary = results[0];
  const secondary = results[1] ?? primary;

  await run('pkill', ['-f', 'tsx server/index.ts'], { capture: true }).catch(() => undefined);
  await run('npm', ['run', 'build'], { cwd: process.cwd() });
  await run('npx', ['tsx', 'scripts/validateBrowser.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      INBOX_VALIDATE_CHANGE_ID: primary.changeUnitId,
      INBOX_VALIDATE_PRIMARY_TITLE: primary.importedTitle,
      INBOX_VALIDATE_SECONDARY_TITLE: secondary.importedTitle,
      INBOX_VALIDATE_REQUIRE_REFRESH: '1',
      INBOX_VALIDATE_CREATE_REPO_PATH: primary.worktreeRoot,
      INBOX_VALIDATE_CREATE_PROJECT_NAME: primary.scenario.title,
      INBOX_VALIDATE_CREATE_GITHUB_REPO: primary.repoSlug,
      INBOX_VALIDATE_CREATE_BRANCH_NAME: primary.branchName,
      INBOX_VALIDATE_CREATE_PLANNER_THREAD_ID: primary.plannerThreadId,
      INBOX_VALIDATE_CREATE_IMPLEMENTER_THREAD_ID: primary.implementerThreadId,
      INBOX_VALIDATE_CREATE_REVIEWER_A_THREAD_ID: primary.reviewerAThreadId,
      INBOX_VALIDATE_CREATE_REVIEWER_B_THREAD_ID: primary.reviewerBThreadId,
    },
  });
}

async function checkRemoteDeleteScope() {
  if (remoteDeleteSupported !== null) return remoteDeleteSupported;
  const authStatus = await run('gh', ['auth', 'status', '-h', 'github.com', '-t'], {
    capture: true,
  }).catch(() => '');
  remoteDeleteSupported = /\bdelete_repo\b/.test(authStatus);
  return remoteDeleteSupported;
}

async function maybeDeleteRepos(results: ScenarioResult[]) {
  if (keepRepos) return;
  const canDeleteRemote = await checkRemoteDeleteScope();
  if (!canDeleteRemote) {
    console.warn('Skipping remote repo deletion because gh auth is missing the delete_repo scope.');
  }
  for (const result of results) {
    if (canDeleteRemote) {
      await run('gh', ['repo', 'delete', result.repoSlug, '--yes'], { capture: true }).catch((error) => {
        console.warn(`Remote cleanup failed for ${result.repoSlug}: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
    await fs.rm(result.worktreeRoot, { recursive: true, force: true });
  }
}

async function main() {
  const results: ScenarioResult[] = [];

  try {
    for (const scenario of scenarios) {
      results.push(await runScenario(scenario));
    }

    const server = await startLocalAppServer();
    try {
      for (const result of results) {
        const created = await createPacketViaApi({
          repo_path: result.worktreeRoot,
          github_repo: result.repoSlug,
          branch_name: result.branchName,
          planner_thread_id: result.plannerThreadId,
          implementer_thread_id: result.implementerThreadId,
          reviewer_a_thread_id: result.reviewerAThreadId,
          reviewer_b_thread_id: result.reviewerBThreadId,
        });

        result.changeUnitId = created.imported;
        result.bundlePath = created.bundle_path;
        const imported = await readImportedBundleSnapshot(created.bundle_path);
        result.importedTitle = imported.title;
        result.importedStatus = imported.status;
        result.importedValidationState = imported.validationState;
        result.importedValidationSummary = imported.validationSummary;
        result.importedPrUrl = imported.prUrl;
        result.importedPrStatus = imported.prStatus;
        await refreshLiveSession(result.changeUnitId);
        await writeScenarioArtifact(result);
      }
    } finally {
      server.kill('SIGTERM');
    }

    await validateImportedBundles(results);

    console.log(
      JSON.stringify(
        {
          runId,
          keepRepos,
          scenarios: results.map((result) => ({
            scenario: result.scenario.slug,
            repo: result.repoSlug,
            remoteUrl: `https://github.com/${result.repoSlug}`,
            worktree: result.worktreeRoot,
            branchName: result.branchName,
            prNumber: result.prNumber,
            prUrl: result.prUrl,
            bundlePath: result.bundlePath,
            changeUnitId: result.changeUnitId,
            importedTitle: result.importedTitle,
            importedStatus: result.importedStatus,
            importedValidationState: result.importedValidationState,
            importedValidationSummary: result.importedValidationSummary,
            importedPrUrl: result.importedPrUrl,
            importedPrStatus: result.importedPrStatus,
            plannerThreadId: result.plannerThreadId,
            implementerThreadId: result.implementerThreadId,
            reviewerAThreadId: result.reviewerAThreadId,
            reviewerBThreadId: result.reviewerBThreadId,
          })),
        },
        null,
        2,
      ),
    );
  } finally {
    await maybeDeleteRepos(results);
  }
}

await main();
