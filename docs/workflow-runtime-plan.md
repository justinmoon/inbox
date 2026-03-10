# Workflow Runtime Plan

This is the living plan for evolving inbox from a checkpoint-first review app into a workflow runtime with explicit user gates.

Update this document as the architecture changes. It should stay focused on:

- the runtime model
- the workflow definition model
- the Codex integration boundary
- the immediate next slices

It should not become a changelog.

## Current Direction

The current inbox app proved a few things that are worth keeping:

- the review packet can be useful
- the session wall is a strong deep-inspection mode
- Codex-native session rendering is the right direction
- generic repo/workspace primitives are worth keeping

The main problem is that the current app still treats the approval packet as too central.

The runtime should instead revolve around:

- `WorkflowRun`
- `Gate`
- `AgentSession`
- `Workspace`
- `Artifact`

The approval packet is just one artifact shown when a run reaches a user gate.

## Product Principle

Do not make the approval packet the app.

The app should primarily answer:

- what workflow runs exist
- what state each run is in
- whether user interaction is currently required
- what sessions/artifacts belong to the run

The approval packet is only the dominant UI when a run is in an approval state.

## First Workflow

The first concrete workflow is:

- one planner/reviewer session
- one implementer session
- planner/reviewer discusses the plan with the user before any implementer prompt exists
- once the planner is ready, it proposes the first implementer prompt
- user approves or asks for revision
- implementer executes the prompt
- planner/reviewer reviews the result
- if review fails, planner/reviewer automatically issues a fixup prompt to the implementer
- if review passes, the planner/reviewer session is forked to produce:
  - tutorial artifact
  - next-prompt artifact
- user reviews and approves the next step
- loop until complete

## Concrete Workflow States

These are the real workflow states, not just UI buckets.

- `planning_conversation`
- `first_prompt_approval`
- `implementing`
- `auto_review`
- `fixup_implementing`
- `artifact_forking`
- `step_approval`
- `completed`
- `failed`

See also [workflow-dag.md](/Users/justin/code/inbox/docs/workflow-dag.md).

## User-Facing State Families

These are only for deciding which UI mode should dominate.

- `conversation`
- `background`
- `approval`
- `terminal`

Suggested mapping:

- `planning_conversation` -> `conversation`
- `first_prompt_approval` -> `approval`
- `implementing` -> `background`
- `auto_review` -> `background`
- `fixup_implementing` -> `background`
- `artifact_forking` -> `background`
- `step_approval` -> `approval`
- `completed` -> `terminal`
- `failed` -> `terminal`

## UI Implications

When a run is in:

- `conversation`
  - planner/reviewer conversation should dominate
- `background`
  - graph/status view should dominate
  - session wall is the main deep-inspection mode
- `approval`
  - approval packet should dominate
  - the packet may include:
    - tutorial
    - diff
    - next prompt
    - review verdict
- `terminal`
  - final summary/outcome should dominate

## Core Runtime Objects

These should be generic, not workflow-specific.

- `Repository`
- `RevisionRef`
- `Workspace`
- `WorkflowDefinition`
- `WorkflowRun`
- `Gate`
- `AgentSession`
- `Artifact`

Avoid baking workflow roles into the core schema.

Do not create first-class concepts like:

- `landing_workspace`
- `implementer_workspace`
- `reviewer_workspace`

If a workflow needs those meanings, it should express them as runtime metadata or tags on a generic `Workspace`.

## Workflow Definition Shape

The workflow definition should be a TypeScript file, not YAML.

It should own:

- metadata
- states
- transitions
- prompts
- extraction rules
- gate definitions
- runtime hooks

A rough shape:

```ts
export default defineWorkflow({
  id: 'plan-implement-review',
  title: 'Plan / Implement / Review',

  states: {
    planning_conversation: { family: 'conversation' },
    first_prompt_approval: { family: 'approval' },
    implementing: { family: 'background' },
    auto_review: { family: 'background' },
    fixup_implementing: { family: 'background' },
    artifact_forking: { family: 'background' },
    step_approval: { family: 'approval' },
    completed: { family: 'terminal' },
    failed: { family: 'terminal' },
  },

  transitions: [
    ['planning_conversation', 'planner.prompt_ready', 'first_prompt_approval'],
    ['first_prompt_approval', 'user.revise', 'planning_conversation'],
    ['first_prompt_approval', 'user.approve', 'implementing'],
    ['implementing', 'implementer.completed', 'auto_review'],
    ['auto_review', 'review.accepted', 'artifact_forking'],
    ['auto_review', 'review.fixup_required', 'fixup_implementing'],
    ['auto_review', 'review.replan_required', 'planning_conversation'],
    ['fixup_implementing', 'implementer.completed', 'auto_review'],
    ['artifact_forking', 'artifacts.ready', 'step_approval'],
    ['step_approval', 'user.approve_next', 'implementing'],
    ['step_approval', 'user.redirect', 'planning_conversation'],
    ['step_approval', 'user.finish', 'completed'],
  ],
});
```

