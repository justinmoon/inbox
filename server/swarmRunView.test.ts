import assert from 'node:assert/strict';
import test from 'node:test';

import type { WorkflowRunSessionDetail } from '../shared/api.ts';
import type { GateRecord, RunEventRecord, WorkflowRunRecord } from '../shared/workflowRuntime.ts';
import { buildWorkflowRunSwarmView, deriveSwarmRunTopLevelState } from './swarmRunView.ts';

function createRun(overrides: Partial<WorkflowRunRecord> = {}): WorkflowRunRecord {
  return {
    id: 'run_1',
    workflow_id: 'plan-implement-review',
    workflow_version: '0.1.0',
    status: 'active',
    current_state_id: 'planning_conversation',
    current_state_family: 'conversation',
    repo: {
      repo_id: 'repo_1',
      repo_path: '/tmp/repo',
    },
    goal_prompt: 'Build the swarm overlay.',
    open_gate_ids: [],
    last_transition_id: null,
    created_at: '2026-03-10T00:00:00.000Z',
    updated_at: '2026-03-10T00:00:00.000Z',
    completed_at: null,
    tags: [],
    metadata: {},
    ...overrides,
  };
}

function createGate(overrides: Partial<GateRecord> = {}): GateRecord {
  return {
    id: 'gate_1',
    run_id: 'run_1',
    workflow_id: 'plan-implement-review',
    definition_gate_id: 'first_prompt_gate',
    state_id: 'first_prompt_approval',
    kind: 'approval',
    actor: 'user',
    title: 'Approve the first prompt',
    description: 'Review the planner prompt candidate.',
    status: 'open',
    blocking: true,
    options: [],
    opened_at: '2026-03-10T00:01:00.000Z',
    answered_at: null,
    closed_at: null,
    tags: [],
    metadata: {
      prompt_candidate: 'Implement the swarm summary view.',
    },
    ...overrides,
  };
}

function createPlannerSession(overrides: Partial<WorkflowRunSessionDetail> = {}): WorkflowRunSessionDetail {
  return {
    session: {
      id: 'session_planner',
      run_id: 'run_1',
      workflow_id: 'plan-implement-review',
      backend: 'codex',
      kind: 'planning_conversation',
      actor: 'planner',
      state_id: 'planning_conversation',
      thread_id: 'thr_1',
      workspace_id: 'workspace_1',
      cwd: '/tmp/repo',
      active_turn_id: null,
      active_turn_started_at: null,
      latest_turn_id: 'turn_1',
      latest_turn_completed_at: '2026-03-10T00:01:00.000Z',
      last_turn_status: 'completed',
      status: 'active',
      created_at: '2026-03-10T00:00:00.000Z',
      updated_at: '2026-03-10T00:01:00.000Z',
      tags: [],
      metadata: {},
    },
    thread: null,
    load_error: null,
    ...overrides,
  };
}

function createWorkerSession(args: {
  id: string;
  kind: string;
  actor: string;
  state_id?: string;
  thread_id: string;
}): WorkflowRunSessionDetail {
  return {
    session: {
      id: args.id,
      run_id: 'run_1',
      workflow_id: 'plan-implement-review',
      backend: 'codex',
      kind: args.kind,
      actor: args.actor,
      state_id: args.state_id ?? 'artifact_forking',
      thread_id: args.thread_id,
      workspace_id: 'workspace_1',
      cwd: '/tmp/repo',
      active_turn_id: null,
      active_turn_started_at: null,
      latest_turn_id: 'turn_worker',
      latest_turn_completed_at: '2026-03-10T00:03:00.000Z',
      last_turn_status: 'completed',
      status: 'completed',
      created_at: '2026-03-10T00:02:00.000Z',
      updated_at: '2026-03-10T00:03:00.000Z',
      tags: [],
      metadata: {},
    },
    thread: null,
    load_error: null,
  };
}

function createEvent(type: string, summary: string, overrides: Partial<RunEventRecord> = {}): RunEventRecord {
  return {
    id: `event_${type}`,
    run_id: 'run_1',
    workflow_id: 'plan-implement-review',
    type,
    summary,
    state_id: 'planning_conversation',
    from_state_id: null,
    to_state_id: null,
    transition_id: null,
    session_id: null,
    thread_id: null,
    turn_id: null,
    created_at: '2026-03-10T00:00:00.000Z',
    tags: [],
    metadata: {},
    ...overrides,
  };
}

test('top-level swarm status is derived from current runtime truth', () => {
  assert.equal(
    deriveSwarmRunTopLevelState({
      run: createRun(),
      open_gates: [],
    }),
    'working',
  );

  assert.equal(
    deriveSwarmRunTopLevelState({
      run: createRun({
        current_state_id: 'first_prompt_approval',
        current_state_family: 'approval',
        open_gate_ids: ['gate_1'],
      }),
      open_gates: [createGate()],
    }),
    'needs_user_input',
  );

  assert.equal(
    deriveSwarmRunTopLevelState({
      run: createRun({
        status: 'failed',
        current_state_id: 'failed',
        current_state_family: 'terminal',
      }),
      open_gates: [],
    }),
    'failed',
  );

  assert.equal(
    deriveSwarmRunTopLevelState({
      run: createRun({
        status: 'completed',
        current_state_id: 'completed',
        current_state_family: 'terminal',
      }),
      open_gates: [],
    }),
    'completed',
  );
});

