# M1 - Solver core (headless)

*Implementation plan. Scope, decisions, and PR sequence for the guillotine packing engine.*

Companion to `docs/project-plan.md` §6. Read `CLAUDE.md` first - the solver invariants,
units policy, and geometry conventions there are binding and are not restated in full here.

---

## 1. Goal and exit criteria

**Goal:** `solve(parts, stock, config)` produces valid, kerf-correct, guillotine-cuttable
layouts from fixture data, deterministically, with zero React/DOM/browser dependencies.

**M1 exits when all of the following hold:**

1. Every benchmark fixture solves to **under 15% total waste** (definition in §3.4).
2. Every fixture solves with **zero unplaced parts**, except the two fixtures that are
   deliberately unsatisfiable (`oversized-part`, `insufficient-stock`), where the expected
   shortfall is asserted exactly.
3. Every solver output in the test suite passes all six invariant checks in
   `domain/validate.ts` (§3.3).
4. `solve()` called twice with identical inputs returns deep-equal results.
5. `npm run bench` reports per-fixture waste and fails on regression against a committed
   baseline. It runs in CI.
6. `npm run typecheck && npm run test:run && npm run lint` are green.

**Deliberately not part of the exit bar:** the §5 "within 5% of a hand-optimized reference"
criterion. That requires ~8 credible hand-planned layouts, which is subjective, slow, and
adds little given the absolute cap. Revisit only if 15% turns out to be trivially easy for
every fixture - which would mean the fixtures are too soft, not that the bar is wrong.

**Wall-clock is not gated.** Timings get reported by the bench harness for information
only. CI timing is too noisy to assert on, and per `CLAUDE.md` we do not optimize for speed
without a measured problem.

---

## 2. Out of scope for M1

Not to be started, not to be anticipated in the design beyond the `Solver` interface:

- Anything in `src/ui/`, `src/import/`, `src/export/`, `src/storage/`. M1 is headless.
- Free-form / irregular nesting. The `Solver` interface is the firewall.
- Offcut inventory, cut sequencing, cost estimation, G-code, 1D linear stock.
- Web Workers, WASM, Rust. Not until profiling justifies them, with numbers.
- Any new runtime dependency. M1 needs none.

**Note on M0:** the M0 spike was never done - it targeted SVG/STL importer risk, which is
M4/M5 work. M1 has no dependency on it. That risk stays unretired and should be spiked
before M4 is planned.

---

## 3. Design

### 3.1 Module layout

```
src/domain/
  types.ts        (exists)
  geometry.ts     NEW - Rect helpers: area, contains, separation, intersects
  units.ts        NEW - mm <-> inch, fractional inch parse/format
  validate.ts     NEW - input validation + Result invariant checks
src/solver/
  types.ts        (exists - Solver interface)
  rng.ts          NEW - seeded PRNG
  instances.ts    NEW - Part/Stock qty expansion into instances
  objective.ts    NEW - Result scoring for the improvement pass
  guillotine/
    freeRects.ts  NEW - free-rectangle list, split rules, fit heuristics
    pack.ts       NEW - greedy multi-sheet packer
    index.ts      NEW - exports GuillotineSolver: Solver
  improve.ts      NEW - randomized-restart wrapper, also a Solver
  index.ts        NEW - the default solver (improve wrapping guillotine)
```

`geometry.ts` is an addition to the structure documented in `CLAUDE.md`. Rationale: both
the packer and the invariant checker need identical rectangle predicates, and duplicating
them is exactly how a checker ends up agreeing with a bug in the thing it checks. It is
pure, headless, and belongs in `domain/`. `CLAUDE.md` gets updated in the final PR.

### 3.2 Solver pipeline

```
solve(parts, stock, config)
  |
  +-- validateInputs()             -> typed issues; hard issues abort with a typed error
  +-- group by materialId          -> N fully independent subproblems
  |     for each subproblem:
  |       expandPartInstances()    -> one entry per unit of qty
  |       expandStockInstances()   -> one entry per unit of qty, id `${stock.id}#${i}`
  |       improve()                -> repeated greedyPack(), keep best by objective
  +-- merge subproblem Results     -> layouts concatenated, waste recomputed globally
