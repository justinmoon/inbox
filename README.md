# Inbox

Local web review cockpit for small multi-agent coding changes.

The core unit is a `change_unit`: one reviewed packet with:

- executive summary
- tutorial/explanation
- diff
- linked agent sessions
- review verdicts
- next proposed chunk

The prototype is intentionally inbox-first. It is not a generic chat shell.

## Stack

- frontend: React + Vite
- backend: Node + Express
- persistence: SQLite
- package contract: JSON bundle validated against [`schema/change-unit.bundle.schema.json`](./schema/change-unit.bundle.schema.json)
- browser validation: `npx agent-browser` against the built app

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

Dev mode starts:

- frontend at `http://127.0.0.1:5173`
- backend at `http://127.0.0.1:8787`

Production-ish local server:

```bash
just build
just start
```

## Commands

```bash
just dev
just build
just start
just typecheck
just reseed
just import seed/change-units/01-session-recovery/change-unit.json
just validate
just e2e-codex
```

## Seed / Import Contract

Bundles live under [`seed/change-units`](./seed/change-units) and are imported through the same storage path used by the app.

Example:

```bash
just import seed/change-units/01-session-recovery/change-unit.json
```

The JSON schema is checked into:

- [`schema/change-unit.bundle.schema.json`](./schema/change-unit.bundle.schema.json)

The runtime Zod contract lives in:

- [`shared/changeUnitBundle.ts`](./shared/changeUnitBundle.ts)

## Live Codex Paths

The app now has two real Codex-backed flows:

- create a live `change_unit` from a local repo plus Codex thread ids
- refresh an existing linked session from `codex app-server`

Both flows land in the same bundle/storage model used by imported packets. Live packet creation also tries to ingest real GitHub PR and CI state for the current branch when it can find a GitHub remote and an open PR.

## Validation

`just validate`:

1. builds the frontend
2. starts the local server
3. opens the built app in a real browser with `agent-browser`
4. captures the create-live-packet modal
5. clicks through the inbox and replay surface
6. asserts that the review surface, diff, and replay panel render
7. writes screenshots under `artifacts/validation/`

## Live Codex E2E

`just e2e-codex` runs a full proof loop:

1. creates three throwaway private GitHub repos under `justinmoon` with `gh`
2. seeds three distinct tiny codebases and pushes `main`
3. runs real Codex planner, implementer, reviewer A, and reviewer B sessions against each repo
4. commits the resulting changes onto real feature branches, opens real GitHub PRs, and waits for real GitHub checks
5. creates two live packets through the app/backend API and one through the in-app create modal driven by `agent-browser`
6. refreshes linked Codex sessions through the app refresh endpoint
7. validates the final inbox state in a real browser with `agent-browser`, including a screenshot tour of the major screens and states

Generated evidence lands under `artifacts/e2e/`.
