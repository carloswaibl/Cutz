# M2 - Minimal Usable App

*Implementation plan for the browser UI, part/stock entry tables, SVG cut diagram renderer, and waste summary.*

Companion to `docs/project-plan.md` §6 (Milestone 2). Read `CLAUDE.md` and `docs/plan-m1.md` first — the solver invariants, units policy (`domain/units.ts`), and geometry conventions are binding and remain unchanged.

---

## 1. Goal and exit criteria

**Goal:** Provide a complete, responsive, client-side web application built with React, TypeScript, and **Tailwind CSS v4** where woodworkers can manage materials, enter parts (with fractional imperial or metric lengths), set available stock sheets and saw config (kerf & edge trim), view interactive SVG cut diagrams, see waste metrics, and identify unplaced parts.

**M2 exits when all of the following hold:**

1. **Full Input Management:** Woodworkers can create, edit, duplicate, and delete Materials, Parts (with labels, dimensions, quantities, material assignment, and grain locking), Stock sheets, and Saw Config (kerf and edge trim).
2. **Fractional & Metric Inputs:** Input fields accept fractional imperial strings (`23 1/4`, `23-1/4`, `23.25`, `1/2"`) as well as metric values (`600`, `1220mm`), converting seamlessly to internal canonical `mm` units via `domain/units.ts` without data loss or precision corruption.
3. **Live / Instant Solver Integration:** Changes to parts, stock, or config invoke `solve()` (debounced for smooth typing) and update the layout views without UI freezes.
4. **SVG Cut Diagram Rendering:** Layouts render as native, responsive React SVG components (`SheetSvg`) featuring:
   - Trimmed stock boundaries and kerf indicators.
   - Part rectangles with distinct colors and high-contrast labels.
   - Formatted dimension lines (width × height) in the selected display unit.
   - Visual grain direction indicators.
   - Hover highlighting linking part rows in the table with SVG parts on the sheet.
5. **Waste Summary & Unplaced Alerts:**
   - Accurate total waste % and per-sheet waste % display.
   - Prominent notification badge and details card if any part cannot be placed, including reasons (e.g. part exceeds stock size or grain lock constraint).
6. **Onboarding Demo Preset:** App loads with an initial realistic sample project (e.g., 3-unit Bookshelf) so first-time users immediately see a working layout without a blank screen.
7. **Verification & Quality:**
   - All tests pass: `npm run typecheck && npm run test:run && npm run lint`.
   - UI builds cleanly: `npm run build`.
   - Desktop and mobile/tablet responsive layouts built with Tailwind CSS v4 work smoothly.

---

## 2. Scope & Out of Scope for M2

### In Scope for M2
- Client-side React state management for materials, parts, stock, saw config, units, and solver results.
- Styling powered by **Tailwind CSS v4** (`@tailwindcss/vite` plugin and `@import "tailwindcss"` in `src/ui/index.css`).
- Material table/manager (name, thickness, grain toggle).
- Part entry table (label, width, height, quantity, material, grain lock toggle).
- Stock table (material, width, height, quantity, grain axis, stock preset quick-adds like 4'x8', 5'x5', 24"x48").
- Saw & Solver config bar (kerf, edge trim, solver effort, seed re-roll).
- SVG layout rendering (`SheetSvg`) with zoom, pan, and hover sync.
- Waste summary metrics (`SummaryCard`).
- Unplaced parts alert banner (`UnplacedAlert`).
- Theme & responsive layout (Dark theme slate background `bg-slate-950`, slate surface cards `bg-slate-900`, amber accent `text-amber-500`, emerald waste metrics `text-emerald-500`).

### Out of Scope for M2 (Reserved for M3+)
- Print stylesheets (`@page` rules and print-optimized multi-page layout) → **M3**.
- File export (SVG export download button, DXF export) → **M3**.
- File import (SVG path flattening, STL mesh projection) → **M4 / M5**.
- IndexedDB persistence / Project saving across reloads → **M6**.
- WASM / Web Workers / Server APIs → **Explicitly out of scope per `CLAUDE.md`**.

---

## 3. Architecture & Component Structure

### 3.1 Directory Layout (`src/ui/`)

```
src/
  ui/
    index.css                 # Tailwind CSS v4 imports (@import "tailwindcss";), custom theme utilities, font imports
    App.tsx                   # App container & top-level responsive layout grid
    state/
      useCutListState.ts      # Custom hook managing materials, parts, stock, config, units, and solver invocation
      types.ts                # App UI state types (DisplayUnit, FormattedInputState, etc.)
      presets.ts              # Preset demo projects (Bookshelf, Cabinet Carcass)
    components/
      Header.tsx              # Brand logo, subtitle, unit toggle (in / mm), solver effort selector, preset loader
      ConfigBar.tsx           # Kerf, edge trim allowance, seed re-roll button
      MaterialManager.tsx     # Add/edit/delete materials modal or inline manager
      PartTable.tsx           # Dynamic table for part entries with fractional inch validation
      StockTable.tsx          # Dynamic table for available stock sheets with stock size presets
      SummaryCard.tsx         # Total waste %, sheet count, placed parts count, material breakdown
      LayoutViewer.tsx        # Multi-sheet container with tab/card selector, zoom/pan controls
      SheetSvg.tsx            # Pure React SVG renderer for an individual stock layout
      UnplacedAlert.tsx       # Warning banner for unplaced parts with actionable explanations
```