```

**Grouping key is `materialId` alone,** not `(materialId, thickness)`. The `Solver`
interface does not receive `Material[]`, and thickness is a property of the material, so
`materialId` already encodes it. Two materials of different thickness necessarily have
different ids. This is consistent with `CLAUDE.md`, just more precise about the mechanism.

**Stock instance ids** are `` `${stock.id}#${index}` ``, index from 0, assigned in
declaration order. Deterministic and stable across runs, which matters because a saved
project must reproduce the same layout.

### 3.3 The greedy guillotine packer

Standard free-rectangle guillotine packer (Jylänki). Per sheet:

- Initial free rectangle is the **usable area**: `(edgeTrim, edgeTrim, W - 2*edgeTrim, H - 2*edgeTrim)`.
- For each part instance in order, score every free rectangle in every legal orientation and
  place into the best-scoring one. Legal orientations: unrotated always; rotated only when
  `rotationPolicy === 'free90'`. Grain lock is a hard constraint and is never traded away.
- Fit test is `w <= rw && h <= rh` - **not** `w + kerf <= rw`. Kerf is only consumed when
  there is material on the far side of the part to cut away.
- On placement, split the free rectangle into at most two children:

```
placed part w x h at rect (rx, ry, rw, rh)

split "horizontal" (the full-width cut runs under the part):
  right  = (rx + w + kerf, ry,            rw - w - kerf, h)
  bottom = (rx,            ry + h + kerf, rw,            rh - h - kerf)

split "vertical" (the full-height cut runs beside the part):
  right  = (rx + w + kerf, ry,            rw - w - kerf, rh)
  bottom = (rx,            ry + h + kerf, w,             rh - h - kerf)
```

A child with width or height `<= 0` is simply not created. This is what makes kerf correct
at edges: a part flush against the free rectangle's edge produces no child there and
consumes no kerf, because no cut happens there.

- **Free rectangles are never merged.** Merging is how a free-rect packer quietly stops
  producing guillotine-decomposable layouts. If we ever want Jylänki's rectangle-merge
  improvement, it goes in behind the invariant checker, not before it.
- Free rectangles too small for any remaining part are pruned.
- Sheets are opened one at a time, largest usable area first, until parts run out or stock
  runs out. Remaining parts go to `unplacedParts`.

**Tunable knobs** (fixed constants in the greedy pass, sampled by the improvement pass):

| Knob | Options |
|---|---|
| Part order | area desc, longest-side desc, perimeter desc, + perturbations |
| Free-rect choice | best-area-fit, best-short-side-fit, best-long-side-fit |
| Split rule | shorter-leftover-axis, longer-leftover-axis, shorter-axis, longer-axis |

The greedy pass contains **no randomness at all**. Ties break on free-rectangle index, then
part instance index. All randomness lives in `improve.ts` and comes from `rng.ts`.

### 3.4 Waste definition

Fix this now, because two reasonable definitions differ by several points and the exit bar
is a number.

```
layout.wastePct   = 1 - (sum of placed part areas on that sheet) / (full W*H of that sheet)
result.totalWastePct = 1 - (sum of all placed part areas) / (sum of full W*H of USED sheets)
```

- Measured against **full sheet area**, not usable area. Edge trim is material you bought
  and lost, so it counts as waste. This is the number a woodworker would compute.
- **Unused stock instances are excluded.** Owning ten sheets and using two is not 80% waste.
- Waste is meaningless when parts are unplaced. The bench harness reports unplaced count
  alongside waste and treats any unexpected shortfall as a hard failure, never as a good
  waste score.

### 3.5 Objective function (`objective.ts`)

The improvement pass compares candidate `Result`s lexicographically:

1. **Minimize unplaced part area.** Failing to place one large panel is worse than failing
   to place one small one.
2. **Minimize total area of used stock.** Area, not sheet count - with mixed sheet sizes,
   consuming one full sheet is worse than consuming one half sheet, and counting sheets
   would call those equal.
3. **Maximize the single largest free rectangle across used sheets.** Pure tiebreaker. It
   consolidates leftover into one usable offcut rather than scattering it. Offcut *tracking*
   is v2; preferring a usable offcut when everything else ties costs nothing now.

