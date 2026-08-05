# M3 - Export

*Implementation plan for the derived cut sequence, print stylesheet, SVG export, and DXF export.*

Companion to `docs/project-plan.md` §6 (Milestone 3). Read `CLAUDE.md`, `docs/plan-m1.md`, and `docs/solver-design.md` first - the units policy (`domain/units.ts`), geometry conventions, and solver invariants are binding and unchanged by this milestone.

---

## 1. Goal and exit criteria

**Goal:** Turn a solved layout into something a woodworker can act on away from the screen - a printed cut sheet they carry to the saw, and machine-readable SVG/DXF files they can open in CAD or send to a CNC shop.

M3 introduces one genuinely new piece of domain logic: **the cut plan**. The solver produces *where parts sit*; it does not produce *the order of operations that gets them there*. Deriving that order is the differentiator flagged in `project-plan.md` §9 question 4, and it is the reason this milestone is more than a styling exercise.

**M3 exits when all of the following hold:**

1. **Derived cut sequence.** Every layout decomposes into an ordered list of edge-to-edge cuts, each labelled rip or crosscut relative to the sheet's grain axis, with the fence setting for the cut and the piece it applies to. Replaying the plan's cuts reproduces exactly the solver's placements - asserted in tests on every fixture.
2. **Print output.** `window.print()` produces one sheet per page: the cut diagram, that sheet's cut list, and that sheet's numbered cut sequence, on a light background that does not empty an ink cartridge. A final page carries the project summary, full cut list, saw settings, and any unplaced parts.
3. **SVG export.** The current sheet, or every sheet, exports as standalone SVG files that open correctly in Inkscape and Illustrator, dimensionally accurate to the millimetre, using the print palette rather than the dark screen theme.
4. **DXF export.** The same sheets export as DXF R12 with parts, sheet boundary, trim line, cut lines, and labels on separate named layers, correct Y-axis orientation, and `$INSUNITS` matching the exported unit system.
5. **No new runtime dependencies.** DXF is hand-rolled. SVG is rendered from the existing React component through `react-dom/server`, which ships inside the `react-dom` package already installed.
6. **Verification.** `npm run typecheck && npm run test:run && npm run lint && npm run build` all clean, and a real print-preview pass in the browser confirms page breaks, margins, and legibility at 100% scale.

---

## 2. Scope

### In scope

- `src/domain/cutplan.ts` - guillotine cut-tree derivation (pure, headless).
- Refactor of `validate.checkGuillotine` to delegate to the cut-tree search, so the checker and the plan generator cannot disagree.
- Print-theme support in `SheetSvg` (palette becomes a prop, not a hardcode).
- `src/export/svg.ts`, `src/export/dxf.ts`, `src/export/download.ts`, `src/export/print.css`.
- Print-only React component tree (`src/ui/components/print/`).
- Export and Print controls in `LayoutViewer`.
- Cut sequence display in the interactive UI (collapsible panel beside the diagram), not print-only.

### Out of scope

- PDF generation. Browser print is the mechanism; no PDF library. (`project-plan.md` §3.)
- Cut *optimisation* for the operator - minimising fence changes, blade height changes, or handling order. The plan reports a valid order derived from the layout. Reordering it for operator efficiency is a v2 concern and must not be confused with this.
- Offcut labelling or inventory. v2.
- SVG/STL import - M4/M5.
- IndexedDB persistence and project names - M6. Exported filenames key off material and sheet index until then.
- G-code. Permanently out of scope for v1.

---

## 3. The cut plan

### 3.1 Why the existing checker is not enough

`validate.checkGuillotine` already answers *can this layout be produced by edge-to-edge cuts*. It cannot be reused as-is for two reasons:

**It discards its own answer.** The search finds a valid cut at each region and returns a boolean. The plan needs the tree it walked.

**Its base case is wrong for an operator.** The checker stops when a region holds one rectangle, on the reasoning that the region boundary is itself made of guillotine cuts. That is sound for provability and useless at a saw: a 300x400 offcut containing a 250x400 part still needs a cut to bring it to size. The plan must continue past that base case and emit **finishing cuts** - up to four per leaf, wherever a part edge does not coincide with its region edge.

So `cutplan.ts` owns the search, and `checkGuillotine` becomes a thin wrapper over it (`buildCutTree(...) !== null`). This is deliberate, and it is the same reasoning `geometry.ts` gives for hosting the shared rectangle predicates: a checker with its own private copy of the logic eventually agrees with the bug it exists to catch.