### 3.2 State Management (`useCutListState.ts`)

Pure React hook utilizing `useMemo` and `useCallback` (or `useReducer`) to maintain application state:

```ts
export type DisplayUnit = 'imperial-fraction' | 'imperial-decimal' | 'metric-mm' | 'metric-cm';

export interface AppState {
  displayUnit: DisplayUnit;
  fractionDenominator: number; // e.g. 16
  materials: Material[];
  parts: Part[];
  stock: Stock[];
  config: SolverConfig;
  activeSheetIndex: number;
  hoveredPartId: string | null;
  selectedMaterialFilter: string | 'all';
}
```

#### Live Solver Invocation:
- Whenever `parts`, `stock`, `config`, or `materials` change, `useCutListState` automatically invokes `solver.solve(parts, stock, config)`.
- Solver execution for 20–100 parts takes ~10–50ms (measured in M1 bench). A short debounce (150ms) ensures smooth typing in text inputs without input lag.

### 3.3 Tailwind CSS v4 & Styling Guidelines

- **Tailwind Setup:**
  - Dev Dependencies: `@tailwindcss/vite`, `tailwindcss` (v4).
  - `vite.config.ts` plugin: `tailwindcss()`.
  - Main CSS (`src/ui/index.css`): `@import "tailwindcss";`
- **Tailwind Theme Palette:**
  - Main background: `bg-slate-950` (`#020617`).
  - Card surfaces: `bg-slate-900/90 border border-slate-800 backdrop-blur-sm shadow-xl rounded-xl`.
  - Warm Woodwork Accent: `amber-500` / `amber-600` (e.g. `bg-amber-500 hover:bg-amber-600 text-slate-950 font-medium`).
  - Emerald Efficiency: `emerald-400` / `emerald-500` for low waste scores and success badges.
  - Text: `text-slate-100` primary, `text-slate-400` secondary, `font-mono` for numbers and dimensions.
- **Interactive SVG Diagram:**
  - Render crisp SVG lines with `vector-effect="non-scaling-stroke"`.
  - Hovering over a part in `PartTable` highlights the corresponding SVG rectangle with an amber glow stroke (`stroke-amber-400 stroke-2 filter drop-shadow`).
  - Hovering over a part in `SheetSvg` highlights the part row in `PartTable` and shows a detail tooltip.

---

## 4. Work Breakdown & PR Sequence

M2 execution is divided into 5 sequential, incremental pull requests:

---

### PR 1 — `feat/ui-tailwind-design-system-and-state`
**Focus:** Install Tailwind CSS v4 (`@tailwindcss/vite`), setup `index.css`, state hook, unit conversion layer, and preset demo data.

#### Tasks:
- Install `@tailwindcss/vite` and `tailwindcss` as devDependencies. Update `vite.config.ts` with `tailwindcss()`.
- Update `src/ui/index.css` with `@import "tailwindcss";`, custom theme utilities, typography, font imports, and custom scrollbars.
- Create `src/ui/state/types.ts` defining UI state interfaces.
- Create `src/ui/state/presets.ts` exposing sample projects (Bookshelf preset based on `test/fixtures/bookshelf.json`).
- Create `src/ui/state/useCutListState.ts` with state reducers/actions for adding, updating, removing parts/stock/materials, unit selection, and automatic solver execution.
- Create `src/ui/components/Header.tsx` styled with Tailwind utilities displaying header branding, unit switcher (`Imperial 1/16"` vs `Metric mm`), solver effort dropdown (`Fast`, `Balanced`, `Thorough`), and "Load Sample Project" preset button.

---

### PR 2 — `feat/ui-part-stock-material-tables`
**Focus:** Form input controls, part entry table, stock table, material manager, and saw configuration bar using Tailwind components.

#### Tasks:
- Create `src/ui/components/ConfigBar.tsx` for saw blade kerf and factory edge trim inputs with unit-aware formatting and seed re-roll trigger.
- Create `src/ui/components/MaterialManager.tsx` allowing users to add/edit materials (name, thickness, grain toggle) and assign color tags.
- Create `src/ui/components/PartTable.tsx`:
  - Columns: Part Label, Material, Width, Height, Qty, Grain Lock (`locked` vs `free90`), Actions (Duplicate / Delete).
  - Support string inputs formatted in active unit (`23 1/4"`, `600mm`) with live validation using `parseLength`. Tailwind red border / tooltip on parse error.
  - "Add Part" button + quick bulk action (clear all parts).
