# Solver Design — Cut List Optimizer Core

This document describes the design, algorithms, invariants, and benchmark suite of the headless cutting engines (`src/domain/` and `src/solver/`). Sections 2 to 3 are the guillotine packer shipped in M1; section 6 is the raster nester added in M7. Both sit behind the same interface and share everything above them.

---

## 1. Architecture Overview

The solver is pure, headless TypeScript with zero DOM/browser/React dependencies. It implements the `Solver` interface:

```ts
interface Solver {
  solve(parts: Part[], stock: Stock[], config: SolverConfig): Result;
}
```

`SolverConfig.mode` picks the engine — `'guillotine'` (default) or `'nest'` — and `src/solver/index.ts` is a registry over the two. `solve()`'s signature never changed when the second engine arrived, so every call site is machine-agnostic. The record is total over `SolverMode`, so adding a mode to the domain type without an engine behind it fails to typecheck rather than at runtime.

### Data Pipeline

```
solve(parts, stock, config)
  └── engine = REGISTRY[config.mode ?? 'guillotine']
      └── solveByMaterial(parts, stock, config, engine)   src/solver/subproblems.ts
          ├── validateInputs()             ──> throws SolverInputError on invalid parameters
          ├── Group by materialId          ──> N independent subproblems
          │   └── For each material:
          │       ├── Expand Part/Stock    ──> discrete PartInstance / StockInstance units
          │       └── search()             ──> deterministic baselines, then seeded restarts,
          │                                    then hill-climbing (src/solver/search.ts)
          └── Merge Subproblem Results     ──> Combine layouts, recompute global waste statistics
```

Everything outside the engine directories is shared:

* **`subproblems.ts`** owns the per-material driver. It existed twice, character-identical, in `packGuillotine` and `improveGuillotine` before M7 extracted it, which is what makes `NestSolver` an engine rather than an engine plus a driver. It takes a packer *factory*, not a packer, so per-solve state (a seeded generator, a mask cache) is only built once validation has passed.
* **`search.ts`** owns the restart/hill-climb loop, the `Rng` threading and the reproducibility contract, parameterised by a "pack one candidate ordering" function. Iteration budgets stay with each engine — they are wildly different numbers (§3.3, §6.5).
* **`objective.ts`** scores a candidate from a solver-agnostic shape (§3.2).

---

## 2. Core Free-Rectangle Guillotine Packer (`src/solver/guillotine/`)

The core packer uses Jylänki's free-rectangle list model adapted for sheet stock woodworking with kerf constraints.

### 2.1 Sheet Usable Area & Kerf Accounting
* **Usable Area:** Each sheet begins with a single free rectangle initialized to:
  $$\text{usable} = (\text{edgeTrim}, \text{edgeTrim}, W - 2\cdot\text{edgeTrim}, H - 2\cdot\text{edgeTrim})$$
* **Kerf:** Cuts consume material of width `kerf`. Kerf is only applied between adjacent placements; parts placed against outer sheet edges produce zero-size leftover rectangles, incurring no kerf penalty.

### 2.2 Split Rules & Heuristics
When a part of dimensions $(w, h)$ is placed inside a free rectangle $(rx, ry, rw, rh)$, the remaining space is split into up to two sub-rectangles:

* **Horizontal Split (Full-width cut under part):**
  * Right: $(rx + w + \text{kerf}, ry, rw - w - \text{kerf}, h)$
  * Bottom: $(rx, ry + h + \text{kerf}, rw, rh - h - \text{kerf})$
* **Vertical Split (Full-height cut beside part):**
  * Right: $(rx + w + \text{kerf}, ry, rw - w - \text{kerf}, rh)$
  * Bottom: $(rx, ry + h + \text{kerf}, w, rh - h - \text{kerf})$

#### Split Rule Tuning (`longer-leftover`)
Sweeping heuristics across benchmark fixtures demonstrated that **`longer-leftover` (LLAS)** is the optimal split rule for table-saw layouts. Running the primary cut along the longer leftover axis produces a single full-width strip (akin to ripping a row on a table saw), preserving continuous usable area for subsequent placements.

