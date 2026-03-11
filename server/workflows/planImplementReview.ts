import { defineWorkflow, createBlockTagMarker, createSelfClosingTagMarker } from './runtime.ts';
import { planImplementReviewSwarm } from '../swarms/planImplementReview.ts';

function describeRepoRegistration(repoId: string | null) {
  if (repoId) {
    return `repo_id=${repoId}`;
  }
  return 'repo registration unavailable';
}

function workspacePathValue(
  runtimeContext: Record<string, string | null> | undefined,
  key: string,
) {
  return runtimeContext?.[key] ?? 'Unavailable.';
}

const firstPromptCandidateMarker = createBlockTagMarker({
  id: 'first_prompt_candidate',
  title: 'First Prompt Candidate',
  description: 'The planner emits the first implementer prompt as an explicit artifact.',
  tag: 'first_prompt_candidate',
  example: '<first_prompt_candidate>Implement the first scoped task here.</first_prompt_candidate>',
});

const reviewAcceptedMarker = createSelfClosingTagMarker({
  id: 'review_accepted',
  title: 'Review Accepted',
  description: 'The reviewer accepts the implementation with no fixup required.',
  tag: 'review_result',
  attributes: { status: 'accepted' },
  example: '<review_result status="accepted" />',
});

const reviewFixupRequiredMarker = createBlockTagMarker({
  id: 'review_fixup_required',
  title: 'Review Fixup Required',
  description: 'The reviewer rejects the step and emits an explicit fixup prompt.',
  tag: 'review_result',
  attributes: { status: 'fixup_required' },
  example:
    '<review_result status="fixup_required">Explain the fixup prompt for the implementer here.</review_result>',
});

const reviewReplanRequiredMarker = createBlockTagMarker({
  id: 'review_replan_required',
  title: 'Review Replan Required',
  description: 'The reviewer decides the overall plan needs to move back to planner discussion.',
  tag: 'review_result',
  attributes: { status: 'replan_required' },
  example:
    '<review_result status="replan_required">Explain what changed in the plan and what to discuss with the user.</review_result>',
});

const tutorialArtifactMarker = createBlockTagMarker({
  id: 'tutorial_artifact',
  title: 'Tutorial Artifact',
  description: 'The planner/reviewer turns an accepted step into a user-facing tutorial artifact.',
  tag: 'tutorial',
  example: '<tutorial>Explain the completed step and its impact here.</tutorial>',
});

const nextPromptArtifactMarker = createBlockTagMarker({
  id: 'next_prompt_artifact',
  title: 'Next Prompt Artifact',
  description: 'The planner/reviewer emits the next implementer prompt as an artifact for user approval.',
  tag: 'next_prompt',
  example: '<next_prompt>Describe the next implementer step here.</next_prompt>',
});

const markers = [
  firstPromptCandidateMarker,
  reviewAcceptedMarker,
  reviewFixupRequiredMarker,
  reviewReplanRequiredMarker,
  tutorialArtifactMarker,
  nextPromptArtifactMarker,
] as const;

function firstMarkerContent(text: string, markerId: string) {
  const marker = markers.find((entry) => entry.id === markerId);
  return marker?.parse(text)[0]?.content ?? null;
}

const plannerAgent = planImplementReviewSwarm.agents.find((agent) => agent.id === 'planner');
const tutorialWriterAgent = planImplementReviewSwarm.agents.find((agent) => agent.id === 'tutorial_writer');
const nextPromptWriterAgent = planImplementReviewSwarm.agents.find((agent) => agent.id === 'next_prompt_writer');
const promptCandidateGateRule = planImplementReviewSwarm.gate_rules.find(
  (gateRule) => gateRule.id === 'prompt_candidate_approval',
);
const promptCandidateArtifact = planImplementReviewSwarm.artifact_kinds.find(
  (artifactKind) => artifactKind.id === 'prompt_candidate',
);

