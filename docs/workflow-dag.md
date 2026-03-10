# Workflow DAG Sketch

This is a first-pass sketch of the `planner/reviewer + implementer` loop we discussed.

It separates:

- the concrete workflow states and transitions
- the higher-level user-facing state families:
  - `conversation`
  - `background`
  - `approval`

## State Diagram

```mermaid
stateDiagram-v2
    [*] --> planning_conversation

    state "Planning Conversation\n(user + planner/reviewer)" as planning_conversation
    state "First Prompt Approval" as first_prompt_approval
    state "Implementing" as implementing
    state "Auto Review" as auto_review
    state "Fixup Implementing" as fixup_implementing
    state "Artifact Forking" as artifact_forking
    state "Step Approval" as step_approval
    state "Completed" as completed
    state "Failed" as failed

    planning_conversation --> planning_conversation: user/planner discuss\nplan still not ready
    planning_conversation --> first_prompt_approval: planner emits candidate first prompt
    planning_conversation --> failed: planner or system aborts

    first_prompt_approval --> planning_conversation: user requests prompt/plan revision
    first_prompt_approval --> implementing: user approves first prompt
    first_prompt_approval --> failed: user aborts run

    implementing --> auto_review: implementer finishes step
    implementing --> failed: implementer run fails hard

    auto_review --> fixup_implementing: reviewer rejects\nand emits fixup prompt
    auto_review --> artifact_forking: reviewer accepts step
    auto_review --> planning_conversation: reviewer decides\nplan needs replanning
    auto_review --> failed: reviewer/system aborts

    fixup_implementing --> auto_review: implementer completes fixup
    fixup_implementing --> failed: fixup fails hard

    artifact_forking --> step_approval: tutorial fork ready\nand next-prompt fork ready
    artifact_forking --> failed: forked artifact generation fails

    step_approval --> implementing: user approves next prompt
    step_approval --> planning_conversation: user redirects plan\nor asks for discussion
    step_approval --> completed: user marks workflow complete
    step_approval --> failed: user aborts run
```

## User-Facing State Families

These are not the real workflow states. They are just how the UI decides what should dominate.

```mermaid
flowchart TD
    planning_conversation --> conversation["conversation"]
    first_prompt_approval --> approval["approval"]
    implementing --> background["background"]
    auto_review --> background
    fixup_implementing --> background
    artifact_forking --> background
    step_approval --> approval
    completed --> terminal["terminal"]
    failed --> terminal
```

## Implications For UI

- `planning_conversation`
  - planner/reviewer conversation should dominate
- `first_prompt_approval`
  - prompt approval packet should dominate
- `implementing`, `auto_review`, `fixup_implementing`, `artifact_forking`
  - graph/status view should dominate
  - session wall is the main deep-inspection mode
- `step_approval`
  - approval packet should dominate again
- `completed`, `failed`
  - summary / status outcome view should dominate

## Notes

- This is intentionally still one concrete workflow, not the generic workflow API yet.
- The important next step is to turn this into an explicit workflow definition model with:
  - states
  - transitions
  - active actors
  - open user gates
