import { defineSwarm } from './runtime.ts';

export const planImplementReviewSwarm = defineSwarm({
  id: 'plan-implement-review',
  title: 'Planner / Implementer Hub',
  summary:
    'A hub-and-spoke swarm where the planner owns user conversation, prompt proposal, and review, while the implementer executes approved prompts.',
  agents: [
    {
      id: 'planner',
      title: 'Planner',
      summary: 'Hub agent that talks to the user, proposes prompts, opens gates, and later reviews work.',
      kind: 'hub',
      owned_state_ids: ['planning_conversation', 'first_prompt_approval', 'auto_review', 'step_approval'],
      session_kinds: ['planning_conversation'],
      role_prompt:
        'You are the planner/reviewer hub for a workflow runtime with explicit user gates.',
      operating_guidelines: [
        'Drive the conversation toward a tightly scoped implementer step before opening a gate.',
        'Do not emit workflow markers until the current prompt candidate is ready for approval.',
        'When the prompt candidate is ready, present exactly one explicit artifact for the user gate.',
      ],
      review_role_prompt:
        'You are the planner/reviewer hub evaluating implementer output for a hub-and-spoke swarm run.',
      review_guidelines: [
        'Base the review on the approved prompt candidate, the implementer output, and the observed result.',
        'If the implementer faithfully completed the approved prompt without a material problem, emit the accepted marker.',
        'Emit fixup_required only when you can provide an implementer-ready fixup prompt.',
        'Emit replan_required only when renewed user planning is necessary before more worker execution.',
      ],
      expected_marker_ids: [
        'first_prompt_candidate',
        'review_accepted',
        'review_fixup_required',
        'review_replan_required',
      ],
      target_artifact_kind_ids: ['prompt_candidate'],
      target_gate_rule_ids: ['prompt_candidate_approval'],
    },
    {
      id: 'implementer',
      title: 'Implementer',
      summary: 'Worker agent that executes approved prompts inside a workspace.',
      kind: 'worker',
      owned_state_ids: ['implementing', 'fixup_implementing'],
      session_kinds: ['implementing'],
      role_prompt:
        'You are the implementer worker for a hub-and-spoke swarm run. Execute the approved task directly in the workspace.',
      operating_guidelines: [
        'Treat the approved prompt candidate as the concrete task to execute.',
        'Make code changes in the workspace, verify the slice honestly, and leave a readable session trail.',
        'Do not re-plan the task unless the approved prompt is impossible to execute as written.',
      ],
      review_role_prompt: null,
      review_guidelines: [],
      expected_marker_ids: [],
      target_artifact_kind_ids: [],
      target_gate_rule_ids: [],
    },
  ],
  allowed_routes: [
    {
      id: 'planner_to_implementer',
      from_agent_id: 'planner',
      to_agent_id: 'implementer',
      title: 'Planner delegates implementation',
      summary: 'The planner can send an approved prompt candidate to the implementer.',
    },
  ],
  gate_rules: [
    {
      id: 'prompt_candidate_approval',
      title: 'Prompt Candidate Approval',
      summary: 'Open a user gate when the planner emits the first prompt candidate.',
      owner_agent_id: 'planner',
      workflow_gate_ids: ['first_prompt_gate'],
      artifact_kind_id: 'prompt_candidate',
      unlocks_route_id: 'planner_to_implementer',
    },
  ],
  artifact_kinds: [
    {
      id: 'prompt_candidate',
      title: 'Prompt Candidate',
      summary: 'The implementer-ready prompt proposed by the planner and shown at the approval gate.',
    },
  ],
});
