# Inbox Overnight Build Brief

Date: 2026-03-07

## What This Is

Build the first usable vertical slice of a local "inbox" app for supervising small multi-agent coding changes.

This is not a general harness framework.

This is not a desktop app project yet.

This is not a long-term architecture document.

This is an implementer brief for the first serious prototype.

## Core Goal

By the end of this build, one person should be able to:

1. open a local web app
2. see a list of change units
3. open one change unit
4. inspect the diff and linked agent sessions
5. read an immediate executive summary/tutorial card
6. see the next proposed chunk of work
7. trust that the UI was tested in a real browser, not only by unit tests

## Full Product Target

The full product is a local "agent work inbox" for supervising a stream of small logical coding changes across one or more projects. The unit of work is a change unit: one chunk of implementation, with its diff, supporting sessions, review outcomes, tutorial, and next proposed chunk. The product should make that unit feel coherent and inspectable. It should not feel like a bag of unrelated chats and terminals.

At maturity, the user should be able to sit down in front of the app and run most of this workflow from one place:

1. see what change units are waiting for attention
2. open any change unit and understand what happened
3. inspect the actual code diff and status of validation
4. replay what planner / implementer / reviewers did
5. talk to one of those sessions if needed
6. approve the next chunk or revise it
7. see whether the current chunk is merely reviewed, in CI, ready to merge, or already landed
8. move on to the next chunk without losing context

This first implementation does not need to deliver all of that. But the code and UI should point in that direction rather than toward a generic single-thread chat app.

## Important Scope Discipline

Do not drift into future harnesses or speculative architecture.

Do not spend time on:

- other harness integrations
- desktop packaging
- giant generic plugin systems
- PR automation
- CI automation
- polished auth/user systems
- background distributed orchestration

The goal is one local Codex-backed vertical slice that proves the product shape.

## Product Shape To Build

The app should feel like a control room for one logical change.

The intended user experience is not "chat with one agent in a box". It is "work from an inbox". The user should be able to leave the app alone for a while, come back when one logical change is ready, and immediately understand three things without hunting around: what just changed, what the agents think should happen next, and whether the change is safe to land. The app should feel like a review cockpit for small frequent commits, not like a generic terminal multiplexer or a generic chat client.

The first impression should be high signal and low ceremony. The user opens the app and sees an inbox of change units, each representing one logical chunk of work. A change unit should read more like a reviewed package than a raw thread: title, status, short summary, maybe a couple role badges, and enough metadata to decide what deserves attention first. Opening one should feel like entering a focused incident room for that change, with the important artifacts already assembled rather than forcing the user to reconstruct them from transcript archaeology.

The detail page should support the review rhythm you described. The user should be able to read an executive summary/tutorial first, then inspect the diff, then browse or replay the underlying agent sessions, then look at the proposed next chunk. That order matters. The product is not trying to hide the underlying sessions, but it should not force the user to start there. The top of the experience should answer "what happened?" and "what should happen next?", while the supporting panes answer "show me why" and "show me exactly what the agents did."

Visually, think in terms of one large fullscreen workspace that can show several kinds of information at once without feeling cramped. The likely shape for the first prototype is an inbox/list rail on the left, a main review/detail area in the center, and one or more side panes or tabs for agent-session replay. The center should prioritize the human-readable artifacts: summary/tutorial, diff, next prompt, and status. The side area should be where the user can drill into individual planner / implementer / reviewer transcripts. A bottom drawer or secondary area for logs is fine if needed, but the first-screen experience should not look like a terminal dashboard.

The main UI for a selected change unit should show:

1. executive summary
2. tutorial / explanation card
3. next proposed chunk / next prompt
4. PR / CI placeholders
5. diff
6. linked session histories

If something has to be cut for time, cut features below this line:

- PR / CI live integration
- editing the next prompt in-app
- multiple simultaneous projects
- advanced transcript search

Do not cut:

- the inbox list
- the change-unit detail page
- diff display
- replayable linked sessions
- browser-level validation

### Inbox Behavior

The inbox should work like a work queue, not a generic file browser. Each row/card should make it obvious whether the change unit is:

- ready for review
- still in progress
- blocked on validation
- ready to land

For the first cut, it is acceptable to hardcode or locally persist those states, but the UI should still present them clearly. The user should be able to scan the inbox and know which change is the one to open next.

### Detail-Page Behavior

A good detail page for this prototype lets the user do all of the following without leaving the page:

1. understand the change at a glance
2. inspect the actual diff
3. replay what each contributing agent did
4. see the next proposed chunk of work
5. see whether the change is merely reviewed or actually ready to land

Do not optimize the first prototype for authoring long new prompts inside the app. Optimize it for comprehension, inspection, and decision-making at the boundary between chunks of work.

