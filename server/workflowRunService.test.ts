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
import type { WorkflowRunUpdate } from './workflowRunService.ts';
import { WorkflowRunService } from './workflowRunService.ts';
import { WorkflowDefinitionService } from './workflowDefinitionService.ts';
import { WorkflowRunStore } from './workflowRunStore.ts';
import { planImplementReviewWorkflow } from './workflows/planImplementReview.ts';

type TurnPlan = {
  completion?: 'immediate' | 'manual';
  assistantText?: string;
  status?: 'completed' | 'failed' | 'interrupted';
};

type PendingTurn = {
  threadId: string;
  turnId: string;
  resolve: (value: { turnId: string; status: string }) => void;
};

class FakeCodexClient implements CodexClient {
  calls: string[] = [];
  #threads = new Map<string, CodexThread>();
  #turnPlans: TurnPlan[];
  #pendingTurns = new Map<string, PendingTurn>();
  #nextThread = 1;
  #nextTurn = 1;
  #failNextStartTurn: Error | null = null;

  constructor(turnPlans: TurnPlan[]) {
    this.#turnPlans = [...turnPlans];
  }

  failNextStartTurn(error: Error) {
    this.#failNextStartTurn = error;
  }

  completeTurn(turnId: string, args: { assistantText?: string; status?: 'completed' | 'failed' | 'interrupted' }) {
    const pending = this.#pendingTurns.get(turnId);
    if (!pending) {
      throw new Error(`No pending turn "${turnId}" exists.`);
    }

    const thread = this.#threads.get(pending.threadId);
    const turn = thread?.turns.find((entry) => entry.id === turnId);
    if (!thread || !turn) {
      throw new Error(`Thread data for pending turn "${turnId}" was not found.`);
    }

    turn.status = args.status ?? 'completed';
    turn.error =
      turn.status === 'failed'
        ? {
            message: 'Synthetic failure',
          }
        : null;
    if (args.assistantText) {
      turn.items.push({
        type: 'agentMessage',
        id: `${turnId}-assistant`,
        text: args.assistantText,
        phase: null,
      });
    }

    this.#pendingTurns.delete(turnId);
    pending.resolve({ turnId, status: turn.status });
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
    if (this.#failNextStartTurn) {
      const error = this.#failNextStartTurn;
      this.#failNextStartTurn = null;
      throw error;
    }

    const turnId = `turn_${this.#nextTurn++}`;
    this.calls.push(`startTurn:${input.threadId}:${turnId}`);
    const thread = this.#threads.get(input.threadId);
    if (!thread) {
      throw new Error(`Unknown thread ${input.threadId}`);
    }

    const plan = this.#turnPlans.shift() ?? { completion: 'immediate', assistantText: '', status: 'completed' };
    const completion = plan.completion ?? 'immediate';
    thread.turns.push({
      id: turnId,
      status: completion === 'manual' ? 'inProgress' : plan.status ?? 'completed',
      error: null,
      items: [
        {
          type: 'userMessage',
          id: `${turnId}-user`,
          content: [{ type: 'text', text: input.text }],
        },
        ...(completion === 'immediate' && plan.assistantText
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

  async steerTurn(input: { threadId: string; turnId: string; text: string }) {
    this.calls.push(`steerTurn:${input.threadId}:${input.turnId}`);
    const thread = this.#threads.get(input.threadId);
    const turn = thread?.turns.find((entry) => entry.id === input.turnId);
    if (!thread || !turn || turn.status !== 'inProgress') {
      throw new Error('invalid request: no active turn');
    }

    turn.items.push({
      type: 'userMessage',
      id: `${input.turnId}-user-${turn.items.length + 1}`,
      content: [{ type: 'text', text: input.text }],
    });

    return { turnId: input.turnId };
  }

  async waitForTurnCompletion(input: { threadId: string; turnId: string }) {
    this.calls.push(`waitForTurnCompletion:${input.threadId}:${input.turnId}`);
    const thread = this.#threads.get(input.threadId);
    const turn = thread?.turns.find((entry) => entry.id === input.turnId);
    if (!turn) {
      throw new Error(`Unknown turn ${input.turnId}`);
    }

    if (turn.status !== 'inProgress') {
      return {
        turnId: input.turnId,
        status: turn.status,
      };
    }

    return await new Promise<{ turnId: string; status: string }>((resolve) => {
      this.#pendingTurns.set(input.turnId, {
        threadId: input.threadId,
        turnId: input.turnId,
        resolve,
      });
    });
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
  const createdWorkspaces: WorkspaceRecord[] = [];
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
    createdWorkspaces,
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
      if (id === workspace.id) {
        return { ...workspace };
      }

      const created = createdWorkspaces.find((entry) => entry.id === id);
      return created ? { ...created } : null;
    },
    async createWorkspace(request: {
      repo_id?: string;
      source_workspace_id?: string;
      name_hint?: string;
      tags?: string[];
      metadata?: Record<string, string>;
    }) {
      const nextWorkspace: WorkspaceRecord = {
        id: request.name_hint ?? 'sample-repo--child',
        repo_id: request.repo_id ?? workspace.repo_id,
        provider: 'shared-store-worktree',
        strategy: 'shared-store-worktree',
        name: request.name_hint ?? 'child',
        path: path.join(repoPath, '.visible', request.name_hint ?? 'child'),
        source_ref: request.source_workspace_id
          ? { kind: 'workspace', workspace_id: request.source_workspace_id }
          : { kind: 'branch', branch: 'main' },
        current_head: 'abc123',
        created_at: timestamp,
        updated_at: timestamp,
        tags: request.tags ?? [],
        metadata: request.metadata ?? {},
      };
      createdWorkspaces.push(nextWorkspace);

      return {
        repository: { ...repository },
        workspace: nextWorkspace,
      };
    },
  };
}

async function createHarness(turnPlans: TurnPlan[]) {
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
    workspaces,
  };
}

function waitForUpdate(service: WorkflowRunService, predicate: (update: WorkflowRunUpdate) => boolean) {
  return new Promise<WorkflowRunUpdate>((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error('Timed out waiting for workflow-run update.'));
    }, 2_000);

