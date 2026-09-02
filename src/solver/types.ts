import type { Layout, Part, Result, SolverConfig, Stock } from '../domain/types';
import type { PartInstance } from './instances';

/**
 * The pluggable packing engine interface.
 *
 * This is the firewall that keeps free-form CNC nesting (v2) out of v1. The
 * guillotine packer is one implementation, not the only one - nothing outside
 * `solver/guillotine/` may assume it has no siblings, and the UI and importers
 * talk to this interface rather than to a concrete solver.
 */
export interface Solver {
  solve(parts: Part[], stock: Stock[], config: SolverConfig): Result;
}

/**
 * One sheet an engine decided to open.
 *
 * Engine-agnostic on purpose: this lives here rather than in
 * `guillotine/pack.ts` because `subproblems.ts` and `objective.ts` both consume
 * it and neither may reach inside an engine's own directory.
 */
export interface PackedSheet {
  layout: Layout;
  /**
   * Sum of what the placed parts consume on this sheet, mm².
   *
   * "Consume" is mode-dependent and the engine is the one that knows: a saw
   * loses the whole bounding box, a router only the outline. See
   * `placedArea(part, mode)` in `domain/polygon.ts` - `docs/plan-m7.md` §7
   * decision 4.
   */
  placedArea: number;
  /** Full `width * height` of the sheet, mm². Not the usable area. */
  sheetArea: number;
  /**
   * Area of the single largest free rectangle remaining on this sheet, mm².
   *
   * Optional because it is a free-rectangle engine's notion. A raster nester
   * has no such thing, and absent means the objective's third criterion does
   * not apply rather than that it scores zero.
   */
  maxFreeRectArea?: number;
}

/**
 * What one per-material subproblem produced.
 *
 * `unplaced` is in the order the instances were offered, which is what lets
 * `summariseUnplaced` roll it back up into the user's own part order.
 */
export interface PackedResult {
  sheets: PackedSheet[];
  unplaced: PartInstance[];
}
