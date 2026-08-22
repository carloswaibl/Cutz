# M5 - STL import

*Implementation plan for mesh parsing, planar face detection, thickness inference, and 2D
projection into parts.*

Companion to `docs/project-plan.md` §6 (Milestone 5). Read `CLAUDE.md`, `docs/plan-m1.md` and
`docs/plan-m4.md` first - the units policy (`domain/units.ts`), geometry conventions, solver
invariants and the importer contract (`src/import/types.ts`, `src/import/errors.ts`,
`src/import/geometry.ts`) are binding and unchanged by this milestone. `plan-m4.md` in
particular is the closest sibling: M5 shares its contract, its geometry primitives, its preview
UI and its "prompt, do not guess" posture on units, applied to a different file format.

---

## 1. Goal and exit criteria

**Goal:** A woodworker who modeled a panel in Fusion 360, SolidWorks, SketchUp or any other CAD
tool exports it as `.stl` and drops it into the app the same way M4 taught them to drop in an
SVG. They see exactly what was found - dimensions, detected thickness, any part the file
couldn't account for - correct anything the file was ambiguous about, and get parts.

STL is a harder input than SVG in one specific way: it is genuinely unitless. `CLAUDE.md` is
explicit that STL files carry no unit information and the app must always prompt with a size
preview, never infer, never default silently. Where M4's hardest problem was *deriving* a scale
from a document that usually states one, M5's hardest problem is *detecting a slab* from a
triangle soup that states nothing but geometry - the scale question is actually simpler than
M4's (there is exactly one path: always ask), but the geometry question is harder (a mesh has to
be proven to be a flat panel before it can become a part at all).

**M5 exits when all of the following hold:**

1. **A real STL export produces the right part(s) at the right size**, verified against the
   modeling tool's own reported dimensions - or, if no genuine export is available by the PR
   that needs test fixtures, a hand-written reproduction clearly marked as such, the same
   override `plan-m4.md` §7 (PR 2) and §9 decision #13 used for SVG. That override is not
   pre-decided here; it is only invoked if a genuine file search comes up empty, the same way
   M4's did.
2. **Units are always asked for, never guessed.** Every STL import starts with `ScaleSource`
   `{ kind: 'none' }` and blocks commit until the user confirms a real-world size. The control
   is pre-filled with the most common real-world case (assume millimetres, since that is Fusion
   360's and most slicers' default STL export unit) so confirming it is one glance and one
   click, not a blank field - but nothing commits on the strength of that default alone.
3. **A mesh that is not a flat slab is rejected with a specific message.** `CLAUDE.md`
   constraint 5 is "if a mesh isn't a slab, reject it with a clear message," not "do your best
   with it." An L-bracket, a box, or a mesh with a hole through the geometry itself (not a
   projected 2D cutout) does not become a wrong-shaped part.
4. **A file whose mesh has multiple disconnected components produces multiple rows**, each
   independently validated. A component that fails validation is reported and excluded; the
   others still import.
5. **The preview is still the commit point.** Nothing reaches the parts table without the user
   seeing label, width, height, quantity and detected thickness for every part, choosing a
   material (pre-suggested by thickness) and a rotation policy, and choosing append or replace -
   unchanged from M4 §1 criterion 5.
6. **One new runtime dependency, lazily loaded.** `three`, used only for `STLLoader` and a
   handful of math classes (`Vector3`, `Plane`, `Box3`, `Matrix4`) - never `Scene`, `Camera` or
   any renderer - lives in the same lazily-fetched `import/` chunk `svg-pathdata` already does,
   prefetched on `ImportDialog` mount. Bundle impact reported in the PR that adds it.
7. **Verification.** `npm run typecheck && npm run test:run && npm run lint && npm run build`
   all clean, plus a real browser pass importing at least one STL panel, solving, printing, and
   exporting the result.

---

## 2. Scope

### In scope

- `src/import/contours.ts` - `Contour`, `nestContours`, `CLOSE_GAP_TOLERANCE_MM`, moved out of
  `src/import/svg/contours.ts`. Confirmed during this planning pass to already be fully generic
  (`Point[]`-based, no SVG-specific dependency), so this is a pure move, not a rewrite - it
  exists so `src/import/stl/` does not have to reach into `src/import/svg/`'s directory for
  logic that was never SVG-specific in the first place.
- `src/import/stl/` - mesh parsing, welding, connected-component splitting, manifold checking,
  planar face clustering, slab validation, thickness measurement, 2D projection, labeling.
- `src/ui/components/import/` extended - `.stl` alongside `.svg` in the dropzone's accepted
  types, multi-file drop/select, per-file scale confirmation, thickness-driven material
  suggestion.
- The `IMPORT_PARTS` reducer action, already batched from M4 - unchanged, since it already
  accepts a flat list of parts regardless of which importer produced them.
- Real or reproduction STL test files in `test/files/`.