    const unsubscribe = service.subscribe((update) => {
      if (!predicate(update)) {
        return;
      }

      clearTimeout(timeout);
      unsubscribe();
      resolve(update);
    });
  });
}

async function waitForNoActiveTurn(service: WorkflowRunService, runId: string) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const detail = await service.readRunDetail(runId);
    if (detail && detail.sessions[0]?.session.active_turn_id === null) {
      return detail;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error('Timed out waiting for planner turn to become idle.');
}

async function moveRunToFirstPromptApproval(harness: Awaited<ReturnType<typeof createHarness>>) {
  const created = await harness.service.createRun({
    workflow_id: 'plan-implement-review',
    repo_path: harness.repoPath,
    goal_prompt: 'Build the workflow runtime.',
  });

  const transitionUpdate = waitForUpdate(
    harness.service,
    (update) =>
      update.run_id === created.run.id &&
      update.event.type === 'state_transition' &&
      update.event.to_state_id === 'first_prompt_approval',
  );
  harness.codex.completeTurn('turn_1', {
    assistantText:
      '<first_prompt_candidate>Implement the runtime persistence and initial planner run path.</first_prompt_candidate>',
  });
  await transitionUpdate;

  const detail = await waitForNoActiveTurn(harness.service, created.run.id);
  const gate = detail.open_gates[0];
  assert.ok(gate, 'expected the first approval gate to be open');

  return {
    created,
    detail,
    gate,
  };
}

test('run creation returns before planner turn completion', async () => {
  const harness = await createHarness([{ completion: 'manual' }]);

  try {
    const detail = await harness.service.createRun({
      workflow_id: 'plan-implement-review',
      repo_path: harness.repoPath,
      goal_prompt: 'Build the workflow runtime.',
    });

    assert.equal(detail.run.current_state_id, 'planning_conversation');
    assert.equal(detail.sessions.length, 1);
    assert.equal(detail.sessions[0]?.session.thread_id, 'thr_1');
    assert.equal(detail.sessions[0]?.session.active_turn_id, 'turn_1');
    assert.equal(detail.sessions[0]?.session.latest_turn_id, null);
    assert.deepEqual(
      detail.events.map((event) => event.type),
      ['run_created', 'agent_session_started', 'planner_turn_started'],
    );

    const completionUpdate = waitForUpdate(
      harness.service,
      (update) => update.run_id === detail.run.id && update.event.type === 'planner_turn_completed',
    );
    const markerMissingUpdate = waitForUpdate(
      harness.service,
      (update) => update.run_id === detail.run.id && update.event.type === 'planner_marker_not_found',
    );
    harness.codex.completeTurn('turn_1', {
      assistantText: 'Need a tighter scope before I propose the first prompt.',
    });
    await completionUpdate;
    await markerMissingUpdate;

    const completedDetail = await waitForNoActiveTurn(harness.service, detail.run.id);
    assert.equal(completedDetail.sessions[0]?.session.active_turn_id, null);
    assert.equal(completedDetail.sessions[0]?.session.latest_turn_id, 'turn_1');
  } finally {
    await fs.rm(harness.rootDir, { recursive: true, force: true });
  }
});

