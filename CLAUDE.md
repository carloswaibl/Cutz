## Project

A free, browser-based cut list optimizer for hobbyist woodworkers. Takes a set of parts — entered manually or imported from SVG/STL — and computes an optimal cutting layout across available sheet stock, respecting saw kerf, grain direction, and material thickness. Outputs printable cut diagrams plus SVG and DXF export.

Full scoping rationale lives in `docs/project-plan.md`. Read it before proposing architectural changes.

---

## Non-negotiable constraints

These were decided deliberately. **Do not violate them without explicit approval, and flag it if a request would require violating one.**

1. **No backend. No server. No API calls.** Everything runs client-side in the browser. This is a hard architectural constraint — it keeps hosting free, works offline in a shop with bad wifi, and means project files never leave the user's machine.
2. **No accounts, no auth, no telemetry.** Local persistence via IndexedDB only.
3. **Guillotine cutting only in v1.** Free-form/irregular nesting is v2. It goes behind the `Solver` interface when it arrives — do not start building it, and do not let guillotine code assume it will never have a sibling.
4. **No WASM, no Rust, no Web Workers until profiling justifies them.** Target problem size is 20–100 parts. Plain TypeScript is fast enough. If you think performance is a problem, measure first and show numbers.
5. **STL import handles single flat parts only.** No 3D assembly decomposition. If a mesh isn't a slab, reject it with a clear message.
6. **No new runtime dependencies without asking.** Bundle size matters for a static app.

---

## Stack

- **TypeScript** (strict mode) + **React** + **Vite**
- **three.js** — STL parsing and plane math only, not for rendering
- **svg-pathdata** — SVG path parsing and curve flattening
- **idb** — IndexedDB wrapper
- **dxf-writer** — DXF export
- **Vitest** — unit tests
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
    types.ts       # Part, Stock, Material, Placement, Layout, Result
    units.ts       # unit conversion + fractional inch parsing/formatting
    validate.ts    # input validation, invariant checks
  solver/
    types.ts       # Solver interface
    guillotine/    # v1 engine: free-rectangle guillotine packer
    improve.ts     # randomized restart / annealing wrapper
    rng.ts         # seeded PRNG
  import/
    svg/           # SVG -> Part[]
    stl/           # STL -> Part
    errors.ts      # typed import errors with user-facing messages
  export/
    svg.ts
    dxf.ts
    print.css
  ui/              # React components
  storage/         # IndexedDB project persistence
test/
  fixtures/        # realistic projects: bookshelf, cabinet carcass, drawer boxes
  files/           # real-world SVG/STL samples from Inkscape, Illustrator, Fusion
docs/
  project-plan.md
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

interface Part {
  id: string;
  label: string;
  width: number;
  height: number;
  qty: number;
  materialId: string;
  rotationPolicy: RotationPolicy;
}

interface Stock {
  id: string;
  materialId: string;
  width: number;
  height: number;
  qty: number;
  grainAxis: 'x' | 'y';
}

interface SolverConfig {
  kerf: number;
  edgeTrim: number;
  seed: number;
}

interface Placement {
  partId: string;
  stockInstanceId: string;
  x: number;           // top-left corner
  y: number;
  rotated: boolean;    // 90 degrees
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
- `Placement.x/y` is the **top-left corner of the part**, excluding kerf.
- `rotated: true` means the part is turned 90°: its effective footprint is `height x width`.
- Stock `grainAxis` describes which axis the grain runs along on the sheet.

---

## Solver invariants

Every `Result` must satisfy these. `domain/validate.ts` checks them; the test suite asserts them on every solver output.

1. No two placements on the same `stockInstanceId` overlap when each is inflated by `kerf`.
2. Every placement lies fully within the stock's usable area (dimensions minus `edgeTrim` on all sides).
3. `rotated === true` only when the part's `rotationPolicy` is `'free90'`.
4. Every layout is guillotine-decomposable — it can be produced by a sequence of full edge-to-edge cuts.
5. A part is only placed on stock with a matching `materialId`.
6. Placed quantity per part never exceeds requested `qty`. Any shortfall appears in `unplacedParts`.

**The solver must be deterministic given the same inputs and seed.** Use the seeded PRNG in `solver/rng.ts`. Never call `Math.random()` anywhere in `solver/`.

---

## Conventions

- Strict TypeScript. No `any`. Prefer discriminated unions over optional-field soup.
- Pure functions in `domain/` and `solver/`. No mutation of inputs.
- Import failures return typed errors with a user-facing message, never throw raw strings. A user should always learn *which* SVG construct wasn't supported.
- Comments explain *why*, especially for woodworking constraints that look arbitrary to a reader who doesn't know the domain.
- React components stay presentational. Solver invocation and state live above them.

## Testing

- Solver changes require running `npm run bench` and reporting the waste-percentage delta across all fixtures. A change that improves one fixture and regresses three is a regression.
- Every solver output in tests goes through `validate.ts` invariant checks.
- Importer tests run against real files in `test/files/` exported from Inkscape, Illustrator, and Fusion — not hand-written minimal XML. Real files are messy; that's the point.
- Add a fixture when you find a bug. Fix the bug second.

---

## Anti-patterns

Things that have been decided against, or are easy to get wrong:

- Adding a server, an API route, or a cloud dependency to solve a problem. Solve it client-side.
- Reaching for WASM/workers/Rust for perceived performance. Profile first.
- Starting nesting work, or writing guillotine code that assumes it is the only solver.
- Treating grain lock as a soft preference the solver may override for a better packing. It may not.
- Forgetting kerf between adjacent parts, or applying it on sheet edges where no cut occurs.
- Producing a layout that packs efficiently but isn't guillotine-decomposable. It will pass a naive overlap check and be uncuttable on a table saw.
- Chasing solver quality indefinitely. The bar is defined in the project plan; hit it and move on.
- Expanding SVG parsing to handle every edge case. Support the documented subset and fail loudly outside it.
- Silently defaulting units on import.

---

## Current status

See `docs/project-plan.md` for milestones. Ask which milestone is active before starting substantial work.
