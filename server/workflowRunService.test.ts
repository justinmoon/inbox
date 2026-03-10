import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { CodexThread } from '../shared/api.ts';
import type { RepositoryRecord, WorkspaceRecord } from '../shared/workspaces.ts';
import { AgentSessionStore } from './agentSessionStore.ts';
import type { CodexClient } from './codexClient.ts';
import { GateStore } from './gateStore.ts';
import { RunEventStore } from './runEventStore.ts';
import { WorkflowDefinitionService } from './workflowDefinitionService.ts';
import { WorkflowRunService } from './workflowRunService.ts';
import { WorkflowRunStore } from './workflowRunStore.ts';
import { planImplementReviewWorkflow } from './workflows/planImplementReview.ts';

type PlannedTurn = {
  assistantText: string;
  status?: string;
};

class FakeCodexClient implements CodexClient {
  calls: string[] = [];
  #threads = new Map<string, CodexThread>();
  #turnPlans: PlannedTurn[];
  #nextThread = 1;
  #nextTurn = 1;

  constructor(turnPlans: PlannedTurn[]) {
    this.#turnPlans = [...turnPlans];
  }

  async ensureStarted() {
    this.calls.push('ensureStarted');
  }

  async startThread() {
    const threadId = `thr_${this.#nextThread++}`;
    this.calls.push(`startThread:${threadId}`);
    this.#threads.set(threadId, {
      id: threadId,
      preview: '',
      ephemeral: false,
      modelProvider: 'openai',
      createdAt: 0,
      updatedAt: 0,
      status: { type: 'loaded' },
      path: null,
      cwd: '',
      cliVersion: 'test',
      source: null,
      agentNickname: null,
      agentRole: null,
      name: null,
      turns: [],
    });
    return { threadId };
  }

  async resumeThread(input: { threadId: string }) {
    this.calls.push(`resumeThread:${input.threadId}`);
    return { threadId: input.threadId };
  }

  async startTurn(input: { threadId: string; text: string }) {
    const turnId = `turn_${this.#nextTurn++}`;
    this.calls.push(`startTurn:${input.threadId}:${turnId}`);
    const thread = this.#threads.get(input.threadId);
    if (!thread) {
      throw new Error(`Unknown thread ${input.threadId}`);
    }

    const plan = this.#turnPlans.shift() ?? { assistantText: '', status: 'completed' };
    thread.turns.push({
      id: turnId,
      status: plan.status ?? 'completed',
      error: null,
      items: [
        {
          type: 'userMessage',
          id: `${turnId}-user`,
          content: [{ type: 'text', text: input.text }],
        },
        ...(plan.assistantText
          ? [
              {
                type: 'agentMessage' as const,
                id: `${turnId}-assistant`,
                text: plan.assistantText,
                phase: null,
              },
            ]
          : []),
      ],
    });

    if (!thread.preview) {
      thread.preview = input.text;
    }

    return { turnId };
  }

  async waitForTurnCompletion(input: { threadId: string; turnId: string }) {
    this.calls.push(`waitForTurnCompletion:${input.threadId}:${input.turnId}`);
    const thread = this.#threads.get(input.threadId);
    const turn = thread?.turns.find((entry) => entry.id === input.turnId);
    return {
      turnId: input.turnId,
      status: turn?.status ?? 'completed',
    };
  }

  async readThread(input: { threadId: string }) {
    this.calls.push(`readThread:${input.threadId}`);
    const thread = this.#threads.get(input.threadId);
    if (!thread) {
      throw new Error(`Unknown thread ${input.threadId}`);
    }
    return structuredClone(thread);
  }

  onNotification() {
    return () => {};
  }

  onServerRequest() {
    return () => {};
  }

  async respond() {}

  async respondError() {}
}

function createWorkspaceHarness(repoPath: string) {
  const timestamp = '2026-03-10T00:00:00.000Z';
  const repository: RepositoryRecord = {
    id: 'sample-repo',
    provider: 'shared-store-worktree',
    source: repoPath,
    backing_store_path: path.join(repoPath, '.store'),
    visible_root_path: path.join(repoPath, '.visible'),
    visible_trunk_path: path.join(repoPath, '.visible', 'trunk'),
    trunk_workspace_id: 'sample-repo--trunk',
    created_at: timestamp,
    updated_at: timestamp,
    tags: [],
    metadata: {},
  };
  const workspace: WorkspaceRecord = {
    id: 'sample-repo--trunk',
    repo_id: repository.id,
    provider: 'shared-store-worktree',
    strategy: 'shared-store-worktree',
    name: 'trunk',
    path: path.join(repoPath, '.visible', 'trunk'),
    source_ref: { kind: 'branch', branch: 'main' },
    current_head: 'abc123',
    created_at: timestamp,
    updated_at: timestamp,
    tags: [],
    metadata: {},
  };

  return {
    repository,
    workspace,
    async ensureRepository(request: { id?: string; source: string }) {
      repository.id = request.id ?? repository.id;
      repository.source = request.source;
      repository.trunk_workspace_id = workspace.id;
      workspace.repo_id = repository.id;
      return {
        repository: { ...repository },
        trunk_workspace: { ...workspace },
      };
    },
    async getRepository(id: string) {
      return id === repository.id ? { ...repository } : null;
    },
    async getWorkspace(id: string) {
      return id === workspace.id ? { ...workspace } : null;
    },
  };
}

