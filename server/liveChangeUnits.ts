import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

import {
  parseChangeUnitBundle,
  type ChangeUnitBundle,
  type ReviewVerdict,
  type ValidationState,
} from '../shared/changeUnitBundle.ts';
import {
  createLiveChangeUnitRequestSchema,
  type CreateLiveChangeUnitRequest,
  type CreateLiveChangeUnitResponse,
} from '../shared/liveChangeUnit.ts';
import { CodexAppServer, mapCodexThreadToSessionUpdate } from './codexAppServer.ts';
import { createCodex } from './codexRuntime.ts';

type RunOptions = {
  cwd?: string;
  capture?: boolean;
  env?: NodeJS.ProcessEnv;
};

type RepoContext = {
  repoPath: string;
  projectName: string;
  githubRepo: string | null;
  branchName: string | null;
  defaultBranch: string | null;
  diffText: string;
  gitStatus: string;
  headSha: string;
};

type LiveChangeUnitOptions = {
  generatedBundleRoot: string;
  codexSdkPath: string;
};

type SessionSpec = {
  role: 'planner' | 'implementer' | 'reviewer_a' | 'reviewer_b';
  threadId: string;
};

type SynthesizedPacket = {
  title: string;
  executive_summary: string;
  tutorial_markdown: string;
  next_prompt: string;
  review_verdicts: Array<{
    reviewer_role: 'reviewer_a' | 'reviewer_b';
    verdict: ReviewVerdict;
    summary: string;
    details_markdown: string;
  }>;
};

type GithubValidation = ChangeUnitBundle['change_unit']['validation'];
type GithubPr = ChangeUnitBundle['change_unit']['pr'];

type GithubStatus = {
  pr: GithubPr;
  validation: GithubValidation;
};

const packetSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'executive_summary', 'tutorial_markdown', 'next_prompt', 'review_verdicts'],
  properties: {
    title: { type: 'string' },
    executive_summary: { type: 'string' },
    tutorial_markdown: { type: 'string' },
    next_prompt: { type: 'string' },
    review_verdicts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['reviewer_role', 'verdict', 'summary', 'details_markdown'],
        properties: {
          reviewer_role: {
            type: 'string',
            enum: ['reviewer_a', 'reviewer_b'],
          },
          verdict: {
            type: 'string',
            enum: ['approve', 'needs_revision', 'comment', 'blocked'],
          },
          summary: { type: 'string' },
          details_markdown: { type: 'string' },
        },
      },
    },
  },
} as const;

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

function now(): string {
  return new Date().toISOString();
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
}

function parseJson<T>(raw: string): T {
  return JSON.parse(raw) as T;
}

function countTranscriptItems(transcript: { turns: Array<{ items: unknown[] }> }) {
  return transcript.turns.reduce((count, turn) => count + turn.items.length, 0);
}

function parseGithubRepo(remoteUrl: string): string | null {
  const sshMatch = remoteUrl.match(/^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/);
  if (sshMatch) return sshMatch[1];
  const httpsMatch = remoteUrl.match(/^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/);
  if (httpsMatch) return httpsMatch[1];
  return null;
}