### Out of scope

- **3D assembly decomposition.** A file whose mesh splits into disconnected components is split
  along those components - that is topology the file already states, not decomposition this app
  performs. A single *connected* mesh that is not itself a flat slab (an L-bracket, a box, a
  cabinet carcass modeled as one body) is rejected outright, never decomposed into the panels a
  human would see in it. `CLAUDE.md` constraint 5 draws this line and this milestone does not
  move it.
- **True outlines.** Imported shapes become rectangles, exactly as M4 decided for SVG
  (`plan-m4.md` §9 decision #5): for a guillotine saw the part *is* its bounding box, because
  every cut runs edge to edge. A mesh's interior cutouts - a hole drilled through the panel,
  modeled as a hole in the mesh rather than a separate part - are reported and discarded, not
  modelled, the same as an SVG's interior contour.
- **Automatic material creation.** The mesh's measured thickness pre-selects the
  closest-matching *existing* `Material` within a tolerance. It never creates or edits a
  material - when nothing matches, the row is flagged and the user picks (or goes and adds one),
  the same posture M4 took toward "when no materials exist, import is disabled with a message
  pointing at the material manager rather than inventing one" (`plan-m4.md` §6).
- **Non-triangle mesh formats.** OBJ, STEP, 3MF and anything else are not read. STL only, per
  the documented stack in `CLAUDE.md` and `project-plan.md` §3.
- **Importing stock, materials or config from a file**, and **importing a *layout***. Both
  already out of scope for SVG (`plan-m4.md` §2) for the same reasons, unchanged here: a file
  describes parts, not sheets, and an already-arranged layout is not a feature anyone asked for.

---

## 3. The pipeline

```
File(s), one or many, selected or dropped together
 └─ bytes                    guard: size cap, .stl extension
 └─ STLLoader.parse          ASCII/binary detection is STLLoader's own job -> BufferGeometry
 └─ weld                     mergeVertices at a tolerance relative to the mesh's own bounding
                              box -> indexed geometry, since raw STL shares no vertex indices
 └─ components                edge-adjacency flood fill over the welded geometry -> one or
                              more disjoint triangle subsets, one candidate part each
     └─ per component:
        └─ manifold check      every edge shared by exactly two triangles; anything else is a
                               hole in the mesh or a degenerate file - reject with a warning
        └─ normal clustering    group triangles by normal direction within an angular tolerance
        └─ slab detection       find the two largest clusters whose normals are antiparallel
                               and coplanar; verify the remainder are "wall" triangles roughly
                               perpendicular to that axis and that top + bottom + walls account
                               for (essentially) the whole surface - or reject as not a slab
        └─ thickness            perpendicular distance between the top and bottom planes
        └─ project              orthonormal 2D basis in the top plane; boundary-loop vertices
                               of the top-face triangle subset projected into it -> Point[] loops
        └─ nestContours         (shared, moved to import/contours.ts) outer loop vs. holes
        └─ minAreaBox            (shared, import/geometry.ts, unmodified) -> width, height, angle
 └─ ImportedPart[]            one row per accepted component; a rejected component becomes a
                              counted warning naming what was wrong with it, not a silent drop
 └─ ImportOutcome              parts + warnings + scale, always starting { kind: 'none' } per file
 └─ preview                    per-file scale confirmation, material suggested from thickness,
                              rotation policy, selection, everything M4's preview already does
 └─ IMPORT_PARTS                append or replace, the same reducer action SVG import uses
```

Everything above the preview line is pure and headless. `STLLoader.parse` and the `three` math
classes used here (`Vector3`, `Plane`, `Box3`, `Matrix4`) run under plain Node with no DOM - `.stl`
parsing needs nothing SVG's `DOMParser` dependency required, so `src/import/stl/` tests run
`environment: 'node'` throughout, simpler than `src/import/svg/`'s jsdom requirement.

### 3.1 Modules

```
src/import/
  types.ts        # unchanged - already designed to carry M5 without modification
  errors.ts        # gains STL-specific error/warning builders, same pattern as SVG's
  geometry.ts       # unchanged - hull, minAreaBox, already Point[]-generic
  contours.ts        # MOVED from svg/contours.ts: Contour, nestContours, CLOSE_GAP_TOLERANCE_MM
  svg/
    ...              # unchanged, except contours.ts loses the two moved exports
  stl/
    index.ts          # importStl(bytes, filename, options): ImportOutcome
    parse.ts           # STLLoader wrapper: ArrayBuffer -> BufferGeometry
    mesh.ts             # mergeVertices wrapper, edge-adjacency graph, connected-component
                        # split, per-component manifold check
    slab.ts              # normal clustering, top/bottom planar-face pairing, thickness,
                        # the slab-or-reject decision
    project.ts            # boundary-loop extraction + 2D projection into the chosen plane
    label.ts                # filename (+ index per component) -> a part label
```

`src/import/` still may depend only on `src/domain/`, never on `src/ui/` or `src/solver/` - the
same one-way rule `plan-m4.md` §3.1 established, unchanged by adding a second importer under it.

### 3.2 The shared importer contract, and what M5 confirms about it

`plan-m4.md` §3.2 wrote `types.ts` "for two importers from the start, because writing it for
one and retrofitting M5 is how the SVG's assumptions end up baked into the STL path." This
planning pass checked that promise against the actual current source rather than assuming it:

- `ScaleSource`'s `declared` and `assumed-px` variants are meaningless for STL and are simply
  never constructed by this importer. Only `{ kind: 'none' }` (always, at first) and
  `{ kind: 'user', mmPerUnit }` (once confirmed) are used. No change to the type.
- `ImportedPart` needs no new field. `angle`, `flags`, `sourceIds` all mean the same thing for a
  projected mesh face as for a flattened SVG path. Detected thickness is *not* added to
  `ImportedPart` - it is UI-layer information used once, to pre-select a material in the preview,
  and does not need to survive into the shared contract or the committed `Part` (which has no
  thickness field of its own; thickness lives on `Material`).
- `ImportOutcome`'s `drawingWidthMm`/`drawingHeightMm`/`extentWidth`/`extentHeight` (added in M4
  PR 3 for exactly this "derive a scale from a user-entered width when there is nothing declared
  to correct" case) are reused as-is for STL's per-file scale control.
- `PartFlag`'s two existing variants (`size-spread`, `sheared`) do not apply to STL - grouping
  by matching dimensions still applies (§3.6 below), but nothing in mesh projection produces a
  parallelogram the way an SVG shear does. No new `PartFlag` variant is added; if a future PR
  finds it needs one (e.g. flagging a component whose thickness disagreed from its siblings the
  way SVG flags size-spread), it is additive, matching how M4 PR 3 added fields rather than
  reshaping existing ones.

`errors.ts` grows new builders, following its own established pattern exactly (a typed
`ImportErrorKind`/`ImportWarningKind` member, a builder function returning a specific, actionable
message, folded counts where multiple occurrences share a kind and message):

- `ImportErrorKind` gains `'not-stl'` (wrong file signature / unreadable as either STL variant)
  and reuses `'file-too-large'` unchanged.
- `ImportWarningKind` gains `'non-manifold-mesh'` (§3.4) and `'not-a-slab'` (§3.5). Interior
  cutouts in a mesh reuse the existing `'hole-discarded'` kind unchanged - the meaning is
  identical to SVG's: an interior contour that is not part of the layout.

---

## 4. What makes a file importable

### 4.1 File format

Both binary and ASCII STL are accepted. `STLLoader.parse` already implements the standard
sniffing rule - a `solid` header text is not proof of an ASCII file (some binary exporters write
`solid` into the 80-byte header anyway), so the loader cross-checks the binary triangle count
against the file's actual byte length before deciding. This milestone does not reimplement that
detection; it is exactly the kind of byte-level parsing worth using a maintained implementation
for rather than hand-rolling, which is the whole reason PR 1's "use `three` + `STLLoader`" was
chosen over a hand-rolled parser (see §7's decision log).

Multi-solid ASCII files (multiple `solid ... endsolid` blocks in one text file) are not treated
specially and do not need their own rule. Whatever geometry `STLLoader` returns - one merged
geometry, regardless of how many `solid` blocks it came from - is run through this milestone's
own connected-component split (§4.3) anyway, because that split is the *only* way to separate
distinct bodies in a binary file, which has no format-level solid boundary at all. A file with
three named solids and a file with three disconnected bodies in one nameless solid produce the
same three components through the same code path.

### 4.2 Vertex welding

Raw STL triangles do not share vertex indices - every triangle stores its own three corners as
independently-rounded floats, so a vertex shared by six triangles in the original model appears
as six near-but-not-exactly-identical points in the file. `mergeVertices` (from
`three/examples/jsm/utils/BufferGeometryUtils.js`) welds points within a tolerance into a single
indexed geometry, which is what makes edge-adjacency counting (§4.3) possible at all - without
welding, no two triangles would appear to share an edge and every triangle would look like its
own disconnected component.

The tolerance has to be relative to the mesh's own scale, not an absolute millimetre value: at
this stage in the pipeline the file's real-world units are not yet known (that is the entire
reason §5 exists), so an absolute tolerance chosen in millimetres could be meaninglessly loose
on a mesh modeled in metres or meaninglessly tight on one modeled in tenths of an inch. The
tolerance is instead a small fraction of the component's bounding-box diagonal, unit-agnostic by
construction.

### 4.3 Connected components and manifold-ness

From the welded, indexed geometry, build a map from each edge (an unordered pair of vertex
indices) to how many triangles reference it. For a closed, watertight solid every edge belongs
to exactly two triangles - one on each side. Flood-filling triangles across shared edges finds
each connected component: the set of triangles reachable from one another without crossing a
gap.

A component where every edge has a count of exactly two is manifold and proceeds to slab
detection. A component with any edge counted once (a genuine hole in the mesh - a boundary the
model never closed) or three-or-more times (self-intersecting or duplicated geometry) is
rejected with a `non-manifold-mesh` warning naming the component rather than being guessed
through - the same "specific, not silent" posture `CLAUDE.md` demands of the SVG importer,
applied to STL's own characteristic failure mode. A CAD export with a genuine modeling error
(commonly: a non-watertight mesh from a bad boolean operation) is exactly the case this catches.

### 4.4 Slab detection

This is the actual hard part of the milestone, and the reason `CLAUDE.md` constraint 5 exists as
its own explicit rule rather than being left implicit.

1. **Cluster triangles by normal direction.** Two triangles belong to the same cluster when
   their face normals agree within a small angular tolerance (their dot product close to 1).
   This groups the mesh's triangles into candidate flat regions without yet knowing which, if
   any, are "the two big faces of a panel."
2. **Find the top/bottom pair.** Among the resulting clusters, look for the two with the largest
   total area whose average normals are antiparallel (dot product close to -1) *and* whose
   member triangles are individually coplanar with each other - not merely parallel-facing, but
   lying on the same plane, within a small perpendicular-distance tolerance. Antiparallel and
   coplanar together are what a slab's top and bottom actually are: two flat faces, facing
   opposite directions, offset from each other by the material's thickness.
3. **Validate the rest as walls.** Every triangle not in the top or bottom cluster should have a
   normal roughly perpendicular to the top/bottom axis - the mesh's "wall" geometry, which for a
   panel with square edges and no interior cutouts is a thin ribbon of triangles running the
   perimeter, and for a panel with a hole modelled all the way through also includes a ribbon
   around that hole's own perimeter.
4. **Check the area accounts for the whole surface.** Sum the top, bottom and wall areas and
   compare against the component's total surface area. A genuine slab accounts for essentially
   all of it; any unaccounted-for area means the mesh has geometry this model of "a flat panel"
   does not explain - a boss, a chamfer more complex than a simple bevel, a second body fused
   into the same connected component.
5. **Reject on any failure**, with a `not-a-slab` warning identifying the component (by its
   position and rough size, since it has not earned a label yet) and explaining in one sentence
   why - the panel wasn't found, the two candidate faces weren't equal in area, or there was
   unaccounted-for geometry. This is `CLAUDE.md` constraint 5's "reject with a clear message"
   turned into an actual decision procedure rather than a vague reassurance that garbage input
   won't produce a wrong part.

The alternative to this whole procedure - taking the mesh's axis-aligned or minimum-volume
bounding box and calling its two largest opposite faces "the panel" - was considered and
rejected. It would silently accept an L-bracket (whose bounding box has six real faces, none of
which is the part) as though it were a flat rectangle, which is exactly the wrong-shaped-part
failure `CLAUDE.md` constraint 5 exists to prevent.

### 4.5 Thickness

Once the top and bottom planes are established, thickness is simply the perpendicular distance
between them, measured in the mesh's raw (still-unscaled) units. It is surfaced in the preview
so a woodworker recognizes their own stock at a glance ("18.2" next to a part reads as "that's my
18mm ply") and is used, once the user has confirmed a real-world scale, to pre-select whichever
existing `Material` has the closest matching thickness within a small tolerance. This is
advisory only - see §2's "no automatic material creation" - the row simply starts on the closest
guess instead of the current filter or first material the way SVG import's rows do, and is
flagged if no material comes close enough to be a plausible match.

### 4.6 Projection

With the top face's plane and normal known, build an orthonormal 2D basis inside that plane: an
arbitrary vector already lying in the plane (any edge of a top-face triangle, normalized) as one
axis, and the cross product of the plane normal with that vector as the other. Every vertex on
the top face's boundary is then projected onto this basis, producing ordinary 2D `Point`s.

The boundary itself is found the same way §4.3 found whole-mesh components, but scoped down to
just the top-face triangle subset: an edge on the boundary of "triangles belonging to the top
cluster" - shared with a wall triangle rather than another top-cluster triangle - is a boundary
edge, and chaining boundary edges together yields one or more closed loops. The outer loop and
any interior loops (an interior loop is what a hole drilled through the panel and modelled in
the mesh looks like from this angle) feed directly into the *shared* `nestContours` (§3.1) to
separate the outline from its holes, exactly the way SVG's flattened subpaths do, and then into
`import/geometry.ts`'s `minAreaBox` (unmodified, confirmed `Point[]`-generic during this planning
pass) to get the same `{ width, height, angle }` result SVG already produces.

Nothing here is STL-specific past the projection step - by the time a set of 2D point loops
exists, the rest of the pipeline is code the SVG importer already wrote and already tested.

### 4.7 Units - the simpler half of this milestone

Where M4 §5.1 spent most of its space deriving a scale from whatever partial information an SVG
document supplies, STL supplies none at all, which makes this half of the milestone simpler, not
harder: there is exactly one path. Every STL import's `ImportOutcome.scale` starts as
`{ kind: 'none' }`, and the preview's existing "drawing is ___ wide" control - built in M4 PR 3
specifically for this `none` case, driven by `extentWidth`/`extentHeight` - is reused verbatim,
just relabeled per-file ("this panel is ___ wide") since a multi-file drop can mix files modeled
at different real-world scales even when their raw units happen to coincide.

The one UX concession worth making, without weakening `CLAUDE.md`'s "never default silently"
rule: the field is pre-filled with the size millimetres-as-raw-units would produce, since that
is by far the most common real STL export convention (Fusion 360's and most 3D printing slicers'
default). Pre-filling is not the same as defaulting silently - the user still sees the resulting
size stated in the preview and still has to accept or correct it before commit is enabled,
exactly as `{ kind: 'none' }` already requires for any value. What changes is that "accept" is a
single glance and a click for the common case, rather than typing a number from scratch every
time.

### 4.8 Labels

A component's label starts from the source filename (stripped of its `.stl` extension, with
underscores and hyphens read as word separators the way `plan-m4.md` §5.7 decodes Illustrator's
`_xHHHH_` escapes for SVG). When a file's mesh splits into more than one component, each gets an
index suffix ("Shelf Bracket 1", "Shelf Bracket 2"). Every label is editable in the preview,
unchanged from M4.

