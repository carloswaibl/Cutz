# M7 - CNC free-form nesting

*Implementation plan for the first v2 milestone: carrying true part outlines through the
whole pipeline, generalising the solver seam the project has been holding open since M1,
and adding a raster nesting engine that packs irregular parts for a CNC router.*

Companion to `docs/project-plan.md` §6 (V2 backlog, first entry). Read `CLAUDE.md` first -
the non-negotiable constraints are binding, with one owner-approved exception recorded in
§7 decision 8. `plan-m4.md` §2 (why parts import as bounding boxes) and `solver-design.md`
(the guillotine engine, its objective function and its seven invariants) are the closest
prior context; this milestone revisits both.

---

## 1. Goal and exit criteria

**Goal:** A woodworker with a CNC router gets layouts that are actually worth having. They
import an SVG or STL of irregular parts - a curved bracket, a chair seat, an L-shaped
gusset - switch the project from Table saw to CNC router, and get a nested layout that
respects kerf and grain, packs parts at angles inside each other's concavities, renders as
true outlines on screen and on paper, and exports as real polygons to SVG and DXF. The
table-saw path is untouched and stays the default.

**M7 exits when all of the following hold:**

1. **A part can carry a true outline, and nothing that already worked cares.** `Part` gains
   an optional `outline` in part-local millimetres, with `width`/`height` still the
   bounding box. That last detail is what keeps `packGuillotine`, `cutplan.ts`,
   `placementRect`, both renderers and both exporters working unchanged - they keep reading
   the box they always read. A hand-entered rectangle has no outline and never needs one.
2. **The importers stop discarding the polygon they already compute.** Today the outline
   dies at exactly two lines - `src/import/svg/index.ts:295` and
   `src/import/stl/index.ts:176` - each handing `contour.box` onward and letting
   `contour.points` fall out of scope. `Contour.points` already exists, `nestContours`
   already separates outers from holes, and `minAreaBox` already runs on the real points.
   After this milestone that polygon reaches `Part`, and the import preview draws the shape
   rather than a box around it.
3. **`Placement` can express an orientation.** `rotated: boolean` is replaced by
   `angleDeg: number`. Guillotine emits only `0` and `90`, so `placementRect` returns
   exactly today's answer for today's inputs. `Placement` is never persisted (`Project`
   stores parts/stock/config and results are recomputed), so this costs no storage
   migration.
4. **A nesting solver exists behind the `Solver` interface and is selected per project.**
   `SolverConfig.mode` picks `'guillotine'` (default) or `'nest'`; `src/solver/index.ts`
   becomes a registry keyed on it and `solve()` keeps its exact signature, so the six
   existing call sites are untouched. This is the drop-in `project-plan.md` §2 promised,
   and §1 criteria 1-3 are the reason it is not actually a drop-in.
5. **Nested results are validated as strictly as guillotine ones, by rules that apply.**
   `checkResult` runs `not-guillotine-decomposable` only in guillotine mode, and checks
   kerf separation and usable-area containment against real polygons in nest mode. A nested
   layout that overlaps, breaks kerf, or rotates a grain-locked part fails the checker.
6. **The nester beats guillotine on irregular parts, measurably.** New bench fixtures with
   genuinely non-rectangular parts, and `npm run bench` reports the nest-vs-guillotine
   waste delta on the same fixtures. That single number is the justification for the
   milestone; a nester that does not beat a bounding-box packer has not earned its place.
7. **The existing eight guillotine baselines do not move.** They have no outlines, so they
   are unaffected by construction - the ratchet in `test/bench/bench.test.ts` is what proves
   it rather than asserts it.
8. **Solving no longer blocks the render path.** `useCutListState.ts:156` currently calls
   `solve()` synchronously inside a `useMemo`. Nesting moves solving into a Web Worker with
   cancellation, stale-response dropping, and a synchronous fallback. Same seed still gives
   the same layout - see §3.6 and §7 decision 8.
9. **The UI never lets a nested layout be mistaken for a table-saw one.** In nest mode the
   cut-sequence panel is replaced by a plain statement that no guillotine cut sequence
   exists, not left showing a stale or invented one. A project holding outlines but set to
   Table saw says its parts will be cut as rectangles.
10. **No new runtime dependency.** The raster nester is plain TypeScript over `Uint32Array`;
    the worker uses Vite's native `new Worker(new URL(...), { type: 'module' })`. Bundle
    impact is the nester's own code and nothing else, per `CLAUDE.md` constraint 6.
11. **Verification.** `npm run typecheck && npm run test:run && npm run lint && npm run
    build` all clean, `npm run bench` reporting the deltas from criteria 6 and 7, plus a
    real browser pass: import an SVG and an STL and confirm true outlines in the preview;
    solve in Table saw mode and confirm today's behaviour; switch to CNC router and confirm
    parts nest at angles; export SVG and DXF and confirm polygons rather than bounding
    boxes; print preview; reload and confirm the mode persists and a pre-M7 project opens in
    guillotine mode with no outlines and no error.