### 3.6 Improvement pass (`improve.ts`)

Implements `Solver`, delegates to the guillotine packer, keeps the best result.

- **Fixed iteration budget, never wall-clock.** A time budget makes output depend on machine
  speed and load, which destroys determinism. Budget is a fixed integer.
- Each iteration samples: a part ordering (base sort + `k` random swaps, `k` growing over
  the run), a free-rect heuristic, and a split rule - all from the seeded PRNG.
- Iterations 0..3 are the deterministic baselines (each base sort, default heuristic) so the
  improvement pass can never be worse than plain greedy.
- After the restart phase, a short hill-climb: mutate the best ordering, keep only strict
  improvements. Stop after a fixed number of non-improving mutations.

**Simulated annealing is not implemented in M1.** The plan lists it as optional. Restarts
plus hill-climbing is the cheap 80%. Add SA only if a fixture fails the 15% bar without it,
and say so in the PR. "Chasing solver quality indefinitely" is a listed anti-pattern.

**Proposed `SolverConfig` change - needs sign-off before PR 6:**

```ts
interface SolverConfig {
  kerf: number;
  edgeTrim: number;
  seed: number;
  effort?: 'fast' | 'balanced' | 'thorough';  // NEW, defaults to 'balanced'
}
```

Mapping to fixed iteration counts (e.g. 40 / 250 / 1500). Rationale: the budget must be
explicit and reproducible, and a named effort level keeps the config declarative instead of
leaking an implementation detail like `maxIterations` into the domain model. `SolverConfig`
is a documented type in `CLAUDE.md`, so this is flagged rather than assumed.

### 3.7 `rng.ts`

`mulberry32` - 12 lines, no dependency, well-distributed, seeds from a 32-bit integer.

```ts
export function createRng(seed: number): Rng;   // { next(): number, int(n): number, shuffle<T>(xs: T[]): T[] }
```

`shuffle` returns a new array; it does not mutate its input. The repo already has a Biome
GritQL plugin banning `Math.random()`, so misuse fails lint.

### 3.8 `validate.ts`

Two independent responsibilities, deliberately in one file since both are "does this data
make sense".

**Input validation** - returns a typed issue list, never throws raw strings:

- kerf < 0, edgeTrim < 0, non-finite dimensions, qty < 1 or non-integer
- `edgeTrim * 2 >= sheet width or height` (sheet has no usable area)
- part has no stock with a matching `materialId`
- part does not fit any usable stock area in any legal orientation - reported as a distinct,
  actionable issue ("grain lock prevents this part from fitting" reads very differently from
  "this part is too big"), since this is the single most likely user error

**Result invariant checks** - the six invariants from `CLAUDE.md`, each returning specific
violations rather than a bare boolean:

1. **Kerf separation.** For every pair of placements on the same sheet, they must be
   separated by `>= kerf` on at least one axis. Note the precision point: "inflated by kerf"
   means inflating *one* of the pair, not both - inflating both would demand `2*kerf` of
   clearance and is wrong. Two parts far apart in x need no y clearance; separation on
   either axis suffices.
2. **Within usable area.** `[edgeTrim, W-edgeTrim] x [edgeTrim, H-edgeTrim]`.
3. **Rotation legality.** `rotated === true` only for `rotationPolicy === 'free90'`.
4. **Guillotine decomposability.** See below.
5. **Material match.** Placement's part `materialId` equals its stock's `materialId`.
6. **Quantity accounting.** Strengthened: placed + unplaced must *equal* requested for every
   part, not merely not exceed it. Silent part loss is the failure mode this catches.

**Guillotine decomposability check.** Recursive, with memoization:

```
decomposable(region, placements):
  if placements.length <= 1: return true
  for each candidate cut c (vertical at every placement's right edge,
                            horizontal at every placement's bottom edge):
    reject unless region.x < c < region.right  and  c + kerf <= region.right
    reject unless every placement is entirely left of c, or entirely at/right of c + kerf
    L = decomposable((region.x, region.y, c - region.x, region.h),        left placements)
    R = decomposable((c + kerf, region.y, region.right - c - kerf, region.h), right placements)
    if L and R: return true
  ...same for horizontal...
  return false
```