test('planning-message returns before planner turn completion', async () => {
  const harness = await createHarness([
    { completion: 'manual' },
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
      message: 'Focus the first step on server-side runtime persistence.',
    });

    assert.equal(detail.run.current_state_id, 'planning_conversation');
    assert.equal(detail.sessions[0]?.session.active_turn_id, 'turn_1');
    assert.deepEqual(harness.codex.calls, ['steerTurn:thr_1:turn_1', 'readThread:thr_1']);
    assert.equal(detail.events.at(-1)?.type, 'planner_turn_steered');
  } finally {
    await fs.rm(harness.rootDir, { recursive: true, force: true });
  }
});

test('planner completion later records events and updates the run', async () => {
  const harness = await createHarness([{ completion: 'manual' }]);

  try {
    const created = await harness.service.createRun({
      workflow_id: 'plan-implement-review',
      repo_path: harness.repoPath,
      goal_prompt: 'Build the workflow runtime.',
    });

    const markerMissingUpdate = waitForUpdate(
      harness.service,
      (update) => update.run_id === created.run.id && update.event.type === 'planner_marker_not_found',
    );
    harness.codex.completeTurn('turn_1', {
      assistantText: 'I still need one clarification before the first prompt is ready.',
    });
    await markerMissingUpdate;

    const detail = await waitForNoActiveTurn(harness.service, created.run.id);
    assert.deepEqual(
      detail.events.map((event) => event.type),
      [
        'run_created',
        'agent_session_started',
        'planner_turn_started',
        'planner_turn_completed',
        'planner_marker_not_found',
      ],
    );
    assert.equal(detail.run.current_state_id, 'planning_conversation');
  } finally {
    await fs.rm(harness.rootDir, { recursive: true, force: true });
  }
});

test('planner output without marker stays in planning_conversation', async () => {
  const harness = await createHarness([{ completion: 'manual' }]);

  try {
    const created = await harness.service.createRun({
      workflow_id: 'plan-implement-review',
      repo_path: harness.repoPath,
      goal_prompt: 'Build the workflow runtime.',
    });

    const markerMissingUpdate = waitForUpdate(
      harness.service,
      (update) => update.run_id === created.run.id && update.event.type === 'planner_marker_not_found',
    );
    harness.codex.completeTurn('turn_1', {
      assistantText: 'I need one more clarification before proposing a prompt.',
    });
    await markerMissingUpdate;

    const detail = await waitForNoActiveTurn(harness.service, created.run.id);
    assert.equal(detail.run.current_state_id, 'planning_conversation');
    assert.equal(detail.run.last_transition_id, null);
    assert.deepEqual(detail.open_gates, []);
  } finally {
    await fs.rm(harness.rootDir, { recursive: true, force: true });
  }
});

test('planner output with a first_prompt_candidate transitions asynchronously to first_prompt_approval', async () => {
  const harness = await createHarness([{ completion: 'manual' }]);

  try {
    const created = await harness.service.createRun({
      workflow_id: 'plan-implement-review',
      repo_path: harness.repoPath,
      goal_prompt: 'Build the workflow runtime.',
    });

    const transitionUpdate = waitForUpdate(
      harness.service,
      (update) => update.run_id === created.run.id && update.event.type === 'state_transition',
    );
    harness.codex.completeTurn('turn_1', {
      assistantText:
        'The plan is ready.\n<first_prompt_candidate>Implement asynchronous workflow-run SSE updates.</first_prompt_candidate>',
    });
    await transitionUpdate;

    const detail = await waitForNoActiveTurn(harness.service, created.run.id);
    assert.equal(detail.run.current_state_id, 'first_prompt_approval');
    assert.equal(detail.run.current_state_family, 'approval');
    assert.equal(detail.run.last_transition_id, 'planning_prompt_ready');
    assert.equal(detail.open_gates.length, 1);
    assert.equal(detail.open_gates[0]?.definition_gate_id, 'first_prompt_gate');
  } finally {
    await fs.rm(harness.rootDir, { recursive: true, force: true });
  }
});

