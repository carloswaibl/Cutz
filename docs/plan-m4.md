# M4 - SVG import

*Implementation plan for SVG parsing, unit resolution, transform flattening, and the mapping of imported shapes to parts.*

Companion to `docs/project-plan.md` §6 (Milestone 4). Read `CLAUDE.md`, `docs/plan-m1.md` and `docs/plan-m3.md` first - the units policy (`domain/units.ts`), geometry conventions and solver invariants are binding and unchanged by this milestone.

---

## 1. Goal and exit criteria

**Goal:** A woodworker who has already drawn their parts - in Inkscape, in Illustrator, in a Fusion sketch - stops retyping them into the parts table. They drop the file in, see exactly what was found and at what size, correct anything the file was ambiguous about, and get parts.

M4 introduces the project's first **untrusted input**. Everything the app has consumed so far it also produced: presets, the solver's own output, values a user typed into a validated field. An SVG comes from someone else's software and is under nobody's control. That changes the posture of the code in this milestone - the parser's job is not to succeed, it is to be *specific*, and the difference between "this file didn't work" and "the three text elements on layer 2 were skipped, and the drawing was assumed to be 96 px per inch" is the whole feature.

**M4 exits when all of the following hold:**

1. **Real files import correctly.** A genuine Inkscape export, a genuine Illustrator SVG and a genuine Fusion sketch export each produce the right parts at the right sizes, verified against the dimensions in the source drawings, with those files committed to `test/files/` and asserted in tests.
2. **Units are resolved or asked for, never guessed silently.** When the document declares a physical size, it is used. When it declares only pixels, the preview says so on its face and offers a scale override. When no scale can be derived at all, import is blocked until the user supplies one. In every case the preview shows the resulting real-world sizes before anything is committed.
3. **Transforms are resolved.** Nested groups, layers, `use` clones and every `transform` form (`matrix`, `translate`, `scale`, `rotate`, `skewX`, `skewY`) compose correctly through to the leaf shape, and a part drawn rotated on the canvas imports at its true size rather than its axis-aligned footprint.
4. **The unsupported subset fails loudly and specifically.** Every element that was skipped is reported by name and count, with a message saying what to do about it. §4 documents the subset; the code and the doc do not diverge.
5. **The preview is the commit point.** Nothing reaches the parts table without the user seeing the label, width, height, quantity and detected angle of every part first, choosing a material and a rotation policy, and choosing whether to append or replace.
6. **One new runtime dependency, lazily loaded.** `svg-pathdata` and the whole importer live in a chunk the initial bundle does not pay for, prefetched on mount the way `export/svg.ts` already is. Initial bundle growth reported in the PR.
7. **Verification.** `npm run typecheck && npm run test:run && npm run lint && npm run build` all clean, plus a real browser pass importing each committed file and cutting the result.

---

## 2. Scope

### In scope

- `src/import/types.ts` and `src/import/errors.ts` - the shared importer contract, designed to carry M5's STL importer without change.
- `src/import/geometry.ts` - convex hull, minimum-area oriented bounding box, polygon area and containment. Shared by SVG now and STL in M5.
- `src/import/svg/` - document parsing, viewport and unit resolution, transform composition, shape normalisation, curve flattening, contour grouping, part grouping.
- `src/ui/components/import/` - the import dialog and preview, plus drag-and-drop onto the parts table.
- A batched `IMPORT_PARTS` reducer action.
- Real test files in `test/files/`, plus synthetic edge-case files clearly marked as such.

### Out of scope

- **True outlines.** Imported shapes become rectangles. This resolves `project-plan.md` §9 question 2: for a guillotine saw the part *is* its bounding box, because every cut is edge to edge. Outline fidelity only buys anything for free-form nesting, which is v2 and behind the `Solver` interface. Interior cutouts are reported and discarded, not modelled.
- **STL import.** M5.
- **Importing stock, materials or config from a file.** An SVG describes parts. Sheet sizes, thickness and kerf stay where they are.
- **Importing a *layout*.** A file containing an already-arranged sheet imports as a pile of parts, not as a fixed placement. Honouring a hand-arranged layout is not a feature anyone asked for and would need a whole second path through the solver.
- **CSS stylesheets.** Presentation attributes and inline `style` are read for visibility; a `<style>` block is not parsed. §4.4 says what happens instead.
- **DXF or PDF import.** Not planned.
- **Persistence of the imported file.** M6 owns project storage; an import is a one-way transaction into the parts table.

