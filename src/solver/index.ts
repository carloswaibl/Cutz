/**
 * Main solver entry point, and the registry that picks an engine.
 *
 * `SolverConfig.mode` names the machine a project is being cut on, and this
 * module maps it to the engine that produces layouts valid for that machine.
 * `solve()`'s signature is unchanged by that indirection, which is the whole
 * point: every caller keeps asking the same question and stops caring which
 * engine answers it.
 */

import type { Part, Result, SolverConfig, SolverMode, Stock } from '../domain/types';
import { solverMode, validateInputs } from '../domain/validate';
import { SolverInputError } from './errors';
import { improveGuillotine } from './improve';
import type { Solver } from './types';

export { SolverInputError } from './errors';
export { GuillotineSolver, packGuillotine } from './guillotine';
export { ImprovementSolver, improveGuillotine } from './improve';
export type { Solver } from './types';

type Engine = (parts: readonly Part[], stock: readonly Stock[], config: SolverConfig) => Result;

/**
 * The placeholder standing in the registry until `src/solver/nest/` exists.
 *
 * `validateInputs` reports `unsupported-solver-mode` as an error for `'nest'`,
 * so this always throws with a message the user can act on. It never falls back
 * to a guillotine layout: handing a router a table-saw packing while
 * `checkResult` has stopped asking whether that packing is cuttable is exactly
 * the silent downgrade the mode-aware validator exists to prevent.
 *
 * `docs/plan-m7.md` §5 PR 6 replaces this entry with the nesting engine and
 * deletes the `unsupported-solver-mode` issue in the same change.
 */
const nestNotYetAvailable: Engine = (parts, stock, config) => {
  throw new SolverInputError(validateInputs(parts, stock, config));
};

/**
 * Which engine serves which machine.
 *
 * Total over `SolverMode` on purpose: adding a mode to the domain type without
 * an engine behind it should fail to typecheck rather than fail at runtime.
 */
const ENGINES: Record<SolverMode, Engine> = {
  guillotine: improveGuillotine,
  nest: nestNotYetAvailable,
};

/**
 * Solve a cut list optimization problem.
 *
 * Dispatches on `config.mode`, defaulting to guillotine - which is what every
 * project written before M7 opens as, and what a user who has not chosen a
 * machine gets. The guillotine engine is the randomized-restart and
 * hill-climbing improvement pass, not the bare greedy packer.
 *
 * Pure, headless, and 100% deterministic given identical inputs and seed.
 */
export function solve(
  parts: readonly Part[],
  stock: readonly Stock[],
  config: SolverConfig,
): Result {
  return ENGINES[solverMode(config)](parts, stock, config);
}

export const DefaultSolver: Solver = {
  solve(parts, stock, config) {
    return solve(parts, stock, config);
  },
};
