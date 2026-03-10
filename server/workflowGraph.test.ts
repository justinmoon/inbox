import assert from 'node:assert/strict';
import test from 'node:test';

import { planImplementReviewWorkflow } from './workflows/planImplementReview.ts';
import { buildWorkflowTransitionGraph } from './workflows/runtime.ts';

test('plan-implement-review graph has the expected adjacency and terminal states', () => {
  const graph = buildWorkflowTransitionGraph(planImplementReviewWorkflow);

  assert.equal(graph.initial_state_id, 'planning_conversation');
  assert.deepEqual(graph.adjacency.planning_conversation, [
    'planning_continue',
    'planning_prompt_ready',
    'planning_abort',
  ]);
  assert.deepEqual(graph.adjacency.auto_review, [
    'review_accepted_transition',
    'review_fixup_transition',
    'review_replan_transition',
    'review_abort',
  ]);
  assert.deepEqual(graph.adjacency.step_approval, [
    'step_approve_next',
    'step_redirect',
    'step_finish',
    'step_abort',
  ]);
  assert.deepEqual(graph.terminal_state_ids, ['completed', 'failed']);
  assert.deepEqual(graph.inbound.completed, ['step_finish']);
  assert.deepEqual(graph.inbound.failed, [
    'planning_abort',
    'first_prompt_abort',
    'implementing_failed',
    'review_abort',
    'fixup_failed',
    'artifacts_failed',
    'step_abort',
  ]);
});