### 4.9 Grouping into quantities

Reuses SVG's existing rule unmodified: parts whose dimensions match within 0.5mm collapse into
one row with a quantity, grouped on the oriented `(width, height)` pair rather than the
unordered one, for the identical reason `plan-m4.md` §5.6 gives - a grain-locked part's
orientation is not incidental. This applies across files in one multi-file drop as much as
within a single file's components: two separately-exported STLs for the same 600x300 shelf
collapse into one row with quantity 2, the same as two matching shapes in one SVG would.

### 4.10 Caps

Following `plan-m4.md` §5.8's pattern: a maximum file size (10MB, matching SVG's cap - an STL
this large is thousands of triangles, far past what a hand-modeled panel needs), a maximum
triangle count per file, and a maximum component count per file, each with its own message
naming the number actually seen. Parsing runs synchronously on the main thread, matching
`CLAUDE.md` constraint 4 - if a real file makes that untenable, the answer is a lower cap
measured against real fixtures, not a worker, exactly the position M4 took.

---

## 5. UI

No new top-level components. `ImportDialog`, `ImportPreview` and `ImportWarnings` from M4 are
extended rather than duplicated:

- The dropzone accepts `.stl` alongside `.svg`, and accepts a `FileList` rather than a single
  `File` - each file is parsed independently (by the appropriate importer, chosen by extension)
  and the results are merged into one preview list before anything is shown.
