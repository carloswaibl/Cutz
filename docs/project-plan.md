# Cut List Optimizer — Project Plan

*A free, browser-based cut list optimizer for hobbyist woodworkers.*

---

## 1. Product summary

A web app that takes a set of parts — entered manually, or imported from SVG or STL — and computes an optimal cutting layout across your available sheet stock. It respects saw kerf, grain direction, and material thickness, and outputs printable cut diagrams plus SVG/DXF export.

**Positioning:** CutList Optimizer and OptiCutter already handle 2D sheet layout competently. The differentiators here are (a) file import — nobody does STL well for this use case, (b) fully client-side so it works offline in a shop with bad wifi, and (c) genuinely free with no account wall.

---

## 2. Scope decisions

| Decision | Choice | Rationale |
|---|---|---|
| Cutting model | **Guillotine (table saw) in v1** | Matches the tool most hobbyists own. Nesting is a separate engine. |
| CNC nesting | **v2, architected for now** | Pluggable `Solver` interface so it drops in without touching UI or importers. |
| STL support | **Flatten single flat parts only** | Tractable. No 3D assembly decomposition. |
| SVG support | **Documented subset** | Closed paths, flattened curves, explicit units. Fail loudly on the rest. |
| Delivery | **Static client-side web app** | Zero hosting cost, works offline, no privacy questions about project files. |
| Accounts | **None in v1** | Projects stored in IndexedDB locally. |
| Outputs | **Print diagrams + cut list, SVG export, DXF export** | Per requirements. |

### Explicitly out of scope for v1
- CNC free-form nesting
- 1D linear stock (boards, 2x4s) — strong v1.5 candidate, ~10% extra work
- Offcut inventory tracking across projects
- G-code generation
- Cost estimation / lumber pricing
- Accounts, cloud sync, sharing

---

## 3. Recommended stack

**TypeScript + React (Vite), 100% client-side.** Solver in plain TypeScript to start.

- **Mesh/STL:** `three` + `STLLoader` for parsing and plane math
- **SVG parsing:** `svg-pathdata` or `paper.js` for path → polygon flattening
- **Rendering:** emit SVG directly from React — this gives you SVG export for free
- **DXF export:** `dxf-writer`, or hand-roll it (POLYLINE entities are simple)
- **Print:** browser print CSS with `@page` rules. No PDF library needed in v1.
- **Storage:** IndexedDB via `idb`
- **Hosting:** Cloudflare Pages or GitHub Pages

**Why not a Python backend:** your instinct will be to reach for one given your background, but it costs money to run, breaks offline use, and adds cold-start latency to what should feel instant. Nothing here needs a server.

**Why not Rust/WASM yet:** hobbyist-scale problems are ~20–100 parts across a handful of sheets. TypeScript will handle that in well under a second. Reach for WASM only when profiling proves you need it — premature WASM is a classic side-project killer.

---

## 4. Core domain model

```
Material   { id, name, thickness, hasGrain }
Part       { id, label, width, height, qty, materialId,
             rotationPolicy: 'locked' | 'free90' }
Stock      { id, materialId, width, height, qty, grainAxis }
Config     { kerf, edgeTrim, allowRotation }

Placement  { partId, stockInstanceId, x, y, rotated }
Layout     { stockInstanceId, placements[], wastePct }
Result     { layouts[], unplacedParts[], totalWastePct }

interface Solver {
  solve(parts, stock, config): Result
}
```

Parts are grouped by `(materialId, thickness)` into fully independent subproblems — solve each separately.

---

## 5. Algorithm approach

**Phase 1 — Greedy baseline.** Sort parts by area descending, first-fit-decreasing into a guillotine free-rectangle list. This is the standard approach from Jukka Jylänki's bin-packing survey; well-documented and fast to implement.

**Phase 2 — Improvement.** Randomized restarts over part ordering and per-part rotation choices, keeping the best result. Optionally simulated annealing. Cheap to add, large quality gain over pure greedy.

**Constraints woven in:**
- `rotationPolicy: 'locked'` disables the 90° rotation option for that part (this is grain direction)
- Kerf inflates each placement footprint on its cut edges
- Edge trim shrinks the usable area of each sheet before packing

**Stopping rule:** define "good enough" up front — e.g. within 5% waste of a hand-optimized reference layout on your benchmark set. Solver quality is unbounded and will eat the whole project otherwise.

---

## 6. Milestones

Ordered to retire risk early and produce something usable before touching file parsing.

