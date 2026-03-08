# Inbox Product Direction

Date: 2026-03-08

## Product

Inbox is a local web review cockpit for small multi-agent coding changes.

The current reset is intentionally narrow:

- left rail: change-unit inbox
- center: reading-first review brief
- right: replay / supporting evidence

The review surface is the product. It should answer, in order:

1. what changed
2. why it matters
3. what should happen next
4. show the diff

## Core Unit

The core unit is a `change_unit` bundle containing:

- title
- binary review state
- structured tutorial
- diff
- linked sessions
- review verdicts
- next executable action

## Current Baseline

The app should boot into one committed canonical checkpoint by default.

That checkpoint should include:

- a real captured diff
- real linked Codex sessions
- real tutorial data
- a real executable next step

The product should not boot into synthetic demo content.

## UX Goals

- calm, scannable inbox rail
- one coherent reading surface in the center
- replay as supporting evidence, not the headline
- keyboard-first navigation where it materially helps review
- no debugging-console feel

## Guardrails

Keep the spec, not old implementation complexity.

Do not broaden the product with:

- GitHub / PR / CI automation
- sprawling live Codex orchestration
- extra dashboards, badges, or metadata chrome
- desktop packaging
- harnesses that are more complex than the product

Bias toward:

- seeded or imported bundles
- hermetic browser validation
- deterministic boot behavior
- obvious, trustworthy defaults

## Working Rule

If the app can recover automatically from stale routing state, recover quietly.

If the queue is truly empty or the canonical seed is broken, say so clearly.
