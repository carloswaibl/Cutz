## Project

A free, browser-based cut list optimizer for hobbyist woodworkers. Takes a set of parts — entered manually or imported from SVG/STL — and computes an optimal cutting layout across available sheet stock, respecting saw kerf, grain direction, and material thickness. Outputs printable cut diagrams plus SVG and DXF export.

Full scoping rationale lives in `docs/project-plan.md`. Read it before proposing architectural changes.

---

## Non-negotiable constraints

These were decided deliberately. **Do not violate them without explicit approval, and flag it if a request would require violating one.**

1. **No backend. No server. No API calls.** Everything runs client-side in the browser. This is a hard architectural constraint — it keeps hosting free, works offline in a shop with bad wifi, and means project files never leave the user's machine.
2. **No accounts, no auth, no telemetry.** Local persistence via IndexedDB only.
3. **Guillotine cutting only in v1.** ~~Free-form/irregular nesting is v2.~~ **Nesting arrived in M7**, behind the `Solver` interface exactly as this said it would, and guillotine is still the default mode. The rule that survives: neither engine may assume it is the only one. Anything shared goes in `src/solver/` (`search.ts`, `subproblems.ts`, `objective.ts`), never inside an engine's own directory.
4. **No WASM, no Rust, no Web Workers until profiling justifies them.** Target problem size is 20–100 parts. Plain TypeScript is fast enough. If you think performance is a problem, measure first and show numbers. **One owner-approved exception: the solve worker** in `src/ui/state/solveWorker.ts`, added in M7 PR 7 with before/after numbers in `docs/plan-m7.md` §5 and the approval recorded in §7 decision 8. It is Vite's native module worker, so it added no dependency. The nester itself is still plain TypeScript over `Uint32Array`, and the rule stands for everything else.
5. **STL import handles single flat parts only.** No 3D assembly decomposition. If a mesh isn't a slab, reject it with a clear message.
6. **No new runtime dependencies without asking.** Bundle size matters for a static app.

---

## Stack

- **TypeScript** (strict mode) + **React** + **Vite**
- **Tailwind CSS v4** — styling and responsive layout grid
- **three.js** — STL parsing and plane math only, not for rendering
- **svg-pathdata** — SVG path parsing and curve flattening
- **idb** — IndexedDB wrapper, behind `src/storage/`
- **react-zoom-pan-pinch** — pan/zoom around the on-screen cut diagram
- DXF export is **hand-rolled** in `src/export/dxf.ts` — no library. R12 is a plain text
  format and the subset a cut sheet needs is a few hundred lines, which is cheaper than a
  dependency in a bundle-size-sensitive static app.
- **Vitest** — unit tests
- **jsdom** - dev dependency; DOM environment for import tests that exercise `DOMParser`
- **fake-indexeddb** - dev dependency; in-memory IndexedDB for `src/storage/` tests, because
  jsdom has no IndexedDB implementation of its own
- Layouts render as **native SVG from React components**, not canvas. This gives SVG export for free and makes print styling straightforward.

---

## Commands

```bash
npm run dev          # Vite dev server
npm run build        # production build
npm run preview      # serve the production build locally
npm test             # vitest, watch mode
npm run test:run     # vitest, single run
npm run bench        # solver benchmark suite against fixtures
npm run typecheck    # tsc -b --noEmit
npm run lint         # biome check (lint + format check)
npm run lint:fix     # biome check --write
```

Run `npm run typecheck && npm run test:run` before considering any change complete.

## Git workflow

`main` is the deploy branch and is never committed to directly. Work happens on a
branch, lands via PR, and CI must be green to merge.

- Branch names: `feat/`, `fix/`, `chore/`, `docs/` + short kebab-case description.
- CI (`.github/workflows/ci.yml`) runs lint, typecheck, tests, and build on every PR.
- Merging to `main` runs the same checks and then deploys `dist/` to GitHub Pages.
  The deployed site is always the exact build CI verified.
- Squash-merge PRs. The PR title becomes the commit message on `main`.

---

## Directory structure