---

## 3. Improvement Wrapper (`src/solver/improve.ts`)

The improvement pass decorates the base guillotine packer to maximize layout efficiency without introducing non-determinism.

### 3.1 Optimization Phases
1. **Deterministic Baseline (Iterations 0..3):** Evaluates canonical sort orders (area, longest side, perimeter) with default heuristics to guarantee the improvement pass never performs worse than plain greedy packing.
2. **Randomized Restarts:** Samples part permutations and heuristic combinations (fit rules, split rules) driven by a seeded PRNG (`mulberry32` in `src/solver/rng.ts`).
3. **Hill-Climbing Local Search:** Performs targeted swap mutations on the best-known part ordering, accepting only strict improvements until reaching a plateau.

### 3.2 Objective Function (`src/solver/objective.ts`)
Candidates are compared lexicographically:
1. **Minimize unplaced part area** (primary hard goal), measured with `placedArea(part, mode)` — the bounding box on a saw, the outline on a router.
2. **Minimize total area of consumed sheet stock** (reduces material cost).
3. **Maximize the leftover consolidation term** (turns scrap into one usable offcut). Each engine supplies its own: the largest single free rectangle for guillotine, the full-width clear band below everything placed for the nester. The field is genuinely absent, not zero, when an engine has none — `compareScores` skips criterion 3 rather than letting a candidate with no free rectangles lose a tiebreak it was never in.

### 3.3 Effort Levels (`SolverConfig.effort`)
* `'fast'`: ~40 iterations.
* `'balanced'` (default): ~250 iterations.
* `'thorough'`: ~1500 iterations.

---

## 4. Invariants & Guillotine Decomposability (`src/domain/validate.ts`)

Every solver result is validated against these strict domain invariants. **The mode the result was solved in decides how three of them are measured — never the shape of the parts.** Keying on `part.outline !== undefined` instead would silently relax the *saw's* kerf check the moment a user imported a curve: two parts would pass whenever their outlines cleared, with their bounding boxes squarely overlapping. On a saw a part consumes its whole box, so on a saw the box is what gets checked.

1. **Kerf Clearance:** Any two placements on the same sheet must maintain $\ge \text{kerf}$ separation. In guillotine mode that is `clearance(a, b)` on bounding boxes — the *larger* of the two axis gaps, because one edge-to-edge saw cut separates them and a cut has an axis. In nest mode it is `polygonSeparation`, a Euclidean distance, because a router bit has no axis of separation and the real gap between two nested parts is the diagonal one. For two rectangles offset 3mm in x and 4mm in y, `clearance` is 4 and `polygonSeparation` is 5; both are right for their own machine, and a test pins the divergence so nobody later "reconciles" them.
2. **Usable Area Containment:** Placements must reside entirely within $[ \text{edgeTrim}, W - \text{edgeTrim} ] \times [ \text{edgeTrim}, H - \text{edgeTrim} ]$ — the bounding box on a saw, the polygon (`polygonInRect`) on a router.
3. **Rotation Legality:** `angleDeg` must be one the part's grain allows: $\{0, 180\}$ when `rotationPolicy === 'locked'` (a half turn keeps the grain on the same axis), anything when it is `'free90'`. Checked against the grain and deliberately *not* against `rotationSteps`, so re-solving a project at a coarser step count cannot retroactively invalidate a layout already cut.
4. **Guillotine Decomposability:** Placements on a sheet must be separable by a recursive sequence of full edge-to-edge cuts. Checked via a memoized recursive bisection algorithm with step caps to prevent exponential blowup on pathological inputs. **Guillotine mode only** — a nested layout has no such decomposition by construction, which is the whole point of nesting. In guillotine mode a companion check, `non-quarter-angle`, rejects any placement turned off the axes: invariant 4 does not cover it, because a part turned 45° still has a rectangular bounding box and a sheet of such boxes can tile guillotine-cleanly while every part on it is uncuttable.

   Since M3 this check no longer owns that search. `checkGuillotine` is a thin wrapper over `buildCutTree` in `src/domain/cutplan.ts`, which returns the tree it walked rather than a boolean; the checker just asks whether one exists. The two used to be separate implementations of the same rule, and a checker holding a private copy of the logic eventually agrees with the bug it exists to catch. `CheckStatus` and `DEFAULT_MAX_GUILLOTINE_STEPS` live in `cutplan.ts` and are re-exported from `validate.ts`, so the dependency runs one way and existing import paths still resolve.