---

## 3. The pipeline

```
File
 └─ text                      guard: size cap, .svg extension
 └─ parseDocument             DOMParser -> Document, or a typed 'not-xml' / 'not-svg' error
 └─ resolveViewport           width/height/viewBox/preserveAspectRatio -> root matrix (user units -> mm)
 └─ walk                      CTM stack, visibility, use-resolution, unsupported-element warnings
     └─ normaliseShape        rect/circle/ellipse/polygon/polyline -> path data
     └─ transform + flatten   apply CTM to path data, then subdivide curves in mm
     └─ contours              close, drop degenerates, nest holes into their parent
 └─ minAreaBox                per outer contour -> { width, height, angle }
 └─ group                     identical sizes collapse into one part with a quantity
 └─ ImportOutcome             parts + warnings + how the scale was determined
 └─ preview                   user confirms scale, material, rotation policy, selection
 └─ IMPORT_PARTS              append or replace
```

Everything above the preview line is pure: a string and an options object in, a plain data structure out. The only browser dependency is `DOMParser`, which is why the whole thing is testable.

### 3.1 Modules

```
src/import/
  types.ts        # ImportedPart, ImportWarning, ImportOutcome  (shared with M5)
  errors.ts       # ImportError kinds and their user-facing messages
  geometry.ts     # hull, min-area box, signed area, point-in-polygon  (shared with M5)
  svg/
    index.ts      # importSvg(text, options): ImportOutcome
    document.ts   # DOMParser wrapper, root resolution, parsererror detection
    viewport.ts   # width/height/viewBox/preserveAspectRatio -> mm matrix + ScaleSource
    transform.ts  # Matrix, transform-attribute parsing, composition, shear detection
    shapes.ts     # rect/circle/ellipse/polygon/polyline -> path data
    flatten.ts    # svg-pathdata pipeline -> contours in mm
    contours.ts   # closing, degenerate filtering, hole nesting
    label.ts      # title / inkscape:label / aria-label / id -> a part label
    group.ts      # identical parts collapse into quantities
```

`src/import/` may depend on `src/domain/`. It must not depend on `src/ui/` or `src/solver/`, and nothing in `src/domain/` or `src/solver/` may depend on it. That is the same one-way rule `export/` follows, pointing the other way.

### 3.2 The shared importer contract

`types.ts` is written for two importers from the start, because writing it for one and retrofitting M5 is how the SVG's assumptions end up baked into the STL path.

```ts
/** Where the millimetre scale came from. The preview says this out loud. */
export type ScaleSource =
  | { kind: 'declared'; unit: string; mmPerUnit: number }   // width="210mm"
  | { kind: 'assumed-px'; mmPerUnit: number }               // unitless: 96 px/in per spec
  | { kind: 'user'; mmPerUnit: number }                     // the override was used
  | { kind: 'none' };                                       // nothing to go on - blocks import

export interface ImportedPart {
  /** Best label the source could offer. Never empty. */
  label: string;
  /** Millimetres, canonical, like everything else in domain/. */
  width: number;
  height: number;
  qty: number;
  /**
   * Degrees the shape was drawn at, 0 when square to the canvas. Reported so a
   * user can see the min-area box did the right thing; not stored on the Part.
   */
  angle: number;
  /**
   * False when the shape is below the tiny-shape threshold or otherwise
   * suspect. The preview starts these unticked rather than dropping them.
   */
  selected: boolean;
  /** Element ids behind this row, for the preview's "3 shapes" affordance. */
  sourceIds: string[];
}

export interface ImportWarning {
  kind: ImportWarningKind;
  /** Occurrences folded into one entry. */
  count: number;
  /** User-facing, names the construct and says what to do. Never generic. */
  message: string;
}

export type ImportOutcome =
  | { ok: true; parts: ImportedPart[]; warnings: ImportWarning[]; scale: ScaleSource }
  | { ok: false; error: ImportError };
```

An `ImportError` is a file the app cannot proceed with at all. An `ImportWarning` is something it proceeded past and the user must be told about. Mixing the two is what produces importers that either throw on a stray `<text>` or silently drop half a drawing.

---

## 4. The supported subset

CLAUDE.md's rule is that a user always learns *which* construct was not supported. That obliges a written list, and this is it. It belongs in the app's own help text too, not only here.

### 4.1 Geometry that becomes a part