if (
  !plannerAgent ||
  !tutorialWriterAgent ||
  !nextPromptWriterAgent ||
  !promptCandidateGateRule ||
  !promptCandidateArtifact
) {
  throw new Error('plan-implement-review swarm definition is missing required agents or gate metadata.');
}

function renderAgentPolicyLines(agent: { role_prompt: string; operating_guidelines: string[] }) {
  return [
    agent.role_prompt,
    '',
    'Operating guidelines:',
    ...agent.operating_guidelines.map((guideline) => `- ${guideline}`),
  ];
}

function renderReviewPolicyLines(agent: {
  role_prompt: string;
  review_role_prompt: string | null;
  review_guidelines: string[];
  expected_marker_ids: string[];
}) {
  return [
    agent.review_role_prompt ?? agent.role_prompt,
    '',
    'Review guidelines:',
    ...agent.review_guidelines.map((guideline) => `- ${guideline}`),
    '',
    `Expected review markers: ${agent.expected_marker_ids.filter((markerId) => markerId.startsWith('review_')).join(', ')}`,
  ];
}

function renderArtifactWorkerPolicyLines(agent: {
  role_prompt: string;
  operating_guidelines: string[];
  expected_marker_ids: string[];
}) {
  return [
    agent.role_prompt,
    '',
    'Operating guidelines:',
    ...agent.operating_guidelines.map((guideline) => `- ${guideline}`),
    '',
    `Expected artifact marker: ${agent.expected_marker_ids.join(', ')}`,
  ];
}

function runtimeContextValue(
  runtimeContext: Record<string, string | null> | undefined,
  key: string,
  fallback: string,
) {
  return runtimeContext?.[key] ?? fallback;
}