**Explicitly not an exit criterion:** G-code, toolpath ordering, or any machine program.
Nesting produces a layout, not instructions for a spindle. `project-plan.md` §6 lists G-code
as its own v2 backlog item and it stays there.

---

## 2. Scope

### In scope

- `src/domain/polygon.ts` - polygon primitives promoted out of `src/import/geometry.ts`
  plus the few the nester and validator need (§3.2).
- `Part.outline`, `Placement.angleDeg`, `SolverConfig.mode` and `SolverConfig.rotationSteps`
  in `src/domain/types.ts` (§3.3).
- `src/domain/validate.ts` - mode-aware invariant checking (§3.4).
- Outline retention through both importers, and an import preview that draws the real shape.
- `src/solver/nest/` - the raster/bitmask nesting engine (§3.5).
- `src/solver/search.ts` - the restart/hill-climb harness generalised out of `improve.ts` so
  both engines share it, and `objective.ts` decoupled from guillotine's `PackResult`.
- A Web Worker solve path in `src/ui/` (§3.6).
- Machine selector, polygon rendering in `SheetFigure`, polygon DXF output, and the
  cut-sequence replacement in nest mode (§4).
- Nest bench fixtures, a widened `Fixture` type, and mode-aware bench assertions.

### Out of scope

- **Interior cutouts as usable space.** Holes are still discarded with a counted warning,
  exactly as `plan-m4.md` §2 and `project-plan.md` §9 question 2 describe. Nesting small
  parts inside a larger part's holes is a real further win and a materially larger change -
  it needs holes modelled on `Part`, subtracted from the occupancy grid, and reasoned about
  by the validator. Deliberately not bundled into an already-large milestone.
- **Continuous-angle search.** Rotation is a discrete configurable set (§3.3). Continuous
  angles are more expensive, harder to keep deterministic, and a poor fit for a browser with
  no worker pool.
- **Mirroring parts.** A flipped panel shows its back face; on veneered or finished stock
  that is a different part, not a free transform the solver may apply.
- **True-outline cut plans.** `cutplan.ts` stays guillotine-only and untouched. There is no
  such thing as a guillotine cut sequence for a nested layout, which is exactly why §1
  criterion 9 replaces the panel rather than adapting it.
- **G-code and toolpath ordering** (§1).
- **Offcut tracking, 1D linear stock, project export-as-file** - separate `project-plan.md`
  §6 v2 backlog items, none of them started or scheduled by this milestone.