### M0 — Spike (one weekend)
Prove the two scary things work before committing. Throwaway code.
- Parse a real STL, isolate the dominant face pair, derive thickness, project an outline
- Parse a real SVG from Inkscape and Illustrator, flatten curves to a polygon
- **Exit:** you know what you're in for on both importers

### M1 — Solver core (headless)
- Domain model + `Solver` interface
- Guillotine greedy packer, then improvement pass
- Unit tests + a benchmark set of 5–10 realistic projects (bookshelf, cabinet carcass, drawer boxes)
- **Exit:** `solve()` produces valid, kerf-correct layouts from JSON fixtures

### M2 — Minimal usable app
- Manual part entry table, material and stock config, kerf setting
- SVG layout rendering with dimensions and labels
- Waste summary
- **Exit: this is already a shippable, useful tool.** Consider soft-launching here.

### M3 — Export
- Print stylesheet: one sheet per page, cut list table, sequence numbering
- SVG export
- DXF export
- **Exit:** you can print it, carry it to the saw, and cut from it

### M4 — SVG import
- Path flattening, unit detection, transform resolution
- Mapping imported shapes → bounding-box parts
- Clear error reporting on unsupported constructs
- **Exit:** import a real Inkscape file and get correct parts

### M5 — STL import
- Mesh load, planar face detection, thickness inference, 2D projection
- Unit disambiguation prompt (STL carries no units — always ask)
- **Exit:** import an STL panel and get a correct part

### M6 — Polish and launch
- Project save/load via IndexedDB
- Onboarding example project
- Landing page, README, license
- Post to r/woodworking, r/hobbycnc, Lumberjocks

### V2 backlog
CNC free-form nesting · 1D linear stock · offcut inventory · G-code · cut sequence optimization for a single operator · multi-sheet cost minimization

---

## 7. Risk register

| Risk | Severity | Mitigation |
|---|---|---|
| **SVG parsing rabbit hole** — units, nested transforms, curves, open paths, groups | High | Support a documented subset. Fail loudly with a specific message. Do not chase generality. |
| **Scope creep into nesting** | High | The `Solver` interface is the firewall. Nesting is v2, no exceptions. |
| **STL has no units** — mm vs inch is ambiguous | Medium | Always prompt on import with a size preview. Never guess. |
| **Solver perfectionism** — unbounded quality chase | Medium | Fixed benchmark set + explicit "good enough" threshold. |
| **Open-ended timeline → stalls** | Medium | M2 is deliberately shippable. Getting real users early creates pull. |
| **No feedback loop** (free, no accounts, no telemetry) | Low | Seed via woodworking forums. Add an optional, clearly-labeled feedback link. |

---

## 8. Success criteria

**v1 ships when:** a woodworker can enter parts by hand or import an SVG, set kerf and grain, get a layout with under 15% waste on the benchmark projects, and print something they can carry to the saw.

**Longer-term signals:** returning users, layouts saved per session, waste percentage vs. hand-planned layouts, and unprompted forum mentions.

---

## 9. Open questions

1. **Imperial or metric first?** US hobbyist market is imperial and fractional (23-1/4"). Fractional input parsing is a small but real feature.
2. ~~**Do parts import as bounding boxes or true outlines?**~~ **Resolved in M4 - shipped.**
   Bounding boxes. `docs/plan-m4.md` §2: for a guillotine saw the part *is* its bounding box,
   because every cut runs edge to edge - outline fidelity only matters for free-form nesting,
   which is v2 and lives behind the `Solver` interface. Interior cutouts import as discarded
   holes, reported by a counted warning, not modelled.
3. **How much of the sheet is usable?** Factory edges on plywood are often not square — does the app assume a default trim allowance?
4. ~~**Cut sequence output?**~~ **Resolved in M3 — shipped.** `domain/cutplan.ts` derives a full
   guillotine cut order from each solved layout: every cut labelled rip or crosscut against the
   sheet's grain axis, with its fence setting and the piece it consumes, ordered depth-first so the
   operator works one piece at a time. It appears on screen, on the printed page, and as blade
   lines in the SVG and DXF exports. `validate.checkGuillotine` delegates to the same search, so
   the checker and the plan cannot disagree.

   **What it does not do:** reorder for operator efficiency. The plan is *a* valid cut order, not
   one minimising fence changes, blade-height changes, or handling. That reordering is in the v2
   backlog above, and the printed page says so on its face so the two are not confused.