### Session Replay Experience

The agent-session area should not just dump raw JSON or one giant transcript blob. It should feel like a readable replay surface with obvious role labeling.

For the first cut, good enough means:

- each session is clearly labeled by role
- the user can switch between planner / implementer / reviewer sessions quickly
- turns are readable and ordered
- tool actions or key milestones are visible enough to follow what happened

Better if time allows:

- collapsible turns
- simple filters for assistant/tool/user
- lightweight "jump to decision" anchors

### Diff Experience

The diff is a first-class artifact, not a footer. The user should be able to inspect what changed without leaving the detail page.

For the first cut:

- a readable unified diff is enough
- changed files should be scannable
- large diffs should remain navigable

Better if time allows:

- file list / outline
- expand-collapse by file
- lightweight syntax highlighting

### Status Experience

Even if the first prototype uses fake or locally persisted state, the UI should already teach the right model. A change unit should have recognizable states such as:

- in progress
- awaiting review
- needs revision
- approved
- validating
- ready to land
- landed

If PR/CI integration is not implemented, use placeholders or mocked values that still preserve the shape of the final product.

### Tutorial / Summary Experience

The tutorial/summary area is not decorative. It is the top-level explanation layer that saves the user from having to read every transcript first.

For the first cut it should support:

- a short executive summary
- a slightly richer tutorial/explanation block
- explicit statement of what the next proposed chunk is

Better if time allows:

- rendered markdown
- lightweight code/file references
- sections like "What changed", "Why", "What to review", and "Next step"

## Concrete Technical Direction

### Runtime Choice

Use Codex for this first build.

Reason:

- there is already a local controllable server surface in the Codex repo
- there is already a small working web shell in `codex-ui`
- this is the shortest path to a real local web prototype

### App Shape

Build a local web app, not a native desktop app.

Preferred first shape:

- browser frontend
- small local backend process
- backend talks to Codex
- frontend talks only to the local backend

You may reuse/adapt structure from `codex-ui`, but do not get trapped into its current product shape. Use it as scaffolding.

### Suggested Stack

Optimize for speed and correctness, not purity.

Good first choice:

- frontend: React + Vite
- backend: Node/TypeScript if that gets you moving faster because `codex-ui` is already there

Also acceptable:

- backend: Rust + axum if borrowing more directly from `pika-news` gets you to a real product surface faster

Do not build both. Pick the path that gets to a working review cockpit fastest.

If you choose to introduce Rust early, keep it to a very small role and do not let it slow the vertical slice.

The priority is proving the workflow UI, not winning a language debate on night one.

## Required Build Environment

Use a `flake.nix`.

The implementer should:

1. create a reproducible dev shell
2. put all required tools in that shell
3. avoid undocumented host assumptions

The flake should support at least:

- Node
- npm or pnpm
- git
- jq
- ripgrep
- just
- whatever browser/Playwright/Chromium support is needed for testing

The flake should also expose at least:

- `devShells.default`
- a runnable dev app command
- a runnable validation command

Look at these local repos for inspiration:

- [codex flake](/Users/justin/code/codex/flake.nix)
- [rally flake](/Users/justin/code/rally/flake.nix)
- [pika flake](/Users/justin/code/pika/worktrees/pika-ci/flake.nix)
- [fedimint flake](/Users/justin/code/fedimint/flake.nix)
- [flakebox template flake](/Users/justin/code/flakebox/templates/default/flake.nix)

Do not overbuild the flake. Keep it pragmatic and easy to enter.

## Local Prior Art You Should Read First

### Pika News

This is the closest local product inspiration for the "inbox + tutorial + chat around an artifact" idea.

Read:

- [pika-news README](/Users/justin/code/pika/worktrees/pika-ci/crates/pika-news/README.md)
- [pika-news model](/Users/justin/code/pika/worktrees/pika-ci/crates/pika-news/src/model.rs)
- [pika-news web handlers](/Users/justin/code/pika/worktrees/pika-ci/crates/pika-news/src/web.rs)
- [pika-news storage](/Users/justin/code/pika/worktrees/pika-ci/crates/pika-news/src/storage.rs)
- [pika-news inbox template](/Users/justin/code/pika/worktrees/pika-ci/crates/pika-news/templates/inbox.html)
- [pika-news detail template](/Users/justin/code/pika/worktrees/pika-ci/crates/pika-news/templates/detail.html)

What to borrow:

- artifact-centric detail view
- browser-first tutorial presentation
- durable storage

What not to borrow blindly:

- server polling model
- PR-only framing

### Codex Runtime

Read:

