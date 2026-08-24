# M6 - Polish and launch

*Implementation plan for project persistence, an onboarding/example flow built on top of
it, and the non-code readiness work (license, README, launch metadata) needed before this
tool is posted anywhere.*

Companion to `docs/project-plan.md` §6 (Milestone 6). Read `CLAUDE.md` first - the
non-negotiable constraints (no backend, no accounts/auth/telemetry, no new runtime
dependency without asking) are binding and unchanged by this milestone. `plan-m2.md` §3.2
(state management), `plan-m3.md` (the `filename.ts` forward-reference to this milestone),
and `plan-m4.md`/`plan-m5.md` (the importer contract, which this milestone does not touch)
are the closest prior context.

---

## 1. Goal and exit criteria

**Goal:** A woodworker's work survives leaving the tab. They can keep more than one
project going (a bookshelf this weekend, a cabinet next month) without one overwriting
the other, a brand-new visitor sees real example projects to start from instead of a
single hardcoded demo, and the repository itself looks like a finished, freely licensed
thing that's safe to post to r/woodworking - a license, a README, and the metadata a
forum link preview actually uses.

**M6 exits when all of the following hold:**

1. **A project's parts, stock, materials, config, display unit, fraction denominator and
   cut-sequence toggle survive a reload.** Today `useCutListState.ts`'s `INITIAL_STATE` is
   always the hardcoded bookshelf preset and every edit is lost on refresh - there is no
   `indexedDB`/`idb`/`localStorage` reference anywhere in `src/`. After this milestone the
   active project is the one last open, reloaded from IndexedDB, not reset to a demo.
2. **Multiple named projects exist independently.** Create, rename, delete, and switch
   between them all work, and switching or deleting one never touches another's stored
   data. This is a real project library, not a single autosave slot - `PresetProject`
   (`src/ui/state/presets.ts`) already carries `id`/`name`/`description` alongside the
   domain data, which is exactly the shape a saved project needs.
3. **A visitor with nothing saved yet sees the three existing example projects
   (bookshelf, cabinet carcass, drawer boxes) as starting points, not a silently
   preloaded bookshelf they didn't ask for.** Today's Header "Sample Project" dropdown
   (`src/ui/components/Header.tsx`) already lets you *load* a preset over whatever's
   open; this milestone turns "load a preset" into "start a new project from a template,"
   which is a materially different action once real saved projects exist to protect.