export const planImplementReviewWorkflow = defineWorkflow({
  id: 'plan-implement-review',
  title: 'Plan / Implement / Review',
  summary:
    'Planner/reviewer discusses the plan with the user, proposes explicit implementer prompts, reviews results, and loops with user gates.',
  version: '0.1.0',
  initial_state_id: 'planning_conversation',
  states: [
    {
      id: 'planning_conversation',
      title: 'Planning Conversation',
      description:
        'The user and planner/reviewer refine the plan until the first implementer prompt is ready.',
      family: 'conversation',
      terminal: false,
      entry_gate_ids: [],
      prompt_ids: ['planner_conversation'],
    },
    {
      id: 'first_prompt_approval',
      title: 'First Prompt Approval',
      description:
        'The first implementer prompt is frozen as an artifact and waits for explicit user approval.',
      family: 'approval',
      terminal: false,
      entry_gate_ids: ['first_prompt_gate'],
      prompt_ids: [],
    },
    {
      id: 'implementing',
      title: 'Implementing',
      description: 'The implementer executes the approved prompt in the target repository workspace.',
      family: 'background',
      terminal: false,
      entry_gate_ids: [],
      prompt_ids: [],
    },
    {
      id: 'auto_review',
      title: 'Auto Review',
      description:
        'The planner/reviewer inspects the implementer result and emits an explicit review verdict marker.',
      family: 'background',
      terminal: false,
      entry_gate_ids: [],
      prompt_ids: ['reviewer'],
    },
    {
      id: 'fixup_implementing',
      title: 'Fixup Implementing',
      description: 'The implementer executes an explicit fixup prompt emitted by the reviewer.',
      family: 'background',
      terminal: false,
      entry_gate_ids: [],
      prompt_ids: [],
    },
    {
      id: 'artifact_forking',
      title: 'Artifact Forking',
      description:
        'After an accepted review, the planner/reviewer produces tutorial and next-prompt artifacts.',
      family: 'background',
      terminal: false,
      entry_gate_ids: [],
      prompt_ids: ['tutorial', 'next_prompt'],
    },
    {
      id: 'step_approval',
      title: 'Step Approval',
      description: 'The user reviews the accepted step, tutorial, and next prompt before continuing.',
      family: 'approval',
      terminal: false,
      entry_gate_ids: ['step_approval_gate'],
      prompt_ids: [],
    },
    {
      id: 'completed',
      title: 'Completed',
      description: 'The workflow reached an explicit user-complete terminal state.',
      family: 'terminal',
      terminal: true,
      entry_gate_ids: [],
      prompt_ids: [],
    },
    {
      id: 'failed',
      title: 'Failed',
      description: 'The workflow ended because a user or system abort path was taken.',
      family: 'terminal',
      terminal: true,
      entry_gate_ids: [],
      prompt_ids: [],
    },
  ],
  transitions: [
    {
      id: 'planning_continue',
      from: 'planning_conversation',
      event: 'planner.continue_planning',
      to: 'planning_conversation',
      title: 'Planner keeps the discussion open',
      description: 'The plan is not ready for implementation yet.',
    },
    {
      id: 'planning_prompt_ready',
      from: 'planning_conversation',
      event: 'planner.prompt_ready',
      to: 'first_prompt_approval',
      title: 'Planner emits the first implementer prompt candidate',
      description: 'The planner is ready to hand the first step to the user for approval.',
    },
    {
      id: 'planning_abort',
      from: 'planning_conversation',
      event: 'planner.abort',
      to: 'failed',
      title: 'Planner or system aborts the run',
      description: 'A terminal failure path during planning.',
    },
    {
      id: 'first_prompt_revise',
      from: 'first_prompt_approval',
      event: 'user.revise',
      to: 'planning_conversation',
      title: 'User asks for plan or prompt revision',
      description: 'The workflow returns to planner discussion before implementation starts.',
    },
    {
      id: 'first_prompt_approve',
      from: 'first_prompt_approval',
      event: 'user.approve',
      to: 'implementing',
      title: 'User approves the first implementer prompt',
      description: 'The implementer can start the first step.',
    },
    {
      id: 'first_prompt_abort',
      from: 'first_prompt_approval',
      event: 'user.abort',
      to: 'failed',
      title: 'User aborts at the first approval gate',
      description: 'A terminal user-abort path.',
    },
    {
      id: 'implementing_completed',
      from: 'implementing',
      event: 'implementer.completed',
      to: 'auto_review',
      title: 'Implementer finishes the current step',
      description: 'Control returns to the planner/reviewer for evaluation.',
    },
    {
      id: 'implementing_failed',
      from: 'implementing',
      event: 'implementer.failed',
      to: 'failed',
      title: 'Implementer fails hard',
      description: 'A terminal failure path from implementation.',
    },
    {
      id: 'review_accepted_transition',
      from: 'auto_review',
      event: 'review.accepted',
      to: 'artifact_forking',
      title: 'Reviewer accepts the current step',
      description: 'Accepted work produces tutorial and next-prompt artifacts.',
    },
    {
      id: 'review_fixup_transition',
      from: 'auto_review',
      event: 'review.fixup_required',
      to: 'fixup_implementing',
      title: 'Reviewer emits a fixup prompt',
      description: 'The implementer gets another background step before user review.',
    },
    {
      id: 'review_replan_transition',
      from: 'auto_review',
      event: 'review.replan_required',
      to: 'planning_conversation',
      title: 'Reviewer sends the run back to planning',
      description: 'The overall plan changed enough to require renewed discussion with the user.',
    },
    {
      id: 'review_abort',
      from: 'auto_review',
      event: 'review.abort',
      to: 'failed',
      title: 'Reviewer or system aborts the run',
      description: 'A terminal failure path during review.',
    },
    {
      id: 'fixup_completed',
      from: 'fixup_implementing',
      event: 'implementer.completed',
      to: 'auto_review',
      title: 'Implementer finishes the fixup',
      description: 'Fixup work returns to review.',
    },
    {
      id: 'fixup_failed',
      from: 'fixup_implementing',
      event: 'implementer.failed',
      to: 'failed',
      title: 'Fixup execution fails hard',
      description: 'A terminal failure path during fixup execution.',
    },
    {
      id: 'artifacts_ready',
      from: 'artifact_forking',
      event: 'artifacts.ready',
      to: 'step_approval',
      title: 'Tutorial and next-prompt artifacts are ready',
      description: 'The workflow waits for explicit user approval of the next step.',
    },
    {
      id: 'artifacts_failed',
      from: 'artifact_forking',
      event: 'artifacts.failed',
      to: 'failed',
      title: 'Artifact generation fails',
      description: 'A terminal failure path while producing user-facing artifacts.',
    },
    {
      id: 'step_approve_next',
      from: 'step_approval',
      event: 'user.approve_next',
      to: 'implementing',
      title: 'User approves the next prompt',
      description: 'The workflow continues with the next implementation step.',
    },
    {
      id: 'step_redirect',
      from: 'step_approval',
      event: 'user.redirect',
      to: 'planning_conversation',
      title: 'User redirects the plan',
      description: 'The user wants renewed discussion before the next step executes.',
    },
    {
      id: 'step_finish',
      from: 'step_approval',
      event: 'user.finish',
      to: 'completed',
      title: 'User marks the workflow complete',
      description: 'A terminal success path.',
    },
    {
      id: 'step_abort',
      from: 'step_approval',
      event: 'user.abort',
      to: 'failed',
      title: 'User aborts at the step-approval gate',
      description: 'A terminal user-abort path.',
    },
  ],
  gates: [
    {
      id: 'first_prompt_gate',
      state_id: 'first_prompt_approval',
      kind: 'approval',
      actor: 'user',
      title: 'Approve First Prompt',
      description: 'The user must either approve, revise, or abort before the implementer starts.',
      blocking: true,
      options: [
        {
          id: 'approve',
          label: 'Approve first prompt',
          transition_id: 'first_prompt_approve',
          description: 'Move into implementation.',
        },
        {
          id: 'revise',
          label: 'Request revision',
          transition_id: 'first_prompt_revise',
          description: 'Return to planner discussion.',
        },
        {
          id: 'abort',
          label: 'Abort run',
          transition_id: 'first_prompt_abort',
          description: 'Stop the workflow.',
        },
      ],
    },
    {
      id: 'step_approval_gate',
      state_id: 'step_approval',
      kind: 'approval',
      actor: 'user',
      title: 'Approve Next Step',
      description: 'The user approves the next prompt, redirects the plan, finishes, or aborts.',
      blocking: true,
      options: [
        {
          id: 'approve_next',
          label: 'Approve next prompt',
          transition_id: 'step_approve_next',
          description: 'Continue the loop.',
        },
        {
          id: 'redirect',
          label: 'Redirect plan',
          transition_id: 'step_redirect',
          description: 'Return to planner discussion.',
        },
        {
          id: 'finish',
          label: 'Finish workflow',
          transition_id: 'step_finish',
          description: 'Mark the workflow complete.',
        },
        {
          id: 'abort',
          label: 'Abort run',
          transition_id: 'step_abort',
          description: 'Stop the workflow.',
        },
      ],
    },
  ],
  prompts: [
    {
      id: 'planner_conversation',
      actor_label: 'planner/reviewer',
      title: 'Planner Conversation Prompt',
      description:
        'Used during the planning conversation. The planner may stay in discussion or emit the first prompt candidate artifact.',
      used_in_state_ids: ['planning_conversation'],
      output_marker_ids: ['first_prompt_candidate'],
      parser_hook_ids: ['parse_first_prompt_candidate'],
      render({ run, runtime_context }) {
        return [
          ...renderAgentPolicyLines(plannerAgent),
          '',
          'Goal:',
          run.goal_prompt,
          '',
          'Repository registration:',
          describeRepoRegistration(run.repo.repo_id),
          '',
          'Authoritative planning workspace:',
          workspacePathValue(runtime_context, 'planning_workspace_path'),
          '',
          'Use repo-root relative paths or the authoritative workspace path above.',
          'Do not inspect or direct work at the original source repository checkout path.',
          '',
          `Current swarm target artifact: ${promptCandidateArtifact.title}.`,
          `Current user gate target: ${promptCandidateGateRule.title}.`,
          `Expected planning marker: ${plannerAgent.expected_marker_ids.find((markerId) => markerId === 'first_prompt_candidate') ?? 'first_prompt_candidate'}.`,
          '',
          'Stay in discussion with the user until the first implementer step is scoped tightly enough to execute.',
          'When the plan is not ready yet, keep the conversation focused and do not emit any workflow markers.',
          'When you emit the prompt candidate, use repo-root relative paths or the authoritative workspace path only.',
          'When the plan is ready, emit exactly one first prompt artifact using this marker protocol:',
          '<first_prompt_candidate>',
          '...first implementer prompt...',
          '</first_prompt_candidate>',
          '',
          'Do not emit tutorial or next-prompt artifacts from this prompt.',
        ].join('\n');
      },
    },
    {
      id: 'reviewer',
      actor_label: 'planner/reviewer',
      title: 'Auto Review Prompt',
      description:
        'Used after implementation. The reviewer must choose one explicit verdict marker and include a fixup/replan body when required.',
      used_in_state_ids: ['auto_review'],
      output_marker_ids: ['review_accepted', 'review_fixup_required', 'review_replan_required'],
      parser_hook_ids: ['parse_review_verdict'],
      render({ run, runtime_context }) {
        return [
          ...renderReviewPolicyLines(plannerAgent),
          '',
          'Goal:',
          run.goal_prompt,
          '',
          'Repository registration:',
          describeRepoRegistration(run.repo.repo_id),
          '',
          'Authoritative implementer workspace:',
          runtimeContextValue(runtime_context, 'implementer_workspace_path', 'Unavailable.'),
          '',
          'Approved prompt candidate:',
          runtimeContextValue(runtime_context, 'approved_prompt_candidate', 'Unavailable.'),
          '',
          'Implementer thread:',
          runtimeContextValue(runtime_context, 'implementer_thread_id', 'Unavailable.'),
          '',
          'Implementer output:',
          runtimeContextValue(runtime_context, 'implementer_output', 'Implementer output unavailable.'),
          '',
          'Pick exactly one of these deterministic verdict markers:',
          '<review_result status="accepted" />',
          '<review_result status="fixup_required">...implementer fixup prompt...</review_result>',
          '<review_result status="replan_required">...what must be re-planned with the user...</review_result>',
          '',
          'If you inspect files, use the authoritative implementer workspace or repo-root relative paths within it.',
          'Do not inspect or reason from the original source repository checkout path.',
          '',
          'Do not describe the verdict in free prose without the explicit marker.',
        ].join('\n');
      },
    },
    {
      id: 'tutorial',
      actor_label: 'tutorial_writer',
      title: 'Tutorial Artifact Prompt',
      description: 'Used after an accepted review to turn the finished step into a user-facing tutorial artifact.',
      used_in_state_ids: ['artifact_forking'],
      output_marker_ids: ['tutorial_artifact'],
      parser_hook_ids: ['parse_tutorial_artifact'],
      render({ run, runtime_context }) {
        return [
          ...renderArtifactWorkerPolicyLines(tutorialWriterAgent),
          '',
          'Produce the user-facing tutorial artifact for the accepted implementation step.',
          '',
          'Goal:',
          run.goal_prompt,
          '',
          'Approved prompt candidate:',
          runtimeContextValue(runtime_context, 'approved_prompt_candidate', 'Unavailable.'),
          '',
          'Authoritative implementer workspace:',
          runtimeContextValue(runtime_context, 'implementer_workspace_path', 'Unavailable.'),
          '',
          'Implementer output:',
          runtimeContextValue(runtime_context, 'implementer_output', 'Implementer output unavailable.'),
          '',
          'Accepted review context:',
          runtimeContextValue(runtime_context, 'review_output', 'Accepted review output unavailable.'),
          '',
          'If you inspect files, use the authoritative implementer workspace or repo-root relative paths within it.',
          '',
          'Emit exactly one artifact using:',
          '<tutorial>',
          '...tutorial content...',
          '</tutorial>',
        ].join('\n');
      },
    },
    {
      id: 'next_prompt',
      actor_label: 'next_prompt_writer',
      title: 'Next Prompt Artifact Prompt',
      description:
        'Used after an accepted review to propose the next implementer prompt as an explicit artifact for user approval.',
      used_in_state_ids: ['artifact_forking'],
      output_marker_ids: ['next_prompt_artifact'],
      parser_hook_ids: ['parse_next_prompt_artifact'],
      render({ run, runtime_context }) {
        return [
          ...renderArtifactWorkerPolicyLines(nextPromptWriterAgent),
          '',
          'Produce the next implementer prompt for the workflow loop.',
          '',
          'Goal:',
          run.goal_prompt,
          '',
          'Approved prompt candidate:',
          runtimeContextValue(runtime_context, 'approved_prompt_candidate', 'Unavailable.'),
          '',
          'Authoritative implementer workspace:',
          runtimeContextValue(runtime_context, 'implementer_workspace_path', 'Unavailable.'),
          '',
          'Implementer output:',
          runtimeContextValue(runtime_context, 'implementer_output', 'Implementer output unavailable.'),
          '',
          'Accepted review context:',
          runtimeContextValue(runtime_context, 'review_output', 'Accepted review output unavailable.'),
          '',
          'Keep the next prompt grounded in repo-root relative paths or the authoritative workspace path above.',
          'Do not send the next worker back to the original source repository checkout path.',
          '',
          'Emit exactly one artifact using:',
          '<next_prompt>',
          '...next implementer prompt...',
          '</next_prompt>',
        ].join('\n');
      },
    },
  ],
  markers: [...markers],
  parser_hooks: [
    {
      id: 'parse_first_prompt_candidate',
      title: 'Parse First Prompt Candidate',
      description: 'Extracts the first implementer prompt candidate from planner output.',
      marker_ids: ['first_prompt_candidate'],
      output_kind: 'prompt_artifact',
      transition_event: 'planner.prompt_ready',
      parse(text) {
        return firstMarkerContent(text, 'first_prompt_candidate');
      },
    },
    {
      id: 'parse_review_verdict',
      title: 'Parse Review Verdict',
      description: 'Extracts the review verdict and fixup/replan body using deterministic markers only.',
      marker_ids: ['review_accepted', 'review_fixup_required', 'review_replan_required'],
      output_kind: 'review_decision',
      transition_event: null,
      parse(text) {
        if (reviewAcceptedMarker.parse(text).length > 0) {
          return { status: 'accepted', body: null };
        }

        const fixup = reviewFixupRequiredMarker.parse(text)[0];
        if (fixup) {
          return { status: 'fixup_required', body: fixup.content };
        }

        const replan = reviewReplanRequiredMarker.parse(text)[0];
        if (replan) {
          return { status: 'replan_required', body: replan.content };
        }

        return null;
      },
    },
    {
      id: 'parse_tutorial_artifact',
      title: 'Parse Tutorial Artifact',
      description: 'Extracts the tutorial artifact body from the post-review forked output.',
      marker_ids: ['tutorial_artifact'],
      output_kind: 'artifact',
      transition_event: null,
      parse(text) {
        return firstMarkerContent(text, 'tutorial_artifact');
      },
    },
    {
      id: 'parse_next_prompt_artifact',
      title: 'Parse Next Prompt Artifact',
      description: 'Extracts the next implementer prompt artifact from the post-review forked output.',
      marker_ids: ['next_prompt_artifact'],
      output_kind: 'artifact',
      transition_event: null,
      parse(text) {
        return firstMarkerContent(text, 'next_prompt_artifact');
      },
    },
  ],
});
