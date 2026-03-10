import assert from 'node:assert/strict';
import test from 'node:test';

import { SwarmDefinitionService } from './swarmDefinitionService.ts';
import { planImplementReviewSwarm } from './swarms/planImplementReview.ts';
import { defineSwarm, validateSwarmDefinition } from './swarms/runtime.ts';

test('plan-implement-review swarm validates cleanly and exposes machine-readable detail', () => {
  const service = new SwarmDefinitionService([planImplementReviewSwarm]);
  const summary = service.listDefinitions();
  const detail = service.readDefinition('plan-implement-review');

  assert.equal(summary.length, 1);
  assert.equal(summary[0]?.id, 'plan-implement-review');
  assert.equal(summary[0]?.agent_count, 2);
  assert.equal(summary[0]?.route_count, 1);
  assert.equal(summary[0]?.gate_rule_count, 1);
  assert.equal(summary[0]?.validation.valid, true);

  assert.ok(detail);
  assert.equal(detail?.agents[0]?.id, 'planner');
  assert.equal(detail?.allowed_routes[0]?.id, 'planner_to_implementer');
  assert.equal(detail?.gate_rules[0]?.artifact_kind_id, 'prompt_candidate');
  assert.equal(detail?.mermaid.includes('Planner'), true);
});

test('swarm validation catches unknown route agents', () => {
  const invalidSwarm = defineSwarm({
    id: 'invalid-swarm',
    title: 'Invalid Swarm',
    summary: 'Used to validate route errors.',
    agents: [
      {
        id: 'planner',
        title: 'Planner',
        summary: 'Hub agent.',
        kind: 'hub',
        owned_state_ids: ['planning_conversation'],
        session_kinds: ['planning_conversation'],
      },
    ],
    allowed_routes: [
      {
        id: 'planner_to_missing',
        from_agent_id: 'planner',
        to_agent_id: 'missing',
        title: 'Broken route',
        summary: 'Points to an unknown agent.',
      },
    ],
    gate_rules: [],
    artifact_kinds: [],
  });

  const validation = validateSwarmDefinition(invalidSwarm);

  assert.equal(validation.valid, false);
  assert.equal(
    validation.issues.some(
      (issue) =>
        issue.code === 'unknown_route_target_agent' &&
        issue.route_id === 'planner_to_missing' &&
        issue.agent_id === 'missing',
    ),
    true,
  );
});
