# Inbox

Local web review cockpit for one real, committed multi-agent checkpoint.

The app currently boots into a single canonical packet:

- bundle: `seed/change-units/validation-rollup-checkpoint/change-unit.json`
- example project: `seed/change-units/validation-rollup-checkpoint/example-project`
- real rollouts: `seed/change-units/validation-rollup-checkpoint/rollouts`

The product is intentionally narrow:

- one inbox rail
- one reading-first review surface
- one Codex-native replay surface
- one structured tutorial
- one generic repo/workspace subsystem with visible peer workspaces
- one persisted `Execute Next Prompt` state model
- one real launched-session surface tied to the reviewed checkpoint
- inline live-session approvals for command and file-change requests

## Run

With Nix:

```bash
nix develop
just dev
```

Without Nix:

```bash
npm install
just dev
```

`just dev` is the frontend-development entrypoint. It expects:

- Vite on `http://127.0.0.1:5173`
- backend on `http://127.0.0.1:8799`

Vite now uses a strict port. If `5173` is already occupied, `just dev` fails instead of silently
moving to another port and leaving you on a stale frontend.

For the most reliable read-only product check, use:

```bash
just build
just start
```

Then open:

- `http://127.0.0.1:8799/`

## Commands

```bash
just dev
just build
just start
just typecheck
just reseed
just import seed/change-units/validation-rollup-checkpoint/change-unit.json
just validate
```

## Current Model

The runtime contract lives in [`shared/changeUnitBundle.ts`](./shared/changeUnitBundle.ts).

The bundle now uses:

- one canonical `change_unit`
- structured tutorial data with `executive_summary` and tutorial `steps`
- real linked sessions, rollout captures, and review verdicts
- a narrow executable `next_action`, optionally with a generic `workspace_request`

Runtime state stays outside the bundle:

- execute-next persists `idle` / `launching` / `launched` / `failed`
- repositories and workspaces persist as generic runtime resources
- local sources may be true git repos or plain committed directories that seed a hidden backing repo
- the reviewed checkpoint packet stays immutable
- linked checkpoint sessions are reconstructed from committed rollout history
- launched thread metadata and live transcript are attached at read time from Codex app-server
- execute-next can ensure a repo, create a fresh peer workspace, and launch Codex in that workspace
- the right rail auto-updates launched live sessions from app-server notifications with polling fallback
- pending live approvals are surfaced inline and answered through the app-server response path

The generated JSON schema lives in
[`schema/change-unit.bundle.schema.json`](./schema/change-unit.bundle.schema.json).

## Data Paths

Seed bundles live under [`seed/change-units`](./seed/change-units).

Imported bundles are copied into `data/imported-change-units/` and override seeded bundles with
the same `change_unit.id`.

Runtime repositories and visible peer workspaces are persisted under `data/runtime/`:

- hidden backing repos: `data/runtime/repositories/<repo-id>/store`
- visible peer workspaces: `data/runtime/workspaces/<repo-id>/<workspace-name>`

[`data/README.md`](./data/README.md) explains the ignored stale debris from earlier prototype
paths. The current product does not use the old generated change-unit or SQLite files there.

## Validation

`just validate`:

1. builds the app
2. starts the static local server
3. opens `/`
4. opens a stale demo deep link and verifies recovery to the canonical checkpoint
5. executes the canonical next action and verifies launched state persists
6. verifies linked and live sessions both render through the Codex-native thread viewer
7. verifies captured file changes render as readable patch history instead of escaped JSON
8. verifies the launched live session visibly auto-updates in place
9. verifies inline live approvals render and accept/decline through the backend response path
10. verifies repo/workspace registration, peer workspace creation, and launched workspace metadata
11. imports a dynamic-step fixture and verifies tutorial navigation from actual step data
12. verifies failed execute-next state renders a real retryable error

## Notes

- `prompt.md` is not part of the current repo state.
- The current checkpoint is real captured data, not a mock demo.
- Live Codex generation beyond `Execute Next Prompt` is not part of this repo reset.