## Prompt Ownership

Prompts should live in the workflow definition, not in the UI and not in hidden backend code.

The workflow file should explicitly define functions for at least:

- planner conversation
- reviewer
- tutorial
- next prompt

If prompts get large, they can move to adjacent files, but the workflow definition should still import and reference them directly.

## Extraction Strategy

The first version should not try to infer state from arbitrary prose.

Use explicit output markers.

Examples:

- `<first_prompt_candidate>...</first_prompt_candidate>`
- `<review_result status="accepted" />`
- `<review_result status="fixup_required">...</review_result>`
- `<tutorial>...</tutorial>`
- `<next_prompt>...</next_prompt>`

This keeps the first runtime deterministic enough to build.

## Codex Integration Boundary

The workflow runtime should not know about JSON-RPC details directly.

It should depend on a narrow `CodexClient` abstraction.

The backend implementation should use the real app-server methods already supported in:

- [appServerProcess.ts](/Users/justin/code/inbox/server/appServerProcess.ts)
- [server/index.ts](/Users/justin/code/inbox/server/index.ts)
- [codex-app-server README](/Users/justin/code/codex/codex-rs/app-server/README.md)

The core calls we actually need are small:

- `initialize`
- `thread/start`
- `thread/resume`
- `thread/fork`
- `turn/start`
- `thread/read`

And the core notifications we need are:

- `turn/started`
- `item/started`
- `item/completed`
- `item/*/delta`
- `turn/completed`
- `serverRequest`
- `serverRequest/resolved`

This is enough for the first runtime.

## Suggested Service Interfaces

```ts
interface CodexClient {
  startThread(input: StartThreadInput): Promise<{ threadId: string }>;
  resumeThread(input: ResumeThreadInput): Promise<{ threadId: string }>;
  forkThread(input: ForkThreadInput): Promise<{ threadId: string }>;
  startTurn(input: StartTurnInput): Promise<{ turnId: string }>;
  readThread(input: ReadThreadInput): Promise<ThreadSnapshot>;
  onEvent(listener: (event: CodexEvent) => void): () => void;
}

interface WorkflowContext {
  codex: CodexClient;
  workspaces: WorkspaceProvider;
  artifacts: ArtifactStore;
  gates: GateStore;
  runs: WorkflowRunStore;
}
```

## Diagram Strategy

We want two different diagrams:

1. Workflow definition diagram
   - state diagram
   - allowed states and transitions

2. Workflow run diagram
   - live run graph
   - current state, active sessions, open gates, pending artifacts

The first can be generated from the workflow definition.
The second can be generated from runtime state.

Mermaid is a good first target because it is lightweight and easy to regenerate.

## Near-Term Implementation Plan

### Phase 1

Add generic workflow runtime concepts:

- `WorkflowDefinition`
- `WorkflowRun`
- `Gate`

No big UI change yet.

### Phase 2

Add one concrete workflow definition:

- `plan-implement-review`

With explicit prompts and output markers.

### Phase 3

Add a run overview page driven by:

- workflow definition diagram
- live workflow run graph
- open gate status

### Phase 4

Reframe the current review packet as:

- an approval artifact shown only when the run is in an approval state

### Phase 5

Add `New Project / Start Run`:

- repo path
- goal prompt
- workflow definition

This replaces manual bundle import as the primary user flow.

## Guardrails

- keep the workflow engine lightweight
- do not bake one workflow’s role names into core schema
- do not make the approval packet the central object
- do not hide transitions from the user
- prefer explicit markers over fuzzy inference
- keep Codex transport logic behind a small client boundary

## Current Next Slice

The next implementation slice should:

- add `WorkflowDefinition`
- add `WorkflowRun`
- add `Gate`
- add one concrete `plan-implement-review` workflow file
- add a generated workflow definition diagram
- stop short of replacing the whole UI in one pass

## Current First Slice Shape

The current first implementation slice now adds these concrete runtime objects:

- `WorkflowRunRecord`
  - generic persisted run record
  - fields include:
    - `id`
    - `workflow_id`
    - `workflow_version`
    - `status`
    - `current_state_id`
    - `current_state_family`
    - `repo`
      - `repo_id`
      - `repo_path`
    - `goal_prompt`
    - `open_gate_ids`
    - `last_transition_id`
    - `created_at`
    - `updated_at`
    - `completed_at`
    - `tags`
    - `metadata`
- `GateRecord`
  - generic persisted gate record
  - fields include:
    - `id`
    - `run_id`
    - `workflow_id`
    - `definition_gate_id`
    - `state_id`
    - `kind`
    - `actor`
    - `title`
    - `description`
    - `status`
    - `blocking`
    - `options`
    - `opened_at`
    - `answered_at`
    - `closed_at`
    - `tags`
    - `metadata`