### 3.2 Model

```ts
/** Which axis the blade line divides. 'x' is a vertical line at constant x. */
export type CutAxis = 'x' | 'y';

/** Structural role of the cut, independent of grain. */
export type CutRole = 'trim' | 'split' | 'finish';

/** Relation to the sheet's grain. null when the material has no grain. */
export type GrainRelation = 'rip' | 'crosscut' | null;

export interface CutPiece {
  /** 'A', 'B', 'C', ... assigned in creation order. Printed so the operator can track offcuts. */
  id: string;
  rect: Rect;
  /** Set when this piece is a finished part rather than an intermediate. */
  placement: Placement | null;
}

export interface CutStep {
  /** 1-based, in the order the operator makes the cuts. */
  index: number;
  role: CutRole;
  grain: GrainRelation;
  axis: CutAxis;
  /** Blade near-face position in sheet coordinates, mm. */
  at: number;
  /**
   * Distance from the piece's near edge to the blade's near face, mm.
   * This is the fence setting, and the near-side keeper comes off at exactly
   * this dimension.
   */
  fence: number;
  /** Piece consumed by this cut. */
  pieceId: string;
  /** Pieces produced: [near, far]. A 'finish' cut's far piece is waste. */
  produces: [string, string];
  /** Nesting depth, for indenting the printed step list. */
  depth: number;
}

export interface CutPlan {
  stockInstanceId: string;
  steps: CutStep[];
  pieces: CutPiece[];
  /** 'unverified' when the search hit its budget; never silently downgraded to complete. */
  status: 'complete' | 'unverified';
}
```

### 3.3 Derivation rules

- **Edge trim first.** When `edgeTrim > 0`, emit up to four `trim` steps before anything else. These are real cuts the operator makes and they are always guillotine-valid, which is why the search itself still starts from the usable area.
- **Grain labelling.** A cut on axis `x` is a vertical blade line, so it runs *along* the grain - a rip - when `stock.grainAxis === 'y'`. Conversely an axis `y` cut is a rip when `grainAxis === 'x'`. When `material.hasGrain` is false, `grain` is `null` and the printout says "CUT".
- **Rips preferred at the top.** Among valid decompositions the search tries the rip axis first. Breaking a full sheet into strips before crosscutting is how the work is actually done, and it is safer to handle. This is a candidate ordering preference only - it never changes whether a plan is found.
- **Step order is depth-first pre-order.** Cut the piece, then finish the near child completely, then the far child. That matches working one piece at a time and setting the other aside; breadth-first would have the operator juggling every offcut at once.
- **Determinism.** Same layout plus same config yields the same plan, byte for byte. Candidate cuts are sorted rather than taken in placement order.

### 3.4 Reconstruction, not re-search

The search memoises `Rect -> CheckStatus` today. It gains a second memo, `Rect -> chosen cut`, populated only on a `valid` outcome. The tree is rebuilt from that memo in a cheap second pass. Building tree nodes during the search would allocate on every abandoned branch, and this search runs on every solver output in the test suite.

---

## 4. Rendering, export, and layering

### 4.1 One renderer, three destinations

`SheetSvg` already draws everything the export needs. Duplicating it into a headless string builder would produce the exact divergence problem described in §3.1, one milestone later and in a place tests are less likely to catch. Instead:

- The hardcoded colours in `SheetSvg` move into a `SheetTheme` object with `screen` and `print` variants, passed as a prop.
- `src/export/svg.ts` calls `renderToStaticMarkup(<SheetSvg theme={printTheme} .../>)` and wraps the result with an XML declaration and explicit `width`/`height` in real units so CAD tools import at correct scale.
- The print component tree renders the same component with the same print theme.

`react-dom/server` runs in plain Node, so exports are testable in the existing `environment: 'node'` Vitest setup with no jsdom and no new dependency.

**Layering rule:** `src/export/` may depend on `src/ui/` renderers. `src/domain/` and `src/solver/` may depend on neither - that constraint is unchanged and non-negotiable.

### 4.2 DXF

Hand-rolled R12 ASCII in `src/export/dxf.ts`, headless, no React.