- Each file's rows are grouped under that file's own per-file scale control (§4.7), sitting
  above its rows in the merged table, distinct from any other file's in the same drop.
- The parts table itself - tick per row, editable label and quantity, angle column, warnings
  block, append/replace, commit button counting parts and pieces - is otherwise unchanged from
  M4 §6. Detected thickness is shown as an additional column for STL-sourced rows only (an SVG
  row has no thickness to show), and drives the material select's initial choice per row rather
  than defaulting every row to the same batch material the way SVG's does.
- The dialog still `import()`s both parsers on open and prefetches on mount, the same lazy chunk
  pattern `LayoutViewer` established for `export/svg.ts` and M4 established for `svg-pathdata` -
  `three` joins that same chunk rather than getting its own.

---

## 6. Work breakdown and PR sequence

Four sequential PRs, proposed to mirror M4's shape. Each independently mergeable and CI-green;
exact scope may shift slightly as each PR's own "what shipped" notes get added, the way M4's did.

### PR 1 - `feat/import-stl-geometry` - pure mesh math, no UI

- Add `three` as a runtime dependency. Report bundle impact even though nothing loads it yet -
  the same discipline M4 PR 1 applied to `svg-pathdata`.
- Move `Contour`, `nestContours`, `CLOSE_GAP_TOLERANCE_MM` from `src/import/svg/contours.ts` to
  `src/import/contours.ts`. Update `svg/index.ts`'s imports; no behavior change.