- `WorkflowDefinition`
  - server-side TypeScript definition object loaded from a registry
  - owns:
    - metadata
    - initial state
    - explicit states
    - explicit transitions
    - gate templates
    - prompt functions
    - marker protocol definitions
    - parser hooks

The current persisted storage is:

- `data/runtime/workflow-runs.json`
- `data/runtime/workflow-gates.json`

## Current Workflow Definition File

The first concrete workflow definition now lives in:

- [server/workflows/planImplementReview.ts](/Users/justin/code/inbox/server/workflows/planImplementReview.ts)

That file is intentionally the readable source of truth for:

- workflow metadata
- explicit state list
- explicit transition list
- user gate definitions for approval states
- planner/reviewer prompt functions
- deterministic marker protocol:
  - `<first_prompt_candidate>...</first_prompt_candidate>`
  - `<review_result status="accepted" />`
  - `<review_result status="fixup_required">...</review_result>`
  - `<review_result status="replan_required">...</review_result>`
  - `<tutorial>...</tutorial>`
  - `<next_prompt>...</next_prompt>`
- parser hooks that only look for those explicit markers

## Current Service Boundary

The current narrow runtime/service layer now does four things:

- loads workflow definitions from a registry
- enumerates available workflow definitions
- validates the state graph and gate wiring
- serializes a machine-readable definition view including Mermaid state-diagram text

The current minimal API surface is:

- `GET /api/workflows`
- `GET /api/workflows/:id`
- `POST /api/workflow-runs`
- `GET /api/workflow-runs/:id`
- `GET /api/workflow-runs/:id/events`
- `POST /api/workflow-runs/:id/planning-message`

Workflow run creation and planning messages now start or steer planner work asynchronously. They no longer wait for the full planner turn to finish before responding.

## Still Missing Before Real Workflow Execution

This definition/runtime slice still intentionally does not yet include:

- a workflow engine that advances runs through transitions
- `Artifact` runtime objects
- gate answering and transition application
- live run graph generation from actual runtime state
- a product UI centered on workflow runs instead of checkpoint bundles

## Current Executable Slice

The current executable workflow slice now proves one real path:

- create a `plan-implement-review` run
- start the planner/reviewer Codex thread
- start the planner conversation prompt from the workflow definition without blocking the API response
- accept follow-up user planning messages on the same thread
- steer those messages into an already active planner turn when one exists
- persist planner-turn started/completed/failed events
- parse the completed planner turn with the workflow-defined marker hook
- transition from `planning_conversation` to `first_prompt_approval` when `<first_prompt_candidate>` appears
- open the configured approval gate for `first_prompt_approval`
- expose async run updates over SSE so clients can observe planner progress and state changes

## Additional Runtime Objects

The runtime now also persists:

- `AgentSessionRecord`
  - enough to know which Codex thread belongs to a run
  - current fields include:
    - `thread_id`
    - `state_id`
    - `actor`
    - `workspace_id`
    - `cwd`
    - `active_turn_id`
    - `active_turn_started_at`
    - `latest_turn_id`
    - `latest_turn_completed_at`
    - `last_turn_status`
    - `status`
- `RunEventRecord`
  - enough to know what happened to a run and when
  - current fields include:
    - `type`
    - `summary`
    - `from_state_id`
    - `to_state_id`
    - `transition_id`
    - `session_id`
    - `thread_id`
    - `turn_id`
    - `created_at`

The current persisted runtime files now include:

- `data/runtime/workflow-agent-sessions.json`
- `data/runtime/workflow-run-events.json`

## Current Codex Boundary

The workflow runtime now talks to Codex through a small `CodexClient` service boundary rather than raw JSON-RPC calls inside the runtime service.

The current boundary supports:

- `startThread`
- `resumeThread`
- `startTurn`
- `steerTurn`
- `waitForTurnCompletion`
- `readThread`

This is enough for the live `planning_conversation` slice and keeps the workflow runtime detached from transport details.

## Current Async Planner Lifecycle

For the planner/reviewer session, the runtime now persists and exposes these honest lifecycle points:

- `planner_turn_started`
- `planner_turn_steered`
- `planner_turn_completed`
- `planner_turn_failed`
- `planner_marker_detected`
- `planner_marker_not_found`
- `state_transition`
- `gate_opened`

The backend also exposes a narrow run-update path:

- `GET /api/workflow-runs/:id/events`
  - SSE stream of persisted runtime events for that run
  - enough for a client to show:
    - planner is thinking
    - planner completed
    - state changed
    - approval gate opened

## Remaining Gaps Before Implementer Execution

The runtime still does not yet include:

- the implementer session path
- review execution and review-result transitions
- artifact generation and post-review forks
- gate answering and transition application from user approval states
- recovery logic for in-flight planner turns across server restarts
- a workflow-run UI that replaces the checkpoint-first product flow