test('initial approval gate opens correctly after an asynchronous planning transition', async () => {
  const harness = await createHarness([{ completion: 'manual' }]);

  try {
    const created = await harness.service.createRun({
      workflow_id: 'plan-implement-review',
      repo_path: harness.repoPath,
      goal_prompt: 'Build the workflow runtime.',
    });

    const gateUpdate = waitForUpdate(
      harness.service,
      (update) => update.run_id === created.run.id && update.event.type === 'gate_opened',
    );
    harness.codex.completeTurn('turn_1', {
      assistantText:
        '<first_prompt_candidate>Implement asynchronous workflow-run SSE updates.</first_prompt_candidate>',
    });
    await gateUpdate;

    const detail = await waitForNoActiveTurn(harness.service, created.run.id);
    assert.equal(detail.open_gates.length, 1);
    assert.equal(detail.open_gates[0]?.definition_gate_id, 'first_prompt_gate');
    assert.equal(
      detail.open_gates[0]?.metadata.prompt_candidate,
      'Implement asynchronous workflow-run SSE updates.',
    );
  } finally {
    await fs.rm(harness.rootDir, { recursive: true, force: true });
  }
});

test('revising the first prompt returns to planning and sends real planner feedback', async () => {
  const harness = await createHarness([{ completion: 'manual' }, { completion: 'manual' }]);

  try {
    const { created, gate } = await moveRunToFirstPromptApproval(harness);

    harness.codex.calls = [];
    const detail = await harness.service.answerGate({
      runId: created.run.id,
      gateId: gate.id,
      optionId: 'revise',
      message: 'Tighten the first step to persistence and SSE only.',
    });

    assert.equal(detail.run.current_state_id, 'planning_conversation');
    assert.equal(detail.run.current_state_family, 'conversation');
    assert.deepEqual(detail.open_gates, []);

    const plannerSession = detail.sessions.find((session) => session.session.kind === 'planning_conversation');
    assert.equal(plannerSession?.session.thread_id, 'thr_1');
    assert.equal(plannerSession?.session.active_turn_id, 'turn_2');
    assert.deepEqual(harness.codex.calls, [
      'resumeThread:thr_1',
      'startTurn:thr_1:turn_2',
      'waitForTurnCompletion:thr_1:turn_2',
      'readThread:thr_1',
    ]);

    const revisionTurn = plannerSession?.thread?.turns.find((turn) => turn.id === 'turn_2');
    const userMessage = revisionTurn?.items.find((item) => item.type === 'userMessage');
    assert.deepEqual(userMessage, {
      type: 'userMessage',
      id: 'turn_2-user',
      content: [{ type: 'text', text: 'Tighten the first step to persistence and SSE only.' }],
    });
    assert.equal(detail.events.some((event) => event.type === 'gate_answered'), true);
    assert.equal(detail.events.some((event) => event.type === 'planner_turn_started'), true);
  } finally {
    await fs.rm(harness.rootDir, { recursive: true, force: true });
  }
});

test('approving the first prompt transitions to implementing', async () => {
  const harness = await createHarness([{ completion: 'manual' }, { completion: 'manual' }]);

  try {
    const { created, gate } = await moveRunToFirstPromptApproval(harness);

    const detail = await harness.service.answerGate({
      runId: created.run.id,
      gateId: gate.id,
      optionId: 'approve',
    });

    assert.equal(detail.run.current_state_id, 'implementing');
    assert.equal(detail.run.current_state_family, 'background');
    assert.equal(detail.open_gates.length, 0);
    assert.equal(detail.run.last_transition_id, 'first_prompt_approve');
    assert.equal(detail.events.some((event) => event.type === 'implementer_turn_started'), true);
  } finally {
    await fs.rm(harness.rootDir, { recursive: true, force: true });
  }
});