5. **Material Matching:** Placements must only occur on stock matching the part's `materialId`.
6. **Quantity Accounting:** For every part, $\text{placed qty} + \text{unplaced qty} == \text{requested qty}$.
7. **Waste Correctness:** Recomputed `wastePct` and `totalWastePct` must match the reported result numbers. Consumed area is `placedArea(part, mode)` — the bounding box on a saw, the outline on a router — so the two modes' waste figures answer different questions and are not comparable (§7).

Input validation additionally rejects a malformed outline before any engine runs: `outline-bounds-mismatch` (the polygon's bounds must equal the part's reported `width`/`height`), `outline-too-few-points`, and a warning for self-intersection. The first is an error rather than a warning because a stale outline would put a part somewhere the renderer and the router disagree about.

---

## 5. Benchmark Performance & Baseline

The benchmark suite (`npm run bench`) tests 8 realistic guillotine projects. All solve with **0 unplaced parts** and waste levels well under the 15% exit requirement:

| Fixture | Category | Sheets Used | Waste % | Exit Bar |
|---|---|---|---|---|
| `bookshelf` | Benchmark | 3 | 4.86% | < 15.0% |
| `cabinet-carcass` | Benchmark | 5 | 10.23% | < 15.0% |
| `closet-organizer` | Benchmark | 3 | 2.77% | < 15.0% |
| `drawer-boxes` | Benchmark | 3 | 9.79% | < 15.0% |
| `grain-locked-panels` | Held-out | 3 | 3.47% | < 15.0% |
| `mixed-stock` | Held-out | 3 | 3.38% | < 15.0% |
| `tight-fit` | Benchmark | 1 | 0.65% | < 15.0% |
| `workbench-cabinet` | Benchmark | 3 | 4.27% | < 15.0% |

M7 added three fixtures whose parts are genuinely non-rectangular, solved in nest mode and compared against the same parts sawn. **Sheets used is the comparison; the two waste figures are printed beside it and never subtracted** (§7):

| Fixture | Nest sheets | Saw sheets | Nest waste (of outline) | Saw waste (of box) | Nest time |
|---|---|---|---|---|---|
| `nest-triangles` | 1 | 2 | 35.50% | 35.50% | 3.7s |
| `nest-l-brackets` | 2 | 3 | 46.25% | 44.01% | 2.8s |
| `nest-imported-brackets` (held out) | 1 | 2 | 60.62% | 48.85% | 7.4s |

`baseline.json` is a ratchet, not a report: the eight guillotine entries have been bit-identical through every M7 PR, including the two that refactored the shared seam underneath them.

**Where nesting does not win, and why that is expected.** On the M1 rectangle fixtures the nester loses — `cabinet-carcass` takes six sheets to guillotine's five, `workbench-cabinet` four to three. Bottom-left fill on a grid is a weaker heuristic than free-rectangle best-fit with 250 restarts, and rasterisation costs up to a cell per part per axis. Nesting is for irregular parts, and the machine is an explicit per-project choice rather than something inferred. `tight-fit` is worse still: it tiles a sheet exactly to the last kerf, so quantisation loses 5 of 8 parts. It is a guillotine fixture and the bench never solves it in nest mode.

---

## 6. Raster Nesting Engine (`src/solver/nest/`)

Chosen over no-fit-polygon deliberately: NFP needs convex decomposition for concave outlines plus degenerate-touching and float-robustness handling, while a raster is robust on any shape at any angle, trivially deterministic, needs no dependency, and errs in the safe direction. `docs/plan-m7.md` §7 decision 2.