```
src/
  domain/          # types + pure domain logic, ZERO dependencies on React or DOM
    types.ts       # Part, Stock, Material, Placement, Layout, Result, SolverConfig
    units.ts       # unit conversion + fractional inch parsing/formatting
    validate.ts    # input validation, invariant checks
    geometry.ts    # Rect helpers: area, contains, separation, clearance, intersects
    instances.ts   # Part and Stock instance expansion utilities
    cutplan.ts     # guillotine cut-tree search -> ordered cut plan (validate.ts delegates here)
    polygon.ts     # polygon primitives: hull, min-area box, containment, simplify, rotate,
                   # separation - plus partOutline/placementPolygon/placementRect/placedArea,
                   # the accessors that erase Part.outline's optionality
  solver/
    types.ts       # Solver interface
    index.ts       # mode registry: 'guillotine' | 'nest' -> engine. solve() dispatches here
    subproblems.ts # solveByMaterial: validate, group by material, assemble the Result.
                   # Engine-agnostic - both engines are packers handed to it
    search.ts      # restart + hill-climb harness, engine-agnostic, seeded
    guillotine/    # v1 engine: free-rectangle guillotine packer
    nest/          # v2 engine: raster/bitmask nester - raster (masks, scanline fill),
                   # collide (word-shifted Uint32Array ops), place (bottom-left fill)
    improve.ts     # guillotine's restart/hill-climb budgets, a thin caller of search.ts
    rng.ts         # seeded PRNG (mulberry32)
    objective.ts   # candidate layout scoring, solver-agnostic
  import/
    types.ts       # ImportedPart, ImportWarning, ImportOutcome - shared contract, SVG and STL
    errors.ts      # typed import errors and warnings with user-facing messages
    geometry.ts    # what counts as a part: contour area/extent thresholds. The geometry
                   # itself moved to domain/polygon.ts in M7
    outline.ts     # contour points -> a part-local outline, refitted to the reported box
    contours.ts    # Contour, nestContours, CLOSE_GAP_TOLERANCE_MM - shared, SVG and STL
    group.ts       # quantity grouping - shared, SVG and STL
    svg/           # SVG -> Part[]: document, viewport/units, transforms, shapes, flatten,
                    # contour classification, label
    stl/           # STL -> Part: parse (STLLoader wrapper), mesh (weld, connected components,
                    # manifold check), slab (normal clustering, top/bottom pairing, thickness),
                    # project (2D projection), label
  export/          # may depend on src/ui/ renderers; domain/ and solver/ may not
    svg.ts         # standalone SVG via renderToStaticMarkup - lazily loaded, pulls react-dom/server
    dxf.ts         # hand-rolled R12 writer, headless, statically imported
    download.ts    # Blob + anchor click, sequential with a gap for multi-file
    filename.ts    # sheet filename slugs, kept out of the lazy svg chunk
    print.css
  storage/         # IndexedDB project persistence; may depend on domain/, never on ui/
    types.ts       # Project, ProjectSummary
    db.ts          # idb schema: `projects` + `meta` stores, version 1, open/close per call
    projects.ts    # list/get/create/update/rename/delete + the active-project id
  ui/              # React components
    format.ts      # display-unit formatting shared by diagram, tables and print
    state/         # reducer, app state, presets
                   # projectStore.ts - headless persistence logic (no React)
                   # useProjectStorage.ts - thin hook wrapping it, composed into App
                   # solveProtocol.ts - the request/response shapes both worker sides import
                   # solveWorker.ts - worker entry; imports solve(), posts results back
                   # solveClient.ts - request ids, debounce, stale-drop, terminate, fallback
                   # useSolve.ts - thin hook over the client
                   # debounce.ts - createDebouncer, shared by the store and the solve client
    components/
      print/       # print-only component tree, hidden on screen
      import/      # SVG import dialog, preview, shape thumbnails, and warnings panel
test/
  fixtures/        # realistic projects: bookshelf, cabinet carcass, drawer boxes
  files/           # real-world SVG/STL samples from Inkscape, Illustrator, Fusion
  storage/         # project store round-trips, against fake-indexeddb
docs/
  project-plan.md  # product roadmap and overall milestone breakdown
  plan-m1.md       # M1 implementation plan, scope, and PR sequence
  plan-m2.md       # M2 implementation plan
  plan-m3.md       # M3 implementation plan: cut plan, print, SVG/DXF export
  plan-m4.md       # M4 implementation plan: SVG import
  plan-m5.md       # M5 implementation plan: STL import
  plan-m6.md       # M6 implementation plan: persistence, project library, launch
  plan-m7.md       # M7 implementation plan: outlines, the solver seam, CNC nesting
  solver-design.md # both engines: design, algorithms, invariants, and benchmarks
```