async function readLocalDefaultBranch(repoPath: string): Promise<string | null> {
  const raw = await run('git', ['symbolic-ref', 'refs/remotes/origin/HEAD', '--short'], {
    cwd: repoPath,
    capture: true,
  }).catch(() => '');
  if (!raw) return null;
  return raw.replace(/^origin\//, '');
}

async function readGithubDefaultBranch(repoPath: string, githubRepo: string): Promise<string | null> {
  const raw = await run(
    'gh',
    ['repo', 'view', githubRepo, '--json', 'defaultBranchRef'],
    { cwd: repoPath, capture: true },
  ).catch(() => '');
  if (!raw) return null;
  const parsed = parseJson<{ defaultBranchRef?: { name?: string } }>(raw);
  return parsed.defaultBranchRef?.name ?? null;
}

async function buildDiff(repoPath: string, branchName: string | null, defaultBranch: string | null): Promise<string> {
  const workingDiff = await run('git', ['diff', '--no-ext-diff', '--unified=3'], {
    cwd: repoPath,
    capture: true,
  });
  if (workingDiff.trim()) return workingDiff;

  if (branchName && defaultBranch && branchName !== defaultBranch) {
    const branchDiff = await run(
      'git',
      ['diff', '--no-ext-diff', '--unified=3', `origin/${defaultBranch}...HEAD`],
      {
        cwd: repoPath,
        capture: true,
      },
    ).catch(() => '');
    if (branchDiff.trim()) return branchDiff;
  }

  const headDiff = await run('git', ['diff', '--no-ext-diff', '--unified=3', 'HEAD~1..HEAD'], {
    cwd: repoPath,
    capture: true,
  }).catch(() => '');
  if (headDiff.trim()) return headDiff;

  throw new Error('No diff found. Commit or stage the change, or leave the worktree dirty before creating a packet.');
}

async function resolveRepoContext(input: CreateLiveChangeUnitRequest): Promise<RepoContext> {
  const repoPath = await run('git', ['rev-parse', '--show-toplevel'], {
    cwd: path.resolve(process.cwd(), input.repo_path),
    capture: true,
  });
  const remoteUrl = await run('git', ['remote', 'get-url', 'origin'], {
    cwd: repoPath,
    capture: true,
  }).catch(() => '');
  const githubRepo = input.github_repo ?? parseGithubRepo(remoteUrl) ?? null;
  const detectedBranch =
    (await run('git', ['branch', '--show-current'], {
      cwd: repoPath,
      capture: true,
    }).catch(() => '')) || null;
  const branchName = input.branch_name ?? detectedBranch;
  const defaultBranch = githubRepo
    ? (await readGithubDefaultBranch(repoPath, githubRepo)) ?? (await readLocalDefaultBranch(repoPath))
    : await readLocalDefaultBranch(repoPath);
  const diffText = await buildDiff(repoPath, branchName, defaultBranch);
  const gitStatus = await run('git', ['status', '--short', '--branch'], {
    cwd: repoPath,
    capture: true,
  });
  const headSha = await run('git', ['rev-parse', 'HEAD'], {
    cwd: repoPath,
    capture: true,
  }).catch(() => 'HEAD');

  return {
    repoPath,
    projectName: input.project_name ?? githubRepo ?? path.basename(repoPath),
    githubRepo,
    branchName,
    defaultBranch,
    diffText,
    gitStatus,
    headSha,
  };
}

function mapCheckState(rawState: string | null | undefined): ValidationState {
  const normalized = rawState?.toUpperCase() ?? '';
  if (['SUCCESS', 'PASSED', 'PASS', 'COMPLETED', 'APPROVED'].includes(normalized)) return 'passed';
  if (['FAILURE', 'FAILED', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED'].includes(normalized)) {
    return 'failed';
  }
  if (['IN_PROGRESS', 'PENDING', 'QUEUED', 'WAITING', 'EXPECTED', 'REQUESTED'].includes(normalized)) {
    return 'running';
  }
  if (['NEUTRAL', 'SKIPPED', 'STALE'].includes(normalized)) return 'warning';
  return 'warning';
}

function summarizeValidationState(states: ValidationState[]): ValidationState {
  if (states.includes('failed')) return 'failed';
  if (states.includes('running')) return 'running';
  if (states.length > 0 && states.every((state) => state === 'passed')) return 'passed';
  if (states.length === 0) return 'warning';
  return 'warning';
}

function mapGithubCheck(raw: Record<string, unknown>, index: number): GithubValidation['checks'][number] {
  const label =
    (typeof raw.name === 'string' && raw.name) ||
    (typeof raw.context === 'string' && raw.context) ||
    (typeof raw.workflowName === 'string' && raw.workflowName) ||
    `GitHub check ${index + 1}`;
  const stateSource =
    (typeof raw.conclusion === 'string' && raw.conclusion) ||
    (typeof raw.state === 'string' && raw.state) ||
    (typeof raw.status === 'string' && raw.status) ||
    'UNKNOWN';
  const detailParts = [
    typeof raw.workflowName === 'string' ? raw.workflowName : null,
    typeof raw.detailsUrl === 'string' ? raw.detailsUrl : null,
    typeof raw.description === 'string' ? raw.description : null,
  ].filter((value): value is string => Boolean(value));

  return {
    id: `github-check-${index + 1}`,
    label,
    state: mapCheckState(stateSource),
    detail: detailParts.join(' · ') || `GitHub reported ${stateSource.toLowerCase()}.`,
  };
}

async function readGithubStatus(repo: RepoContext): Promise<GithubStatus> {
  const checks: GithubValidation['checks'] = [
    {
      id: 'git-status',
      label: 'git status',
      state: 'passed' as const,
      detail: repo.gitStatus || 'Worktree is clean.',
    },
  ];

  if (!repo.githubRepo) {
    return {
      pr: {
        number: null,
        status: 'No GitHub remote detected for this repo.',
        url: null,
        branch_name: repo.branchName,
      },
      validation: {
        state: 'warning' as const,
        summary: 'GitHub PR and CI status are unavailable because the repo has no GitHub remote.',
        checks,
      },
    };
  }

  if (!repo.branchName) {
    return {
      pr: {
        number: null,
        status: `Unable to determine the active branch for ${repo.githubRepo}.`,
        url: null,
        branch_name: null,
      },
      validation: {
        state: 'warning' as const,
        summary: 'GitHub PR and CI status are unavailable because the local branch is unknown.',
        checks,
      },
    };
  }

  const prRaw = await run(
    'gh',
    [
      'pr',
      'list',
      '--repo',
      repo.githubRepo,
      '--head',
      repo.branchName,
      '--json',
      'number,url,state,isDraft,reviewDecision,headRefName,statusCheckRollup',
      '--limit',
      '1',
    ],
    {
      cwd: repo.repoPath,
      capture: true,
    },
  ).catch(() => '[]');

  const prList = parseJson<Array<Record<string, unknown>>>(prRaw);
  const pr = prList[0];
  if (!pr) {
    checks.push({
      id: 'github-pr',
      label: 'GitHub PR',
      state: 'warning' as const,
      detail: `No open PR found for branch ${repo.branchName}.`,
    });
    return {
      pr: {
        number: null,
        status: `No open PR for branch ${repo.branchName}.`,
        url: null,
        branch_name: repo.branchName,
      },
      validation: {
        state: 'warning' as const,
        summary: `No open PR found for ${repo.branchName}, so GitHub check status is limited to local repo state.`,
        checks,
      },
    };
  }

  const statusChecks = Array.isArray(pr.statusCheckRollup)
    ? pr.statusCheckRollup
        .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
        .map(mapGithubCheck)
    : [];
  checks.push(
    ...statusChecks.length
      ? statusChecks
      : [
          {
            id: 'github-checks',
            label: 'GitHub checks',
            state: 'warning' as const,
            detail: 'GitHub PR exists, but no status checks were reported yet.',
          },
        ],
  );

  const validationState = summarizeValidationState(checks.map((check) => check.state));
  const reviewDecision = typeof pr.reviewDecision === 'string' ? pr.reviewDecision : null;
  const statusBits = [
    typeof pr.state === 'string' ? pr.state.toLowerCase() : 'open',
    pr.isDraft === true ? 'draft' : null,
    reviewDecision ? `review ${reviewDecision.toLowerCase()}` : null,
  ].filter((value): value is string => Boolean(value));

  return {
    pr: {
      number: typeof pr.number === 'number' ? pr.number : null,
      status: statusBits.join(' · ') || 'open',
      url: typeof pr.url === 'string' ? pr.url : `https://github.com/${repo.githubRepo}`,
      branch_name: typeof pr.headRefName === 'string' ? pr.headRefName : repo.branchName,
    },
    validation: {
      state: validationState,
      summary:
        validationState === 'passed'
          ? `GitHub PR and checks are green for ${repo.branchName}.`
          : validationState === 'running'
            ? `GitHub is still running checks for ${repo.branchName}.`
            : validationState === 'failed'
              ? `One or more GitHub checks failed for ${repo.branchName}.`
              : `GitHub PR data was found for ${repo.branchName}, but the check state is incomplete.`,
      checks,
    },
  };
}

function extractAssistantSnippet(session: ReturnType<typeof mapCodexThreadToSessionUpdate>): string | null {
  for (const turn of [...session.transcript.turns].reverse()) {
    for (const item of [...turn.items].reverse()) {
      if (item.type === 'assistant' && typeof item.text === 'string' && item.text.trim()) {
        return item.text.slice(0, 1500);
      }
    }
  }
  return null;
}

async function synthesizePacket(
  repo: RepoContext,
  sessions: Array<{
    role: SessionSpec['role'];
    threadId: string;
    mapped: ReturnType<typeof mapCodexThreadToSessionUpdate>;
  }>,
  githubStatus: GithubStatus,
  codexSdkPath: string,
): Promise<SynthesizedPacket> {
  const runtimeCodex = await createCodex(codexSdkPath);
  const synthesizer = runtimeCodex.startThread({
    workingDirectory: repo.repoPath,
    approvalPolicy: 'never',
    sandboxMode: 'read-only',
    networkAccessEnabled: false,
  });

  const sessionDigest = sessions.map((session) => ({
    role: session.role,
    thread_id: session.threadId,
    status: session.mapped.status,
    summary: session.mapped.summary,
    transcript_summary: session.mapped.transcript.summary,
    last_assistant_excerpt: extractAssistantSnippet(session.mapped),
  }));

  const prompt = [
    'Build a change_unit packet for a local inbox-style code review cockpit.',
    'Return JSON only.',
    'Base the packet on the real repo diff, GitHub status, and linked Codex session summaries below.',
    'Write for a human reviewer who wants a coherent packet, not raw transcript archaeology.',
    'The title should read like a compact inbox item.',
    'The executive summary should be 2-4 sentences.',
    'The tutorial markdown must include sections named "What changed", "Why it matters", and "What to review".',
    'The next prompt must propose the immediate next chunk after this change.',
    'Only include review_verdicts for reviewer_a and reviewer_b when the reviewer context is present.',
    '',
    `Repo: ${repo.projectName}`,
    `Branch: ${repo.branchName ?? 'unknown'}`,
    `GitHub repo: ${repo.githubRepo ?? 'none'}`,
    `PR status: ${githubStatus.pr.status}`,
    `Validation summary: ${githubStatus.validation.summary}`,
    '',
    'Git status:',
    repo.gitStatus || '(empty)',
    '',
    'Diff:',
    repo.diffText,
    '',
    'Session digest:',
    JSON.stringify(sessionDigest, null, 2),
  ].join('\n');

  const response = await synthesizer.run(prompt, { outputSchema: packetSchema });
  return parseJson<SynthesizedPacket>(response.finalResponse);
}

function deriveAttentionScore(
  status: ChangeUnitBundle['change_unit']['status'],
  validationState: ValidationState,
  reviewVerdicts: SynthesizedPacket['review_verdicts'],
): number {
  let score = 45;
  if (status === 'awaiting_review') score = 74;
  if (status === 'needs_revision') score = 96;
  if (status === 'validating') score = 68;
  if (status === 'ready_to_land') score = 80;
  if (reviewVerdicts.some((verdict) => verdict.verdict === 'blocked')) score = 100;
  if (validationState === 'failed') score = Math.max(score, 95);
  if (validationState === 'running') score = Math.max(score, 70);
  return score;
}

function deriveChangeUnitStatus(
  reviewVerdicts: SynthesizedPacket['review_verdicts'],
  validationState: ValidationState,
  pr: GithubPr,
): ChangeUnitBundle['change_unit']['status'] {
  if (reviewVerdicts.some((verdict) => verdict.verdict === 'blocked' || verdict.verdict === 'needs_revision')) {
    return 'needs_revision';
  }
  if (validationState === 'failed') return 'needs_revision';
  if (validationState === 'running') return 'validating';
  if (reviewVerdicts.length === 0) return 'awaiting_review';
  if (reviewVerdicts.every((verdict) => verdict.verdict === 'approve') && validationState === 'passed') {
    return pr.number ? 'ready_to_land' : 'approved';
  }
  if (reviewVerdicts.every((verdict) => verdict.verdict === 'approve' || verdict.verdict === 'comment')) {
    return validationState === 'passed' ? 'approved' : 'awaiting_review';
  }
  return 'awaiting_review';
}

export async function createLiveChangeUnitBundle(
  rawInput: CreateLiveChangeUnitRequest,
  options: LiveChangeUnitOptions,
): Promise<{
  bundle: ChangeUnitBundle;
  bundlePath: string;
  response: CreateLiveChangeUnitResponse;
}> {
  const input = createLiveChangeUnitRequestSchema.parse(rawInput);
  const repo = await resolveRepoContext(input);
  const sessionSpecs = [
    input.thread_ids.planner ? { role: 'planner' as const, threadId: input.thread_ids.planner } : null,
    { role: 'implementer' as const, threadId: input.thread_ids.implementer },
    input.thread_ids.reviewer_a ? { role: 'reviewer_a' as const, threadId: input.thread_ids.reviewer_a } : null,
    input.thread_ids.reviewer_b ? { role: 'reviewer_b' as const, threadId: input.thread_ids.reviewer_b } : null,
  ].filter((value): value is SessionSpec => Boolean(value));

  const appServer = new CodexAppServer();
  try {
    const sessions = [];
    for (const spec of sessionSpecs) {
      const thread = await appServer.readThread(spec.threadId);
      sessions.push({
        role: spec.role,
        threadId: spec.threadId,
        mapped: mapCodexThreadToSessionUpdate(thread),
      });
    }

    const githubStatus = await readGithubStatus(repo);
    const packet = await synthesizePacket(repo, sessions, githubStatus, options.codexSdkPath);
    const createdAt = now();
    const repoSlug = slugify(repo.githubRepo ?? repo.projectName);
    const changeUnitId = `cu_live_${repoSlug}_${Date.now()}`;
    const projectId = `project_${repoSlug}`;
    const changeUnitStatus = deriveChangeUnitStatus(
      packet.review_verdicts,
      githubStatus.validation.state,
      githubStatus.pr,
    );
    const attentionScore = deriveAttentionScore(
      changeUnitStatus,
      githubStatus.validation.state,
      packet.review_verdicts,
    );
    const bundlePath = path.join(options.generatedBundleRoot, `${changeUnitId}.json`);

    const bundle = parseChangeUnitBundle({
      bundle_version: 1,
      project: {
        id: projectId,
        name: repo.projectName,
        worktree_path: repo.repoPath,
        repo_path: repo.repoPath,
        created_at: createdAt,
      },
      change_unit: {
        id: changeUnitId,
        project_id: projectId,
        title: packet.title,
        status: changeUnitStatus,
        attention_score: attentionScore,
        tags: ['live-codex', repo.githubRepo ? 'github' : 'local-import'],
        executive_summary: packet.executive_summary,
        tutorial_markdown: packet.tutorial_markdown,
        next_prompt: packet.next_prompt,
        diff_text: repo.diffText,
        pr: githubStatus.pr,
        validation: githubStatus.validation,
        created_at: createdAt,
        updated_at: createdAt,
      },
      agent_sessions: sessions.map((session) => ({
        id: `${changeUnitId}_${session.role}`,
        change_unit_id: changeUnitId,
        role: session.role,
        runtime: 'codex',
        thread_id: session.threadId,
        status: session.mapped.status,
        summary: session.mapped.summary,
        milestones: [
          {
            id: `${changeUnitId}_${session.role}_imported`,
            timestamp: createdAt,
            label: 'Imported into inbox',
            description: `Linked ${session.role.replaceAll('_', ' ')} thread ${session.threadId}.`,
          },
        ],
        transcript: session.mapped.transcript,
        codex_sync: {
          source: 'live_create',
          source_thread_status: session.mapped.status,
          imported_turn_count: session.mapped.transcript.turns.length,
          imported_item_count: countTranscriptItems(session.mapped.transcript),
          last_attempted_at: createdAt,
          last_succeeded_at: createdAt,
        },
        created_at: createdAt,
        updated_at: session.mapped.updated_at,
      })),
      artifacts: [
        {
          id: `${changeUnitId}_bundle`,
          change_unit_id: changeUnitId,
          kind: 'bundle',
          label: 'Generated live bundle',
          path_or_blob_ref: bundlePath,
          metadata: {
            source: 'live_create',
          },
          created_at: createdAt,
        },
        {
          id: `${changeUnitId}_repo`,
          change_unit_id: changeUnitId,
          kind: 'repo',
          label: 'Local repo path',
          path_or_blob_ref: repo.repoPath,
          metadata: {
            git_head: repo.headSha,
            branch_name: repo.branchName,
          },
          created_at: createdAt,
        },
        ...(repo.githubRepo
          ? [
              {
                id: `${changeUnitId}_github_repo`,
                change_unit_id: changeUnitId,
                kind: 'github_repo',
                label: 'GitHub repo',
                path_or_blob_ref: `https://github.com/${repo.githubRepo}`,
                metadata: {
                  source: 'gh',
                },
                created_at: createdAt,
              },
            ]
          : []),
        ...(githubStatus.pr.number && githubStatus.pr.url
          ? [
              {
                id: `${changeUnitId}_github_pr`,
                change_unit_id: changeUnitId,
                kind: 'github_pr',
                label: 'Linked PR',
                path_or_blob_ref: githubStatus.pr.url,
                metadata: {
                  pr_number: githubStatus.pr.number,
                },
                created_at: createdAt,
              },
            ]
          : []),
      ],
      review_verdicts: packet.review_verdicts.map((verdict) => ({
        id: `${changeUnitId}_${verdict.reviewer_role}_verdict`,
        change_unit_id: changeUnitId,
        reviewer_role: verdict.reviewer_role,
        verdict: verdict.verdict,
        summary: verdict.summary,
        details_markdown: verdict.details_markdown,
        created_at: createdAt,
      })),
    });

    await fs.mkdir(options.generatedBundleRoot, { recursive: true });
    await fs.writeFile(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`, 'utf8');

    return {
      bundle,
      bundlePath,
      response: {
        imported: bundle.change_unit.id,
        bundle_path: bundlePath,
        project_name: bundle.project.name,
        github_repo: repo.githubRepo,
        branch_name: repo.branchName,
      },
    };
  } finally {
    await appServer.stop();
  }
}