- Layers: `SHEET` (stock boundary), `TRIM` (usable area after edge trim), `PARTS` (part outlines as closed `LWPOLYLINE`), `CUTS` (cut lines from the cut plan), `LABELS` (`TEXT` entities with part label and dimensions).
- **Y-axis flip.** DXF is Y-up; our origin is top-left with Y down. Every emitted Y is `sheetHeight - y`. This is the single most likely correctness bug in the milestone and gets a dedicated test asserting a known part lands in the expected DXF quadrant.
- **Units.** Emitted in the user's current display unit system with `$INSUNITS` set to match (`4` = mm, `1` = inches). A user working in inches expects an inch drawing. Conversion happens here, at the export boundary, exactly as the units policy requires.

### 4.3 Download

`src/export/download.ts` - Blob, `URL.createObjectURL`, synthetic anchor click, revoke. "Export all sheets" fires downloads sequentially with a short gap; browsers throttle rapid successive downloads and Chrome shows a "download multiple files" permission prompt on the first use. The UI states this on the control so it does not read as a failure.

Filenames: `cutz-sheet-<n>-<material-slug>.svg` / `.dxf`. Project names arrive in M6 and will slot into the prefix.

### 4.4 Print

Print output is a **separate component tree**, `hidden print:block`, not the interactive UI coerced by CSS overrides. Inverting a dark, zoomable, hover-driven interface into a printable document via media queries is the kind of thing that works until someone adds a card.

```
src/ui/components/print/
  PrintDocument.tsx     # all pages; hidden on screen
  PrintSheetPage.tsx    # one stock sheet: diagram + cut list + cut sequence
  PrintSummaryPage.tsx  # project totals, saw settings, full cut list, unplaced parts
  CutListTable.tsx      # shared with the on-screen panel
  CutSequenceList.tsx   # shared with the on-screen panel
```

`src/export/print.css`: `@page { size: auto; margin: 12mm }`, `break-after: page` per sheet page, `print-color-adjust: exact` so part fills survive, and rules hiding all interactive chrome.

---

## 5. Work breakdown and PR sequence

Five sequential PRs. Each is independently mergeable and CI-green.

---

### PR 1 - `feat/domain-cut-plan`

**Focus:** the cut tree. Pure domain, zero UI.

- Add `src/domain/cutplan.ts`: `buildCutTree(region, rects, kerf, preferAxis, maxSteps)` (low-level search returning the tree or `null`/`'unverified'`) and `buildCutPlan(stock, material, layout, parts, config)` (high-level, resolves usable area and placement rects, emits trim and finishing cuts, assigns piece ids and grain labels).
- Refactor `validate.checkGuillotine` to delegate. `test/domain/validate.guillotine.test.ts` must pass **unchanged** - if it needs edits, the refactor changed behaviour and is wrong.
- Tests in `test/domain/cutplan.test.ts`:
  - **Replay verification** on every fixture: apply the plan's cuts to the sheet and assert the resulting finished pieces match the solver's placements exactly, in position and dimension. This is the load-bearing test.
  - Finishing cuts emitted where a part is smaller than its leaf region; none emitted where it fills it.
  - Pinwheel arrangement returns `null`.
  - Budget exhaustion returns `'unverified'`, never `'complete'`.
  - Grain labelling for both `grainAxis` values and for a grainless material.
  - Determinism: same input, identical plan across runs.
- Measure plan-build time across all fixtures and record it. If it is material relative to solve time, the UI computes plans lazily (PR 4 decision point).

---

### PR 2 - `feat/export-svg`

**Focus:** theme extraction and SVG export.

- Extract `SheetTheme` from `SheetSvg`'s hardcoded colours into `src/ui/components/sheetTheme.ts` with `SCREEN_THEME` and `PRINT_THEME`. Screen rendering must be pixel-identical to today.
- Add optional cut-line and part-number overlays to `SheetSvg`, driven by props, off by default on screen.
- `src/export/svg.ts`: `renderSheetSvg(...)` returning a standalone SVG string with XML declaration, `width`/`height` in real units, and embedded metadata comment (material, sheet index, kerf, edge trim, generated date).
- `src/export/download.ts`.
- Export controls in `LayoutViewer`: "SVG (this sheet)" and "SVG (all sheets)".
- Tests: snapshot golden SVG for the bookshelf fixture; assert dimensional accuracy by parsing back the sheet rect; assert no `class=` attributes leak into export output (Tailwind classes are meaningless in a standalone file).

---

### PR 3 - `feat/export-dxf`

**Focus:** hand-rolled DXF R12 writer.