- Create `src/ui/components/StockTable.tsx`:
  - Columns: Stock Label/Material, Width, Height, Available Qty, Grain Axis (`X` / `Y`), Actions.
  - Quick-add stock presets bar: `4' x 8' Sheet (48" x 96")`, `5' x 5' Baltic Birch (60" x 60")`, `2' x 4' Handy Panel (24" x 48")`, `1220 x 2440mm`.

---

### PR 3 — `feat/ui-sheet-svg-renderer`
**Focus:** SVG cut diagram component, dimensions rendering, kerf visualization, and grain indicators.

#### Tasks:
- Create `src/ui/components/SheetSvg.tsx`:
  - Receives `Layout`, `Stock`, `Part[]`, `Material`, `DisplayUnit`, `hoveredPartId`, `onHoverPart`.
  - SVG viewBox scaled to stock dimensions `(width, height)`.
  - Usable stock rect (stock minus `edgeTrim` in dashed line).
  - Render each `Placement` rect with distinct color fill based on part ID / index.
  - Render dimension lines: arrow headers and text labels formatted according to `DisplayUnit`. Automatically hide or abbreviate text if part rect is too small to fit full text.
  - Render kerf cut lines along placement borders to visualize saw blade path.
  - Render subtle diagonal wood grain pattern overlay if material has grain.
  - Interactive hover state: highlight border, cursor pointer, trigger `onHoverPart(partId)`.

---

### PR 4 — `feat/ui-layout-viewer-summary`
**Focus:** Layout navigation viewer, zoom/pan controls, summary metrics card, and unplaced parts alert.

#### Tasks:
- Create `src/ui/components/LayoutViewer.tsx`:
  - Sheet selection tabs (e.g. `Sheet 1: 3/4" Ply (Waste: 4.9%)`, `Sheet 2: 3/4" Ply...`).
  - Zoom (+ / - / Reset) and Pan controls for inspecting intricate cut details.
  - Filter layouts by material tab when multi-material projects are loaded.
- Create `src/ui/components/SummaryCard.tsx`:
  - Total Waste % badge (green `<10%`, amber `10-20%`, red `>20%`).
  - Total sheets used count and total sheet area.
  - Total parts placed vs unplaced count.
  - Breakdown by material.
- Create `src/ui/components/UnplacedAlert.tsx`:
  - Warning banner when `result.unplacedParts.length > 0`.
  - Lists unplaced parts with specific actionable reasons (e.g., "Part 'Cabinet Back' (48"x96") exceeds usable sheet area 47.75"x95.75" after edge trim").

---

### PR 5 — `chore/m2-exit-verification`
**Focus:** Integration in `App.tsx`, polish, responsive layout testing, accessibility, and documentation.

#### Tasks:
- Wire all components into `src/ui/App.tsx`.
- Add Tailwind responsive grid layout (`grid grid-cols-1 lg:grid-cols-12 gap-6`).
- Implement keyboard navigation & ARIA labels for accessibility.
- Run `npm run typecheck && npm run test:run && npm run lint` to ensure zero regressions.
- Verify production build with `npm run build` and `npm run preview`.
- Update `CLAUDE.md` and project documentation to reflect M2 completion status and Tailwind v4 usage.

---

## 5. Risk Register & Mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| **Input Parsing Confusion** (user enters `23 1/4` vs `23.25` vs `23"`) | Medium | Use `domain/units.ts` `parseLength` on blur/change. Provide visual inline error text when input fails to parse. |
| **SVG Label Overlap / Text Overflow** on small parts | Medium | Calculate label bounding box relative to part `w` x `h`. Hide text or show label-only if width/height is below threshold (e.g., `< 40mm`). Show full info on hover tooltip. |
| **Solver Re-render Lag** on typing | Low | Debounce solver call in `useCutListState` by 150ms. Solver run is already ultra-fast (~10-50ms). |
| **Tailwind v4 Vite Integration** | Low | Standard `@tailwindcss/vite` plugin setup in `vite.config.ts` and `@import "tailwindcss";` in `src/ui/index.css`. |

---

## 6. Confirmed Options & Defaults

1. **Styling Framework:** Tailwind CSS v4 using `@tailwindcss/vite` plugin.
2. **Default Unit System:** Imperial fractional (`1/16"` precision) with metric toggle (`mm`).
3. **Solver Execution Mode:** Debounced auto-solve on edit (150ms) + manual re-solve button.
4. **Demo Preset:** Bookshelf preset loaded by default on first visit.