| Element | Handling |
|---|---|
| `path` | Full grammar via `svg-pathdata`. Arcs converted to cubics, curves flattened. |
| `rect` | Including `rx`/`ry`. A rounded rect's box is the full rect, which is correct - the corner radius is inside the cut. |
| `circle`, `ellipse` | Become their bounding square/rectangle. |
| `polygon` | Closed by definition. |
| `polyline` | Closed if its ends meet within tolerance, otherwise reported as an open path. |

### 4.2 Structure that is walked

`svg` (root), `g` including Inkscape layers, `a`, `switch`, and `use`.

**`use` is resolved**, to a depth cap of 8 with cycle detection. This is not completeness for its own sake: Inkscape clones are exactly how somebody draws six identical shelves, and an importer that ignores `use` returns one part from a drawing that plainly shows six. The referenced element is instantiated with the `use` element's own transform plus its `x`/`y` offset, and inherits the `use`'s label if it has one.

`defs` is not walked for geometry, only followed as a `use` target. `title`, `desc`, `metadata`, `style` and `sodipodi:namedview` are read where useful and never treated as shapes.

### 4.3 Skipped, with a warning naming it

`text`, `tspan`, `image`, `foreignObject`, `marker`, `symbol` outside a `use`, nested `<svg>`, and any unrecognised element in a geometry position.

`clipPath` and `mask` get their own warning, and it matters more than the others: the geometry we take is the *unclipped* path, so the imported part can be larger than what the user sees on screen. The message says exactly that.

`line` and any contour below the minimum area are dropped as degenerate. Construction lines and registration marks are the common case and a user does not want six warnings about them, so these fold into a single counted entry.

### 4.4 Visibility

`display="none"`, `visibility="hidden"` and the same two properties in an inline `style` are honoured, on the element and on every ancestor - which covers hidden Inkscape layers, the single most common way a real file contains geometry the user does not consider part of the drawing.

A `<style>` block is **not** parsed. Illustrator emits class-based styling (`.st0{fill:none;stroke:#000}`) and hiding things that way is rare, but it is possible, so: if a `<style>` element exists whose text mentions `display` or `visibility`, emit a warning saying that stylesheet-based hiding is not read and shapes may appear that the drawing does not show. Parsing CSS to find out is a rabbit hole with a cheap, honest alternative.

---

## 5. The parts that will actually be hard

### 5.1 Units and the viewport

This is where an importer produces a plausible, wrong answer, and it is the reason the units policy says *prompt, do not guess*.

The root `<svg>` gives up to three pieces of information: `width`, `height`, and `viewBox`. The scale is derived as:

- **Both a physical `width` and a `viewBox`.** `mmPerUnit = physicalWidthMm / viewBoxWidth`. Absolute units accepted: `mm`, `cm`, `in`, `pt` (1/72 in), `pc` (1/6 in), `px` (1/96 in), and `q`. `ScaleSource` is `declared`. This is Inkscape 1.x's normal output and the happy path.
- **A physical `width` and no `viewBox`.** User units are the declared unit directly.
- **A `viewBox` and unitless or `px` dimensions.** The spec defines a px as 1/96 in, so a scale *is* derivable - but Inkscape before 0.92 used 90 dpi and files in the wild still carry that, so this is an assumption and is labelled `assumed-px`. The preview states the assumption and the resulting overall drawing size in the user's display unit, which is the number a woodworker will spot as wrong instantly.
- **A `viewBox` and no dimensions, or percentage dimensions.** `ScaleSource` is `none`. Import is blocked until the user gives a scale.

Beyond the scale, the viewport also contributes a transform: a `viewBox` with a non-zero `min-x`/`min-y` translates, and `preserveAspectRatio` decides how a mismatched aspect is reconciled. Default `xMidYMid meet` is a *uniform* scale of `min(sx, sy)` plus a centring translate - taking `sx` alone is a real bug that silently stretches every part in one axis. `none` is the anisotropic case and is honoured as written. `slice` is treated as `meet` with a warning, because the clipped-away geometry is not something we want to silently include or silently drop.

**The scale override is a first-class control, not an error path.** The preview carries a "drawing is ___ wide" field pre-filled with the detected size. Correcting a misdetected scale, a 90-dpi Inkscape file, or a Fusion export in the wrong unit is then one field, and the same control is what M5's STL prompt will use.

`inkscape:document-units` and the `sodipodi:namedview` unit hints are deliberately **not** consulted. They describe the editor's ruler, not the document, and a file whose ruler says inches and whose width says `210mm` is 210mm.

