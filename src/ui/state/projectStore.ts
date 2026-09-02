/**
 * Headless project-persistence logic: no React import, tested directly against
 * `fake-indexeddb` the same way `test/storage/projects.test.ts` tests
 * `src/storage/projects.ts`. `useProjectStorage.ts` is the thin React wrapper
 * around this - see `docs/plan-m6.md` §3.3 and the codebase's own stated
 * convention in `test/ui/state.test.ts` for keeping hooks thin and their logic
 * testable without a renderer.
 *
 * Lives in `src/ui/state/` rather than `src/storage/` because building a
 * project from a template reads `PRESETS` (`./presets.ts`), and `src/storage/`
 * may not depend on `src/ui/` - `docs/plan-m6.md` §3.1.
 */

import type { SolverConfig } from '../../domain/types';
import { inchToMm } from '../../domain/units';
import { getActiveProjectId, getProject, listProjects } from '../../storage/projects';
import type { Project, ProjectSummary } from '../../storage/types';
import { PRESETS } from './presets';
import type { ProjectFields } from './types';

const DEFAULT_CONFIG: SolverConfig = {
  kerf: inchToMm(0.125), // 1/8" saw blade kerf
  edgeTrim: inchToMm(0.25), // 1/4" factory edge trim
  seed: 1,
  effort: 'balanced',
};

type ProjectInput = Omit<Project, 'id' | 'createdAt' | 'updatedAt'>;

/** A new project with nothing in it - the "blank" choice in the New Project flow. */
export function blankProjectInput(name: string): ProjectInput {
  return {
    name,
    displayUnit: 'imperial-fraction',
    fractionDenominator: 16,
    materials: [],
    parts: [],
    stock: [],
    config: DEFAULT_CONFIG,
    showCutSequence: true,
  };
}

/**
 * A new project seeded from one of the three example templates in
 * `presets.ts`. Throws on an unknown key - a stale UI reference, not user
 * input, the same posture `storage/projects.ts`'s `updateProject` takes.
 */
export function templateProjectInput(presetKey: string, name?: string): ProjectInput {
  const preset = PRESETS[presetKey];
  if (!preset) {
    throw new Error(`Unknown preset: ${presetKey}`);
  }
  return {
    name: name ?? preset.name,
    displayUnit: 'imperial-fraction',
    fractionDenominator: 16,
    materials: preset.materials,
    parts: preset.parts,
    stock: preset.stock,
    config: preset.config,
    showCutSequence: true,
  };
}

/**
 * The seven persisted fields, stripped of whatever else the source object
 * carries - `AppState`'s transient/derived fields, or `Project`'s
 * `id`/`name`/`createdAt`/`updatedAt`. Both satisfy `ProjectFields`
 * structurally, so this doubles as the `AppState -> ProjectFields` autosave
 * mapping and the `Project -> ProjectFields` load mapping; either way the
 * fields not part of the shape are dropped rather than silently carried
 * through a wider-typed spread.
 */
export function pickProjectFields(source: ProjectFields): ProjectFields {
  const { displayUnit, fractionDenominator, materials, parts, stock, config, showCutSequence } =
    source;
  return { displayUnit, fractionDenominator, materials, parts, stock, config, showCutSequence };
}

/**
 * Which project to load on mount. Prefers the last-active project; falls back
 * to the most recently updated saved project if that id is missing or stale
 * (deleted, or never set); resolves to `'empty'` when nothing is saved at all.
 */
export async function resolveInitialProject(): Promise<Project | 'empty'> {
  const activeId = await getActiveProjectId();
  if (activeId) {
    const active = await getProject(activeId);
    if (active) return active;
  }
  const list = await listProjects();
  const mostRecent = list[0];
  if (!mostRecent) return 'empty';
  const project = await getProject(mostRecent.id);
  return project ?? 'empty';
}

/**
 * Which project becomes active after deleting the current one. `remaining`
 * must already be sorted most-recently-updated first, matching what
 * `listProjects()` returns - the caller re-lists after the delete rather than
 * filtering its own stale copy, so a rename or edit elsewhere isn't lost.
 */
export function resolveFallbackAfterDelete(remaining: ProjectSummary[]): ProjectSummary | 'empty' {
  return remaining[0] ?? 'empty';
}
