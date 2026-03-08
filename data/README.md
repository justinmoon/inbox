# Data Quarantine

`data/` is not part of the canonical checkpoint boot path.

The current product boots from the committed bundle under:

- `seed/change-units/validation-rollup-checkpoint/change-unit.json`

Anything under `data/generated-change-units/` or the old SQLite files in this directory is stale
prototype debris from earlier experiments. Those files are ignored by git and can be deleted
without affecting the current canonical checkpoint flow.