`src/domain/` and `src/solver/` must stay pure and headless — testable in Node with no DOM. Do not import React, browser globals, or anything from `src/ui/` into them.

---

## Domain model

```ts
type RotationPolicy = 'locked' | 'free90';

interface Material {
  id: string;
  name: string;
  thickness: number;   // canonical units
  hasGrain: boolean;
}

interface Point { x: number; y: number }

interface Part {
  id: string;
  label: string;
  width: number;       // bounding box, always - outline or not
  height: number;
  qty: number;
  materialId: string;
  rotationPolicy: RotationPolicy;
  /**
   * Closed polygon in part-local millimetres: origin at the bounding box top-left,
   * x right, y down, clockwise. Absent means "this part is its bounding box" - a
   * hand-entered rectangle, which stays the common case.
   * Invariant: boundsOf(outline) == { 0, 0, width, height } within EPSILON.
   */
  outline?: readonly Point[];
}

interface Stock {
  id: string;
  materialId: string;
  width: number;
  height: number;
  qty: number;
  grainAxis: 'x' | 'y';
}

type SolverEffort = 'fast' | 'balanced' | 'thorough';
type SolverMode = 'guillotine' | 'nest';
type RotationSteps = 2 | 4 | 12 | 24;

interface SolverConfig {
  kerf: number;              // saw blade on a saw, cutter diameter on a router
  edgeTrim: number;
  seed: number;
  effort?: SolverEffort;     // defaults to 'balanced'
  mode?: SolverMode;         // defaults to 'guillotine'
  rotationSteps?: RotationSteps; // equally spaced over 360deg, defaults to 4. Nest only
}

interface Placement {
  partId: string;
  stockInstanceId: string;
  x: number;           // top-left corner of the placed part's bounding box
  y: number;
  angleDeg: number;    // clockwise. Guillotine emits only 0 and 90
}

interface Layout {
  stockInstanceId: string;
  placements: Placement[];
  wastePct: number;
}

interface Result {
  layouts: Layout[];
  unplacedParts: { partId: string; qty: number }[];
  totalWastePct: number;
}

interface Solver {
  solve(parts: Part[], stock: Stock[], config: SolverConfig): Result;
}
```

Parts are grouped by `(materialId, thickness)` into **fully independent subproblems**. Never mix materials in a single packing run.

---

## Woodworking glossary

Get these right — they drive real behavior, and misunderstanding them produces layouts that are wrong in ways tests won't catch.

- **Kerf** — the width of material removed by the saw blade, typically 3mm / 1/8". Every cut consumes this. Two adjacent parts need `kerf` of space between them, not zero.
- **Grain direction** — the visible wood fiber direction. On a plywood sheet it runs along one axis. Parts with visible faces usually must have grain running a specific way, so they **cannot be rotated 90°**. This is exactly what `rotationPolicy: 'locked'` means. It is not an arbitrary user preference — rotating a grain-locked part produces a visibly wrong result.
- **Guillotine cut** — a cut that runs edge to edge across the entire workpiece. A table saw can only make these. It means every layout must be decomposable into a sequence of full-width/full-height splits. A layout that is valid for a CNC router may be *impossible* on a table saw.
- **Rip cut** — cut along the grain. **Crosscut** — cut across it.
- **Sheet goods** — plywood, MDF, melamine. Sold in fixed sizes, commonly 4'x8' (1220x2440mm).
- **Edge trim / factory edge** — sheet edges are often not square and get trimmed off before use. `edgeTrim` shrinks the usable area on all four sides.
- **Offcut** — usable leftover material. Tracked in v2, not v1.