async function createHarness(turnPlans: PlannedTurn[]) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'inbox-workflow-run-test-'));
  const repoPath = path.join(rootDir, 'repo');
  await fs.mkdir(repoPath, { recursive: true });

  const codex = new FakeCodexClient(turnPlans);
  const workspaces = createWorkspaceHarness(repoPath);
  const service = new WorkflowRunService({
    definitions: new WorkflowDefinitionService([planImplementReviewWorkflow]),
    runs: new WorkflowRunStore(rootDir),
    gates: new GateStore(rootDir),
    sessions: new AgentSessionStore(rootDir),
    events: new RunEventStore(rootDir),
    workspaces,
    codex,
    clock: () => '2026-03-10T00:00:00.000Z',
    idGenerator: (() => {
      let nextId = 1;
      return () => String(nextId++);
    })(),
  });

  return {
    rootDir,
    repoPath,
    codex,
    service,
  };
}

test('run start creates planner session and runtime history', async () => {
  const harness = await createHarness([{ assistantText: 'Tell me more about the desired scope.' }]);

  try {
    const detail = await harness.service.createRun({
      workflow_id: 'plan-implement-review',
      repo_path: harness.repoPath,
      goal_prompt: 'Build the workflow runtime.',
    });

    assert.equal(detail.run.current_state_id, 'planning_conversation');
    assert.equal(detail.sessions.length, 1);
    assert.equal(detail.sessions[0]?.session.kind, 'planning_conversation');
    assert.equal(detail.sessions[0]?.session.thread_id, 'thr_1');
    assert.equal(detail.sessions[0]?.session.latest_turn_id, 'turn_1');
    assert.equal(detail.sessions[0]?.thread?.turns.length, 1);
    assert.equal(detail.open_gates.length, 0);
    assert.deepEqual(
      detail.events.map((event) => event.type),
      [
        'run_created',
        'agent_session_started',
        'planner_turn_completed',
        'planner_marker_not_found',
      ],
    );
  } finally {
    await fs.rm(harness.rootDir, { recursive: true, force: true });
  }
});

test('sending a planning message resumes the planner thread and starts a new turn', async () => {
  const harness = await createHarness([
    { assistantText: 'Need more context first.' },
    { assistantText: 'Still planning, no prompt yet.' },
  ]);

  try {
    const created = await harness.service.createRun({
      workflow_id: 'plan-implement-review',
      repo_path: harness.repoPath,
      goal_prompt: 'Build the workflow runtime.',
    });

    harness.codex.calls = [];

    const detail = await harness.service.sendPlanningMessage({
      runId: created.run.id,
      message: 'Please break the first step down more tightly.',
    });

    assert.equal(detail.run.current_state_id, 'planning_conversation');
    assert.equal(detail.sessions[0]?.thread?.turns.length, 2);
    assert.deepEqual(harness.codex.calls.slice(0, 4), [
      'resumeThread:thr_1',
      'startTurn:thr_1:turn_2',
      'waitForTurnCompletion:thr_1:turn_2',
      'readThread:thr_1',
    ]);
  } finally {
    await fs.rm(harness.rootDir, { recursive: true, force: true });
  }
});

test('planner output without a marker stays in planning_conversation', async () => {
  const harness = await createHarness([{ assistantText: 'I need one more clarification before proposing a prompt.' }]);

  try {
    const detail = await harness.service.createRun({
      workflow_id: 'plan-implement-review',
      repo_path: harness.repoPath,
      goal_prompt: 'Build the workflow runtime.',
    });

    assert.equal(detail.run.current_state_id, 'planning_conversation');
    assert.equal(detail.run.last_transition_id, null);
    assert.deepEqual(detail.open_gates, []);
  } finally {
    await fs.rm(harness.rootDir, { recursive: true, force: true });
  }
});

test('planner output with a first_prompt_candidate transitions to first_prompt_approval', async () => {
  const harness = await createHarness([
    { assistantText: 'Need more context first.' },
    {
      assistantText:
        'The plan is ready.\n<first_prompt_candidate>Implement the workflow run detail API.</first_prompt_candidate>',
    },
  ]);

  try {
    const created = await harness.service.createRun({
      workflow_id: 'plan-implement-review',
      repo_path: harness.repoPath,
      goal_prompt: 'Build the workflow runtime.',
    });

    const detail = await harness.service.sendPlanningMessage({
      runId: created.run.id,
      message: 'The repo shape is stable now. Propose the first prompt.',
    });

    assert.equal(detail.run.current_state_id, 'first_prompt_approval');
    assert.equal(detail.run.current_state_family, 'approval');
    assert.equal(detail.run.last_transition_id, 'planning_prompt_ready');
    assert.equal(detail.events.some((event) => event.type === 'state_transition'), true);
  } finally {
    await fs.rm(harness.rootDir, { recursive: true, force: true });
  }
});

test('initial approval gate opens with the extracted prompt candidate after transition', async () => {
  const harness = await createHarness([
    {
      assistantText:
        '<first_prompt_candidate>Implement the workflow run detail API.</first_prompt_candidate>',
    },
  ]);

  try {
    const detail = await harness.service.createRun({
      workflow_id: 'plan-implement-review',
      repo_path: harness.repoPath,
      goal_prompt: 'Build the workflow runtime.',
    });

    assert.equal(detail.run.current_state_id, 'first_prompt_approval');
    assert.equal(detail.open_gates.length, 1);
    assert.equal(detail.open_gates[0]?.definition_gate_id, 'first_prompt_gate');
    assert.equal(
      detail.open_gates[0]?.metadata.prompt_candidate,
      'Implement the workflow run detail API.',
    );
    assert.equal(detail.events.some((event) => event.type === 'gate_opened'), true);
  } finally {
    await fs.rm(harness.rootDir, { recursive: true, force: true });
  }
});
