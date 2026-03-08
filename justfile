set positional-arguments

dev:
    npm run dev

build:
    npm run build

start:
    npm run start

typecheck:
    npm run typecheck

reseed:
    npm run reseed

import bundle:
    npm run import -- --bundle {{ bundle }}

validate:
    npm run validate

e2e-codex:
    npm run e2e:codex
