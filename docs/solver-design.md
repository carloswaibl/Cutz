# Solver Design — Cut List Optimizer Core (M1)

This document describes the design, algorithms, invariants, and benchmark suite of the headless guillotine cutting engine (`src/domain/` and `src/solver/`).

---

## 1. Architecture Overview

The solver is pure, headless TypeScript with zero DOM/browser/React dependencies. It implements the `Solver` interface:

```ts
interface Solver {
  solve(parts: Part[], stock: Stock[], config: SolverConfig): Result;
}
```

### Data Pipeline

```
solve(parts, stock, config)
  ├── validateInputs()             ──> throws SolverInputError on invalid parameters
  ├── Group by materialId          ──> N independent subproblems
  │   └── For each material:
  │       ├── Expand Part/Stock    ──> discrete PartInstance / StockInstance units
  │       └── Improve Pass         ──> Randomized restart + hill-climbing over free-rect packer
  └── Merge Subproblem Results     ──> Combine layouts, recompute global waste statistics
```

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
1. **Minimize unplaced part area** (primary hard goal).
2. **Minimize total area of consumed sheet stock** (reduces material cost).
3. **Maximize largest single free rectangle** (consolidates leftover into usable offcuts).

### 3.3 Effort Levels (`SolverConfig.effort`)
* `'fast'`: ~40 iterations.
* `'balanced'` (default): ~250 iterations.
* `'thorough'`: ~1500 iterations.

---

## 4. Invariants & Guillotine Decomposability (`src/domain/validate.ts`)

Every solver result is validated against seven strict domain invariants:

1. **Kerf Clearance:** Any two placements on the same sheet must maintain $\ge \text{kerf}$ separation on at least one axis (`geometry.ts` `clearance(a, b)`).
2. **Usable Area Containment:** Placements must reside entirely within $[ \text{edgeTrim}, W - \text{edgeTrim} ] \times [ \text{edgeTrim}, H - \text{edgeTrim} ]$.
3. **Rotation Legality:** `rotated === true` is only permitted when `rotationPolicy === 'free90'`.
4. **Guillotine Decomposability:** Placements on a sheet must be separable by a recursive sequence of full edge-to-edge cuts. Checked via a memoized recursive bisection algorithm with step caps to prevent exponential blowup on pathological inputs.

   Since M3 this check no longer owns that search. `checkGuillotine` is a thin wrapper over `buildCutTree` in `src/domain/cutplan.ts`, which returns the tree it walked rather than a boolean; the checker just asks whether one exists. The two used to be separate implementations of the same rule, and a checker holding a private copy of the logic eventually agrees with the bug it exists to catch. `CheckStatus` and `DEFAULT_MAX_GUILLOTINE_STEPS` live in `cutplan.ts` and are re-exported from `validate.ts`, so the dependency runs one way and existing import paths still resolve.
5. **Material Matching:** Placements must only occur on stock matching the part's `materialId`.
6. **Quantity Accounting:** For every part, $\text{placed qty} + \text{unplaced qty} == \text{requested qty}$.
7. **Waste Correctness:** Recomputed `wastePct` and `totalWastePct` must match the reported result numbers.

---

## 5. Benchmark Performance & Baseline

The benchmark suite (`npm run bench`) tests 8 realistic woodworking projects. All fixtures solve with **0 unplaced parts** and waste levels well under the 15% exit requirement:

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