### 6.1 Masks
`{ cols, rows, stride, bits: Uint32Array }`, row-major, 32 cells per word, `stride` words per row. Polygons are filled by scanline with **conservative rounding** — a cell is occupied if the polygon touches it at all — and cached per `(part, angle)`. Collision and union are word-shifted operations over the two bitmaps.

### 6.2 Cell size is derived from the kerf
The structuring element below can only separate two parts by whole cells, so the gap it leaves is *the kerf rounded up to a multiple of the cell*. A fixed 1mm grid sounds harmless and is not: on a 2mm grid a 3mm kerf becomes a 4mm gap, and `bookshelf` fits four 300mm rows on a 1210mm sheet at 3mm but only three at 4mm — one millimetre costing a whole sheet, and 28.6% waste against guillotine's 4.9%. Choosing a cell that divides the kerf removes the rounding entirely and costs nothing (3mm grids at 3mm kerf, 1/8" at 3.175mm).

### 6.3 Kerf as a structuring element
Dilate the *candidate* mask, test it against the exact occupancy already on the sheet, then OR the *exact* mask in. That yields separation $\ge \text{kerf}$ between any two parts, is order-independent, and charges nothing at the sheet edge where no cut happens — the rule `freeRects.ts` already follows for guillotine. Containment against the usable area uses the exact, undilated mask.

The dilation is not a radius of `kerf` in cells. Conservative rasterisation puts a point up to half a cell-diagonal from its cell's centre, so a centre-distance dilation leaves true separation only $> \text{kerf} - c\sqrt2$, and `checkResult` measures the exact Euclidean gap. The sound bound is how close two points in cells $\Delta$ apart can possibly be:

$$L(\Delta) = c\sqrt{\max(0, |\Delta i| - 1)^2 + \max(0, |\Delta j| - 1)^2}$$

with the $-1$ because adjacent cells touch. The structuring element is every offset with $L(\Delta) < \text{kerf}$, which is both sufficient and as small as soundness allows. The counterexample the naive version misses — a $(3,3)$ offset on a 1mm grid, outside a 3-cell radius yet only 2.83mm apart — is pinned by a test.

Because the raster is conservative, real separation is never *less* than kerf: the approximation errs safe. Grid resolution is a quality knob, never a correctness one, and the exact polygon check in `validate.ts` certifies every result independently of it.

### 6.4 Placement
Bottom-left fill over the part's allowed angle set — lowest `y`, then lowest `x`. The angle set comes from `allowedAngles` in `validate.ts`, not from a second opinion inside the engine: grain-locked parts get $\{0, 180\}$ whatever `rotationSteps` says.

Two exact optimisations, not heuristics, and the engine is unusable without them. Occupancy only ever grows, so (a) a part that fits nowhere on a sheet can never fit later on it, and the failure is memoised per sheet; (b) the bottom-left-most free position for an orientation only moves forward, so each orientation resumes where it last succeeded. `cabinet-carcass` went from 12.9s to 3.3s. `place.test.ts` pins the cursor against a from-scratch scan placement by placement, because if that reasoning were wrong the packing would quietly get *worse* rather than fail.

### 6.5 Effort levels
`NEST_RESTART_BUDGETS` is 4 / 12 / 60 against guillotine's 40 / 250 / 1500. A nest candidate rasterises every orientation of every part and scans a whole sheet's bitmap; two orders of magnitude separate the two engines' candidate costs. `'fast'` is exactly the four deterministic baselines, and `'balanced'` is set where the largest nest fixture lands near three seconds.

---

## 7. Why the two modes' waste figures are not comparable

`placedArea(part, mode)` is the single definition of consumed area, used by the solver, the validator and the UI. On a saw a part consumes its whole bounding box, because the blade cuts a rectangle and the material inside the box is not recoverable. On a router it consumes its outline. That is correct rather than a fudge, and it means waste percentages across modes answer different questions: `nest-imported-brackets` reports 60.62% nested against 48.85% sawn while using *half* the sheets. Read as a subtraction that says the opposite of the truth. Sheets used is the same question either way, and is what the user is buying, so it is the headline in the bench, in the assertions, and in the UI.