### 5.2 Transforms, and when the box stops being honest

`transform.ts` handles a 2x3 affine as `[a b c d e f]`, parses all six transform functions including `rotate(deg cx cy)`, composes right-to-left, and multiplies down the tree.

The subtlety is which composed transforms keep a rectangle a rectangle. A rotation, a translation, a uniform scale and even a non-uniform axis-aligned scale all map a rectangle to a rectangle, so the min-area box remains exact. A **shear** does not - it maps a rectangle to a parallelogram, and its min-area box is strictly larger than the shape. So the CTM is tested for shear (`a*c + b*d` away from zero, relative to scale) and sheared shapes get their own warning: the part is oversized and the user needs to know which one.

### 5.3 Flattening, in the right order

The CTM is applied to the path data **before** flattening, not after. Flattening tolerance is a physical distance - 0.05mm, well inside any saw's accuracy - and a tolerance is meaningless applied to coordinates that are about to be scaled by an unknown factor. So: `svg-pathdata` normalises H/V/S/T and converts arcs to cubics, the matrix transformer puts everything in millimetres, and adaptive de Casteljau subdivision with a recursion cap runs last against a tolerance that means something.

Subdivision is deterministic - depth driven by flatness, not by any adaptive state carried between segments - because a re-import of the same file must produce the same parts.

### 5.4 Contours and holes

Each subpath is one contour. It is closed if it ends in `Z`, or if its endpoints meet within 0.1mm, which is a drawing artefact rather than a decision and closes silently. A larger gap makes it an **open path**, which is not a part: the warning gives the gap size, because "your path is open by 4.2mm" tells a user where to look and "unsupported path" does not.

A contour whose bounding box sits inside another's, and whose first vertex is inside it, is a **hole**. Holes do not become parts and do not affect the parent's size. They are counted in one warning that says what happened and why: a table saw does not produce interior cutouts, so they are the user's problem after the sheet is cut, not the layout's.

Two disjoint contours in a single `path` element are two parts. This is common in Illustrator output, where a compound path holds an entire set of panels.

### 5.5 Minimum-area box

`geometry.ts`: convex hull by monotone chain, then rotating calipers - the minimum-area enclosing rectangle of a convex polygon has a side collinear with a hull edge, so the search is over hull edges, and it is exact rather than a sampled approximation.

The resulting angle is snapped to 0 when it is within 0.5 degrees of axis-aligned, so a drawing that is square to the canvas to within float noise reports `0` rather than `0.03`. Dimensions themselves are never snapped or rounded - the display formatter is where rounding belongs, and rounding twice is how a 600mm part becomes 599.

### 5.6 Grouping into quantities

Shapes whose dimensions match within 0.5mm collapse into one part with a quantity. The group's reported size is the **maximum** in each axis, never the mean: a part that imports smaller than it was drawn is a part that does not fit, and a part that imports 0.3mm larger is a part that fits. Where the spread inside a group exceeds 0.2mm the row is flagged, since that usually means the drawing itself is inconsistent and the user should know before it becomes six shelves of slightly different length.

**Grouping is on the oriented pair, not the unordered one.** A 600x300 and a 300x600 stay two rows. They are visually distinct in the drawing, the user drew them that way, and for a grain-locked part they are genuinely different parts - merging them would quietly rotate a part whose grain direction is the entire reason `rotationPolicy: 'locked'` exists. A user who does want them merged edits one row in the preview.

### 5.7 Labels

