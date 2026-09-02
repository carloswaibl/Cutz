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
import { solverMode } from '../domain/validate';
import { improveGuillotine } from './improve';
import { nestSolve } from './nest';
import type { Solver } from './types';

export { SolverInputError } from './errors';
export { GuillotineSolver, packGuillotine } from './guillotine';
export { ImprovementSolver, improveGuillotine } from './improve';
export { NestSolver, nestSolve } from './nest';
export type { Solver } from './types';

type Engine = (parts: readonly Part[], stock: readonly Stock[], config: SolverConfig) => Result;

/**
 * Which engine serves which machine.
 *
 * Total over `SolverMode` on purpose: adding a mode to the domain type without
 * an engine behind it should fail to typecheck rather than fail at runtime.
 *
 * This module is the only thing allowed to reach inside either engine's
 * directory. Both `guillotine/index.ts` and `nest/index.ts` say so in their own
 * headers, and it is what keeps `solve()`'s callers from ever learning which one
 * answered.
 */
const ENGINES: Record<SolverMode, Engine> = {
  guillotine: improveGuillotine,
  nest: nestSolve,
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