Full backtracking over candidate cuts - taking the first valid cut is not sound in general.
Memoized on the region rectangle, which collapses the search for realistic layouts. A
recursion/step cap guards against pathological input, and **hitting the cap reports
`'unverified'`, never `'valid'`.** A checker that gives up silently is worse than no checker.

Seed region is the usable area, not the full sheet - the edge trim cuts are themselves
guillotine cuts and are always valid.

### 3.9 `units.ts`

Pure, headless, gets its own test suite. Canonical unit is mm everywhere.

```ts
mmToInch(mm: number): number
inchToMm(inch: number): number
parseLength(input: string, unit: Unit): number | LengthParseError   // -> mm
formatLength(mm: number, opts: { unit: Unit; denominator?: number }): string
```

- `parseLength` accepts `23-1/4`, `23 1/4`, `23.25`, `1/2`, `23"`, `600mm`, with leading and
  trailing whitespace. Returns a typed error, never throws.
- `formatLength` in imperial rounds to the nearest `1/denominator` (default 16 - tape-measure
  resolution), reduces the fraction (`23-1/4`, never `23-4/16`), and marks values that do not
  land exactly on the grid so the user knows it is approximate.
- Never returns a value that carries a unit tag into the domain model.

---

## 4. Benchmark fixtures

`test/fixtures/*.json`, mm dimensions, with a `description` field recording the imperial
source dimensions and the hand-checked layout. JSON rather than TypeScript modules so M6 can
reuse them as onboarding example projects. A typed loader in `test/fixtures/index.ts`
validates shape at load time, so a malformed fixture fails loudly instead of producing a
mystery solver bug.

**Sizing rule (established in PR 3).** Waste is a step function in sheet count, so a project
of one or two sheets is dominated by granularity rather than by packing quality and can fail
the 15% bar under a *perfect* pack. Every benchmark fixture is therefore authored so its
material needs ~3+ sheets and its part sizes tile the usable width, with the layout worked
out by hand and recorded in the fixture's `description`.

| Fixture | What it is | What it stresses |
|---|---|---|
| `bookshelf` | Three matching 5ft shelves: 6 sides, 24 shelves | Baseline realistic project, grain-locked sides |
| `cabinet-carcass` | Eight wall cabinet carcasses | Mixed part sizes on one material |
| `drawer-boxes` | 12 drawers: 12mm sides + 6mm bottoms | **Two materials** - subproblem independence |
| `closet-organizer` | Many identical shelves and uprights | High `qty`, repetition |
| `workbench-cabinet` | Ply carcass + MDF fronts | Mixed materials and part scales together |
| `grain-locked-panels` | Every part `rotationPolicy: 'locked'` | Rotation constraint under pressure |
| `mixed-stock` | Two full sheets + one half sheet | Stock instance selection with mixed sizes |
| `tight-fit` | Parts that exactly tile a sheet minus kerf | **Kerf correctness canary** - 0.7% waste is achievable and that is the kerf alone, so an off-by-one kerf error shows up immediately as an unplaceable part |
| `oversized-part` | One part larger than any stock | Graceful `unplacedParts`, no crash |
| `insufficient-stock` | More parts than stock can hold | Exact shortfall accounting |

Each fixture declares its own purpose as `role: 'benchmark' | 'held-out' | 'correctness'`, so
the bench harness reads it from the file rather than hardcoding a list. The last two are
correctness fixtures, excluded from the waste benchmark.

**Overfitting guard:** tune the solver against 6 fixtures. `mixed-stock` and
`grain-locked-panels` are **held out** - they run in the bench and must clear 15%, but no
heuristic or constant may be tuned by looking at them. If they fail, that is real signal, not
a tuning target.

Per `CLAUDE.md`: when a bug is found, add a fixture first, fix second.

---

## 5. Benchmark harness

Waste percentage is deterministic given a seed, so unlike timing it can be gated in CI with
zero flakiness. That is worth exploiting.

- `npm run bench` becomes `vitest run test/bench` (currently `vitest bench --run`, which
  measures wall-clock time - the wrong quantity for this project). This is a deliberate
  change to `package.json`.
