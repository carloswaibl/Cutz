# M3 - Export

*Implementation plan for the derived cut sequence, print stylesheet, SVG export, and DXF export.*

Companion to `docs/project-plan.md` §6 (Milestone 3). Read `CLAUDE.md`, `docs/plan-m1.md`, and `docs/solver-design.md` first - the units policy (`domain/units.ts`), geometry conventions, and solver invariants are binding and unchanged by this milestone.

---

## 1. Goal and exit criteria

**Goal:** Turn a solved layout into something a woodworker can act on away from the screen - a printed cut sheet they carry to the saw, and machine-readable SVG/DXF files they can open in CAD or send to a CNC shop.

M3 introduces one genuinely new piece of domain logic: **the cut plan**. The solver produces *where parts sit*; it does not produce *the order of operations that gets them there*. Deriving that order is the differentiator flagged in `project-plan.md` §9 question 4, and it is the reason this milestone is more than a styling exercise.

**M3 exits when all of the following hold:**

1. **Derived cut sequence.** Every layout decomposes into an ordered list of edge-to-edge cuts, each labelled rip or crosscut relative to the sheet's grain axis, with the fence setting for the cut and the piece it applies to. Replaying the plan's cuts reproduces exactly the solver's placements - asserted in tests on every fixture.
2. **Print output.** `window.print()` gives each sheet its own page or pages - never sharing one with another sheet - carrying the cut diagram, that sheet's cut list, and that sheet's numbered cut sequence, on a light background that does not empty an ink cartridge. A final page carries the project summary, full cut list, saw settings, and any unplaced parts.

   *Amended in PR 5.* This read "one sheet per page" until real print output was measured. It is not achievable: a sheet's cut sequence has no upper bound, and the `drawer-boxes` preset's first sheet needs 51 steps at 1533px against 1032px of A4 content box, so it exceeds a page on the sequence alone before the diagram is drawn. The achievable property - and the one that actually matters to someone at a saw - is that sheets never share a page. See PR 5 for the measurements.
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
   * this dimension. Negative when the blade overhangs the piece's near edge.
   */
  fence: number;
  /** Piece consumed by this cut. */
  pieceId: string;
  /**
   * Pieces produced: [near, far]. A 'finish' cut's far piece is waste.
   * A side is null when the blade left no offcut at all. Never both.
   */
  produces: [string | null, string | null];
  /** Nesting depth, for indenting the printed step list. */
  depth: number;
}

