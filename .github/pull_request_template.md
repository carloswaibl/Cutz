## What and why

<!-- What changed, and what problem it solves. Link the milestone in docs/project-plan.md if relevant. -->

## Checklist

- [ ] `npm run typecheck && npm run test:run` pass locally
- [ ] Still fully client-side - no server, API call, account, or telemetry
- [ ] Every dimension in `domain/`, `solver/`, `import/`, `export/` is millimeters
- [ ] No new runtime dependency (or: it was agreed beforehand and is justified below)

### If this touches the solver

- [ ] `npm run bench` run, waste-percentage delta reported below for **every** fixture
- [ ] Output validated with `domain/validate.ts` invariant checks in tests
- [ ] Deterministic - seeded PRNG only, no `Math.random()`
- [ ] Layouts remain guillotine-decomposable, and grain-locked parts are never rotated

<!--
Bench delta (fixture: before% -> after%):

-->

### If this touches import

- [ ] Failures return a typed error naming the unsupported construct, not a raw throw
- [ ] Tested against real exported files in `test/files/`, not hand-written XML
- [ ] Units are prompted for, never silently defaulted
