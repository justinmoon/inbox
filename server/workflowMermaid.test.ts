import assert from 'node:assert/strict';
import test from 'node:test';

import { planImplementReviewWorkflow } from './workflows/planImplementReview.ts';
import { renderWorkflowDefinitionMermaid } from './workflows/runtime.ts';

test('plan-implement-review Mermaid state diagram is deterministic', () => {
  const mermaid = renderWorkflowDefinitionMermaid(planImplementReviewWorkflow);

  assert.equal(
    mermaid,
    `stateDiagram-v2
    [*] --> planning_conversation

    state "Planning Conversation" as planning_conversation
    state "First Prompt Approval\\nGates: first_prompt_gate" as first_prompt_approval
    state "Implementing" as implementing
    state "Auto Review" as auto_review
    state "Fixup Implementing" as fixup_implementing
    state "Artifact Forking" as artifact_forking
    state "Step Approval\\nGates: step_approval_gate" as step_approval
    state "Completed" as completed
    state "Failed" as failed

    planning_conversation --> planning_conversation: planner.continue_planning\\nPlanner keeps the discussion open
    planning_conversation --> first_prompt_approval: planner.prompt_ready\\nPlanner emits the first implementer prompt candidate
    planning_conversation --> failed: planner.abort\\nPlanner or system aborts the run
    first_prompt_approval --> planning_conversation: user.revise\\nUser asks for plan or prompt revision
    first_prompt_approval --> implementing: user.approve\\nUser approves the first implementer prompt
    first_prompt_approval --> failed: user.abort\\nUser aborts at the first approval gate
    implementing --> auto_review: implementer.completed\\nImplementer finishes the current step
    implementing --> failed: implementer.failed\\nImplementer fails hard
    auto_review --> artifact_forking: review.accepted\\nReviewer accepts the current step
    auto_review --> fixup_implementing: review.fixup_required\\nReviewer emits a fixup prompt
    auto_review --> planning_conversation: review.replan_required\\nReviewer sends the run back to planning
    auto_review --> failed: review.abort\\nReviewer or system aborts the run
    fixup_implementing --> auto_review: implementer.completed\\nImplementer finishes the fixup
    fixup_implementing --> failed: implementer.failed\\nFixup execution fails hard
    artifact_forking --> step_approval: artifacts.ready\\nTutorial and next-prompt artifacts are ready
    artifact_forking --> failed: artifacts.failed\\nArtifact generation fails
    step_approval --> implementing: user.approve_next\\nUser approves the next prompt
    step_approval --> planning_conversation: user.redirect\\nUser redirects the plan
    step_approval --> completed: user.finish\\nUser marks the workflow complete
    step_approval --> failed: user.abort\\nUser aborts at the step-approval gate
`,
  );
});
