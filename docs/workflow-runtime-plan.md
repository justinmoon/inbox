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

## Current Swarm Overlay

The runtime now also has a thin hub-and-spoke simplification layer on top of the existing workflow runtime.

This layer does not drive execution.

It only describes and projects the current runtime truth so the app can answer simpler questions first:

- which agents are active
- whether the run is just working or needs user input
- what the current gate artifact is
- what happened recently in chronological order

The minimal swarm model is:

- `SwarmDefinition`
  - `id`
  - `title`
  - `summary`
  - `agents`
  - `allowed_routes`
  - `gate_rules`
  - `artifact_kinds`
- `WorkflowRunSwarmView`
  - `top_level_state`
  - `active_state_id`
  - `active_state_family`
  - `current_gate`
  - `agents`
  - `timeline`
  - `graph_mermaid`

This is intentionally a projection layer, not a second workflow engine.

## Top-Level Run State

The app now derives a simpler top-level run state directly from current runtime truth:

- `needs_user_input`
  - the run has an open gate
- `failed`
  - the run is in the failed state or has failed status
- `completed`
  - the run has completed status
- `working`
  - everything else

This is intentionally much simpler than the concrete workflow state graph.

The detailed workflow state, sessions, events, and gates still exist underneath for observability and execution.

## Current Hub-And-Spoke Definition

The first concrete swarm definition is the current `plan-implement-review` flow, reframed as:

- planner = hub
- implementer = worker

The current swarm definition says:

- planner owns user conversation and prompt proposal
- planner can delegate work to implementer
- a user gate opens when the planner emits a prompt candidate
- the current gate artifact is the prompt candidate

Tutorial generation, PR forks, and the full review loop are intentionally not part of this first swarm slice.

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
- `GET /api/workflow-runs`
- `GET /api/workflow-runs/:id`
- `GET /api/workflow-runs/:id/events`
- `POST /api/workflow-runs/:id/planning-message`
- `POST /api/workflow-runs/:id/gates/:gateId/answer`

Workflow run creation and planning messages now start or steer planner work asynchronously. They no longer wait for the full planner turn to finish before responding.

## Still Missing Before Real Workflow Execution

This definition/runtime slice still intentionally does not yet include:

- a workflow engine that advances runs through transitions
- `Artifact` runtime objects
- live run graph generation from actual runtime state
- a product UI centered on workflow runs instead of checkpoint bundles

## Current Executable Slice

The current executable workflow slice now proves one real user path:

- create a `plan-implement-review` run
- inspect the run from a dedicated `/workflow-runs` route without replacing the checkpoint UI
- start the planner/reviewer Codex thread
- start the planner conversation prompt from the workflow definition without blocking the API response
- accept follow-up user planning messages on the same thread
- steer those messages into an already active planner turn when one exists
- persist planner-turn started/completed/failed events
- parse the completed planner turn with the workflow-defined marker hook
- transition from `planning_conversation` to `first_prompt_approval` when `<first_prompt_candidate>` appears
- open the configured approval gate for `first_prompt_approval`
- show that gate and the candidate prompt on the run detail page
- answer the first approval gate generically with `option_id` plus an optional user message
- on `revise`, close the approval gate honestly, transition back to `planning_conversation`, and send the user feedback into the same planner thread
- on `approve`, transition into `implementing`, create the implementer workspace, create the implementer Codex session, and start the implementer turn from the approved prompt candidate
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

## Current Gate Answer Model

The runtime now has a first generic gate-answer path:

- gate answers are submitted as:
  - `option_id`
  - optional `message`
- answering a gate:
  - marks the selected gate as `answered`
  - dismisses sibling open gates for the same state
  - records `gate_answered` and `gate_dismissed` events
  - applies the workflow-defined transition associated with the selected gate option
- the first concrete gate behavior is:
  - `approve`
    - transition to `implementing`
    - create implementer workspace/session/turn
  - `revise`
    - transition back to `planning_conversation`
    - send the revision feedback into the live planner session

## States Now Executable

The currently executable states are:

- `planning_conversation`
  - live user-facing planner conversation
- `first_prompt_approval`
  - real user gate with approve/revise handling
- `implementing`
  - implementer workspace/session/turn launch only
  - completion is recorded, but the workflow does not yet move into reviewer execution

## Remaining Gaps Before Reviewer Loop

The runtime still does not yet include:

