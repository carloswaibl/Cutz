/**
 * The saved-project shape.
 *
 * `AppState` (`src/ui/state/types.ts`) minus the fields that are either
 * derived or purely transient UI state: `activeSheetIndex`, `hoveredPartId`,
 * `selectedMaterialId`, and the solve-result fields, which are always
 * recomputed from the fields below rather than stored. `storage/` may depend
 * on `domain/`, never on `ui/` - the same one-way rule `plan-m4.md` set for
 * `import/` - so this type is defined here rather than reused from `AppState`.
 */

import type { Material, Part, SolverConfig, Stock } from '../domain/types';
import type { DisplayUnit } from '../domain/units';

export interface Project {
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

/** The trimmed shape a project switcher needs, without every part/stock payload. */
export interface ProjectSummary {
  id: string;
  name: string;
  updatedAt: number;
}
