import assert from 'node:assert/strict';
import test from 'node:test';

import { SwarmDefinitionService } from './swarmDefinitionService.ts';
import { planImplementReviewSwarm } from './swarms/planImplementReview.ts';
import {
  defineSwarm,
  getSwarmGateRule,
  resolveSwarmGateRuleRoute,
  validateSwarmDefinition,
} from './swarms/runtime.ts';

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
  assert.equal(detail?.agents[0]?.role_prompt.includes('planner/reviewer hub'), true);
  assert.equal(detail?.agents[0]?.target_gate_rule_ids[0], 'prompt_candidate_approval');
  assert.equal(detail?.allowed_routes[0]?.id, 'planner_to_implementer');
  assert.equal(detail?.gate_rules[0]?.artifact_kind_id, 'prompt_candidate');
  assert.equal(detail?.gate_rules[0]?.unlocks_route_id, 'planner_to_implementer');
  assert.equal(detail?.mermaid.includes('Planner'), true);
  assert.equal(detail?.mermaid.includes('approve via Planner delegates implementation'), true);
});

test('swarm validation catches unknown route agents and bad gate-route mappings', () => {
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
        role_prompt: '',
        operating_guidelines: [],
        target_artifact_kind_ids: [],
        target_gate_rule_ids: [],
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
    gate_rules: [
      {
        id: 'broken_gate_rule',
        title: 'Broken Gate Rule',
        summary: 'Points to a missing route.',
        owner_agent_id: 'planner',
        workflow_gate_ids: ['first_prompt_gate'],
        artifact_kind_id: 'prompt_candidate',
        unlocks_route_id: 'missing_route',
      },
    ],
    artifact_kinds: [
      {
        id: 'prompt_candidate',
        title: 'Prompt Candidate',
        summary: 'Artifact for approval.',
      },
    ],
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
  assert.equal(
    validation.issues.some(
      (issue) =>
        issue.code === 'unknown_gate_rule_route' &&
        issue.gate_rule_id === 'broken_gate_rule' &&
        issue.route_id === 'missing_route',
    ),
    true,
  );
  assert.equal(
    validation.issues.some(
      (issue) => issue.code === 'missing_agent_role_prompt' && issue.agent_id === 'planner',
    ),
    true,
  );
});

test('gate rules resolve explicitly to their unlocked route and target agent', () => {
  const gateRule = getSwarmGateRule(planImplementReviewSwarm, 'prompt_candidate_approval');
  assert.ok(gateRule);

  const resolved = resolveSwarmGateRuleRoute(planImplementReviewSwarm, gateRule);
  assert.equal(resolved.route?.id, 'planner_to_implementer');
  assert.equal(resolved.route?.title, 'Planner delegates implementation');
  assert.equal(resolved.target_agent_id, 'implementer');
});