- The run prints a table: fixture, waste %, sheets used, unplaced count, solve time (ms).
- It compares waste and sheet count against a committed `test/bench/baseline.json` and
  **fails on any regression**. Solve time is printed but never asserted.
- `npm run bench:update` rewrites the baseline. Baseline changes then appear as a reviewable
  diff in the PR, which is exactly what "improves one fixture and regresses three is a
  regression" needs to be visible.
- Add a `Bench` step to `.github/workflows/ci.yml` after `Test`.

---

## 6. PR sequence

`main` is never committed to directly. Each item is one branch, one squash-merged PR, CI green.

**PR 1 - `feat/domain-geometry-units` - DONE** ([#2](https://github.com/carloswaibl/Cutz/pull/2), merged as `b30de6c`)
`geometry.ts` + `units.ts` + tests. No solver dependency. Fractional parse/format edge cases:
`23-1/4`, `23 1/4`, `1/2`, `23"`, garbage input, values off the 1/16 grid, negative and zero.

Landed with 84 tests. Decisions made during the work, for reference by later PRs:

- `clearance(a, b)` in `geometry.ts` is the kerf primitive: it takes the **larger** of the
  two axis gaps, since parts clearing each other on one axis need no cut on the other.
  Placements are legal when `clearance >= kerf`. Invariant 1 in PR 2 is built on this.
- `EPSILON` is 1e-6mm and is justified in practice, not theory - `4'` parses to
  `1219.1999999999998`. Every dimension comparison in the packer and checker must go
  through the tolerant helpers rather than `<=` / `===`.
- `parseLength` accepts zero (a kerf of 0 is meaningful). **Per-field positivity checks are
  PR 2's job**, not the parser's.
- `parseLength` rejects combined feet-and-inches rather than parsing it, since reading
  `4' 6"` as 4 feet would be plausible-looking and half a foot wrong.
- `formatLength` nudges by one ULP before rounding: 590.55mm - exactly 23-1/4" - is stored
  as a double just below itself, so `toFixed(1)` would render it 590.5.

**PR 2 - `feat/domain-validate` - DONE**
`validate.ts`: input validation and all six invariant checks, including the guillotine
checker. Tested against **hand-built** layouts, not solver output - the checker must be
trustworthy before anything is checked with it.

Landed with 89 new tests (173 total). Decisions made during the work:

- **`domain/instances.ts` is a new file**, owning the `` `${stockId}#${index}` `` convention
  from §3.2 as `stockInstanceId` / `parseStockInstanceId`. The checker has to read instance
  ids back, so the format needed one owner rather than being minted in `solver/instances.ts`
  and re-derived here. PR 4 imports these instead of defining the format. `parseStockInstanceId`
  splits at the **last** separator, and rejects non-canonical spellings like `s#007` so an id
  is a stable name for a sheet.
- **A seventh check was added: waste correctness.** `wastePct` and `totalWastePct` are
  recomputed per §3.4 and compared. A wrong waste number cannot crash and no invariant would
  catch it, and PR 5 freezes these numbers into `baseline.json` as if they were right.
- **`Layout.wastePct` is a fraction in 0..1**, not a 0..100 percentage. The name says
  otherwise; §3.4's formula is authoritative. Now documented on the type itself.
- **`placementRect` and `usableArea` live in `geometry.ts`**, for the same reason the rest of
  that file does: a packer and a checker that disagree about where a rotated part sits
  disagree about everything downstream.
- Two checks beyond the six that fall out of resolving references: a layout naming a stock
  instance beyond the stock's `qty` (a sheet nobody owns), and two layouts for one sheet
  (which would let each per-sheet check see half the parts and pass).
- `unplacedParts` entries must have a positive integer `qty`. Otherwise invariant 6 balances
  by cancellation - placing five of four parts and reporting minus one unplaced adds up.
- Input issues carry a `severity`. Structural nonsense is an `error`; a part that simply
  cannot be placed is a `warning`, because the solver runs fine and says so in `unplacedParts`.
- The guillotine step cap is exposed as a parameter so the `'unverified'` path is tested
  directly, rather than by constructing an adversarial layout that may stop being adversarial.
- **Not tested: a crafted cut-level dead end** where the first candidate cut must be
  abandoned for a later one. Every attempt collapsed into a layout that was either wholly
  valid or wholly invalid. Covered instead by 120 randomly generated layouts built by
  performing actual guillotine cuts (so the answer is known by construction), plus
  permutation-invariance on the pinwheel, since candidate cuts are enumerated in part order.

**PR 3 - `feat/solver-fixtures` - DONE**
Fixture JSON files, typed loader, shape validation, plus `rng.ts` and its determinism tests.
No solver yet. Lands early so later PRs can bench against it.

Landed with 55 new tests (228 total). Decisions made during the work:

- **Fixtures had to be sized deliberately to make the 15% bar reachable, and §4's list as
  written could not have cleared it.** A single 6ft bookshelf is ~3.7M mm² of parts on a
  2.98M mm² sheet - 1.25 sheets, so two get opened and waste is 37% under a *perfect* pack.
  Sheet granularity, not packing quality, dominates any project of one or two sheets. Every
  benchmark fixture is therefore authored to a rule: **enough parts that the material needs
  ~3+ sheets, with part sizes that tile the usable width**, verified by a hand-checked row
  layout recorded in the fixture's own `description`. `bookshelf` became three matching
  units for this reason, `cabinet-carcass` eight carcasses.
- Fixture dimensions are **round millimetres**, with `tight-fit` alone authored from
  imperial so its literals are the doubles `units.ts` actually produces
  (`1219.1999999999998` is `inchToMm(48)`). A test pins them to `inchToMm` so nobody tidies
  them to `1219.2` and silently retires the EPSILON path.
- `tight-fit`'s achievable waste is **0.7%, not zero** - that is the four kerf lines, which
  are real material. Worth stating because PR 5 freezes it into `baseline.json`.
- Fixtures carry `materials` and a **`role` discriminant** (`benchmark` | `held-out` |
  `correctness`), so one file is the single source of truth and PR 5's bench reads held-out
  status rather than hardcoding a list. `expectedUnplaced` exists only on `correctness`.
- **The loader throws**, unlike `validate.ts`. Deliberate: that module guards data a user
  typed and owes them an actionable message, this one guards data we wrote and a stack
  trace naming the file and field is the most useful thing it can produce.
- JSON is read with `node:fs` and parsed as `unknown` rather than imported through
  `resolveJsonModule`, so the validation is real instead of TypeScript inferring a shape
  nobody checked.
- The loader rejects a **grain-locked part on a grainless material**. Locking a part on MDF
  or melamine is a fixture-authoring slip that would make the packing problem harder for a
  reason that does not exist in the workshop.
- The fixtures gave PR 2's `validateInputs` its first run against realistic data. All eight
  benchmark and held-out fixtures report **zero issues**; `oversized-part` reports exactly
  one `part-too-large` warning; `insufficient-stock` reports nothing, because a capacity
  shortfall is the solver's answer to give, not the validator's.
- `rng.ts` exposes `createRng(seed) -> { next, int, shuffle }`. The **output stream is
  frozen by golden vectors** - it is part of the product's contract, since a saved project
  must lay out identically when reopened, so changing it has to show up as a diff in review.
  The seed is reduced to 32 bits, documented. `shuffle` copies rather than mutating, and
  reads its slots through a bounds-checked helper: narrowing `noUncheckedIndexedAccess`
  away with an `=== undefined` guard would silently skip swaps when `T` includes `undefined`.

**Fixture waste under a throwaway row packer**, as a floor on what PR 4 must achieve. Every
benchmark and held-out fixture clears 15% with a naive shelf heuristic, so the free-rect
packer has real margin. Both correctness fixtures reproduced their declared shortfalls
exactly, which is independent confirmation of those numbers:

| Fixture | Sheets | Waste |
|---|---|---|
| `bookshelf` | 3 | 4.9% |
| `cabinet-carcass` | 5 | 10.2% |
| `closet-organizer` | 3 | 2.8% |
| `drawer-boxes` | 3 | 9.8% |
| `grain-locked-panels` | 3 | 3.5% |
| `mixed-stock` | 3 | 3.4% |
| `tight-fit` | 1 | 0.7% |
| `workbench-cabinet` | 3 | 4.3% |

**PR 4 - `feat/guillotine-greedy`**
`instances.ts`, `freeRects.ts`, `pack.ts`, `guillotine/index.ts`. Single fixed heuristic and
split rule, fully deterministic, no randomness. Every fixture solved and run through all six
invariant checks. PR reports the greedy waste number per fixture - this is the number the
improvement pass has to beat.

**PR 5 - `feat/bench-harness`**
Bench runner, `baseline.json` seeded from PR 4's greedy output, `package.json` script change,
CI step. Deliberately separate from PR 4 so the baseline is established before it is moved.

**PR 6 - `feat/solver-improve`**
`objective.ts`, `improve.ts`, `solver/index.ts`, and the `SolverConfig.effort` field (pending
the §3.6 sign-off). PR body reports the waste delta per fixture against the PR 5 baseline,
and updates the baseline in the same PR. Also adds the two-identical-runs determinism test
across the full pipeline.

**PR 7 - `chore/m1-exit`**
Whatever tuning is needed to clear 15% on all eight benchmark fixtures, a short
`docs/solver-design.md` covering the free-rect algorithm and the guillotine checker, and a
`CLAUDE.md` update for `geometry.ts` and any `SolverConfig` change. Delete
`test/scaffold.test.ts` - it exists to be replaced by the M1 suite.

---

## 7. Risks

| Risk | Mitigation |
|---|---|
| **Guillotine checker is wrong** and rubber-stamps uncuttable layouts. The worst outcome in M1 - it invalidates every other test. | Built and tested before the solver, against hand-built layouts including the pinwheel. Cap reports `'unverified'`, never `'valid'`. |
| **Kerf off-by-one at sheet edges** - applying kerf where no cut occurs, or omitting it between adjacent parts. Passes a naive overlap check. | The `tight-fit` fixture only fits if kerf accounting is exact. Invariant 1 catches the other direction. |
| **Checker exponential blowup** on adversarial layouts. | Memoized on region; hard step cap; `'unverified'` result surfaces it instead of hanging. |
| **Overfitting to fixtures** - tuning until the benchmark passes rather than until the solver is good. | Two held-out fixtures never used for tuning. |
| **Solver perfectionism**, the listed anti-pattern. | Hard 15% stop. Fixed iteration budget. No SA unless a fixture demonstrably needs it. |
| **Guillotine assumptions leaking outside `solver/guillotine/`** and blocking v2 nesting. | Nothing outside that directory may import from it except `solver/index.ts`. Everything else talks to the `Solver` interface. |
| Determinism regression from an accidental `Math.random()`. | Already blocked by the Biome GritQL plugin, plus an explicit two-run equality test. |

---

## 8. Open items

1. **`SolverConfig.effort`** (§3.6) - **approved**. Changes a type documented in `CLAUDE.md`;
   lands in PR 6, `CLAUDE.md` updated in PR 7.
2. **`geometry.ts` is a new file** outside the documented directory listing (§3.1) -
   **approved, landed in PR 1**. `CLAUDE.md` still to be updated in PR 7. The same applies to
   **`domain/instances.ts`**, landed in PR 2, and to the **seventh (waste) check**, which
   `CLAUDE.md` currently describes as six invariants.
3. **`npm run bench` changes meaning** from wall-clock benchmarking to waste benchmarking
   (§5) - **approved**. A semantic change to an existing documented command; lands in PR 5.
4. **Unlimited stock is not modelled.** `Stock.qty` is required and finite, so "I can buy as
   many sheets as I need" is expressed as a large `qty`. Fine for M1; M2's UI should decide
   whether to surface an explicit "unlimited" affordance.
5. **M0 was skipped** (§2). Importer risk for M4/M5 remains unretired.
6. **Fixture waste figures are a floor, not a promise.** The PR 3 table was produced by a
   throwaway row packer, not by the real solver. If PR 4's free-rect packer does *worse*
   than a naive shelf heuristic on a fixture, the packer is wrong, not the fixture. A
   fixture only gets redesigned if it turns out to be unreachable for a structural reason.
