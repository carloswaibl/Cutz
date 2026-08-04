/**
 * Main solver entry point.
 *
 * Exports `solve()` (the default solver: randomized restart & hill-climbing wrapper
 * over guillotine packing), plus the `ImprovementSolver` and `GuillotineSolver`
 * implementations of the `Solver` interface.
 */

import type { Part, Result, SolverConfig, Stock } from '../domain/types';
import { improveGuillotine } from './improve';
import type { Solver } from './types';

export { SolverInputError } from './errors';
export { GuillotineSolver } from './guillotine';
export { ImprovementSolver, improveGuillotine } from './improve';
export type { Solver } from './types';

/**
 * Solve a cut list optimization problem.
 *
 * This is the default solver export for the application. It runs the randomized-restart
 * and hill-climbing improvement pass around the guillotine engine.
 *
 * Pure, headless, and 100% deterministic given identical inputs and seed.
 */
export function solve(
  parts: readonly Part[],
  stock: readonly Stock[],
  config: SolverConfig,
): Result {
  return improveGuillotine(parts, stock, config);
}

export const DefaultSolver: Solver = {
  solve(parts, stock, config) {
    return solve(parts, stock, config);
  },
};
