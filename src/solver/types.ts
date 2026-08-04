import type { Part, Result, SolverConfig, Stock } from '../domain/types';

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