In order: a `<title>` child, `inkscape:label`, `aria-label`, then `id` if it does not look machine-generated (`path1234`, `rect27`, Illustrator's `_x5F_`-mangled forms), then the enclosing layer's name with an index, then `Part n`. Illustrator's `_xHHHH_` escapes are decoded, since `Shelf_x20_Side` should import as `Shelf Side`.

A group takes the first non-empty label among its members. Every label is editable in the preview.

### 5.8 Caps

A 40MB SVG map of Europe is not a cut list, and the failure mode of not saying so is a hung tab. File size caps at 10MB, supported shapes at 2000, `use` depth at 8, subdivision depth at 16. Each cap has its own message naming the number actually seen. Parsing runs synchronously on the main thread - constraint 4 in CLAUDE.md - and PR 2 records the measured parse time for the largest committed test file. If a real file makes that untenable the answer is a lower cap, not a worker.

---

## 6. UI

```
src/ui/components/import/
  ImportDialog.tsx     # modal: dropzone -> parsing -> preview -> commit
  ImportPreview.tsx    # scale control, parts table, material and rotation defaults
  ImportWarnings.tsx   # grouped and counted, collapsed by default
```

Entry points: an **Import** button in `PartTable`'s header beside Add and Clear, and drag-and-drop onto the parts table itself.

The preview is one screen:

- **Scale.** The detected source stated in words - "Declared: 210mm wide", "Assumed 96 px per inch", "No scale in this file" - and a "drawing is ___ wide" field that overrides it, parsed with the existing `parseLength`. Import is disabled while the source is `none` and no override is set.
- **Parts.** A tick per row, then label, width, height, quantity, angle. Sizes formatted with `ui/format.ts` so they read in whatever unit the user is already working in. Label and quantity are editable. Sub-threshold rows arrive unticked with the reason shown.
- **Defaults.** Material select, defaulting to the current material filter or the first material, and a rotation policy select. Imported parts default to `free90`; grain is a property of the panel and the file cannot know it, so the user says. When no materials exist, import is disabled with a message pointing at the material manager rather than inventing one.
- **Append or replace**, with replace stating how many existing parts it removes.
- **Warnings**, grouped and counted, above the commit button and impossible to miss.
- The commit button counts both: "Add 7 parts (28 pieces)".

Commit dispatches one `IMPORT_PARTS` action carrying the whole batch, not N `addPart` calls. One reducer pass, one solve, one undoable step when M6 adds undo.

The dialog `import()`s the parser on open and prefetches it on mount, exactly as `LayoutViewer` does with the SVG exporter, and for the same reason: a shop with bad wifi must not discover the chunk is missing at the moment it needs it.

---

## 7. Work breakdown and PR sequence

Four sequential PRs. Each independently mergeable and CI-green.

### PR 1 - `feat/import-geometry` - pure geometry, no DOM

- Add `svg-pathdata` (runtime), `jsdom` (dev). Report bundle impact even though nothing loads it yet.
- `src/import/types.ts`, `src/import/errors.ts` - the contract from §3.2, with no SVG-specific field.
- `src/import/geometry.ts` - monotone-chain hull, rotating-calipers min-area box, signed area, point-in-polygon, contour nesting.
- `src/import/svg/transform.ts` - matrix type, transform-attribute parsing, composition, shear detection.
- `src/import/svg/flatten.ts` - the `svg-pathdata` pipeline and adaptive subdivision.
- `src/import/svg/contours.ts` - closing, degenerate filtering, hole nesting.
- Tests, `environment: 'node'` throughout:
  - Min-area box: axis-aligned rect returns itself at angle 0; the same rect rotated 30 degrees returns the same dimensions; a square returns a square at any angle; a circle's box is its diameter square; degenerate and collinear inputs do not crash.
  - Transform parsing against every form including `rotate(45 100 100)`, whitespace and comma variants, and composition order.
  - Shear detection: `skewX(20)` flagged, `scale(2,1)` not.
  - Flattening: a circle path flattens within tolerance of its true radius; tolerance is respected after a 10x matrix; output is identical across runs.
  - Contour nesting: donut yields one part and one hole; two disjoint contours yield two parts.

### PR 2 - `feat/import-svg` - the importer

- `src/import/svg/document.ts`, `viewport.ts`, `shapes.ts`, `label.ts`, `group.ts`, `index.ts`.
- The tree walk: CTM stack, visibility, `use` resolution with cycle detection, warning collection.
- Real files committed to `test/files/`: an Inkscape export, an Illustrator SVG, a Fusion sketch export. Synthetic edge-case files live under `test/files/synthetic/` and are named so nobody mistakes them for captures - they cover hidden layers, nested transforms, arcs, open paths, `use` clones, a shear, a clip path, a `<style>` block, and a viewBox with a non-zero origin.
- Tests, `// @vitest-environment jsdom` for anything touching `DOMParser`:
  - Each real file: golden snapshot of parts and warnings, with the expected dimensions checked against the source drawing and stated in a comment. This is the load-bearing test and it is what exit criterion 1 means.
  - **Self round-trip.** `export/svg.ts` already produces complex, tool-independent SVG. Importing an exported bookshelf sheet must recover the part rectangles at their exact placement dimensions, and must warn about the dimension text rather than choking on it. This exercises viewport, units and transforms against a file whose correct answer is known exactly.
  - Unit resolution across all four §5.1 cases, including `preserveAspectRatio` uniform scaling, which gets its own test with a deliberately mismatched aspect.
  - Every skipped construct produces its named warning; nothing is dropped silently except sub-minimum-area contours.
  - `parsererror` from a truncated file, a non-SVG XML file, and an empty drawing each produce their typed error.
  - Determinism: the same file twice yields identical output.
  - Every produced part list passes `validateInputs` once given a material.
  - Record parse time for the largest committed file.
- Confirm early that jsdom's `DOMParser` reports malformed XML the way the browser does - it is the one place the test environment could pass a file the real thing rejects, and it decides how `document.ts` detects failure.

### PR 3 - `feat/import-svg-ui` - dialog, preview, commit

- The three components in §6, the `IMPORT_PARTS` action and reducer case, the parts-table entry points, drag-and-drop, lazy chunk with prefetch.
- Tests: `renderToStaticMarkup` over the preview asserting the scale wording per `ScaleSource`, that a `none` scale disables commit, that sub-threshold rows start unticked, and that warnings render with their counts. Reducer tests for append and replace.
- Report the initial bundle before and after, and the import chunk's own size.

### PR 4 - `chore/m4-exit-verification` - close it out

- Browser pass: import each committed file, confirm the sizes against the drawings, solve, print, export. Every one of them cuts.
- Resolve `project-plan.md` §9 question 2 - bounding boxes, with the reasoning in §2 - and record the supported subset in the app's own help text, not only in this file.
- `CLAUDE.md` to M4 complete / M5 next, with `src/import/` filled in and the new dependencies noted.
- Record what shipped and what was decided along the way, the way PRs 1-5 of M3 do.

---

## 8. Risk register

| Risk | Severity | Mitigation |
|---|---|---|
| **Silently wrong scale** - a file imports as plausible numbers at the wrong size, and the error is invisible until a sheet is cut | High | Scale source is stated in words in the preview, the overall drawing size is shown in the user's own unit, the override is a first-class control, and a file with no derivable scale blocks import entirely. |
| **SVG parsing rabbit hole** - the project plan's own top risk | High | The subset in §4 is written down before the code, every exclusion has a message, and no PR extends the subset without a real file that needs it. Caps in §5.8 bound the worst input. |
| **jsdom is not the browser** - a test passes on a file Chrome rejects, or vice versa | Medium | Verified deliberately in PR 2 before `document.ts` is written, and PR 4's browser pass imports every committed file for real. |
| **`preserveAspectRatio` anisotropy** - taking `sx` alone stretches every part in one axis and still looks like a drawing | Medium | Uniform `min(sx, sy)` for `meet`, with a mismatched-aspect fixture whose correct dimensions are known. |
| **Shear** - a sheared shape's box is silently oversized | Low | Detected in the CTM and warned per shape, since it cannot be corrected, only reported. |
| **Bundle growth** - `svg-pathdata` plus the importer on a feature most visitors never use | Low | Own chunk, prefetched on mount, sizes reported in PRs 1 and 3. This is the pattern `export/svg.ts` set in M3. |
| **Quantity grouping merges parts that differ** | Low | 0.5mm tolerance, oriented pairs only, spread over 0.2mm flagged, and every row editable before commit. |

---

## 9. Confirmed decisions

1. **XML parsing:** the browser's `DOMParser`, with `jsdom` as a devDependency so the import tests run under `// @vitest-environment jsdom`. Nothing new ships in the bundle for this.
2. **Path parsing:** `svg-pathdata`, the choice CLAUDE.md's stack section already names. Its arc-to-cubic conversion is the specific thing worth not hand-rolling.
3. **Part sizing:** minimum-area oriented bounding box, not the axis-aligned one, with the detected angle surfaced in the preview. A part drawn at 30 degrees imports at its true size.
4. **Test files:** real exports supplied for Inkscape, Illustrator and Fusion, committed to `test/files/`; synthetic edge-case files alongside them under `test/files/synthetic/`, named so the distinction survives.
5. **Bounding boxes, not outlines** - `project-plan.md` §9 question 2, resolved. Interior cutouts are reported and discarded.
6. **Imported parts default to `free90`.** The file cannot know which face is visible, and defaulting to `locked` would silently cost sheets on parts where grain does not matter.
7. **Import appends by default.** Replace is offered and states what it removes.