---

## Units policy

**Canonical internal unit is millimeters, stored as `number`.** Every value in `domain/`, `solver/`, `import/`, and `export/` is millimeters. No exceptions.

- Conversion happens **only** at the UI boundary and at import/export boundaries.
- The UI supports imperial display with fractional input (`23-1/4`, `23 1/4`, `23.25`). Parsing and formatting live in `domain/units.ts`.
- **Never store a display string in the domain model.** Never store a unit tag alongside a dimension.
- **STL files carry no unit information.** Always prompt the user with a size preview on import. Never infer, never default silently.
- SVG has explicit units in most cases but not all. If units cannot be determined, prompt — do not guess.

---

## Geometry conventions

- Origin is **top-left**, `x` increases right, `y` increases down. This matches SVG so rendering needs no flip.
- `Placement.x/y` is the **top-left corner of the part's bounding box at its placed angle**, excluding kerf. `placementPolygon` anchors the turned shape's box there, so `x/y` means the same thing at 0°, 90° and 37°.
- `angleDeg` turns the part clockwise. `90` means the footprint is `height x width`; guillotine emits only `0` and `90`.
- Stock `grainAxis` describes which axis the grain runs along on the sheet.
- **Ask `domain/polygon.ts` for a placement's geometry, never rebuild it.** `partOutline(part)` returns the four box corners when there is no outline, `placementPolygon(part, placement)` turns and positions it, `placementRect` is that polygon's bounds. Renderer, exporters and checker all read the same answer.

---

## Solver invariants

Every `Result` must satisfy these. `domain/validate.ts` checks them; the test suite asserts them on every solver output.

1. No two placements on the same `stockInstanceId` overlap when each is inflated by `kerf`. Measured between bounding boxes in guillotine mode and between real polygons in nest mode — **mode decides, never shape** (see the M7 conventions below).
2. Every placement lies fully within the stock's usable area (dimensions minus `edgeTrim` on all sides).
3. A part is turned only to an angle its grain allows: `{0, 180}` when `rotationPolicy` is `'locked'`, anything when it is `'free90'`.
4. Every layout is guillotine-decomposable — it can be produced by a sequence of full edge-to-edge cuts. **Guillotine mode only**; a nested layout has no such decomposition by construction. In guillotine mode every `angleDeg` is also a quarter turn.
5. A part is only placed on stock with a matching `materialId`.
6. Placed quantity per part never exceeds requested `qty`. Any shortfall appears in `unplacedParts`.
7. Waste percentages (`wastePct` and `totalWastePct`) recomputed per formula match the reported result numbers. Consumed area is `placedArea(part, mode)`: the bounding box on a saw, the outline on a router.

**The solver must be deterministic given the same inputs and seed.** Use the seeded PRNG in `solver/rng.ts`. Never call `Math.random()` anywhere in `solver/`.

---

## Conventions

- Strict TypeScript. No `any`. Prefer discriminated unions over optional-field soup.
- Pure functions in `domain/` and `solver/`. No mutation of inputs.
- Import failures return typed errors with a user-facing message, never throw raw strings. A user should always learn *which* SVG construct wasn't supported.
- Comments explain *why*, especially for woodworking constraints that look arbitrary to a reader who doesn't know the domain.
- React components stay presentational. Solver invocation and state live above them.

## Testing

- Solver changes require running `npm run bench` and reporting the delta across all fixtures - waste for the guillotine ones, **sheets used** for the nest ones, which is the only number comparable between the two modes. A change that improves one fixture and regresses three is a regression.
- Every solver output in tests goes through `validate.ts` invariant checks, in the mode it was solved in.
- Importer tests run against real files in `test/files/` exported from Inkscape, Illustrator, and Fusion — not hand-written minimal XML. Real files are messy; that's the point.
- Add a fixture when you find a bug. Fix the bug second.

---

## Anti-patterns

Things that have been decided against, or are easy to get wrong:

- Adding a server, an API route, or a cloud dependency to solve a problem. Solve it client-side.
- Reaching for WASM/workers/Rust for perceived performance. Profile first. The solve worker is the one approved exception and it came with numbers.
- Writing engine code that assumes it is the only solver, or reaching into another engine's directory instead of moving the shared piece up into `src/solver/`.
- Treating grain lock as a soft preference the solver may override for a better packing. It may not. On a router that means `{0, 180}` and nothing between.
- Forgetting kerf between adjacent parts, or applying it on sheet edges where no cut occurs.
- Producing a layout that packs efficiently but isn't guillotine-decomposable **in guillotine mode**. It will pass a naive overlap check and be uncuttable on a table saw.
- Presenting a nested layout as if a saw could cut it: a cut sequence, kerf dashes off a bounding box, or a waste figure compared against a guillotine one.
- Chasing solver quality indefinitely. The bar is defined in the project plan; hit it and move on.
- Expanding SVG parsing to handle every edge case. Support the documented subset and fail loudly outside it.
- Silently defaulting units on import.

---

## Current status

Milestone 7 (CNC free-form nesting) is complete - the first v2 milestone, planned in
`docs/plan-m7.md`. A part can now carry a true outline in part-local millimetres beside the
bounding box it has always had, and both importers keep the polygon they were already computing
and throwing away. `Placement.rotated` became `Placement.angleDeg`, `SolverConfig` gained `mode`
and `rotationSteps`, and `src/solver/index.ts` is a registry over the two engines: the M1
guillotine packer, still the default and untouched, and `src/solver/nest/`, a raster/bitmask
nester that packs irregular parts at discrete angles for a CNC router. A woodworker picks the
machine per project. On a router the diagram, the printed sheets, the SVG and the DXF all carry
real polygons at real angles, and the cut-sequence panel is replaced by a plain statement that a
nested layout has none; on a saw everything behaves exactly as it did in v1, with an outlined
part's shape drawn faintly inside the box the blade actually cuts. Solving moved off the render
path into a Web Worker with a request debounce, cancellation and a synchronous fallback -
measured, on the wall-cabinet preset in nest mode, at 21,549 ms of blocked main thread for eight
keystrokes before and 87 ms after. Interior cutouts are still discarded; a part carries its outer
outline only.

Milestone 6 (Polish and launch) is complete, and with it the whole v1 scope in
`docs/project-plan.md`. Work no longer disappears when the tab closes: the app opens the project
it had open last, autosaves every edit to IndexedDB behind a debounce, and keeps as many named
projects as a woodworker wants side by side - create, rename, switch, delete, each isolated from
the others. A first-ever visitor gets a "no projects yet" prompt offering a blank project or one
of the three example templates rather than a demo that silently overwrites itself. Exported SVG
and DXF filenames carry the active project's name. The repo itself is launch-ready: MIT `LICENSE`,
a hand-written `README.md`, favicon and Open Graph/Twitter tags on `index.html`, and a footer in
the app carrying the repo link, the license and the version. The only thing left in M6 is the
manual step of posting it to r/woodworking, r/hobbycnc and Lumberjocks, which is the owner's to
take and was never a code deliverable.

Milestone 5 (STL import) is also complete. On top of M4's SVG path, a woodworker can drop a
Fusion 360, SolidWorks or SketchUp `.stl` export onto the parts table alongside or instead of an
SVG: the importer welds raw triangle soup into an indexed mesh, splits it into connected
components, checks each for manifold-ness, clusters triangles by normal to find a slab's top and
bottom faces, measures thickness, rejects anything that isn't a flat panel (a bracket, a box, a
carcass modelled as one body) with a specific reason, and projects the accepted slab's outline
into the same 2D contour/quantity-grouping pipeline SVG already used. Every STL import starts
with no known scale and blocks commit until the user confirms a real-world size, pre-filled with
the common case (raw units read as millimetres) so confirming it is one glance, not a typed
number. Detected thickness pre-selects the closest matching material per row. The dropzone now
accepts multiple files of either format in one drop, merged into one preview list.

Conventions from M7 that are easy to break:

- **Mode decides whether a placement is measured as a box or as a polygon. Shape never does.**
  `validate.ts`, `objective.ts` and `SheetFigure` all read `config.mode`. Keying on
  `part.outline !== undefined` instead looks equivalent and is not: two imported parts on a *saw*
  would pass the kerf check whenever their curves cleared, with their bounding boxes squarely
  overlapping - the uncuttable layout the checker exists to catch. `docs/plan-m7.md` PR 3.
- **`Part.outline` is optional and nothing branches on it.** `partOutline()` returns the four box
  corners when it is absent, so there is one code path. Adding an `if (part.outline)` at a call
  site is how the optional field becomes the optional-field soup the conventions warn about.
  `docs/plan-m7.md` §7 decision 6.
- **A part that *is* its bounding box stores no outline.** The importers check after refitting, so
  an imported rectangle is structurally identical to a typed one and `outline !== undefined` keeps
  meaning "this part is not a rectangle".
- **Any edit to a part's width or height refits its outline (`fitPolygonToBox`), never drops it.**
  `outline-bounds-mismatch` is a hard error that blocks solving for every material at once, so a
  stranded outline is a dead end the user cannot see or fix. `UPDATE_PART` in the reducer owns
  this; dropping the outline instead silently turns the part back into a rectangle, which is a
  surprise discovered at the router.
- **The nester's grid cell size is derived from the kerf, not fixed.** The structuring element can
  only separate parts by whole cells, so a cell that does not divide the kerf rounds every gap up
  and costs whole sheets - measured: a 1mm rounding put `bookshelf` at 28.6% waste against
  guillotine's 4.9%. `docs/plan-m7.md` PR 6.
- **`allowedAngles` lives in `validate.ts` and the engine imports it.** An engine holding its own
  opinion about which angles the grain permits produces layouts its own checker rejects.
- **`solveWorker.ts` must never import `solveClient.ts`.** The client holds
  `new Worker(new URL('./solveWorker.ts', ...))`, so that import makes Vite emit worker chunks
  recursively. What both sides share lives in `solveProtocol.ts`, which neither owns.
- **Solve requests are debounced (200ms in `solveClient.ts`); solver iteration budgets are not.**
  No wall-clock cutoff exists anywhere in `src/solver/` and none may be added - results would
  depend on machine speed and the determinism the golden RNG vectors protect would be gone.
- **Nest and guillotine waste percentages are not comparable, by design** (`placedArea(part, mode)`,
  §7 decision 4). Compare sheets used. The UI says so on both sides; the bench prints both figures
  labelled and never subtracts them.
- **In nest mode the drawn boundary is `placementPolygon` for *every* part, outline or not.**
  A rectangle turned 30° is still a rectangle; `placementRect` is the axis-aligned box *around* it,
  which for a 140x90 part is 166x148. Gating the polygon branch on `part.outline` drew that box -
  a different size at every angle, overlapping the neighbours nested against it - while `dxf.ts`
  emitted the real corners, so the two exports of one layout disagreed. `SheetFigure.tsx`, M7 PR 9.
- **A nested part's label is dropped when a bigger part's label already covers that spot**
  (`suppressedLabels` in `SheetFigure.tsx`, M7 PR 9). Nesting overlaps bounding boxes on purpose,
  so two labels centred in them can print on top of each other. Guillotine layouts never suppress
  anything, which is what keeps the M3 golden SVGs byte-identical.

Conventions from M3, M4, M5 and M6 that are easy to break:

- **`src/storage/` may depend on `src/domain/`, never on `src/ui/`** - the same one-way rule
  `plan-m4.md` set for `src/import/`. It is not headless-in-Node (it needs IndexedDB), but its
  tests run under jsdom with `fake-indexeddb`, never a browser.
- **Persistence logic that does not need React lives in `src/ui/state/projectStore.ts`;
  `useProjectStorage.ts` is a thin hook over it.** That split is what lets the whole
  load/autosave/switch/delete surface be tested with `vi.useFakeTimers()` and no renderer -
  `@testing-library/react` is deliberately not a dependency. `docs/plan-m6.md` §5 PR 2.
- **`storage/db.ts` opens and closes a connection per call, deliberately** - not a cached
  singleton. A held connection blocks `deleteDatabase` in tests and would block a future version
  bump in a tab the user left open.