4. **Every exported filename carries the project's name ahead of the sheet number**,
   closing the standing forward-reference in `src/export/filename.ts` ("Project names
   arrive with IndexedDB persistence in M6 and will slot in ahead of the sheet number").
5. **`LICENSE` (MIT) exists at the repo root, `package.json` has a matching `"license"`
   field, and `README.md` exists** with what the project is, how to run it
   (`npm run dev`/`build`/`test:run`), and a license mention. Neither is auto-generated
   and both are written by hand once, here.
6. **`index.html` has a favicon and Open Graph/Twitter meta tags**, so a link dropped into
   a forum post or a Slack channel shows something better than a bare title. The page
   still boots straight into the tool - no marketing route, no pitch above the fold, per
   the decision in §8.
7. **A small footer is present** (repo link, license, version) - the one piece of
   "landing page" content this milestone actually adds to the running app, per §8.
8. **One new runtime dependency (`idb`) and one new devDependency (`fake-indexeddb`),
   both reported with justification in the PR that adds them.** No other new
   dependencies. `idb` has been the named intended library in `project-plan.md` §3 and
   `CLAUDE.md`'s stack section since the project's start; `fake-indexeddb` is needed
   because jsdom (already a devDependency) has no IndexedDB implementation of its own.
9. **Verification.** `npm run typecheck && npm run test:run && npm run lint && npm run
   build` all clean, plus a real browser pass: create a project, reload, confirm it's
   still there; create a second project from a template, switch between the two, delete
   one and confirm the other is untouched; import an SVG or STL and confirm it survives a
   reload; export a sheet and confirm the filename carries the active project's name.

**Explicitly not an exit criterion:** posting to r/woodworking, r/hobbycnc, or
Lumberjocks. That's a manual action the project owner takes once this PR sequence has
shipped and deployed - not something a PR or a test can verify, and not gated on here.

---

## 2. Scope

### In scope

- `src/storage/` - an IndexedDB-backed project store: schema, CRUD (`list`, `get`,
  `create`, `update`, `rename`, `remove`), built on `idb`.
- A `Project` type (§3.2) and the read/write mapping between it and `AppState`.
- A `useProjectStorage` hook that composes with the existing `useCutListState` (§3.3):
  loads the last-active project on mount, autosaves changes (debounced), and exposes
  project-list operations to the UI.
- A `ProjectMenu` UI component in `Header`, replacing today's "Sample Project" dropdown:
  shows the current project's name (editable inline), lists other saved projects to
  switch to, offers "New Project" (blank or from one of the three existing templates),
  and deletes with a confirmation step.
- A `Footer` component: link to the GitHub repo, license, version number from
  `package.json`.
- `src/export/filename.ts` - project name slots ahead of the sheet number, closing the
  standing comment there.
- `README.md`, `LICENSE` (MIT text), `package.json` `"license"`/`"repository"`/
  `"homepage"` fields.
- `index.html` - a favicon and Open Graph/Twitter card meta tags. Title and description
  are already correct and don't change.
- `docs/project-plan.md` §3's stale "Hosting: Cloudflare Pages or GitHub Pages" line,
  corrected to state GitHub Pages plainly, matching what `.github/workflows/ci.yml`
  already does and `CLAUDE.md` already asserts.

### Out of scope

- **Any backend, account, or cross-device sync.** Projects remain entirely local to the
  browser's IndexedDB, per `CLAUDE.md` constraints 1 and 2. A user switching machines
  starts with nothing saved - expected, not a bug this milestone fixes.
- **A router or a separate marketing screen.** The app keeps loading directly into the
  tool, unchanged from today. Confirmed with the project owner during planning: no pitch
  above the fold, a footer is enough (§8 decision 2).
- **Project export-as-file or sharing between users.** Not asked for by
  `project-plan.md` §6, and it would be new scope (a `.json` project file format, an
  import path for it) beyond "save/load via IndexedDB." A natural v1.5/v2 candidate, not
  this milestone.
- **Reworking the three existing preset templates' content.** `BOOKSHELF_PRESET`,
  `CABINET_CARCASS_PRESET`, and `DRAWER_BOXES_PRESET` in `src/ui/state/presets.ts` are
  reused exactly as they are today, just re-purposed from "load over what's open" to
  "start a new project from."
- **Reusing `test/fixtures/*.json` as the example/starter content.**
  `test/fixtures/index.ts` says fixtures were kept as JSON partly "so M6 can reuse them
  as onboarding examples," but that intent is now stale: `bookshelf.json` and
  `BOOKSHELF_PRESET` have already diverged (different ids, quantities, and unit/config
  conventions - fixtures are metric-native for the solver benchmark harness in
  `test/bench`, presets are entered against the UI's imperial-fraction defaults).
  Reusing fixtures directly risks leaking solver-benchmark-tuned values into user-facing
  templates. `presets.ts` is the single source of example content going forward; fixtures
  stay solver-benchmark-only, and this divergence is worth a one-line comment update in
  `test/fixtures/index.ts` when PR1 or PR2 touches this area, so the next reader doesn't
  chase a stale cross-reference.
- **Actually posting to forums.** Manual, non-code, after this PR sequence ships (§1).
- **Schema migration tooling.** M6 ships IndexedDB at version 1 with the `Project` shape
  in §3.2. If a later milestone needs to change that shape, it adds a versioned migration
  then - not designed speculatively now.

---

## 3. Architecture

### 3.1 Modules

```
src/storage/
  types.ts       # Project, ProjectSummary
  db.ts          # idb: openDB, object store name/keyPath, version = 1
  projects.ts    # listProjects, getProject, createProject, updateProject,
                 # renameProject, deleteProject - all Promise-returning, all pure
                 # wrappers over one `idb` object store keyed by Project.id
```

`src/storage/` depends on `idb` and the browser's IndexedDB, so unlike `src/domain/` and
`src/solver/` it is not headless-in-Node by nature - but its tests still run without a
real browser, using `fake-indexeddb` to provide an in-memory IndexedDB implementation
under Vitest's existing jsdom environment (jsdom itself does not implement IndexedDB).
`src/storage/` may depend on `src/domain/` (for `Material`/`Part`/`Stock`/`SolverConfig`)
but not on `src/ui/` - the same one-way dependency rule `plan-m4.md` §3.1 established for
`src/import/`.

### 3.2 The `Project` type

```ts
interface Project {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  displayUnit: DisplayUnit;
  fractionDenominator: number;
  materials: Material[];
  parts: Part[];
  stock: Stock[];
  config: SolverConfig;
  showCutSequence: boolean;
}
```

This is `AppState` (`src/ui/state/types.ts`) minus the fields that are either derived or
purely transient UI state and have no business surviving a reload as part of the saved
document: `activeSheetIndex`, `hoveredPartId`, `selectedMaterialId`, and the
solve-result fields (`result`, `solverError`, `cutPlans`, `cutPlanError` - these live on
`CutListStateReturn`, not `AppState`, and are always recomputed from the persisted
fields, never stored). Re-solving on load is expected and cheap (`CLAUDE.md` constraint
4 - target problem size is 20-100 parts).

`ProjectSummary` is the trimmed shape the switcher's list view actually needs -
`{ id, name, updatedAt }` - so listing projects never has to deserialize every project's
full parts/stock payload just to render a menu.

### 3.3 Wiring: a new hook, not a wider reducer

Persistence composes as `useProjectStorage`, a hook that wraps `useCutListState` rather
than folding load/save/switch/delete into `cutListReducer`'s existing action union
(`SET_UNIT`, `ADD_PART`, `LOAD_PRESET`, ... - see `src/ui/state/useCutListState.ts`).
`cutListReducer` stays focused on editing the document that's currently open; storage
concerns (which project is active, when to persist it, the list of what else is saved)
are a layer above it. Concretely:

- On mount, `useProjectStorage` reads the most-recently-active project id (itself a small
  piece of persisted UI state, not a `Project`) and loads that project's fields into
  `useCutListState`'s initializer. If none exists (first-ever visit, or every project was
  deleted), it falls back to the "no projects yet" state described in §4.
- On every change to the persisted subset of `AppState`, it schedules a debounced write
  to IndexedDB for the active project, updating `updatedAt`.
- It exposes `projects: ProjectSummary[]`, `activeProjectId`, `createProject(fromTemplate?
  presetId)`, `switchProject(id)`, `renameProject(id, name)`, `deleteProject(id)` for
  `ProjectMenu` to call.

`App.tsx` calls `useProjectStorage()` in place of today's direct `useCutListState()`
call; everything downstream of that point (`Header`, `PartTable`, `LayoutViewer`, etc.)
is unaffected, since `useProjectStorage` re-exposes the same `CutListStateReturn` shape
alongside its own project-list additions.

---

## 4. UI

- **`ProjectMenu`** (new component, `src/ui/components/`), replacing the "Sample
  Project" `<select>` in `Header.tsx`: current project name shown and editable inline;
  a list of the other saved projects (name + relative last-modified time) to switch to;
  "New Project," which offers a blank project or one of the three existing templates
  (§2); "Delete," gated behind a confirmation step since it's destructive and
  irreversible - deleting the last remaining project returns to the "no projects yet"
  empty state, it does not recreate a default.
- **Empty state (no projects yet).** First-ever visit, or every project deleted: instead
  of `useCutListState`'s current always-bookshelf `INITIAL_STATE`, the user is shown the
  same "New Project" choice (blank or one of the three templates) with nothing assumed.
  This is the "onboarding example project" bullet from `project-plan.md` §6: the three
  presets already exist and already work as example content; what's new is offering them
  as starting points for a real saved project instead of a demo that quietly overwrites
  itself.
- **`Footer`** (new component): a link to the project's GitHub repository, the license
  name, and the version from `package.json`. Rendered once at the bottom of `App.tsx`,
  below the existing content, not fixed/sticky - it's a footer, not a banner.

---

## 5. Work breakdown and PR sequence

Four sequential PRs, proposed to mirror M4's and M5's shape. Each is independently
mergeable and CI-green; each gets its own `plan-next` pass before it starts, the same way
M4's PR20 preceded PR21-24 and M5's PR25 preceded PR26-29. Exact scope may shift slightly
as each PR's own "what shipped" notes get added here, the way M4's and M5's did.

### PR 1 - `feat/storage-idb` - headless storage layer, no UI

- Add `idb` as a runtime dependency and `fake-indexeddb` as a devDependency. Report
  bundle impact for `idb` even though nothing loads it from the UI yet, matching the
  discipline M4 PR1 applied to `svg-pathdata` and M5 PR1 applied to `three`.
- `src/storage/types.ts`, `db.ts`, `projects.ts` per §3.1/§3.2.
- Tests against `fake-indexeddb`: create/list/get/update/rename/delete round-trip;
  deleting one project never touches another's stored record; `updatedAt` advances on
  update; listing returns `ProjectSummary`, not full payloads.

### PR 2 - `feat/project-persistence` - wiring, autosave, UI - **shipped**

- `useProjectStorage` per §3.3, composed into `App.tsx`.
- `ProjectMenu` and the empty-state "New Project" flow per §4, replacing `Header`'s
  "Sample Project" dropdown.
- `src/export/filename.ts` - project name slots ahead of the sheet number, closing the
  standing comment.
- A one-line comment update in `test/fixtures/index.ts` noting that fixtures are
  solver-benchmark-only and example/starter content now lives in `presets.ts` (§2).
- Tests: debounced autosave actually persists after a change; reload restores the active
  project; switching projects never bleeds one project's edits into another's stored
  record; deleting the active project falls back to the empty state, not a crash.

**What shipped, and what changed on the way.**

- **A new headless module, `src/ui/state/projectStore.ts`, holds every piece of logic
  that doesn't need React** (initial-project resolution, blank/template project input,
  the `AppState`/`Project` -> `ProjectFields` mapping, delete-fallback selection, a
  generic debouncer), tested directly against `fake-indexeddb`/`vi.useFakeTimers()` with
  no renderer. `useProjectStorage.ts` wraps it as a thin hook, verified manually in the
  browser. This wasn't spelled out in §3.3 - it follows a convention `test/ui/state.test.ts`
  already stated for `useCutListState`, and avoids adding `@testing-library/react` (not
  named in §1 criterion 8's two approved new dependencies).
- **`LOAD_PRESET`/`loadPreset` and `RESET_ALL`/`resetAll` removed from `cutListReducer`
  and `useCutListState`, replaced by one `LOAD_PROJECT` action.** Both were dead code the
  moment `ProjectMenu` took over "load a preset" (now "create a project from a
  template," which persists rather than overlaying live state) - grepped confirmed no
  other caller.
- **Deletion is confirmed with `window.confirm`, not a modal component.** No modal exists
  anywhere in this codebase; building one for this single call site would be new UI
  infrastructure the milestone didn't ask for.
- **Filename format is `cutz-{project-slug}-sheet-{n}-{material-slug}.ext`.** Both slugs
  independently fall back to omitting themselves (not the whole segment) when a name
  slugs to nothing, matching the material slug's existing fallback behavior.
- **`ProjectMenu`'s "New Project" section and the full-screen empty-state prompt
  (`NewProjectPrompt.tsx`) are two components, not one reused verbatim** - the empty
  state needed a different visual (full-screen cards, not a dropdown panel) even though
  both read the same `PRESETS` list and call the same `createProject`.

No bugs surfaced by the tests this time; the type system caught the two design slips
worth recording. First, `pickProjectFields` was originally typed to take `AppState`,
which doesn't type-check against a loaded `Project` (missing `activeSheetIndex` etc.) -
retyped to take `ProjectFields` itself, which both `AppState` and `Project` satisfy
structurally, so the same function serves both the autosave direction and the load
direction. Second, the autosave effect originally called `pickProjectFields(state)`
inside a `useEffect`, which would have needed bare `state` in the dependency array -
firing on every dispatch, including the purely transient ones (hover, active sheet,
material filter) autosave must ignore. Fixed by reading each of the seven fields by its
own member expression in the effect body, matching the individual fields already listed
in its dependency array.

### PR 3 - `chore/launch-polish` - non-code readiness

- `README.md`: what the project is, `npm run dev`/`build`/`test:run`, license mention.
- `LICENSE` (MIT), `package.json` `"license"`/`"repository"`/`"homepage"` fields.
- `index.html` favicon and Open Graph/Twitter meta tags.
- `Footer` component per §4.
- No behavior change to solver/import/export - this PR is docs and static metadata plus
  one small presentational component.

### PR 4 - `chore/m6-exit-verification` - close it out

- Browser pass per §1 criterion 9: create/reload/switch/delete projects, import
  persisting across reload, exported filenames carrying the project name.
- `CLAUDE.md`'s "Current status" updated to M6 complete, `src/storage/` filled in in the
  directory listing, `idb` and `fake-indexeddb` added to the Stack section.
- `docs/project-plan.md` §3's hosting line corrected to state GitHub Pages plainly (§2).
- Record what shipped and what changed on the way, matching M4's and M5's PR4 pattern in
  this same document.

---

## 6. Risk register

| Risk | Severity | Mitigation |
|---|---|---|
| **IndexedDB schema needs to change later** - a future milestone adds a field to `Project` | Low | Version = 1 shipped deliberately minimal (§3.2). A future change is a versioned `idb` upgrade callback, not designed speculatively now. |
| **Autosave writes too often** - every keystroke in a part's label triggering an IndexedDB write | Medium | Debounced in `useProjectStorage` (§3.3). Tested against a burst of rapid changes producing one write, not one per change. |
| **Accidental project deletion** - a destructive, irreversible action with no accounts/undo to fall back on | Medium | `ProjectMenu`'s delete is gated behind a confirmation step (§4), not a single click. |
| **`test/fixtures` vs `presets.ts` divergence causes confusion later** - a future contributor reads the stale "M6 reuses fixtures as examples" comment and tries to unify them | Low | Comment corrected in PR2 (§5) to state plainly that the two are separate and why. |
| **New devDependency (`fake-indexeddb`) surprises a reviewer expecting only `idb`** | Low | Called out explicitly in this doc (§1 criterion 8) and in PR1's own description, following `CLAUDE.md` constraint 6's "ask first" posture even though it's a devDependency, not a runtime one. |

---

## 7. Confirmed decisions

1. **Multi-project library, not a single autosave slot.** Discussed and decided during
   this milestone's planning pass: `PresetProject`'s existing `id`/`name`/`description`
   shape and the project's own "polish and launch" framing both point at real saved
   projects a user can return to, not just "don't lose today's session."
2. **No router, no separate marketing screen.** The app keeps loading straight into the
   tool. A footer is the only new "landing page" content this milestone adds - decided
   explicitly with the project owner rather than assumed, since it's an architectural
   choice (routing is a new dependency and a real UX change) the plan doc can't default
   its way past.
3. **License: MIT.** Chosen explicitly by the project owner over Apache-2.0 and
   GPL-3.0 - permissive, one paragraph, matches a small free client-side tool with no
   commercial backend to protect and no expectation of corporate contributors needing an
   explicit patent grant.
4. **Example/starter content reuses `presets.ts`, not `test/fixtures/*.json`.**
   `test/fixtures/index.ts`'s comment anticipating the opposite predates the two having
   diverged in literal values and unit conventions; reusing fixtures now would leak
   solver-benchmark-tuned data into user-facing templates. Recorded as a deliberate
   supersession of that earlier stated intent, not an oversight.
5. **Autosave, debounced, no explicit Save action.** Matches the app's existing
   no-friction, no-accounts posture elsewhere - nothing else in the app requires an
   explicit commit step to take effect except importing (which has its own preview/commit
   step for a different reason - reviewing what a file produced before trusting it, per
   `plan-m4.md` §1 criterion 5).
6. **`idb` (runtime) and `fake-indexeddb` (devDependency) are the two new dependencies.**
   `idb` was already the named intended library in `project-plan.md` §3 and `CLAUDE.md`'s
   stack section since the project's start; `fake-indexeddb` is the standard way to test
   `idb`-based code under Vitest/jsdom, which has no IndexedDB implementation of its own.
7. **`docs/project-plan.md` §3's "Cloudflare Pages or GitHub Pages" line is corrected to
   state GitHub Pages plainly**, bundled into PR4 as a stale-doc fix rather than treated
   as a new decision - `.github/workflows/ci.yml` and `CLAUDE.md` both already committed
   to GitHub Pages; only `project-plan.md` had not caught up.