- `src/import/stl/parse.ts` - `STLLoader` wrapper.
- `src/import/stl/mesh.ts` - `mergeVertices` wrapper, edge-adjacency graph, connected-component
  split, per-component manifold check.
- `src/import/stl/slab.ts` - normal clustering, top/bottom pairing, thickness, the
  slab-or-reject decision from §4.4.
- `src/import/stl/project.ts` - boundary-loop extraction and 2D projection from §4.6.
- Tests, `environment: 'node'` throughout, against synthetic STL buffers built in-test (binary
  format is straightforward to emit programmatically - a helper that writes triangles as raw
  bytes is worth its own small test utility):
  - A rectangular slab: correct width, height, thickness, angle 0.
  - The same slab modeled with an interior hole: hole discarded, panel dimensions unaffected,
    matching SVG's `hole-discarded` behavior.
  - A file with two disconnected rectangular slabs: two components, two parts.
  - A non-manifold mesh (an intentionally open edge): rejected with `non-manifold-mesh`.
  - An L-bracket: rejected with `not-a-slab`, not silently boxed.
  - A box (six faces, no antiparallel-coplanar pair spanning most of the area at any candidate
    thickness): rejected.
  - Welding tolerance: a mesh with deliberately duplicated-but-jittered vertices at a known
    fraction of its bounding-box diagonal welds correctly; one jittered well past that fraction
    does not silently weld two genuinely distinct vertices together.
  - Determinism: the same buffer parsed twice yields identical output.

