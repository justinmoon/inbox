import assert from 'node:assert/strict';
import test from 'node:test';

import { WorkflowDefinitionService } from './workflowDefinitionService.ts';
import { planImplementReviewWorkflow } from './workflows/planImplementReview.ts';
import { defineWorkflow, validateWorkflowDefinition } from './workflows/runtime.ts';

test('plan-implement-review validates cleanly and exposes machine-readable detail', () => {
  const service = new WorkflowDefinitionService([planImplementReviewWorkflow]);
  const summary = service.listDefinitions();
  const detail = service.readDefinition('plan-implement-review');

  assert.equal(summary.length, 1);
  assert.equal(summary[0]?.id, 'plan-implement-review');
  assert.equal(summary[0]?.state_count, 9);
  assert.equal(summary[0]?.transition_count, 20);
  assert.equal(summary[0]?.validation.valid, true);

  assert.ok(detail);
  assert.equal(detail?.states[0]?.id, 'planning_conversation');
  assert.equal(detail?.transitions[0]?.id, 'planning_continue');
  assert.equal(detail?.markers.map((marker) => marker.id).includes('review_fixup_required'), true);
  assert.equal(detail?.parser_hooks.map((hook) => hook.id).includes('parse_review_verdict'), true);
});

test('workflow validation catches unknown state references', () => {
  const invalidWorkflow = defineWorkflow({
    id: 'invalid-workflow',
    title: 'Invalid Workflow',
    summary: 'Used to validate graph errors.',
    version: '0.0.0',
    initial_state_id: 'start',
    states: [
      {
        id: 'start',
        title: 'Start',
        description: 'Initial state.',
        family: 'conversation',
        terminal: false,
        entry_gate_ids: [],
        prompt_ids: [],
      },
      {
        id: 'done',
        title: 'Done',
        description: 'Terminal state.',
        family: 'terminal',
        terminal: true,
        entry_gate_ids: [],
        prompt_ids: [],
      },
    ],
    transitions: [
      {
        id: 'start_to_missing',
        from: 'start',
        event: 'go',
        to: 'missing',
        title: 'Broken transition',
        description: 'Points to an unknown state.',
      },
    ],
    gates: [],
    prompts: [],
    markers: [],
    parser_hooks: [],
  });

  const validation = validateWorkflowDefinition(invalidWorkflow);

  assert.equal(validation.valid, false);
  assert.equal(
    validation.issues.some(
      (issue) =>
        issue.code === 'unknown_transition_target' &&
        issue.transition_id === 'start_to_missing' &&
        issue.state_id === 'missing',
    ),
    true,
  );
});
