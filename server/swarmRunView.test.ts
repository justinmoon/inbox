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
  assert.equal(swarm?.agents.find((agent) => agent.agent_id === 'planner')?.status, 'waiting_on_user');
  assert.equal(swarm?.agents.find((agent) => agent.agent_id === 'implementer')?.status, 'idle');
  assert.deepEqual(
    swarm?.timeline.map((entry) => entry.title),
    ['Agent session started', 'Marker detected', 'Gate opened'],
  );
  assert.equal(swarm?.graph_mermaid.includes('Approve the first prompt'), true);
});