- **Re-tuning the guillotine engine.** Its heuristics, split rules and effort budgets are
  unchanged. The only guillotine code this milestone touches is what it shares with the
  nester (§3.5's search harness, `objective.ts`), and the bench ratchet guards it.

---

## 3. Architecture

### 3.1 Modules

```
src/domain/
  polygon.ts     # Point, polygon area/bounds/containment, hull, min-area box,
                 # simplify, rotate, separation - and partOutline/placementPolygon/
                 # placedArea, the accessors that erase Part.outline's optionality
src/solver/
  search.ts      # restart + hill-climb harness, engine-agnostic, seeded
  nest/
    raster.ts    # Mask, scanline polygon rasterisation, conservative rounding
    collide.ts   # word-shifted intersects/orInto over Uint32Array grids
    place.ts     # bottom-left-fill over the allowed angle set
    index.ts     # NestSolver: Solver - per-material subproblems, multi-sheet
src/ui/
  state/
    solveWorker.ts    # worker entry: imports solve(), posts results back
    useSolve.ts       # request ids, stale-drop, cancellation, sync fallback
```

`src/domain/polygon.ts` is where the geometry has to live, not `src/import/geometry.ts`
where it currently sits: `biome.json` bars `src/solver/**` from importing `**/import/**`
("The file boundaries depend on domain/, never the other way round"), so a solver cannot
reach `convexHull`, `minAreaBox` or `pointInPolygon` today. ~~`src/import/geometry.ts`
re-exports the moved symbols, so no importer code changes.~~ **Shipped without the shim** -
the importers cut over to `../domain/polygon` directly and `src/import/geometry.ts` keeps only
the contour-filtering thresholds. See PR 2's note in §5.

The worker wrapper lives in `src/ui/`, never `src/solver/`. `biome.json` denies `window`,
`document` and friends inside `solver/**`, and the engine must stay headless and testable
in Node - the worker is a delivery mechanism, not part of the solver.

### 3.2 Polygon primitives

Moved from `src/import/geometry.ts`: `Point`, `OrientedBox`, `signedArea2`, `polygonArea`,
`boundsOf`, `pointInPolygon`, `convexHull`, `minAreaBox`.

New:

- `simplify(points, toleranceMm)` - Douglas-Peucker. Flattened SVG curves run to hundreds of
  vertices; every one of them costs on every collision test and every rasterisation.
- `rotatePolygon(points, angleDeg)`, `translatePolygon(points, dx, dy)`.
- `partOutline(part)` - returns the four rectangle corners when `outline` is absent, so **no
  call site ever branches on the optional field.** This is what keeps an optional property
  from becoming the optional-field soup `CLAUDE.md` warns against.
- `placementPolygon(part, placement)` - `partOutline` rotated by `angleDeg` and translated
  to `x`/`y`. The single mapping from a placement to its real geometry, the way
  `placementRect` is today for boxes.
- `polygonSeparation(a, b)` - minimum distance between two polygons, negative on overlap.
  Edge-pair distance plus a containment test.
- `polygonInRect(points, rect)`.
- `placedArea(part, mode)` - see §7 decision 4.

### 3.3 Domain model changes

```ts
// Part
/**
 * Closed polygon in part-local millimetres: origin at the bounding box top-left,
 * x right, y down. Absent means "this part is its bounding box" - a hand-entered
 * rectangle, which stays the common case.
 * Invariant: boundsOf(outline) == { 0, 0, width, height } within EPSILON.
 */
outline?: readonly Point[];

// Placement - replaces `rotated: boolean`
/** Degrees clockwise about the part's own top-left origin. Guillotine emits 0 or 90. */
angleDeg: number;

// SolverConfig - both optional with defaults, mirroring `effort?: SolverEffort`
mode?: 'guillotine' | 'nest';      // default 'guillotine'
rotationSteps?: 2 | 4 | 12 | 24;   // equally spaced over 360deg, default 4
```

Keeping `width`/`height` as the bounding box is the compatibility decision the whole
milestone rests on (§1 criterion 1). Making the two `SolverConfig` fields optional with
defaults follows the precedent `effort` already set in that exact interface, which means old
IndexedDB records load unchanged and **no `DB_VERSION` bump is needed** - IndexedDB stores
are schemaless and both fields read as their defaults.

**Grain lock restricts a part to `{0, 180}` regardless of `rotationSteps`.** 180 degrees
keeps the grain running along the same axis, so it is physically legal on a grain-locked
part, and on an asymmetric outline it is a real packing win that `rotated: boolean` cannot
express today. A `free90` part gets the full step set.

### 3.4 Validation

`ResultCheckOptions` already carries `config`, so `config.mode` is reachable with no
signature change.

- `not-guillotine-decomposable` runs **only** when `mode === 'guillotine'`. Today
  `checkResult` runs `buildCutTree` on every sheet unconditionally, which would fail every
  nested layout by definition.
- `kerf-separation` uses `polygonSeparation` when either part has an outline or a
  non-axis-aligned angle, and keeps the existing `clearance(Rect)` fast path otherwise -
  exactly equivalent for axis-aligned rectangles and far cheaper.
- `outside-usable-area` uses `polygonInRect`.
- `illegal-rotation` checks `angleDeg` against the legal set for the part's
  `rotationPolicy`, replacing today's `placement.rotated && policy !== 'free90'`.
- New `validateInputs` issues: `outline-bounds-mismatch` (error - the §3.3 invariant),
  `outline-too-few-points` (error), `outline-self-intersecting` (warning).

`validateInputs`'s `fitsAnywhere` also becomes mode-aware: its axis-aligned bounding-box
test would warn `part-too-large` about parts a nester could place at an angle.

### 3.5 The nesting engine

Raster/bitmask, not no-fit-polygon (§7 decision 2).

- **Mask.** `{ cols, rows, bits: Uint32Array }`, row-major, 32 cells per word. Scanline
  polygon fill with **conservative rounding** - a cell is occupied if the polygon touches it
  at all. Default cell size 1mm; a 2440x1220 sheet is ~3M cells, ~372KB, which is nothing.
  Masks are cached per `(part, angle)`.
- **Kerf.** Dilate the *candidate* mask by the full kerf and test it against the exact
  occupancy of already-placed parts, then OR the *exact* mask in. That yields separation
  >= kerf between any two parts, is order-independent, and charges nothing at the sheet edge
  where no cut happens - matching the rule `freeRects.ts` already follows for guillotine.
  Containment against the usable area is tested with the exact, undilated mask.
- **Placement.** Bottom-left-fill over the allowed angle set, lowest `y` then lowest `x`.
- **Search.** `src/solver/search.ts`, generalised out of `improve.ts`: deterministic
  baselines, then seeded restarts, then hill-climbing, parameterised by a "pack one candidate
  ordering" function so both engines share the loop, the `Rng` threading and the
  reproducibility contract.

Because the raster is conservative, real separation is never *less* than kerf - the
approximation errs in the safe direction. The exact polygon check in `validate.ts` is what
certifies each result, so grid resolution is a quality knob, never a correctness one.

`objective.ts` stops importing `./guillotine/pack`. `SolutionScore` is computed from a
solver-agnostic shape and `maxFreeRectArea` becomes an optional third criterion rather than
the hardcoded `0` that `scoreResult` uses today.

### 3.6 Async solve

One persistent module worker, a monotonic request id, stale responses dropped, the last good
result retained while a solve is in flight, and a synchronous fallback when `Worker` is
unavailable. `useCutListState`'s solve `useMemo` becomes a `useSolve` hook; everything
downstream reads the same `result`/`solverError` shape it does today.

**No wall-clock-based early stopping anywhere.** Iteration budgets only. A time-based cutoff
would make results depend on machine speed and destroy the determinism contract that
`test/solver/rng.test.ts`'s golden vectors exist to protect.

---

## 4. UI

- **Machine selector** in `ConfigBar`: Table saw (guillotine) or CNC router (nesting),
  persisted per project via `SolverConfig.mode`. Guillotine is the default and what every
  existing project opens as.
- **`SheetFigure.tsx:238`** - `PlacedPartRect` renders a `<polygon>` when the part has an
  outline and keeps today's `<rect rx={1.5}>` otherwise. Everything derived from the box
  (label centroid, font sizing, `PieceBadge` anchor, the `showLabel`/`showDims` size gates)
  keeps using the bounding box. `GrainArrow` at line 604 is existing `<polygon>` precedent in
  this same file.
- **SVG export needs no work.** `export/svg.ts` renders `SheetFigure` through
  `renderToStaticMarkup`, so it follows automatically - the documented design intent, now
  collected on.
- **DXF export is one call.** `closedPolyline(dxf, layer, points)` at `dxf.ts:238` is already
  generic over `DxfPoint[]` and `rectPolyline` is just a four-point caller; R12
  `POLYLINE`/`VERTEX`/`SEQEND` handles N vertices natively. `partLabels` still takes the box.
- **Rotated geometry is computed in `domain/polygon.ts`, not via an SVG `transform`**, so the
  renderer, the DXF writer and the invariant checker cannot disagree about where a part is -
  the same reasoning `dxf.ts`'s header comment already gives for sourcing every coordinate
  from `domain/geometry.ts`.
- **Cut sequence in nest mode.** The panel is replaced by a plain statement that a nested
  layout has no guillotine cut sequence. `showCutSequence` drives four destinations at once
  (screen, print, SVG, DXF) and has two on-screen controls that must stay in sync; in nest
  mode all four simply have no cut lines to draw.
- **Import preview draws the real outline**, which is also the cheapest end-to-end check that
  outline retention actually works.
- **A project holding outlines but set to Table saw says so** - a quiet note that its parts
  will be cut as rectangles, not a silent downgrade.

---

## 5. Work breakdown and PR sequence

Nine sequential PRs. Each is independently mergeable and CI-green; each gets its own
`plan-next` pass before it starts, the same way M6's PR30 preceded PR31-34. This is a larger
milestone than M4-M6, and the shape that keeps it shippable is that **PRs 2-5 are pure
refactors with no user-visible change at all** - the feature only becomes visible in PR 6.
Exact scope may shift as each PR's own "what shipped" notes get added here.

### PR 1 - `docs/m7-plan` - this document

- `docs/plan-m7.md`.
- `docs/project-plan.md` §6: an M7 entry, and CNC free-form nesting removed from the V2
  backlog line now that it is an active milestone.
- `docs/project-plan.md` §9 question 2: reopened for nest mode, recorded in the doc's
  existing style for a resolved-then-revisited question.

### PR 2 - `feat/domain-polygon` - polygon primitives, no behaviour change - **shipped**

- `src/domain/polygon.ts` per §3.2; `src/import/geometry.ts` re-exports the moved symbols.
- Tests for the new primitives, especially `polygonSeparation` (touching, overlapping,
  nested, and disjoint pairs) and `simplify` (a flattened arc keeps its shape within
  tolerance).
- Nothing else changes. The importers keep passing untouched tests through the re-export.

**What shipped, and what changed on the way.**

- **No re-export shim; the six importers cut over to `../domain/polygon` directly.** §3.1
  proposed re-exporting the moved symbols from `src/import/geometry.ts` to keep the importer
  diff at zero. Cutting over instead costs six import lines and leaves exactly one home per
  symbol rather than two names for each. `src/import/geometry.ts` now holds only what was
  never geometry: `MIN_CONTOUR_AREA_MM2`, `MIN_CONTOUR_EXTENT_MM` and `isDegenerate` - a
  policy about what counts as a *part*, which is an importer's question and nobody else's.
  `ANGLE_SNAP_DEGREES` moved with `minAreaBox`, its only caller.
- **`polygonSeparation` samples edge midpoints, not just vertices, and this is load-bearing.**
  The first implementation detected overlap from strictly-interior vertices plus properly
  crossing edge pairs. Both miss the single most common overlap on a cut sheet: two
  rectangles in adjacent columns, sharing flush top and bottom edges. No vertex of either is
  strictly inside the other, and no edge pair *properly* crosses because every candidate pair
  meets at a collinear endpoint - so the pair reported as comfortably disjoint. Caught by the
  new tests before anything depended on it. Sampling each edge's midpoint as well fixes both
  the detection and the magnitude, and `test/domain/polygon.test.ts` pins the flush-band case
  with the reason.
- **Containment is decided by a metric margin, not by `pointInPolygon` alone.** A sample
  landing exactly on the other ring's boundary is a coin flip under the even-odd rule, and
  that is precisely what happens when two parts are butted edge to edge. A sample counts as
  intruding only when its distance to the other boundary exceeds `EPSILON`, so touching reads
  as touching regardless of which way the parity test falls.
- **`polygonSeparation` is Euclidean where `clearance(Rect)` is axis-of-separation, and the
  divergence is deliberate.** `clearance` takes the *larger* of the two axis gaps, because a
  guillotine separation is made by one edge-to-edge saw cut and a cut has an axis - two parts
  in different columns need no vertical gap at all. A router bit has no axis of separation, so
  the real gap between two nested parts is the diagonal one. For two rectangles offset 3mm in
  x and 4mm in y, `clearance` is 4 and `polygonSeparation` is 5. Both are right for their own
  machine, which is why §3.4 keeps the rectangle fast path rather than replacing it. Pinned by
  a test that asserts the divergence on purpose, so nobody later "reconciles" them.
- **The overlap magnitude is documented as a lower bound on penetration depth, and only the
  sign is contractual.** Exact penetration depth for concave polygons needs convex
  decomposition - the rabbit hole §7 decision 2 already declined for NFP. Where the bound is
  loose the pair reports a gap near zero rather than a negative one, which degrades the
  *message* a user reads and never the invariant: a near-zero gap is still below any real kerf
  and still fails the check.
- **`simplify` cuts the ring at two anchors rather than treating vertex 0 as an endpoint.**
  Douglas-Peucker pins its endpoints, so running it on a closed ring as though the first
  stored vertex were an endpoint shaves the shape asymmetrically around whichever vertex
  happened to be stored first - and two copies of one part, stored starting from different
  vertices, would simplify differently and stop grouping into a quantity. Cutting at vertex 0
  and the vertex farthest from it makes the result independent of where the ring starts, which
  a test pins.
- **`partOutline`/`placementPolygon`/`placedArea` are not here.** §3.1 lists them in
  `polygon.ts` and §5 assigns them to PR 3; they read `Part.outline` and `Placement.angleDeg`,
  which PR 3 introduces. §5 is the one that governs.
- Verified: `typecheck`, `test:run` (840 passing), `lint` and `build` clean, and `npm run
  bench` reporting the eight existing baselines unmoved. No browser pass - nothing
  user-visible changes until PR 8.

### PR 3 - `feat/domain-outlines` - model and validator, no user-visible change - **shipped**

- `Part.outline`, `Placement.angleDeg` replacing `rotated`, `SolverConfig.mode` and
  `rotationSteps` per §3.3.
- `partOutline`/`placementPolygon`/`placedArea` accessors.
- Mode-aware `validate.ts` per §3.4.
- Guillotine emits `angleDeg: 0 | 90`; `placementRect` returns identical results.
- Tests: a rectangle with and without an explicit outline validates identically; the new
  input issues fire; `illegal-rotation` still catches a rotated grain-locked part.

**What shipped, and what changed on the way.**

- **Mode, not shape, decides whether a placement is measured as a box or as a polygon.** §3.4
  says `kerf-separation` uses `polygonSeparation` "when either part has an outline". Implemented
  literally, that silently changes the *guillotine* path the moment PR 4 starts attaching
  outlines: two imported parts set to Table saw would pass the kerf check whenever their curves
  cleared, even with their bounding boxes squarely on top of each other - which is precisely the
  uncuttable layout the checker exists to catch. It also contradicts §7 decision 4, which already
  says a part consumes its whole box on a saw. So `isPlainBox` returns true for *every* guillotine
  placement, and the polygon predicates run only in nest mode. Caught by a test asserting that the
  same nested pair is valid on a router and a kerf violation on a saw.
- **`Point` moved from `polygon.ts` to `types.ts`.** `Part.outline` made it a model type, and
  `types.ts` imports nothing - anything a model field is built from has to live there or
  `types -> polygon -> geometry -> types` becomes a cycle. Eight importers cut over, no re-export,
  per PR 2's precedent. `polygon.ts` still owns every operation on one.
- **`placementRect` moved to `polygon.ts` and generalised**, rather than being duplicated. It is
  now `boundsOf(placementPolygon(...))`. It could not stay in `geometry.ts`: an arbitrary angle
  needs the real polygon, and `geometry.ts` is deliberately polygon-free and sits *below*
  `polygon.ts` in the import graph. Keeping an axis-aligned copy there and a general one here is
  exactly the split `geometry.ts`'s own header warns against - a packer and a checker that
  disagree about where a turned part sits disagree about everything downstream. Seven call sites
  changed import path only.
- **`placementPolygon` anchors the turned shape's bounding box, not its rotated origin.** §3.2
  describes it as `partOutline` "rotated by `angleDeg` and translated to `x`/`y`". Done that way a
  90°-turned `w x h` part lands at `x ∈ [-h, 0]`, because `rotatePolygon` turns about the origin -
  nowhere near where any existing renderer draws it. Translating by `placement - bounds` instead is
  what keeps `Placement.x/y` meaning what it has always meant, and is what makes §1 criterion 3
  true rather than aspirational.
- **`rotatePolygon` now does quarter turns with exact integers.** `Math.cos(90°)` is 6.1e-17, not
  0, so a 600mm part came back 600.00000000000006mm wide. That is eight orders below `EPSILON` and
  broke nothing, but a quarter turn is the *only* thing the guillotine packer emits, so it is what
  every existing layout, cut plan and benchmark baseline is built from. Making it exact was
  cheaper than reasoning about where the noise might one day matter.
- **`illegal-rotation` is measured against the grain, deliberately not against `rotationSteps`.**
  A locked part is legal at 0 and 180 - a half turn keeps the grain on the same axis - and a
  `free90` part is legal at any angle. Checking the configured step set instead would mean
  re-solving a project at a coarser step count retroactively invalidated a layout already cut.
  `rotationSteps` is documented on the type as a search knob for that reason.
- **`non-quarter-angle` is a new violation kind rather than a reuse of `illegal-rotation`.**
  Confirmed with the project owner. They are two different faults - "the grain forbids this" and
  "this machine cannot cut it" - and invariant 4 does not cover the second: a part turned 45°
  still has a rectangular bounding box, and a sheet of such boxes can tile guillotine-cleanly
  while every part on it is uncuttable.
- **`unsupported-solver-mode` (error) closes the two-PR window before an engine exists.** Also
  confirmed with the owner. Without it, `mode: 'nest'` would return a guillotine layout while
  `checkResult` quietly stopped asking whether that layout is cuttable. Both solver entry points
  already gate on `hasErrors`, so the guard cost nothing new. **PR 6 deletes it.**
- **`Footprint.rotated` in `freeRects.ts` stays a boolean.** It is a solver-internal orientation
  flag over the two footprints a saw can produce, not a `Placement`. Leaving it alone kept the
  packer's tie-break ordering, and therefore the baselines, untouched; only what leaves the engine
  speaks in degrees.
- Verified: `typecheck`, `test:run` (880 passing), `lint` and `build` clean. `npm run bench`
  regenerated from scratch and diffed against the committed `baseline.json` - **bit-identical
  across all eight fixtures**, which is a stronger check than the ratchet itself, since that only
  asserts `<=`. No browser pass - nothing user-visible changes until PR 8.

### PR 4 - `feat/import-outlines` - stop discarding the polygon - **shipped**

- Retain `contour.points` through both importers per §1 criterion 2, simplified and
  normalised to bounding-box-local coordinates.
- `ImportedPart` gains the outline; `ImportDialog.handleCommit` carries it onto `Part`.
- ~~Import preview draws the real shape.~~ **Moved to PR 8** - see the first note below.
- Tests against the existing `test/files/` corpus: an imported outline's bounds equal the
  reported width/height; quantity grouping still keys on box dimensions only.

**What shipped, and what changed on the way.**

- **The preview outline moved to PR 8, resolving a contradiction this document was carrying.**
  §5's preamble promises PRs 2-5 are pure refactors with no user-visible change; §4 lists "the
  import preview outline" under PR 8; the bullet above claimed it for PR 4. The preview is a
  text table today, so this was a new component plus a rewrite of the dialog's "What can I
  import?" copy, which currently tells the user outlines are discarded. Confirmed with the
  project owner: it lands in PR 8, where the machine selector and the guillotine-with-outlines
  note can say what the shape actually means. Showing a true outline in a build that still cuts
  every part as a rectangle, with nothing on screen saying so, is the silent downgrade §4 exists
  to prevent.
- **`fitPolygonToBox` is the load-bearing addition, and it is in `domain/polygon.ts`.** §5
  described this PR as threading a polygon through, which undersells the one hard constraint:
  `outline-bounds-mismatch` is an **error**, checked with `approxEq`, and one stale outline
  blocks solving for every material at once. Three unrelated things push a ring a few hundredths
  off its box - float drift through the un-rotation, `simplify` shaving a vertex that happened
  to be extreme, and `groupRows` reporting `maxWidth`/`maxHeight` beside the first member's
  shape. One function absorbs all three, so no caller reasons about which it is exposed to.
- **Un-rotating by `-box.angle` is what makes the outline part-local, and it is the step that
  keeps rectangles rectangles.** `minAreaBox` folds its angle into `[0, 90)` and swaps the
  extents to follow, so `-angle` lands the box on the axes in both the swapped and unswapped
  cases. Without it, `nested-transforms.svg`'s rectangle drawn at 30° would store a four-point
  ring spanning a box larger than the part - a shape the user never drew, on the most ordinary
  input there is.
- **A shape that is its own bounding box stores no outline at all.** `isBoxOutline` is checked
  *after* the refit, so a rectangle that arrived 0.3mm under its group still stores nothing. All
  three real SVG corpus files and every hand-entered part come out with `outline: undefined`,
  which is what keeps an imported panel structurally identical to a typed one and keeps
  `Part.outline` meaning "this part is not a rectangle".
- **`UPDATE_PART` had to be fixed in the same PR, because this PR is what creates the hazard.**
  The reducer was a plain `{ ...p, ...action.part }` spread. The moment imported parts carry
  outlines, a user retyping an imported part's width strands one - and is then shown a hard
  error about a polygon they have never seen and cannot edit. The outline now stretches to the
  new box via the same `fitPolygonToBox`, which is what dragging a handle does in any drawing
  program. Dropping it instead would turn the part silently back into a rectangle, which is a
  change a woodworker discovers at the router. Verified in the browser, not only in tests.
- **Winding is normalised to clockwise.** `partOutline()` already documented its return as
  clockwise and the corners it synthesises for an outline-less part are, but an SVG path may be
  drawn either way and a mirroring transform flips it - so the promise held by luck. Now it
  holds by construction.
- **`simplify` at 0.1mm converges on a vertex count set by the geometry, not the exporter.** A
  150mm-radius circle comes back at 128 points whether the file sampled it at 240 or 2000. That
  makes it a normalisation rather than a compression, and it matters for grouping: the same part
  exported twice at different flattening settings must still collapse into a quantity of two. It
  is also why the tolerance sits an order of magnitude below `GROUP_TOLERANCE_MM`.
- **A sheared rectangle now keeps the parallelogram it actually is.** The `sheared` flag has
  always said "this box is strictly larger than the shape"; until now the shape itself was
  thrown away. It survives as a four-point outline, so a router can follow it even though the
  flag still stands for a saw. An unlooked-for win, pinned by a test.
- **Both importers' existing "produces parts that pass domain validation" tests were the right
  place for the contract, and only needed the outline carried across** exactly as
  `handleCommit` does. That makes `outline-bounds-mismatch` itself the assertion, over the whole
  `test/files/` corpus, rather than a hand-written bounds comparison that could drift from what
  the validator actually enforces.
- Verified: `typecheck`, `test:run` (915 passing, up from 880), `lint` and `build` clean, and
  `npm run bench` diffed against a run on `main` - **all eight baselines identical** in sheets,
  waste and unplaced. Plus a browser pass, which §5 does not require for this PR but which was
  the only cover for `ImportDialog.handleCommit`: an STL imported through the real dialog stores
  a 31-point outline whose bounds are exactly the part's reported size, round-tripped through
  IndexedDB, and retyping its width refits the outline onto the new box with no error raised.

### PR 5 - `feat/solver-registry` - the seam

- `src/solver/search.ts` per §3.5; `improve.ts` becomes a thin caller.
- `objective.ts` decoupled from guillotine's `PackResult`.
- `src/solver/index.ts` becomes a mode registry; `solve()`'s signature is unchanged.
- `npm run bench` must show the eight existing baselines bit-identical. This is the PR where
  a guillotine regression would hide, so it lands alone.

### PR 6 - `feat/nest-engine` - the nester

- `src/solver/nest/` per §3.5.
- New bench fixtures with irregular parts whose ideal pack is genuinely hand-checkable -
  L-shapes, T-shapes and triangles that interlock - plus one derived from a real file in
  `test/files/`. A widened `Fixture` type in `test/fixtures/index.ts` and mode-aware bench
  assertions.
- **Reports the nest-vs-guillotine waste delta** (§1 criterion 6) and nest solve times.

### PR 7 - `feat/async-solve` - off the render path

- `solveWorker.ts` and `useSolve.ts` per §3.6, with the measured numbers from PR 6 quoted in
  the PR description as the justification (§7 decision 8).
- Tests: a superseded request's result is dropped; the sync fallback produces an identical
  layout to the worker for the same seed.

### PR 8 - `feat/nest-ui` - make it visible

- Machine selector, polygon rendering, DXF polygon output, cut-sequence replacement, the
  guillotine-with-outlines note, and the import preview outline, all per §4.

### PR 9 - `chore/m7-exit-verification` - close it out

- Browser pass per §1 criterion 11.
- `CLAUDE.md` "Current status" updated, `src/solver/nest/` and `src/domain/polygon.ts` added
  to the directory listing, and the M7 conventions worth not breaking recorded there.
- `docs/solver-design.md` extended with the nesting engine, its objective and its invariants,
  alongside the guillotine sections that document M1.
- Record what shipped and what changed on the way, matching M4-M6's final-PR pattern.

---

## 6. Risk register

| Risk | Severity | Mitigation |
|---|---|---|
| **Milestone is materially larger than M4-M6** - four modules, a new engine, a threading change and a UI change | High | Nine PRs, of which 2-5 are pure refactors with zero user-visible change and full green CI. The feature is only exposed in PR 8, so an abandoned milestone leaves a better-factored codebase rather than a half-built one. |
| **Guillotine regresses while the shared seam is refactored** | High | PR 5 lands alone and must show the eight existing baselines bit-identical; the bench ratchet in `test/bench/bench.test.ts` is an assertion, not a report. Guillotine stays the default mode throughout. |
| **Raster resolution is not accurate enough for a router** | Medium | Conservative rounding errs toward more clearance, never less, so the grid is a quality knob rather than a correctness one. Exact `polygonSeparation` in `validate.ts` certifies every result independently of the grid. |
| **Waste percentages stop being comparable between modes** | Medium | One `placedArea(part, mode)` function used by solver, validator and UI, so the number can never be computed two ways (§7 decision 4). The UI states the difference rather than hiding it. |
| **Determinism lost when solving moves to a worker** | Medium | Iteration budgets only, never wall-clock (§3.6). PR 7 tests that the worker and the sync fallback produce identical layouts for the same seed, on top of the existing golden-vector RNG tests. |
| **`CLAUDE.md` constraint 4 relaxed for the worker** | Medium | Owner-approved and recorded (§7 decision 8). Sequenced after the nester so it still lands with measurements, and it adds no dependency. |
| **Scope creep into holes, G-code or continuous angles** - all adjacent and all tempting | Medium | Each is named in §2's out-of-scope list with the reason. `project-plan.md` §7 already rates nesting scope creep High; this milestone opens that gate deliberately and narrowly. |

---

## 7. Confirmed decisions

1. **Full milestone, not just the outline prerequisite.** Decided with the project owner
   during this planning pass. Retaining outlines without a nester would ship no user-visible
   value and leave a half-motivated model change; building a nester on bounding boxes would
   barely beat guillotine and show almost no win until the second half.
2. **Raster/bitmask nesting, not no-fit-polygon.** Chosen explicitly by the project owner
   over exact NFP and over an NFP/raster hybrid. NFP needs convex decomposition for concave
   outlines plus degenerate-touching and float-robustness handling - the same rabbit-hole
   shape `project-plan.md` §7 already rates High for SVG parsing. Raster is robust on any
   shape at any angle, trivially deterministic, needs no dependency, and its approximation is
   conservative in the safe direction.
3. **Discrete configurable rotation steps, not continuous angles or a 90-degree boolean.**
   Continuous angles are expensive and hard to keep deterministic; a boolean gives up most of
   what nesting is for on irregular shapes. `rotationSteps` defaults to 4, and grain-locked
   parts are restricted to `{0, 180}` regardless (§3.3).
4. **Consumed area is mode-dependent, and that is correct rather than a fudge.** In
   guillotine mode a part consumes its bounding box, because the saw cuts a rectangle and the
   material inside the box is not recoverable. In nest mode it consumes its outline. One
   `placedArea(part, mode)` function serves solver, validator and UI. The consequence -
   nest and guillotine waste percentages for the same parts are not directly comparable - is
   stated in the UI rather than hidden.
5. **Explicit per-project machine choice, not automatic mode selection.** Chosen by the
   project owner over inferring the mode from whether parts have outlines, and over solving
   both ways for comparison. Inference would silently change which machine the output is
   valid for, which is a genuinely dangerous surprise in a workshop; solving both doubles
   solve time and needs a whole comparison UI.
6. **`Part.outline` is optional, and `partOutline()` is what keeps that honest.** `CLAUDE.md`
   prefers discriminated unions over optional-field soup, and making `Part` a union would
   break every consumer for no gain. Instead the optionality is erased at a single accessor
   that returns the rectangle corners when the field is absent, so no call site branches on
   it.
7. **`Placement.rotated` is replaced by `angleDeg`, not joined by it.** Keeping both would be
   two sources of truth for the same fact. The change is wide but mechanical and fully
   type-checked, and `Placement` is never persisted, so it costs no migration.
8. **The Web Worker is an owner-approved relaxation of `CLAUDE.md` constraint 4.** The
   constraint reads "No WASM, no Rust, no Web Workers until profiling justifies them...
   measure first and show numbers," and building the worker into this milestone pre-commits
   to it before the numbers exist. Confirmed explicitly with the project owner rather than
   assumed. Two things keep the constraint's spirit: the worker PR is sequenced *after* the
   nester so it still lands with measured before/after numbers, and it uses Vite's native
   module-worker support, so constraint 6 (no new dependencies) is untouched.
9. **Interior cutouts stay discarded.** Nesting parts inside other parts' holes is real value
   and a materially larger change - holes on `Part`, subtracted from the occupancy grid, and
   understood by the validator. `project-plan.md` §9 question 2 and `plan-m4.md` §2 stay as
   they are for holes; only the outer outline changes in M7.
10. **No mirroring.** A flipped panel shows its back face, which on veneered or finished
    stock is a different part. Recorded because it is the kind of transform a nesting
    engine offers for free and a woodworker would not thank you for.