- [codex app-server README](/Users/justin/code/codex/codex-rs/app-server/README.md)
- [codex app-server main](/Users/justin/code/codex/codex-rs/app-server/src/main.rs)
- [codex app-server thread state](/Users/justin/code/codex/codex-rs/app-server/src/thread_state.rs)
- [codex SDK README](/Users/justin/code/codex/sdk/typescript/README.md)

Pay attention to:

- thread lifecycle
- resume
- fork support
- turn streaming
- approvals
- schema generation

### Codex UI

Read:

- [codex-ui README](/Users/justin/code/codex-ui/README.md)
- [codex-ui server bridge](/Users/justin/code/codex-ui/server/index.ts)
- [codex-ui app-server process wrapper](/Users/justin/code/codex-ui/server/appServerProcess.ts)
- [codex-ui app](/Users/justin/code/codex-ui/src/App.tsx)
- [codex-ui types](/Users/justin/code/codex-ui/src/lib/types.ts)

What to borrow:

- local browser shell
- websocket bridge
- app-server request/response flow
- approval handling shape

What not to borrow blindly:

- the current one-thread chat layout as your final product

### Browser Validation Tooling

Read:

- [agent-browser README](/Users/justin/code/agent-browser/README.md)

You should prefer real browser testing with `npx agent-browser` if possible.

## Data Model For This First Slice

Keep it small and explicit.

Implement these core records:

- `change_unit`
- `agent_session`
- `artifact`
- `project`
- `review_verdict`

Suggested fields:

### `change_unit`

- id
- title
- status
- executive_summary
- tutorial_markdown_or_html
- next_prompt
- diff_text
- created_at
- updated_at

### `agent_session`

- id
- change_unit_id
- role
- runtime
- thread_id
- status
- transcript_path_or_blob_ref
- created_at
- updated_at

### `artifact`

- id
- change_unit_id
- kind
- path_or_blob_ref
- created_at

### `project`

- id
- name
- worktree_path
- repo_path
- created_at

### `review_verdict`

- id
- change_unit_id
- reviewer_role
- verdict
- summary
- created_at

Do not build an elaborate event-sourced system tonight unless it falls out naturally.

SQLite plus a few explicit tables is enough.

The SQLite schema plus a seed/import format should be treated as the first integration surface. A future coordinator should be able to create or update change units through that model without forcing a second incompatible representation.

## Change-Unit Bundle Contract

Define one explicit ingest format early. Do not leave "seeded data" as an implied pile of ad hoc fixtures.

For the first cut, create a machine-readable bundle format such as `change-unit.json` that can seed the app with one coherent change unit.

The bundle should include:

- project metadata
- change-unit metadata
- executive summary
- tutorial content
- next prompt
- diff text
- linked agent sessions
- reviewer verdicts
- optional artifact references

At minimum, the implementer should be able to load one believable example bundle through a documented dev command.

This matters for two reasons:

1. it makes the UI deterministic and testable before the live Codex bridge is perfect
2. it gives later automation a concrete integration surface

## Full Product Workflow To Aim Toward

The implementer should understand the product as a workflow, not just as pages.

The intended long-form workflow is:

1. work begins on a logical change
2. one or more agent sessions produce implementation and review context
3. a change unit is created or updated to collect those artifacts
4. the app surfaces that change unit in the inbox
5. the user opens it and reads the executive summary/tutorial
6. the user inspects the diff and key transcripts
7. the user checks whether validation passed
8. the user either:
   - accepts the next proposed chunk
   - requests revision
   - or decides the current chunk is ready to land
9. the user moves back to the inbox and repeats

For tonight, you may fake or locally seed some of those transitions, but the app should still reflect this product shape.

## Minimum End-To-End Flow

The app only needs one hardcoded workflow for this slice.

Suggested roles:

- planner
- implementer
- reviewer_a
- reviewer_b

For the first cut, these can all just be linked sessions on one change unit.

The required behavior is:

1. create a change unit
2. attach one or more sessions to it, initially via the explicit seed/import path if needed
3. display their histories
4. display a diff
5. generate a summary/tutorial card
6. display a next prompt

If live multi-session orchestration is too much for one night, it is acceptable to seed the app from the explicit bundle format and/or from persisted thread IDs and stored transcript blobs.

The product point is the review surface.

## Full Implementation Plan

The goal is not to stop at the minimum if the implementer still has time and momentum. Build in layers and keep pushing as far as the night allows.

### Phase 1: Foundation

Set up the project so the rest of the work is reproducible and fast to iterate on.

Deliver:

- `flake.nix`
- a dev shell with all required tools
- app skeleton
- local persistence choice
- `just dev`
- `just validate`
- initial `change-unit` bundle contract

### Phase 2: Local Data / Storage Model

Create the records needed to represent one project and one or more change units cleanly.

Deliver:

- storage schema
- seed data path or fixtures
- ability to persist and reload change units
- ability to persist linked sessions and artifacts

### Phase 3: Seed / Import Path

Build the deterministic ingest path first.

Deliver:

- load one or more change-unit bundles
- persist imported change units
- document the seed/import command
- prove the UI can be driven from realistic seeded data

### Phase 4: Inbox UI

Build the main list/work-queue view.

Deliver:

- project selector if practical, otherwise one hardcoded project
- inbox list of change units
- visible status badges
- enough metadata to decide what to open next

### Phase 5: Change Detail UI

Build the central review page.

Deliver:

- executive summary area
- tutorial/explanation area
- next-prompt area
- PR/CI placeholder status area
- diff area
- session-replay area

### Phase 6: Early Browser Smoke

Start browser validation as soon as the review surface exists. Do not leave first real UI validation until the end.

Deliver:

- `npx agent-browser` smoke path against the inbox
- `npx agent-browser` smoke path against the detail page
- one or more recorded snapshots showing what currently works

### Phase 7: Codex Backend Bridge

Build the thin local backend path that speaks to Codex and translates that into the same app-facing records used by the seed/import path.

Deliver:

- Codex app-server process management or connection wiring
- fetch thread history
- persist thread references
- translate thread data into the app's `agent_session` model
- import persisted thread IDs / transcript blobs if full live bridge is going badly

### Phase 8: Live Codex Behaviors And Polish

Make the detail page actually good to use.

Deliver:

- start / resume thread support if feasible
- live bridge polish if feasible
- readable transcript rendering
- basic role-based tabs or columns
- usable diff scrolling/navigation
- artifact links if there are any stored files

### Phase 9: Stretch Goals If Time Remains

Only do these after the core review flow feels solid.

Good stretch goals:

- richer markdown rendering for tutorials
- better diff navigation
- simple status transitions inside the UI
- session filtering
- seeded example change units that tell a coherent story

Avoid these even as stretch goals:

- extra harnesses
- desktop packaging
- generic plugin systems
- overengineered orchestration
- pretending PR/CI automation is done when it is not

## Strong Validation Requirement

Validate aggressively.

Do not stop at "the page loads on localhost".

At minimum, the implementer should validate:

1. app boots inside the flake shell
2. Codex bridge can start or resume a thread
3. selected change-unit page renders real data
4. diff pane renders correctly
5. transcript panes render correctly
6. summary/tutorial card is visible and legible
7. core interactions work in a real browser

### Browser Validation

Preferred:

- use `npx agent-browser`

Examples:

- open the local app
- snapshot the page
- click into a change unit
- verify key text exists
- inspect the accessibility tree

### Fast Text Validation

If you add a faster CLI/text-mode validation path, it must use the exact same web-app code path at the rendering level.

Acceptable examples:

- SSR or DOM extraction from the same React components
- browser-driven DOM-to-text snapshots from the mounted app

Not acceptable:

- a second hand-written text renderer that can drift from the real UI

The validation path must reflect the actual web app, not a parallel fake UI.

## Validation Checklist

The implementer should actually prove these, not just claim them:

1. entering the flake shell works on a clean terminal
2. dependency install is documented and reproducible
3. the app starts from a documented command
4. the backend can talk to Codex or to realistic seeded data if Codex is unavailable
5. the inbox renders at least one believable change unit
6. opening a change unit shows summary, tutorial, diff, and sessions
7. the browser automation can navigate to the page and verify key text
8. if a text-mode validation path exists, it uses the same rendering path as the real web UI

If something fails, document what is good and bad. The overnight output should include a blunt assessment, not a vague "mostly works".

## Deliverables

The overnight build should produce:

1. a repo in `~/code/inbox`
2. a `flake.nix`
3. a bootable local app
4. a documented dev command
5. a documented validation command
6. browser-tested proof that the main flow works

## Implementation Phases

Use the fuller phase plan above.

## Acceptance Criteria

This build is successful if:

1. the app is runnable from the flake shell
2. the implementer can point to believable change-unit data loaded through the app's real ingestion model; live Codex-backed data is preferred, but seeded/imported data is acceptable for v0
3. the main review screen is usable
4. browser automation confirms the important UI states
5. the product direction is visible in the UI, not only the plumbing
6. the code is small enough that we can iterate on it tomorrow instead of rewriting it

## Final Notes To The Implementer

- Keep the product narrow.
- Reuse local prior art aggressively.
- Do not guess about Codex protocol details when the local checkout already answers them.
- Do not skip the flake.
- Do not skip browser validation.
- Be extremely thorough. Build the thing, test the thing, and write down exactly what is good, bad, real, fake, finished, and missing.
- Prefer one hardcoded beautiful path over a half-built generic framework.