- transition from implementer completion into `auto_review`
- reviewer session startup and reviewer-result transitions
- artifact generation and post-review forks
- later approval states beyond the first prompt gate
- recovery logic for in-flight planner turns across server restarts
- a workflow-run UI that replaces the checkpoint-first product flow
- a generic scheduler or second state machine for the swarm layer
- peer-to-peer agent routing beyond the planner -> implementer spoke
- explicit swarm modeling for tutorial or PR fork workers

## Minimal Swarm Policy Layer

The swarm layer now carries a small amount of real role policy in addition to labels:

- `SwarmAgentDefinitionView`
  - `role_prompt`
  - `operating_guidelines`
  - `target_artifact_kind_ids`
  - `target_gate_rule_ids`
- `SwarmGateRuleView`
  - `unlocks_route_id`

This is intentionally still a thin overlay rather than a second execution engine.

Current usage:

- the planner agent policy text now seeds the workflow planner/reviewer prompt functions
- the implementer agent policy text now seeds the first implementer turn text after approval
- the planner agent also declares which artifact and gate it is trying to produce:
  - `prompt_candidate`
  - `prompt_candidate_approval`

This keeps higher-level programming intent in the swarm definition without moving execution truth out of the workflow runtime yet.

## Gate To Route Mapping

The swarm graph no longer guesses an approval edge from `allowed_routes[0]`.

Instead:

- the swarm gate rule explicitly names the route it unlocks with `unlocks_route_id`
- the swarm runtime resolves that route to its target agent
- the run swarm view exposes:
  - `current_gate.unlocks_route_id`
  - `current_gate.unlocks_route_title`
  - `current_gate.unlocks_target_agent_id`
  - `current_gate.unlocks_target_agent_title`

For the current hub-and-spoke slice:

- `prompt_candidate_approval`
  - unlocks `planner_to_implementer`
  - which targets `implementer`

That mapping now drives both the Mermaid graph generation and the lightweight swarm overview on `/workflow-runs`.

## What Still Stays In Workflow Runtime

The detailed workflow runtime still remains the execution truth for:

- explicit workflow states and transitions
- actual Codex session/thread lifecycle
- parser hooks and marker detection
- run events and transition history
- gate opening, gate answering, and transition application
- implementer workspace/session creation

The swarm layer is currently descriptive plus prompt/policy-bearing. It is not yet:

- a scheduler
- a peer routing engine
- a replacement for the detailed workflow state machine
- a full collapse of planner/reviewer/implementer behavior into one generic swarm policy model

## Browser Validation Coverage

`scripts/validateBrowser.ts` now treats the workflow-runtime route as a real browser surface.

`just validate` now exercises:

- `/workflow-runs`
- creating a workflow run from the UI
- the live planning conversation surface
- planner feedback submission from the UI
- asynchronous transition into `first_prompt_approval`
- first-prompt approval into `implementing`
- the swarm overview updating to show the implementer route/status

This keeps the runtime route from drifting into an unvalidated developer-only path.

## Swarm Review Policy

The swarm definition now carries a small first-class review policy for the planner hub:

- `SwarmAgentDefinitionView`
  - `review_role_prompt`
  - `review_guidelines`
  - `expected_marker_ids`

For `plan-implement-review`, the planner hub policy now explicitly owns:

- prompt-proposal behavior
- review behavior after implementer execution
- the expected review markers:
  - `review_accepted`
  - `review_fixup_required`
  - `review_replan_required`

The workflow runtime still owns execution truth, but the planner/reviewer role text and review guidance now come from the swarm definition instead of being duplicated as backend-only strings.

## Executable Hub And Worker Loop

The runtime now executes the first real hub-and-spoke review loop:

- `planning_conversation`
  - live planner conversation with explicit first-prompt marker parsing
- `first_prompt_approval`
  - explicit user gate with approve/revise handling
- `implementing`
  - implementer workspace/session/turn launch from the approved prompt candidate
- `auto_review`
  - planner/reviewer session reuse
  - real review turn launched after implementer completion
  - explicit verdict parsing from deterministic review markers
- `fixup_implementing`
  - implementer relaunch from the planner’s fixup prompt
- `artifact_forking`
  - accepted-review boundary only for now

Current review-loop behavior:

- implementer completion records `implementer_turn_completed`
- runtime transitions into `auto_review`
- planner review records:
  - `review_turn_started`
  - `review_turn_completed`
  - `review_result_detected`