export interface CutPlan {
  stockInstanceId: string;
  steps: CutStep[];
  pieces: CutPiece[];
  /**
   * 'unverified' - the search hit its budget and proved nothing.
   * 'invalid' - the search proved no cut order exists.
   * Neither is ever silently downgraded to complete, and neither carries steps.
   */
  status: 'complete' | 'unverified' | 'invalid';
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

### PR 1 - `feat/domain-cut-plan` - DONE

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

Landed with 34 new tests (399 total). Decisions made during the work, binding on PRs 2-5:

- **`CutPlan.status` has three values, not two:** `'complete' | 'unverified' | 'invalid'`.
  §3.2 gave only the first two, but a layout that is *provably* uncuttable and a search that
  *ran out of budget* are different facts, and `validate.ts` argues at length that conflating
  them is the one thing a checker must never do. PR 4 owes them different messages: "this
  layout cannot be cut on a table saw" versus "cut sequence unavailable for this sheet".
  Neither carries a partial step list - half a cut plan is worse than none, because the
  operator discovers where it stops by running out of sheet.
- **`CutStep.produces` is `[string | null, string | null]`**, not `[string, string]`. When the
  waste a trim or finishing cut removes is thinner than the kerf, the blade runs off the edge
  of the piece and no offcut survives it. The cut is still real and still has to be made -
  this happens on the bookshelf fixture, where a 301mm strip yields a 300mm part - but there
  is no piece to name. Never `null` on both sides.
- **`fence` can be negative**, on a near-side finishing cut whose waste is thinner than the
  kerf. There is no fence setting for a blade that overhangs the piece; PR 4 renders those as
  "trim flush" rather than printing a plausible-looking number.
- **Rip preference applies at every level of the search**, not only the root, which is what
  §3.3's "rips preferred at the top" gets you in practice. The bookshelf sheet comes out as
  four 300mm rips followed by crosscuts at 1600 and 780 - the order a person would actually
  work in.
- **`CheckStatus` and `DEFAULT_MAX_GUILLOTINE_STEPS` moved to `cutplan.ts`** and are
  re-exported from `validate.ts`, so the dependency runs one way and existing import paths
  still resolve. `checkGuillotine` is now four lines.
- **Candidate cuts are sorted** rather than taken in placement order. Reordering the parts of
  a layout must not reorder the cut list the user is holding.
- **`reduceTo` snaps its keeper to the target rect** rather than carrying the arithmetic's
  residue. A keeper 1e-13mm off the part it is meant to be is a float artefact, and letting
  it accumulate would drift the plan away from the placements it was derived from. The replay
  test compares to 1e-6, so the snap can only ever be absorbing noise.
- **Signatures take options objects**, `buildCutPlan({ stock, material, layout, parts, config })`,
  plus `buildCutPlans(result, { parts, stock, materials, config })` returning one plan per
  layout for the UI.
- **Both throw on a broken result** - a layout naming a part or a stock entry the project does
  not contain. That is an internal inconsistency rather than user data, and `checkResult`
  reports it properly long before a plan is built.

**Timing: build plans eagerly.** Across all ten fixtures, building every sheet's plan costs
0.09-2.21ms against 2.4-22.8ms to solve - under 10% of solve time in every case, and the
plan only rebuilds when the result does. PR 4 memoises `buildCutPlans` alongside `result` in
`useCutListState` with no lazy path and no loading state.

| Fixture | Sheets | Solve (ms) | Plan (ms) | Steps |
|---|---|---|---|---|
| `bookshelf` | 3 | 22.81 | 2.21 | 61 |
| `cabinet-carcass` | 5 | 17.83 | 0.87 | 98 |
| `closet-organizer` | 3 | 6.31 | 0.36 | 50 |
| `drawer-boxes` | 3 | 12.42 | 0.70 | 96 |
| `grain-locked-panels` | 3 | 3.90 | 0.24 | 48 |
| `insufficient-stock` | 1 | 4.04 | 0.09 | 13 |
| `mixed-stock` | 3 | 10.40 | 0.46 | 75 |
| `oversized-part` | 1 | 3.81 | 0.18 | 22 |
| `tight-fit` | 1 | 2.39 | 0.10 | 7 |
| `workbench-cabinet` | 3 | 9.79 | 0.31 | 63 |

---

### PR 2 - `feat/export-svg` - DONE

**Focus:** theme extraction and SVG export.

- Extract `SheetTheme` from `SheetSvg`'s hardcoded colours into `src/ui/components/sheetTheme.ts` with `SCREEN_THEME` and `PRINT_THEME`. Screen rendering must be pixel-identical to today.
- Add optional cut-line and part-number overlays to `SheetSvg`, driven by props, off by default on screen.
- `src/export/svg.ts`: `renderSheetSvg(...)` returning a standalone SVG string with XML declaration, `width`/`height` in real units, and embedded metadata comment (material, sheet index, kerf, edge trim, generated date).
- `src/export/download.ts`.
- Export controls in `LayoutViewer`: "SVG (this sheet)" and "SVG (all sheets)".
- Tests: snapshot golden SVG for the bookshelf fixture; assert dimensional accuracy by parsing back the sheet rect; assert no `class=` attributes leak into export output (Tailwind classes are meaningless in a standalone file).

Landed with 17 new tests (416 total). Decisions made during the work, binding on PRs 3-5:

- **The `<svg>` element moved to `src/ui/components/SheetFigure.tsx`.** §4.1 assumed the export
  could render `SheetSvg` directly, but the sheet identity badge is an HTML `div` *outside* the
  SVG, so rendering that component yields a fragment no `.svg` file can hold. `SheetSvg` is now
  the screen wrapper - div, badge, `SCREEN_THEME`, hover wiring - and `SheetFigure` is the
  drawing. PR 4's print components render `SheetFigure`, never `SheetSvg`.
- **The screen rendering is a golden file too**, `test/export/golden/screen-sheet-1.svg`. The
  theme extraction was verified byte-identical against a capture taken from `main` before the
  refactor; the golden keeps it that way through PRs 3-5. If a change to `SheetFigure` moves
  it, that is a real screen change and needs to be an intended one.
- **The exported drawing states its physical size in millimetres**, regardless of display unit.
  Physical size is identical either way - only the number in the attribute differs - and the
  `mm` suffix makes the scale unambiguous. This is *not* the precedent for DXF: `$INSUNITS` is
  a document-level declaration a CAD user acts on, so PR 3 still follows the display unit as
  §4.2 says.
- **`figureViewBox(stock, showTitle)` is exported** and the exporter reads the physical size
  from it rather than recomputing. A drawing that claims a size it does not have is the one
  error a CAD user cannot see, because it looks entirely correct at the wrong scale. PR 3
  should take its `$EXTMIN`/`$EXTMAX` from the same helper.
- **The title block is inside the SVG, the waste badge is not.** `showTitle` draws material,
  sheet n of m, waste, kerf and trim above the sheet. The screen keeps its HTML badge, which
  stays crisp while the diagram zooms. PR 4's print pages set `showTitle`.
- **Overlays are wired but off.** `cutPlan`, `showCutLines`, and `showPartNumbers` render blade
  lines with numbered badges and piece letters on parts, and nothing turns them on yet. PR 4
  enables them for screen, print, and export in one change, so the diagram a user is looking at
  never differs from the file they export.
- **View padding is derived from the dimension labels**, not the fixed 8mm it had been. The
  rotated height label sits 3mm outside the sheet and its glyphs run back towards it, so 8mm
  clipped it on any full sheet of ply - visible on screen before this milestone and unmissable
  in an exported file. This is the one intended change to the screen diagram in this PR.
- **XML comment content is sanitised.** A material named `ply -- factory seconds` would
  otherwise close the metadata comment early and produce a file no parser will open.
- **Downloads are spaced 300ms apart** in `downloadFiles`, and the viewer caption states the
  browser will ask permission the first time. Chrome silently drops downloads that arrive
  faster. Confirmed in Chrome: the first "all sheets" export delivers sheet 1 and holds the
  rest until the user grants the multiple-downloads permission.
- **The exporter is a lazily-loaded chunk, prefetched on mount.** §4.1's "no new runtime
  dependencies" is true of `package.json` and false of the bundle: `react-dom/server` costs
  **196 kB raw / 60 kB gzip**, taking the app from 91 kB to 151 kB gzip for a feature most
  visitors never use. `LayoutViewer` now reaches it through `import('../../export/svg')` and
  warms it in a `useEffect` on mount, which puts initial load back at 92.5 kB gzip with a
  58.5 kB `svg-*.js` chunk alongside. Prefetching rather than loading on click is the offline
  constraint doing its work - a shop with bad wifi must not discover the chunk is missing at
  the moment it clicks export. PR 3's DXF writer is hand-rolled and headless, so it has no
  reason to join that chunk; if it ever imports a renderer, it must be lazily loaded the same
  way. **A service worker would close the remaining gap and is M6's business, not this PR's.**
- **Export failures surface.** A dynamic import that fails has no visible effect otherwise, so
  `LayoutViewer` catches and renders the message under the diagram.

**Known cosmetic gaps, not fixed here:** the `trim` callout still overlaps the sheet's top edge
(there is no room for it inside a 5mm trim band, and the title block now states the trim
anyway), and coordinates carry float residue from inch conversion - `1235.1999999999998` in the
viewBox against a clean `1235.2mm` physical size. Both are cosmetic; the physical size and the
geometry are exact.

---

### PR 3 - `feat/export-dxf` - DONE

**Focus:** hand-rolled DXF R12 writer.

- `src/export/dxf.ts`: header section with `$INSUNITS`/`$EXTMIN`/`$EXTMAX`, `TABLES` section with the five layers, `ENTITIES` section.
- Y-flip helper, isolated and separately tested.
- Unit conversion at the boundary, driven by display unit.
- UI wiring mirroring PR 2's controls.
- Tests: golden-file comparison for one fixture; quadrant assertion for the Y-flip; layer presence and entity counts; inch and mm variants both emitted with the right `$INSUNITS`.
- Manual verification: open an exported file in a DXF viewer and confirm scale and orientation. Record which viewer was used in the PR description.

Landed with 28 new tests (444 total). Decisions made during the work, binding on PRs 4-5:

- **R12 with closed `POLYLINE`/`VERTEX`/`SEQEND`, not `LWPOLYLINE`.** §4.2 asked for R12 *and*
  `LWPOLYLINE`, which contradict each other: `LWPOLYLINE` is an R13+ entity. R13 and R2000 were
  both weighed and rejected - from R13 on, a DXF needs entity handles, a `CLASSES` section, space
  blocks and an `OBJECTS` dictionary, scaffolding whose only real test is whether a CAD seat
  accepts the file.
- **The Y flip lives in one tested helper, `sheetToDxf`.** A mirrored drawing passes every overlap
  check and cuts grain-locked parts the wrong way round, so it is verified by parsing the emitted
  file back and comparing rects to the solver's placements on every fixture, plus a quadrant
  assertion.
- **Extents are the sheet, not the SVG viewBox.** PR 2 said to take `$EXTMIN`/`$EXTMAX` from
  `figureViewBox`; that turned out to be wrong, because the viewBox carries label padding in which
  nothing is drawn. A DXF has no physical size, only numbers, so its extents must bound the
  geometry.
- **Coordinates follow the display unit, with `$INSUNITS` to match** (`1`/`4`/`5`), which is the
  opposite of PR 2's decision for SVG and deliberately so: an SVG states a physical size, while a
  DXF has only a document-level unit declaration a CAD user acts on.
- **`sheetFileName` moved to `src/export/filename.ts`.** `svg.ts` pulls `react-dom/server` and is a
  lazily-loaded chunk, so a statically-imported DXF writer reaching into it for a filename would
  have undone that split.
- **The DXF writer is imported statically, not lazily.** It is a headless string builder with no
  renderer behind it, so it costs a few kB, and splitting it would buy nothing but a second way for
  an export to fail offline. Main bundle stayed at 94.3 kB gzip plus the 58.4 kB `svg` chunk.
- **Cut lines are wired but off**, as PR 2's SVG overlays are. PR 4 turns them on for screen, print
  and both exports together.

Verified end to end by exporting an imperial sheet from the running app, reading it back, and
confirming extents of 48x96 in and a layout matching the on-screen diagram in both axes.

---

### PR 4 - `feat/print-cut-sheets` - DONE

**Focus:** the printed document.

- Wire `buildCutPlan` into `useCutListState` (memoised alongside `result`; lazy if PR 1's timings say so).
- `src/export/print.css`, imported from `src/ui/index.css`.
- The five print components in §4.4.
- On-screen collapsible "Cut sequence" panel beside the diagram, reusing `CutSequenceList`.
- Print button in the header.
- Cut numbers overlaid on the diagram, matching the step list.
- Tests: `renderToStaticMarkup` of `PrintDocument` for a multi-sheet fixture - asserts page count, one cut list per sheet, step numbering continuity, and that unplaced parts appear on the summary page.
- Browser verification: print preview in Chrome and Safari. Check page breaks, that no sheet diagram splits across pages, that text is legible at 100%, and that the grain arrow and kerf lines survive the light palette.

Landed with 17 new tests (461 total). Decisions made during the work, binding on PR 5:

- **One toggle drives all four destinations.** `AppState.showCutSequence`, default on, controls the
  blade lines and piece letters on the screen diagram, the same overlays in the SVG and DXF
  exports, and the step list on the printed pages. PR 2 and PR 3 each promised "PR 4 turns them on
  together"; making that a single piece of state rather than four call sites is what makes it true.
  It lives in `AppState` rather than in `LayoutViewer` precisely because print and export read it.
- **Print follows the material filter**, exactly as the export buttons beside it do. Two controls in
  one cluster with different scopes would be a trap. The summary page says which material a
  filtered printout covers, and its waste figure is over the sheets on the printout rather than the
  solver's project-wide number - with a filter on, those differ.
- **The cut sequence panel sits below the diagram, not beside it.** §5 said beside; the viewer is in
  a 5/12 grid column and a five-column step table squeezed in next to a cut diagram is unreadable
  in the place precision matters most.
- **A sheet may take two pages, and that is the design.** §1 said "one sheet per page". A 4x8 sheet
  is 2438mm against roughly 270mm of usable page, so the diagram prints near 1:9 whatever it is
  given; the bookshelf preset's sheet plus its 19-step sequence measures about 1290px against
  1032px of A4 content box. `break-after: page` per sheet guarantees sheets never *share* a page,
  which is the property that actually matters, and nothing is shrunk to fit. Putting the sequence
  in the column beside the diagram was tried and reverted: at 55% width its Yields column wraps to
  three lines a row, costing more page than the diagram saved.
- **The sheet page layout adapts to the stock aspect.** A tall sheet leaves the page two-thirds
  empty beside it, so the cut list goes there; a wide sheet takes the full width with the list
  underneath. The fixtures are all 2440x1220 and the `BOOKSHELF_PRESET` sheet is 1219x2438, so both
  branches are exercised - a test pins which one is chosen.
- **`showTitle` is off on the printed pages**, against PR 2's note that they would set it. The
  title block is sized in sheet millimetres for a standalone full-width SVG; on a page column it
  renders around 1.5mm tall. The page carries an HTML header instead, which is legible at real size.
- **`print.css` uses no `!important`.** An `!important` in a print sheet is invisible until someone
  prints. `html body` and `body > #root > *` win on specificity instead, and the diagram is sized
  in `PrintSheetPage`'s markup rather than by overriding `SheetFigure`'s inline styles from a
  stylesheet that cannot know the stock's aspect ratio.
- **`placementKey` is exported from `SheetFigure`** so the printed cut list looks up the same piece
  letters the figure draws. Two keying schemes for one lookup would put a letter on the diagram
  that no row in the table matches.
- **`toFormatUnit` moved to `src/ui/format.ts`** alongside a new `formatDisplayLength`, so the
  diagram, the tables and the printed pages give one answer. The screen rendering is unchanged -
  the `screen-sheet-1.svg` golden still matches byte for byte.
- **A plan that is not `complete` shows no overlay and no steps**, with PR 1's two distinct
  messages: "cannot be cut on a table saw" for `invalid`, "unavailable for this sheet" for
  `unverified`. `fence < 0` renders "trim flush" rather than a negative number, per PR 1.
- **Main bundle is 100.4 kB gzip**, up from 94.3 kB, with the 58.4 kB `svg` chunk unchanged. Print
  renders in-app and needs no `react-dom/server`, so it is not lazily loaded - a shop with no wifi
  must be able to print.

**Known gap, surfaced not fixed here:** the units dropdown offers "Metric (cm)" but `formatLength`
only knows `mm` and `in`, so that setting renders millimetres. The summary page's "Units" row
derives its wording from `toFormatUnit` rather than the setting name so it cannot claim
centimetres, but the dropdown itself is still wrong. Worth a fix; it is not this milestone's.

**Not verified in-browser:** real print-preview pagination. The printed pages were rendered and
measured in Chrome by applying the print rules outside their media query, which checks layout,
palette and page height but not the browser's own page breaking. A human print-preview pass in
Chrome and Safari is still owed - PR 5.

---

### PR 5 - `chore/m3-exit-verification` - DONE

**Focus:** close PR 4's two debts, verify the printed document in a real browser, and bring the
docs in line with what shipped.

- Full-app pass: solve, print, export SVG, export DXF.
- Resolve `project-plan.md` §9 question 4 - cut sequence output shipped, with the
  no-operator-efficiency-reordering non-goal stated.
- `CLAUDE.md` to M3 complete / M4 next, with `cutplan.ts` and the `export/` and print files in the
  directory structure block.
- `docs/solver-design.md` §4 notes `checkGuillotine` delegates to `cutplan.ts`.
- **Preset item dropped, confirmed stale.** `BOOKSHELF_PRESET` has 2 part *rows* but 30 instances -
  6 sides and 24 shelves across 3 sheets - which is the 3-unit bookshelf `plan-m2.md` §1.6 asked
  for. No change made.

Landed with 460 tests, down one from 461. Decisions made during the work:

- **"Metric (cm)" removed rather than implemented.** Metric woodworking is millimetres: sheet
  goods, cabinet plans and saw scales are all specified in mm. `parseLength` already accepts a `cm`
  suffix on input independently of the display setting, so `60cm` still parses to 600mm; what goes
  is only the display mode. Implementing it properly would have put a third case in `Unit` in
  `domain/units.ts`, which every table, the diagram, both print trees and both exporters fan out
  from, to serve a unit nobody specifies plywood in.
- **The cm gap was worse than PR 4 recorded.** PR 4 called it "silently renders millimetres". In
  the DXF it was worse than silent: `unitSystem` scaled geometry by 1/10 and declared `$INSUNITS 5`
  while `toFormatUnit` rendered the LABELS layer in millimetres - one file, geometry in centimetres,
  dimension text in millimetres, and nothing on its face to say so. Deleting the setting deleted
  that file. The two functions now carry a comment saying they move together or not at all.
- **`dxf.ts` no longer keeps its own copy of `toFormatUnit`.** It imports the one in
  `ui/format.ts`. Two copies of that mapping are exactly what let the geometry and the labels
  disagree, and `ui/format.ts` pulls no React, so a statically-imported `dxf.ts` stays cheap.
- **§1 exit criterion 2 amended from "one sheet per page".** Not achievable, and the print pass
  proved it rather than argued it. Measured sheet-page heights against a 1032px A4 content box:

  | Preset | Sheet page overflow (px) | Cut-sequence steps |
  |---|---|---|
  | `bookshelf` | +268, +268, +355 | 19, 19, 22 |
  | `cabinet-carcass` | +239, +471, +616, +413 | 18, 26, 31, 24 |
  | `drawer-boxes` | **+1594**, +951, +355 | 51, 32, 22 |

  `drawer-boxes` sheet 1 is 2626px: a 1015px diagram block and a 1533px sequence. A sheet's cut
  sequence has no upper bound, so no diagram cap and no column arrangement makes it one page - with
  a zero-height diagram it still needs one and a half. PR 4's "a sheet may take two pages, and that
  is the design" was right, and it is now what the criterion says. **No layout change was made**,
  because none of the available ones fixes the case that motivated looking.
- **The cut-sequence toggle is what actually governs page count.** `bookshelf` with the sequence
  shown is 7 physical pages; with it hidden every sheet fits exactly one page and the document is 4.
  That is the lever a user has, and it works.

**Verified in Chrome, on the browser's own pagination.** PR 4 could only measure the printed pages
by applying the print rules outside their media query. This pass drove headless Chrome over CDP and
used `Page.printToPDF`, which runs the real page-breaking engine, then rendered the PDFs and read
them. Confirmed across all three presets: no sheet shares a page with another, no sheet diagram
splits across a break (`break-inside-avoid` holds - the largest diagram block measured 1015px
against 1032px available, which is close enough to be worth knowing), the cut-sequence table
repeats its header on continuation pages, the summary page comes last, and the light palette,
grain arrow and kerf lines all survive `print-color-adjust: exact`.

Also confirmed live in the running app:

- **No horizontal overflow** on any print page - zero elements exceed the page box on any preset.
  The text sitting flush to the right margin is right-aligned, not clipped.
- **No viewBox clipping.** Content edges sit exactly on the viewBox on the left and top with 12.45mm
  spare on the right and bottom, on all three presets, with the rotated height label's own transform
  accounted for. PR 2's label-derived padding is doing its job.
- **The material filter scopes print**, as the export buttons beside it do: filtering `drawer-boxes`
  to Baltic Birch prints 2 sheets, and the summary page says "Filtered to 12mm Baltic Birch - other
  materials are not on this printout" with waste over the printed sheets, not the project.
- **Exports run through the real UI wiring.** SVG and DXF both produce correct MIME types, correct
  provenance headers and `cutz-sheet-<n>-<material>.svg|dxf` filenames; "all sheets" delivers 3
  files spaced ~300ms apart; the exported SVG carries 19 blade lines matching the 19 printed steps,
  and no `class=` attribute leaks into it.

**Safari confirmed** by a human print-preview pass against the seven-step checklist in PR #19 -
page breaks, the colour-managed fills and kerf lines, the repeated table header, the cut-sequence
toggle, the filtered printout, and legibility at 100%. Chrome and Safari therefore both pass, which
closes §6's browser-print-inconsistency risk for the two engines it names. Firefox remains
checked-but-not-blocking.

**M3 exits here.** All six criteria in §1 are met, with criterion 2 as amended.

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