test('swarm view derives current gate, agent status, and timeline from runtime records', () => {
  const swarm = buildWorkflowRunSwarmView({
    run: createRun({
      current_state_id: 'first_prompt_approval',
      current_state_family: 'approval',
      open_gate_ids: ['gate_1'],
    }),
    sessions: [createPlannerSession()],
    open_gates: [createGate()],
    events: [
      createEvent('agent_session_started', 'Planner session started.', {
        session_id: 'session_planner',
      }),
      createEvent('planner_marker_detected', 'Planner emitted a prompt candidate.', {
        session_id: 'session_planner',
        turn_id: 'turn_1',
        created_at: '2026-03-10T00:01:00.000Z',
      }),
      createEvent('gate_opened', 'Gate opened for user approval.', {
        created_at: '2026-03-10T00:02:00.000Z',
        metadata: {
          definition_gate_id: 'first_prompt_gate',
        },
      }),
    ],
  });

  assert.ok(swarm);
  assert.equal(swarm?.definition.id, 'plan-implement-review');
  assert.equal(swarm?.top_level_state, 'needs_user_input');
  assert.equal(swarm?.current_gate?.artifact?.content, 'Implement the swarm summary view.');
  assert.equal(swarm?.current_gate?.unlocks_route_id, 'planner_to_implementer');
  assert.equal(swarm?.current_gate?.unlocks_target_agent_id, 'implementer');
  assert.equal(swarm?.agents.find((agent) => agent.agent_id === 'planner')?.status, 'waiting_on_user');
  assert.equal(swarm?.agents.find((agent) => agent.agent_id === 'implementer')?.status, 'idle');
  assert.deepEqual(
    swarm?.timeline.map((entry) => entry.title),
    ['Agent session started', 'Marker detected', 'Gate opened'],
  );
  assert.equal(swarm?.graph_mermaid.includes('approve via Planner delegates implementation'), true);
});

test('swarm view derives artifact-worker timeline and step gate routing from runtime records', () => {
  const swarm = buildWorkflowRunSwarmView({
    run: createRun({
      current_state_id: 'step_approval',
      current_state_family: 'approval',
      open_gate_ids: ['gate_2'],
    }),
    sessions: [
      createPlannerSession({
        session: {
          ...createPlannerSession().session,
          state_id: 'step_approval',
        },
      }),
      createWorkerSession({
        id: 'session_tutorial',
        kind: 'tutorial_writing',
        actor: 'tutorial_writer',
        thread_id: 'thr_2',
      }),
      createWorkerSession({
        id: 'session_next_prompt',
        kind: 'next_prompt_writing',
        actor: 'next_prompt_writer',
        thread_id: 'thr_3',
      }),
    ],
    open_gates: [
      createGate({
        id: 'gate_2',
        definition_gate_id: 'step_approval_gate',
        state_id: 'step_approval',
        title: 'Approve Next Step',
        description: 'Review the tutorial and next prompt.',
        metadata: {
          prompt_candidate: 'Implement the next bounded repo step.',
          tutorial_artifact_content: 'Explain the completed change.',
          next_prompt_artifact_content: 'Implement the next bounded repo step.',
        },
      }),
    ],
    events: [
      createEvent('review_result_detected', 'Review accepted the step.', {
        created_at: '2026-03-10T00:02:00.000Z',
        session_id: 'session_planner',
      }),
      createEvent('tutorial_worker_session_started', 'Tutorial worker session started.', {
        created_at: '2026-03-10T00:03:00.000Z',
        session_id: 'session_tutorial',
      }),
      createEvent('tutorial_artifact_persisted', 'Tutorial artifact persisted.', {
        created_at: '2026-03-10T00:04:00.000Z',
        session_id: 'session_tutorial',
      }),
      createEvent('next_prompt_worker_session_started', 'Next prompt worker session started.', {
        created_at: '2026-03-10T00:05:00.000Z',
        session_id: 'session_next_prompt',
      }),
      createEvent('next_prompt_artifact_persisted', 'Next prompt artifact persisted.', {
        created_at: '2026-03-10T00:06:00.000Z',
        session_id: 'session_next_prompt',
      }),
      createEvent('gate_opened', 'Step approval gate opened.', {
        created_at: '2026-03-10T00:07:00.000Z',
        metadata: {
          definition_gate_id: 'step_approval_gate',
        },
      }),
    ],
  });

  assert.ok(swarm);
  assert.equal(swarm?.current_gate?.rule_id, 'step_packet_approval');
  assert.equal(swarm?.current_gate?.unlocks_route_id, 'planner_to_implementer');
  assert.equal(swarm?.current_gate?.artifact?.title, 'Next Prompt Artifact');
  assert.deepEqual(
    swarm?.timeline.map((entry) => entry.title),
    [
      'Review result detected',
      'Tutorial worker session started',
      'Tutorial artifact persisted',
      'Next prompt worker session started',
      'Next prompt artifact persisted',
      'Gate opened',
    ],
  );
  assert.equal(swarm?.timeline[2]?.emphasis, 'marker');
  assert.equal(swarm?.timeline[4]?.emphasis, 'marker');
  assert.equal(swarm?.graph_mermaid.includes('approve via Planner delegates implementation'), true);
});