- `src/export/dxf.ts`: header section with `$INSUNITS`/`$EXTMIN`/`$EXTMAX`, `TABLES` section with the five layers, `ENTITIES` section.
- Y-flip helper, isolated and separately tested.
- Unit conversion at the boundary, driven by display unit.
- UI wiring mirroring PR 2's controls.
- Tests: golden-file comparison for one fixture; quadrant assertion for the Y-flip; layer presence and entity counts; inch and mm variants both emitted with the right `$INSUNITS`.
- Manual verification: open an exported file in a DXF viewer and confirm scale and orientation. Record which viewer was used in the PR description.

---

### PR 4 - `feat/print-cut-sheets`

**Focus:** the printed document.

- Wire `buildCutPlan` into `useCutListState` (memoised alongside `result`; lazy if PR 1's timings say so).
- `src/export/print.css`, imported from `src/ui/index.css`.
- The five print components in §4.4.
- On-screen collapsible "Cut sequence" panel beside the diagram, reusing `CutSequenceList`.
- Print button in the header.
- Cut numbers overlaid on the diagram, matching the step list.
- Tests: `renderToStaticMarkup` of `PrintDocument` for a multi-sheet fixture - asserts page count, one cut list per sheet, step numbering continuity, and that unplaced parts appear on the summary page.
- Browser verification: print preview in Chrome and Safari. Check page breaks, that no sheet diagram splits across pages, that text is legible at 100%, and that the grain arrow and kerf lines survive the light palette.

---

### PR 5 - `chore/m3-exit-verification`

- Full-app pass against every fixture: solve, print-preview, export SVG, export DXF.
- Resolve `project-plan.md` §9 question 4 - record that cut sequence output shipped, and what it does and does not do (§2, "no operator-efficiency reordering").
- Update `CLAUDE.md` current status to M3 complete, M4 next. Add `cutplan.ts` and the `export/` files to the directory structure block.
- Update `docs/solver-design.md` §4 to note `checkGuillotine` now delegates to `cutplan.ts`.
- **Pre-existing gap to close here:** `BOOKSHELF_PRESET` has 2 parts, while `plan-m2.md` §1.6 promises a realistic 3-unit bookshelf onboarding project. A 2-part preset also makes a thin first impression of the printed cut sheet, which is the thing this milestone exists to sell. Bring the preset in line with `test/fixtures/bookshelf.json`.
- `npm run typecheck && npm run test:run && npm run lint && npm run build`.

---

## 6. Risk register

| Risk | Severity | Mitigation |
|---|---|---|
| **Cut-plan search cost** - the tree search is exponential worst-case and now runs on every UI state change, not just in tests | Medium | Reuses the existing memoisation and step budget. Measured in PR 1 before wiring into the UI; falls back to computing on print/expand only. `'unverified'` surfaces in the UI as "cut sequence unavailable for this sheet", never as a wrong sequence. |
| **DXF Y-flip** - silently produces a mirrored drawing that looks plausible | High | Isolated helper with its own test; quadrant assertion on a known part; manual open in a real DXF viewer before merge. |
| **Print palette regressions** - extracting the theme breaks the screen rendering | Medium | Theme extraction is mechanical and lands in its own PR with the screen output required to be unchanged. |
| **Browser print inconsistency** - page breaks and background colours differ across engines | Medium | `print-color-adjust: exact`, `break-inside: avoid` on diagrams, verified in Chrome and Safari in PR 4. Firefox checked but not blocking. |
| **Multi-file download prompt** - Chrome blocks rapid successive downloads | Low | Sequential dispatch with a gap, and the control states that the browser will ask permission. |
| **Cut plan mistaken for an optimised work order** | Low | The printed header labels it "a valid cut order", and §2 states the non-goal. Operator-efficiency ordering is v2. |

---

## 7. Confirmed decisions

1. **Cut sequence:** full derived guillotine cut order, not part numbering alone.
2. **DXF:** hand-rolled R12 writer, no `dxf-writer` dependency, per the bundle-size constraint in `CLAUDE.md`.
3. **Export granularity:** per-sheet files, plus an "all sheets" action firing sequential downloads. No zip dependency, no combined tiled file.
4. **SVG generation:** `renderToStaticMarkup` over the existing `SheetSvg`, not a parallel headless builder.
5. **Print:** dedicated light-themed component tree plus `@page` CSS. No PDF library.
6. **DXF units:** follow the user's display unit system, with `$INSUNITS` set to match.
