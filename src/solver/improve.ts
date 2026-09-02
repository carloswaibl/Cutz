/**
 * The randomized-restart and local hill-climbing improvement wrapper.
 *
 * Implements `Solver`. The outer loop it used to own now lives in `search.ts`
 * so the nester can share it; what stays here is the part that is genuinely
 * about a table saw - which packing knobs exist, which orderings are worth
 * starting from, and how hard to try at each effort level.
 *
 * **Pure, headless, and 100% deterministic.** Uses `src/solver/rng.ts` for all
 * random decisions; never calls `Math.random()`. Given identical inputs and
 * seed, it always produces deep-equal output.
 */

import type { Part, Result, SolverConfig, SolverEffort, Stock } from '../domain/types';
import { solverMode } from '../domain/validate';
import {
  type FitHeuristic,
  orderParts,
  type PartOrder,
  type SplitRule,
} from './guillotine/freeRects';
import { GUILLOTINE_DEFAULTS } from './guillotine/index';
import { greedyPack, type PackOptions } from './guillotine/pack';
import type { PartInstance, StockInstance } from './instances';
import { type SolutionScore, scorePack } from './objective';
import { createRng, type Rng } from './rng';
import { type SearchBudget, type SearchEngine, search } from './search';
import { solveByMaterial } from './subproblems';
import type { PackedResult, Solver } from './types';

/** Map effort levels to restart iteration budgets. */
const RESTART_BUDGETS: Record<SolverEffort, number> = {
  fast: 40,
  balanced: 250,
  thorough: 1500,
};

/** Number of non-improving steps allowed during local hill climbing. */
const HILL_CLIMB_NON_IMPROVING_LIMIT = 20;

const FIT_HEURISTICS: readonly FitHeuristic[] = ['best-area', 'best-short-side', 'best-long-side'];
const SPLIT_RULES: readonly SplitRule[] = [
  'longer-leftover',
  'shorter-leftover',
  'shorter-axis',
  'longer-axis',
];
const BASE_ORDERS: readonly PartOrder[] = [
  'area-desc',
  'longest-side-desc',
  'perimeter-desc',
  'declaration',
];

/**
 * A guillotine candidate: the order parts are offered in, and the knobs the
 * packer uses to choose and split free rectangles.
 *
 * The ordering is held explicitly rather than left to `options.order` because
 * hill climbing perturbs it directly, and a perturbation only survives into the
 * packer when `options.order` is `'declaration'`.
 */
interface GuillotineCandidate {
  ordering: readonly PartInstance[];
  options: PackOptions;
}

/**
 * Perturb a list of part instances by making `k` random pair swaps.
 */
function mutateOrdering(instances: readonly PartInstance[], k: number, rng: Rng): PartInstance[] {
  const result = [...instances];
  if (result.length <= 1) return result;
  for (let step = 0; step < k; step++) {
    const i = rng.int(result.length);
    const j = rng.int(result.length);
    if (i !== j) {
      const temp = result[i];
      const target = result[j];
      if (temp !== undefined && target !== undefined) {
        result[i] = target;
        result[j] = temp;
      }
    }
  }
  return result;
}

/**
 * The guillotine engine's candidate space, for one material subproblem.
 */
function guillotineEngine(
  partInstances: readonly PartInstance[],
  stockInstances: readonly StockInstance[],
  config: SolverConfig,
): SearchEngine<GuillotineCandidate, PackedResult> {
  const mode = solverMode(config);

  return {
    baselines(): readonly GuillotineCandidate[] {
      const options: readonly PackOptions[] = [
        GUILLOTINE_DEFAULTS,
        { order: 'longest-side-desc', fit: 'best-area', split: 'longer-leftover' },
        { order: 'perimeter-desc', fit: 'best-area', split: 'longer-leftover' },
        { order: 'declaration', fit: 'best-area', split: 'longer-leftover' },
      ];
      // Pre-ordering here rather than letting `greedyPack` do it is what gives
      // hill climbing something to perturb. `orderParts` is a stable sort on a
      // pure key, so ordering twice by the same rule is ordering once and the
      // packer sees exactly the sequence it always did.
      return options.map((opts) => ({
        ordering: orderParts(partInstances, opts.order),
        options: opts,
      }));
    },

    draw(rng: Rng): GuillotineCandidate | null {
      const baseOrder = BASE_ORDERS[rng.int(BASE_ORDERS.length)];
      const fit = FIT_HEURISTICS[rng.int(FIT_HEURISTICS.length)];
      const split = SPLIT_RULES[rng.int(SPLIT_RULES.length)];
      if (baseOrder === undefined || fit === undefined || split === undefined) return null;

      const ordered = orderParts(partInstances, baseOrder);
      // Perturb ordering with random swaps
      const maxSwaps = Math.max(1, Math.floor(ordered.length / 2));
      const k = rng.int(maxSwaps) + 1;

      // `declaration` keeps the perturbation: any other rule would sort it
      // straight back out inside the packer.
      return {
        ordering: mutateOrdering(ordered, k, rng),
        options: { order: 'declaration', fit, split },
      };
    },

    neighbour(best: GuillotineCandidate, rng: Rng): GuillotineCandidate | null {
      if (best.ordering.length <= 1) return null;
      return { ordering: mutateOrdering(best.ordering, 1, rng), options: best.options };
    },

    pack(candidate: GuillotineCandidate): PackedResult {
      return greedyPack(candidate.ordering, stockInstances, config, candidate.options);
    },

    score(packed: PackedResult): SolutionScore {
      return scorePack(packed, mode);
    },

    fallback(): PackedResult {
      return greedyPack(partInstances, stockInstances, config, GUILLOTINE_DEFAULTS);
    },
  };
}

/**
 * Run randomized restarts and hill climbing for one material subproblem.
 */
export function solveSubproblem(
  partInstances: readonly PartInstance[],
  stockInstances: readonly StockInstance[],
  config: SolverConfig,
  rng: Rng,
): PackedResult {
  const budget: SearchBudget = {
    restarts: RESTART_BUDGETS[config.effort ?? 'balanced'],
    nonImprovingLimit: HILL_CLIMB_NON_IMPROVING_LIMIT,
  };
  return search(guillotineEngine(partInstances, stockInstances, config), budget, rng);
}

/**
 * Solve a packing problem using the randomized restart & hill-climbing solver.
 */
export function improveGuillotine(
  parts: readonly Part[],
  stock: readonly Stock[],
  config: SolverConfig,
): Result {
  return solveByMaterial(parts, stock, config, () => {
    // One generator for the whole solve, threaded across materials in turn, so
    // a seed reproduces the project rather than each subproblem independently.
    // Seeded inside the factory so `validateInputs` gets to reject a bad seed
    // with a message before `createRng` throws about it.
    const rng = createRng(config.seed);
    return (partInstances, stockInstances) =>
      solveSubproblem(partInstances, stockInstances, config, rng);
  });
}

export const ImprovementSolver: Solver = {
  solve(parts, stock, config) {
    return improveGuillotine(parts, stock, config);
  },
};