### PR 2 - `feat/import-stl` - the importer

- `src/import/stl/index.ts` - `importStl(bytes, filename, options): ImportOutcome`, wiring
  parse -> weld -> components -> (manifold check, slab detection, thickness, projection) per
  component -> `nestContours` -> `minAreaBox` -> `ImportedPart[]`.
- `src/import/stl/label.ts`.
- `errors.ts` additions from §3.2: `not-stl`, `non-manifold-mesh`, `not-a-slab` builders,
  following the existing message style exactly (specific, names what happened, says what to do
  about it).
- Real STL files committed to `test/files/` if a genuine export can be sourced (Fusion 360,
  SolidWorks, or a slicer's own sample panel); otherwise hand-written reproductions clearly
  marked "REPRODUCTION, NOT A CAPTURE" in a header comment, the same override M4 PR 2/PR 4 used
  and PR 4 formally accepted as permanent for SVG. This PR is where that call gets made for STL,
  not this planning document - genuinely searching for real files comes first.
- Golden tests per file: parts and warnings checked against the file's own stated dimensions,
  the load-bearing test for exit criterion 1.
- Every produced part list passes `validateInputs` once given a material, matching M4's own
  pattern.
- Record parse time for the largest committed file, matching M4 PR 2's discipline.

### PR 3 - `feat/import-stl-ui` - dialog, preview, multi-file, thickness suggestion

- Dropzone accepts `.stl` and multiple files, per §5.
- `ImportPreview` gains the per-file scale control (reusing the existing `none`-scale UI,
  relabeled and pre-filled per §4.7) and the thickness column with material auto-suggestion.
- Tests: multi-file merge produces one combined preview list; a `none` scale blocks commit per
  file independently (confirming one file's confirmed scale doesn't inadvertently unblock
  another's); thickness suggestion picks the closest material within tolerance and leaves the
  row unmatched (falling back to the current default) when nothing is close.
- Report the updated bundle size, the `three`-inclusive lazy chunk's own size, before and after.

### PR 4 - `chore/m5-exit-verification` - close it out - **shipped**

- Browser pass: import each committed STL file, confirm sizes and thickness against the source
  model, solve, print, export SVG and DXF. Every panel cuts.
- `CLAUDE.md`'s directory listing and "Current status" updated to M5 complete / M6 next, with
  `src/import/stl/` and `src/import/contours.ts` filled in and `three` added to the stack
  section.
- `project-plan.md` updated if this milestone resolves or reframes any open question in its §9,
  the way M4's PR 4 resolved question 2.
- Record what shipped and what changed on the way, the way M4's PRs 1-4 do in this same document.

**What shipped, and what changed on the way.**

- **Exit criterion 1 closed against genuine tool exports, not the reproduction fallback.** Unlike
  M4, a real search wasn't even needed here: PR 2 had already committed three genuine binary STL
  exports from ImageToStl.com to `test/files/` and asserted their exact width/height/angle in
  golden tests against independently-computed raw-geometry values. This PR's browser pass is
  additional confirmation on top of an already-closed criterion, not what closes it.
- **Browser pass, done via Chrome automation against the dev build.** All three
  `test/files/imagetostl-part-*.stl` files dropped into the import dialog in one multi-file drop:
  each row's shown width/height/angle matched the golden-test values exactly
  (160.39x40.37mm @ 70.5°, 131.09x135.48mm @ 78.3°, 181.13x51.82mm @ 0°), each showed a
  detected-thickness column (~4.76mm, close to none of the sample project's single 19.05mm
  material - the "no close match, falls back to the default" path PR 3's `materialSuggestion`
  tests already cover, exercised here for real rather than just unit-tested). Overriding one
  file's width from 7-1/8" to 14-1/4" doubled its shown height and thickness in lockstep,
  confirming the scale control recomputes every derived field, not just the one being edited;
  reverting the override recovered the original values exactly. Committed (append) onto the
  sample bookshelf project: the solver re-ran automatically, placed all 33/33 parts across 3
  sheets at 7.8% waste, and the on-screen SVG, the hidden print SVG, and both the exported SVG
  and DXF files for the sheets holding the STL-sourced parts all carried the correct
  `imagetostl part 1/2/3` labels and dimensions - verified by reading each output's DOM/file
  content directly rather than relying on a screenshot at a scale where a ~50mm part on a
  1220x2440mm sheet is a few pixels wide. `imagetostl part 2` placed rotated, correctly marked
  with the rotation glyph, consistent with the `free90` policy the import dialog applied.
  Skipped triggering `window.print()` itself, same call M4's PR 4 made - the print component tree
  is unchanged M3/M4 code, and the browser sandbox treats a native print dialog as a hang.
  Nothing found needed fixing; PR 3's own two browser-caught bugs (the scale-before-welding
  ordering bug and the live-`FileList` bug) had already had their fix verified there.
- **`CLAUDE.md`'s directory listing gained `contours.ts` and `group.ts` as their own top-level
  `import/` entries**, both already moved out of `svg/` since PR 1/PR 2 but never reflected in the
  listing, which still described `stl/` with a one-line M5 placeholder. `stl/`'s line now names
  its real modules (`parse.ts`, `mesh.ts`, `slab.ts`, `project.ts`, `label.ts`); `svg/`'s line
  dropped `contours`/`group` from its own description since both are shared, not SVG-specific.
  `docs/plan-m4.md` and `docs/plan-m5.md` were also missing from the `docs/` listing entirely -
  added alongside the `import/` fix. `three` was already listed under Stack from the project's
  start, so no change was needed there.
- **`project-plan.md` §9 is unchanged.** Unlike M4, which resolved open question 2, nothing in M5
  settles or reframes any of §9's remaining questions (imperial-vs-metric-first, edge trim). The
  STL-specific risk in §7 ("STL has no units") isn't struck out either, matching how M4 left its
  own risk-register rows alone - the register describes forward-looking risk, not milestone
  completion.

---

## 7. Risk register

| Risk | Severity | Mitigation |
|---|---|---|
| **Slab detection false-accepts a non-slab mesh** - a bracket or a box imports as a plausible but wrong-shaped rectangle | High | The area-accounting check in §4.4 is deliberately conservative: top, bottom and walls must account for essentially the whole surface, or the component is rejected rather than approximated. Tested against an L-bracket and a box explicitly in PR 1. |
| **No real STL fixtures available** - the same problem M4 hit with SVG, and resolved by an explicit, documented override | Medium | The same override path: hand-written reproductions, clearly marked, invoked only if a genuine search in PR 2 comes up empty, not assumed here. |
| **Vertex-welding tolerance wrong for a mesh's actual scale** - too loose welds distinct vertices, too tight leaves a manifold mesh looking non-manifold | Medium | Tolerance is relative (a fraction of the bounding-box diagonal), not an absolute millimetre value, since the real-world scale is unknown at that stage of the pipeline. Tested against a synthetic mesh with deliberately jittered vertices at a known fraction. |
| **`three` bundle weight** - a large 3D library pulled in for byte-parsing and vector math alone | Low | Only `STLLoader` and a handful of math classes are imported, tree-shaken by Vite, and the whole thing lives in the lazy `import/` chunk M4 already established - the initial bundle pays nothing. Sizes reported in PRs 1 and 3, the same discipline M4 applied to `svg-pathdata`. |
| **A component with a genuinely ambiguous thickness** (a mesh with more than one plausible antiparallel-coplanar pair - e.g. a stepped panel) | Low | Largest-area pair wins by construction (§4.4 step 2); if the runner-up pair is close in area, that is exactly the "unaccounted-for area" signal step 4 catches, and the component is rejected rather than guessed between the two. |
| **Bundle growth on top of M4's** - the import chunk now carries `svg-pathdata` and `three` together | Low | Both are needed only once the dialog is opened, and both were already paid for as a single prefetch-on-mount chunk; the marginal cost of one more library in an already-lazy chunk is the number reported in PR 3, not a new architectural risk. |

---

## 8. Confirmed decisions

1. **Mesh parsing: `three` + `STLLoader`**, not a hand-rolled parser. Considered and rejected
   the hand-rolled alternative (the shape of tradeoff that led M3 to hand-roll the DXF writer
   instead of using `dxf-writer`) because STL's binary/ASCII sniffing has real edge cases
   (`solid`-prefixed binary files) that a maintained implementation already handles correctly,
   and because the same library supplies the `Vector3`/`Plane`/`Matrix4` math the slab-detection
   and projection steps need anyway - matches `project-plan.md`'s and `CLAUDE.md`'s stack
   sections, which already named this combination.
2. **One file, possibly many parts.** A file's mesh is split into connected components first;
   each is independently validated as a slab or rejected. Chosen over "one file, one part"
   (which would have matched `project-plan.md` §6's singular "import an STL panel" phrasing more
   literally) because it mirrors how the SVG importer already turns disjoint contours in one
   `path` element into separate parts (`plan-m4.md` §5.4), and because a body with multiple
   disconnected shapes fused into one STL export is a real CAD workflow, not a hypothetical one.
3. **The dropzone accepts multiple files per drop.** CAD tools commonly export one STL per part;
   a woodworker with eight parts should not have to import eight times. Each file is parsed
   independently and merged into one preview list, with its own per-file scale control.
4. **No new `ImportedPart` field for thickness.** Detected thickness is used once, in the UI
   layer, to pre-select a matching `Material` in the preview. It does not travel into the
   committed `Part` (which has no thickness of its own - thickness lives on `Material`) and does
   not need to survive in the shared importer contract.
5. **`Contour`/`nestContours` move out of `svg/` into a shared `import/contours.ts`.** Confirmed
   during this planning pass that the code was already fully generic; this is a relocation, not
   new logic, done so `stl/` never has to import from `svg/`'s own directory. **In PR 2, the same
   reasoning was applied to quantity grouping**: `group.ts` moved from `svg/` to `import/` too,
   for the identical reason - it was already fully generic and STL's multi-file drop groups
   matching parts the same way SVG's repeated shapes do. Not written down as its own numbered
   decision at the time; recorded here in PR 4's pass for consistency with this one.
6. **The scale control's default is pre-filled, never silently accepted.** STL's "always ask,
   never guess" rule (`CLAUDE.md`) is upheld exactly as written - every import starts at
   `{ kind: 'none' }` and blocks commit until confirmed - while still pre-filling the most common
   real answer (raw units read as millimetres) so confirming the common case costs one glance,
   not a typed number every time.
7. **Material selection stays advisory.** Thickness pre-selects the closest matching material
   within a tolerance; it never creates one. Consistent with M4's "when no materials exist,
   import is disabled with a message pointing at the material manager rather than inventing one."

PR 3 (`feat/import-stl-ui`) added the following, once the dialog/preview were actually wired to
`.stl` and a real scale started reaching the importer for the first time:

8. **Detected thickness rides beside `ImportOutcome`, not inside it.** `importStl` returns
   `StlImportOutcome` - the same `ok:true` shape plus a `thicknessMm: Record<sourceId, number>`
   map - rather than widening the shared `ImportedPart`/`ImportOutcome` contract decision 4
   already closed. A caller that doesn't know it's looking at STL output never sees the field.
9. **`importStl` gained `options: { mmPerUnitOverride }`, applied by scaling the raw mesh
   positions immediately after parsing, before anything else runs.** PR 2 never exercised a
   confirmed scale (`scale.kind` was always `'none'`), which hid a real bug: `group.ts`'s and
   `contours.ts`'s grouping/hole-nesting tolerances are absolute millimetres, but were being fed
   the mesh's raw, possibly-non-mm units. A mesh modelled in inches or metres (not a hypothetical
   for this app's hobbyist audience) would silently misgroup once real mm were known. Scaling
   positions before welding fixes this for every downstream absolute-mm tolerance at once, and
   costs nothing extra to compute - every other tolerance in the pipeline is already relative to
   the mesh's own bounding box.
10. **Material selection moved from one dialog-wide `<select>` to a `materialId` per `PreviewRow`.**
    Thickness suggests a match per row (§8 decision 7's tolerance), and a batch of parts of
    different measured thicknesses has no single correct default to fall back on. `initialRows`
    now takes `materials`/`selectedMaterialId`/`thicknessMm` and computes each row's own default.
11. **The dropzone reads `e.target.files`/`e.dataTransfer.files` into a plain array before doing
    anything else with it.** A real bug, caught only by driving the actual browser (Playwright,
    not the unit suite): `HTMLInputElement.files` is a *live* `FileList` - resetting the input's
    `.value` to clear it for re-selection (needed so picking the same file twice still fires
    `change`) empties that same `FileList` object in place. Code that captures the live list and
    reads it after the reset - exactly what a naive multi-file port of M4's single-file
    `files?.[0]` extraction does - sees zero files every time. `Array.from(...)` before the reset
    is the fix; the drop path was never affected (nothing resets `dataTransfer` afterward) but was
    changed to match for the same reason. No unit test catches this class of bug - `ImportDialog`
    still has none, matching M4's posture that its file-handling glue is verified by driving a
    real browser, not by test, and PR 3 confirmed the whole pipeline that way (single STL, mixed
    multi-file SVG+STL drop, full commit) before landing.