- **Example/starter content is `src/ui/state/presets.ts`. `test/fixtures/*.json` is
  solver-benchmark-only.** The two have diverged in ids, quantities and unit conventions;
  fixtures are metric-native for `test/bench`, presets are entered against the UI's
  imperial-fraction defaults. `docs/plan-m6.md` §7 decision 4 supersedes the older comment in
  `test/fixtures/index.ts` that anticipated the opposite.
- **Display units are `imperial-fraction | imperial-decimal | metric-mm`.** Metric is millimetres
  only. `parseLength` still accepts a `cm` suffix on *input*; there is no cm display mode, and
  adding one means moving `unitSystem` and `toFormatUnit` in `export/dxf.ts` together or the DXF
  scales its geometry in one unit and prints its labels in another.
- **`AppState.showCutSequence` drives four destinations at once** - the screen diagram, the printed
  pages, the SVG export and the DXF export. Read it; do not re-derive an equivalent per call site.
  It also has **two** on-screen controls that must both write to it: `LayoutViewer`'s toolbar
  button and the cut-sequence panel's own `<summary>` (via `onToggle`). A `<details open={...}>`
  without `onToggle` silently desyncs - the panel collapses while the diagram and the next export
  keep the overlay.
- ~~**Imported parts are always bounding boxes, never true outlines.**~~ **Superseded by M7**: a
  part carries an optional true outline and `width`/`height` stay its bounding box. The half that
  still stands is **interior cutouts are discarded** with a counted warning, not modelled - only
  the outer outline survives import. `docs/project-plan.md` §9 question 2 and `docs/plan-m7.md`
  §7 decision 9 record why, and what it would take to change.
- **Hole nesting in the SVG importer is scoped to one element's own subpaths, not the whole
  document.** Document-wide containment reads any background or frame rectangle as a panel with
  the entire drawing cut out of it. `docs/plan-m4.md` decision #11 has the reasoning.
- **`ImportedPart` carries `flags: PartFlag[]`, never a `selected: boolean`.** The importer
  reports *why* a row looks the way it does; whether a row is wanted is `ImportDialog`'s own UI
  state, not part of the importer's output. `docs/plan-m4.md` decisions #9 and #15.
- **`test/files/*.svg` (the non-synthetic ones) are hand-written reproductions of Inkscape,
  Illustrator and Fusion export idioms, not genuine captures from those tools** - each file says
  so in its own header comment. This was an explicit, approved substitution; see `docs/plan-m4.md`
  decision #13.
- **`Contour`/`nestContours` and quantity grouping (`group.ts`) live in `src/import/`, not inside
  `svg/`.** Both were already fully generic when SVG alone used them; M5 moved them up rather than
  having `stl/` reach into `svg/`'s own directory. `docs/plan-m5.md` §8 decision #5.
- **STL's detected thickness rides beside `ImportOutcome`, not inside it.** `importStl` returns
  `StlImportOutcome` - the shared `ok:true` shape plus a `thicknessMm: Record<sourceId, number>`
  map - rather than widening the contract every caller sees. `docs/plan-m5.md` §8 decision #8.
- **`importStl`'s `mmPerUnitOverride` scales the raw mesh positions immediately after parsing,
  before welding or anything else runs.** Every downstream tolerance in the shared pipeline
  (`contours.ts`, `group.ts`) is an absolute millimetre value; scaling late would feed them the
  mesh's raw, possibly-non-mm units. `docs/plan-m5.md` §8 decision #9.
- **Material selection is a `materialId` per `PreviewRow`, not one dialog-wide select.** A batch of
  STL parts can have different measured thicknesses with no single correct default between them.
  `docs/plan-m5.md` §8 decision #10.

**There is no active milestone.** v1 is done and deployed, and M7 - the first v2 milestone - is
finished and merged. The remaining v2 candidates are listed in `docs/project-plan.md` §6: nesting
parts inside other parts' interior cutouts, offcut inventory, 1D linear stock, G-code, cut
sequence optimisation, project export-as-file. None of them is started or scheduled. Ask before
starting substantial work.