test('implementer workspace, session, and turn are created on approval', async () => {
  const harness = await createHarness([{ completion: 'manual' }, { completion: 'manual' }]);

  try {
    const { created, gate } = await moveRunToFirstPromptApproval(harness);

    harness.codex.calls = [];
    const detail = await harness.service.answerGate({
      runId: created.run.id,
      gateId: gate.id,
      optionId: 'approve',
    });

    assert.equal(harness.workspaces.createdWorkspaces.length, 1);
    const implementerWorkspace = harness.workspaces.createdWorkspaces[0];
    assert.ok(implementerWorkspace);
    assert.equal(implementerWorkspace?.metadata.run_id, created.run.id);

    const implementerSession = detail.sessions.find((session) => session.session.kind === 'implementing');
    assert.equal(implementerSession?.session.workspace_id, implementerWorkspace?.id ?? null);
    assert.equal(implementerSession?.session.thread_id, 'thr_2');
    assert.equal(implementerSession?.session.active_turn_id, 'turn_2');
    assert.equal(
      implementerSession?.session.metadata.prompt_candidate,
      'Implement the runtime persistence and initial planner run path.',
    );
    assert.deepEqual(
      harness.codex.calls,
      [
        'startThread:thr_2',
        'startTurn:thr_2:turn_2',
        'waitForTurnCompletion:thr_2:turn_2',
        'readThread:thr_1',
        'readThread:thr_2',
      ],
    );
  } finally {
    await fs.rm(harness.rootDir, { recursive: true, force: true });
  }
});

test('run detail reflects implementing state, sessions, gates, and events honestly after approval', async () => {
  const harness = await createHarness([{ completion: 'manual' }, { completion: 'manual' }]);

  try {
    const { created, gate } = await moveRunToFirstPromptApproval(harness);

    await harness.service.answerGate({
      runId: created.run.id,
      gateId: gate.id,
      optionId: 'approve',
    });

    const detail = await harness.service.readRunDetail(created.run.id);
    assert.ok(detail);
    assert.equal(detail?.run.current_state_id, 'implementing');
    assert.equal(detail?.open_gates.length, 0);
    assert.deepEqual(
      detail?.sessions.map((session) => session.session.kind),
      ['planning_conversation', 'implementing'],
    );
    assert.equal(detail?.sessions[0]?.session.active_turn_id, null);
    assert.equal(detail?.sessions[0]?.session.latest_turn_id, 'turn_1');
    assert.equal(detail?.sessions[1]?.session.active_turn_id, 'turn_2');
    assert.equal(detail?.events.some((event) => event.type === 'gate_answered'), true);
    assert.equal(detail?.events.some((event) => event.type === 'implementer_workspace_created'), true);
    assert.equal(detail?.events.some((event) => event.type === 'implementer_session_started'), true);
    assert.equal(detail?.events.some((event) => event.type === 'implementer_turn_started'), true);
  } finally {
    await fs.rm(harness.rootDir, { recursive: true, force: true });
  }
});

test('planner turn failure is recorded honestly', async () => {
  const harness = await createHarness([{ completion: 'manual' }]);

  try {
    const created = await harness.service.createRun({
      workflow_id: 'plan-implement-review',
      repo_path: harness.repoPath,
      goal_prompt: 'Build the workflow runtime.',
    });

    const failureUpdate = waitForUpdate(
      harness.service,
      (update) => update.run_id === created.run.id && update.event.type === 'planner_turn_failed',
    );
    harness.codex.completeTurn('turn_1', {
      status: 'failed',
    });
    await failureUpdate;

    const detail = await waitForUpdate(
      harness.service,
      (update) =>
        update.run_id === created.run.id &&
        update.event.type === 'state_transition' &&
        update.event.to_state_id === 'failed',
    ).then(async () => await harness.service.readRunDetail(created.run.id));

    assert.equal(detail?.run.status, 'failed');
    assert.equal(detail?.run.current_state_id, 'failed');
    assert.equal(detail?.sessions[0]?.session.status, 'failed');
    assert.equal(detail?.sessions[0]?.session.active_turn_id, null);
    assert.equal(detail?.events.some((event) => event.type === 'planner_runtime_failed'), true);
  } finally {
    await fs.rm(harness.rootDir, { recursive: true, force: true });
  }
});

test('planner startup failure is recorded honestly during run creation', async () => {
  const harness = await createHarness([]);
  harness.codex.failNextStartTurn(new Error('Codex failed to start the planning turn.'));

  try {
    const detail = await harness.service.createRun({
      workflow_id: 'plan-implement-review',
      repo_path: harness.repoPath,
      goal_prompt: 'Build the workflow runtime.',
    });

    assert.equal(detail.run.status, 'failed');
    assert.equal(detail.run.current_state_id, 'failed');
    assert.equal(detail.sessions[0]?.session.status, 'failed');
    assert.deepEqual(
      detail.events.map((event) => event.type),
      [
        'run_created',
        'agent_session_started',
        'planner_turn_failed',
        'state_transition',
      ],
    );
  } finally {
    await fs.rm(harness.rootDir, { recursive: true, force: true });
  }
});