- explicit review markers drive the next path:
  - `accepted`
    - transition to `artifact_forking`
  - `fixup_required`
    - transition to `fixup_implementing`
    - relaunch implementer with the fixup prompt
  - `replan_required`
    - transition back to `planning_conversation`
    - keep planner thread continuity
    - persist the replanning feedback on the planner session

## Browser Validation Coverage

The browser validator now exercises one real hub-and-spoke review path end to end on a tiny dedicated git repo:

- `/workflow-runs`
- create a workflow run from the UI
- live planning conversation
- first prompt approval
- implementer launch
- implementer completion
- planner auto-review start
- accepted-review transition into `artifact_forking`
- swarm overview and timeline update at the accepted-review boundary

The validator also checks the actual implementer workspace output by reading the expected file from the implementer workspace after the accepted review boundary is reached.

## Remaining Gaps Before Tutorial / Next-Prompt Workers

This slice still intentionally stops before post-review worker fanout.

Still missing:

- tutorial generation execution
- next-prompt artifact generation
- later user gates after the first prompt approval
- a reviewer path beyond the planner hub
- broader worker fanout such as PR or tutorial spokes
- restart recovery for in-flight implementer/review turns
- any generic swarm scheduler or peer-mesh routing model

The detailed workflow file still remains the execution truth. The swarm layer now owns more agent policy, but it is still not the scheduler or full runtime engine.

## Artifact Worker Roles

The hub-and-spoke swarm now includes two bounded post-review workers:

- `tutorial_writer`
  - produces the explicit `tutorial_artifact`
  - owns lightweight tutorial-writing role policy in the swarm definition
- `next_prompt_writer`
  - produces the explicit `next_prompt_artifact`
  - owns lightweight next-step prompt policy in the swarm definition

The swarm definition now carries enough worker policy to describe:

- each worker’s role prompt
- operating guidelines
- expected output markers
- target artifact kind
- target gate rule

This keeps more of the “programming” for post-review worker behavior in the swarm layer without replacing the detailed workflow execution file yet.

## Minimal Artifact Model

The runtime now persists a minimal artifact record:

- `WorkflowArtifactRecord`
  - `id`
  - `run_id`
  - `workflow_id`
  - `kind`
  - `status`
  - `state_id`
  - `session_id`
  - `thread_id`
  - `turn_id`
  - `content`
  - `created_at`
  - `updated_at`
  - `completed_at`
  - `tags`
  - `metadata`

This is intentionally small. It is enough to:

- inspect which worker produced which artifact
- show artifact content in the workflow route
- attach artifact ids/content to later user gates
- support later landing / export work without inventing a large artifact framework first

Because artifact workers can complete concurrently, the JSON-backed runtime stores now serialize mutations per store instance instead of relying on best-effort temp-file writes alone.

## Stable Event Ordering

`RunEventRecord` now carries a persisted per-run `sequence` field.

The runtime assigns this sequence centrally when events are saved, and run history now orders by `sequence` first instead of trusting wall-clock timestamps alone. Timestamps still matter for display, but the event timeline and swarm projection now have a deterministic lifecycle order even when concurrent worker completions land in the same timestamp window.

## Executable Accepted-Review To Step-Approval Path

The workflow runtime now executes the next real post-review slice:

- accepted review
  - transitions into `artifact_forking`
- `artifact_forking`
  - planner hub forks two bounded worker sessions from planner context
  - tutorial worker runs the `tutorial` prompt
  - next-prompt worker runs the `next_prompt` prompt
- explicit marker parsing
  - `<tutorial>...</tutorial>` persists the tutorial artifact
  - `<next_prompt>...</next_prompt>` persists the next-prompt artifact
- once both artifacts are ready
  - transition into `step_approval`
  - open `step_approval_gate`
  - attach tutorial and next-prompt artifact ids/content to the gate metadata

The workflow route now shows a real step-approval packet with:

- accepted prompt context
- tutorial artifact
- next prompt artifact
- explicit approve / redirect / finish / abort actions

## Browser Validation Coverage

`scripts/validateBrowser.ts` now proves the first full prompt-approval packet path end to end:

- create run
- planning conversation
- first prompt approval
- implementer execution
- accepted review
- tutorial worker completion
- next-prompt worker completion
- transition into `step_approval`
- tutorial and next prompt visible in the workflow UI

This means the workflow-runtime route is now validated through the first real artifact-worker packet, not just through the accepted-review boundary.

## Workspace Truth Contract

The surfaced runtime workspace path is now the authoritative working directory for workflow execution.

That means:

- planning prompts describe the authoritative runtime workspace, not the original source checkout path
- approved implementer prompts are rewritten against the authoritative workspace path if they accidentally mention the source repo path
- review turns reuse the planner hub session, but are re-grounded onto the implementer workspace before execution
- artifact workers inherit the accepted implementer workspace context, not the original source repo checkout

The original local source repo path is still useful as repository registration metadata, but it is not the execution target once the runtime has created visible peer workspaces.

The runtime now also records a small workspace-contract baseline for implementer turns:

- authoritative workspace path
- local source repo path when one exists
- source repo `git status --porcelain` snapshot before worker execution

If the source repo becomes dirty while the run was supposed to execute inside a peer workspace, the run now fails loudly with `workspace_contract_violated` instead of continuing into review or artifact generation.

## Recoverable Planner Timeout

Planner turn timeout during `planning_conversation` is now modeled as a recoverable stall, not an automatic terminal run failure.

The runtime now persists lightweight planner activity truth on the planning session:

- `activity_status`
  - `idle`
  - `running`
  - `stalled`
- `stalled_at`
- `stall_reason`
- `last_error`

When the planner wait hits a timeout:

- the run stays in `planning_conversation`
- the run stays `active`
- the planning session moves to:
  - `activity_status = stalled`
  - `stall_reason = timeout`
- the runtime records `planner_turn_timed_out`

Recovery is intentionally narrow:

- the user can send another planning message into the same run
- the user can trigger an explicit planning retry action
- retry attempts to resume the same planner thread / turn first
- if that is no longer possible, runtime starts a fresh planning turn on the same planner thread

The workflow route now surfaces stalled planning explicitly instead of making it look like healthy background work:

- planner stalled banner
- retry action
- current active agent
- authoritative workspace path
- last successful milestone / last runtime event

Broader reliability work is still missing:

- restart recovery for in-flight planner turns
- automatic detection of a turn that completed after the runtime already marked it stalled
- richer backoff / health policies beyond this one recoverable timeout path

## Live Progress And Freshness

The workflow route now derives a small current-work snapshot from runtime truth instead of relying on a generic "working" label alone.

The swarm projection now carries:

- `activity.progress_state`
  - `making_progress`
  - `recently_updated`
  - `quiet_but_active`
  - `stalled`
  - `waiting_on_user`
  - `idle`
  - `failed`
  - `completed`
- `activity.active_agent_id` / `activity.active_agent_title`
- `activity.authoritative_workspace_path`
- `activity.subphase_id` / `activity.subphase_title`
- `activity.active_turn_started_at`
- `activity.last_meaningful_event`

This is intentionally lightweight:

- open gate => `waiting_on_user`
- stalled session => `stalled`
- active turn + recent milestone => `making_progress`
- active turn + older milestone => `quiet_but_active`
- no active turn + recent non-failure milestone => `recently_updated`

The goal is not a general health engine. The goal is to stop healthy background turns from feeling frozen while still making real stalls obvious.

## Gate And Artifact Freshness

The workflow route now treats runtime event sequence as the freshness floor for detail refresh.

That means:

- workflow run SSE events still carry the persisted run event
- the browser tracks the highest seen event sequence for the active run
- detail refreshes that come back older than the latest seen sequence are ignored and re-fetched instead of overwriting newer truth
- workflow run GETs are now explicitly `no-store`

This keeps gate packets and artifact views aligned with persisted runtime truth during fast background transitions, especially around:

- accepted review -> `artifact_forking`
- tutorial / next-prompt worker completion
- `step_approval` gate opening

The route also now visually demotes the graph / timeline / session walls when a gate is open so the approval packet remains the dominant decision surface.

## Remaining Gaps Before Later Loops And Landing Flows

Still intentionally missing:

- answering the `step_approval` gate into another full loop in browser validation
- later landing / publish flows that consume tutorial and next-prompt artifacts
- tutorial execution beyond one bounded worker output
- PR / branch / fork artifact workers
- restart recovery for in-flight artifact workers
- collapsing more of the detailed workflow file into a smaller swarm-policy-plus-gates execution model

The detailed workflow file still remains execution truth. The swarm layer now owns more role policy and worker behavior, but there is still no generic scheduler, peer mesh, or broad artifact engine.
