/**
 * The randomized-restart and local hill-climbing improvement wrapper.
 *
 * Implements `Solver`, delegates to `greedyPack`, scores results using
 * `compareScores` in `objective.ts`, and keeps the best layout found.
 *
 * **Pure, headless, and 100% deterministic.** Uses `src/solver/rng.ts` for all
 * random decisions; never calls `Math.random()`. Given identical inputs and
 * seed, it always produces deep-equal output.
 */

import type { Part, Result, SolverConfig, SolverEffort, Stock } from '../domain/types';
import { hasErrors, validateInputs } from '../domain/validate';
import { SolverInputError } from './errors';
import {
  type FitHeuristic,
  orderParts,
  type PartOrder,
  type SplitRule,
} from './guillotine/freeRects';
import { GUILLOTINE_DEFAULTS, groupByMaterial, summariseUnplaced } from './guillotine/index';
import { greedyPack, type PackOptions, type PackResult } from './guillotine/pack';
import {
  expandPartInstances,
  expandStockInstances,
  type PartInstance,
  type StockInstance,
} from './instances';
import { isBetterScore, type SolutionScore, scorePackResult } from './objective';
import { createRng, type Rng } from './rng';
import type { Solver } from './types';

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
 * Run randomized restarts and hill climbing for one material subproblem.
 */
export function solveSubproblem(
  partInstances: readonly PartInstance[],
  stockInstances: readonly StockInstance[],
  config: SolverConfig,
  rng: Rng,
): PackResult {
  const effort = config.effort ?? 'balanced';
  const totalRestarts = RESTART_BUDGETS[effort];

  let bestPackResult: PackResult | null = null;
  let bestScore: SolutionScore | null = null;
  let bestOrdering: PartInstance[] = [...partInstances];
  let bestOptions: PackOptions = GUILLOTINE_DEFAULTS;

  // 1. Deterministic Baseline Iterations (0..3)
  const baselines: PackOptions[] = [
    GUILLOTINE_DEFAULTS,
    { order: 'longest-side-desc', fit: 'best-area', split: 'longer-leftover' },
    { order: 'perimeter-desc', fit: 'best-area', split: 'longer-leftover' },
    { order: 'declaration', fit: 'best-area', split: 'longer-leftover' },
  ];

  for (let i = 0; i < baselines.length && i < totalRestarts; i++) {
    const opts = baselines[i];
    if (opts === undefined) continue;
    const pack = greedyPack(partInstances, stockInstances, config, opts);
    const score = scorePackResult(pack);

    if (bestScore === null || isBetterScore(score, bestScore)) {
      bestScore = score;
      bestPackResult = pack;
      bestOrdering = orderParts(partInstances, opts.order);
      bestOptions = opts;
    }
  }

  // 2. Randomized Restarts
  const remainingRestarts = totalRestarts - baselines.length;
  for (let i = 0; i < remainingRestarts; i++) {
    const baseOrder = BASE_ORDERS[rng.int(BASE_ORDERS.length)];
    const fit = FIT_HEURISTICS[rng.int(FIT_HEURISTICS.length)];
    const split = SPLIT_RULES[rng.int(SPLIT_RULES.length)];

    if (baseOrder === undefined || fit === undefined || split === undefined) continue;

    const ordered = orderParts(partInstances, baseOrder);
    // Perturb ordering with random swaps
    const maxSwaps = Math.max(1, Math.floor(ordered.length / 2));
    const k = rng.int(maxSwaps) + 1;
    const perturbed = mutateOrdering(ordered, k, rng);

    const opts: PackOptions = { order: 'declaration', fit, split };
    const pack = greedyPack(perturbed, stockInstances, config, opts);
    const score = scorePackResult(pack);

    if (bestScore === null || isBetterScore(score, bestScore)) {
      bestScore = score;
      bestPackResult = pack;
      bestOrdering = perturbed;
      bestOptions = opts;
    }
  }

  // 3. Local Hill Climbing Phase
  let nonImprovingCount = 0;
  while (nonImprovingCount < HILL_CLIMB_NON_IMPROVING_LIMIT && bestOrdering.length > 1) {
    const mutated = mutateOrdering(bestOrdering, 1, rng);
    const pack = greedyPack(mutated, stockInstances, config, bestOptions);
    const score = scorePackResult(pack);

    if (bestScore !== null && isBetterScore(score, bestScore)) {
      bestScore = score;
      bestPackResult = pack;
      bestOrdering = mutated;
      nonImprovingCount = 0;
    } else {
      nonImprovingCount++;
    }
  }

  if (bestPackResult === null) {
    // Fallback (e.g. empty part list)
    return greedyPack(partInstances, stockInstances, config, GUILLOTINE_DEFAULTS);
  }

  return bestPackResult;
}

/**
 * Solve a packing problem using the randomized restart & hill-climbing solver.
 */
export function improveGuillotine(
  parts: readonly Part[],
  stock: readonly Stock[],
  config: SolverConfig,
): Result {
  const issues = validateInputs(parts, stock, config);
  if (hasErrors(issues)) throw new SolverInputError(issues);

  const partGroups = groupByMaterial(parts);
  const stockGroups = groupByMaterial(stock);
  const rng = createRng(config.seed);

  const result: Result = { layouts: [], unplacedParts: [], totalWastePct: 0 };
  const allUnplaced: PartInstance[] = [];
  let placedAreaTotal = 0;
  let usedSheetAreaTotal = 0;

  for (const [materialId, groupParts] of partGroups) {
    const partInstances = expandPartInstances(groupParts);
    const stockInstances = expandStockInstances(stockGroups.get(materialId) ?? []);

    const packed = solveSubproblem(partInstances, stockInstances, config, rng);

    for (const sheet of packed.sheets) {
      result.layouts.push(sheet.layout);
      placedAreaTotal += sheet.placedArea;
      usedSheetAreaTotal += sheet.sheetArea;
    }
    allUnplaced.push(...packed.unplaced);
  }

  result.unplacedParts = summariseUnplaced(allUnplaced, parts);
  result.totalWastePct = usedSheetAreaTotal > 0 ? 1 - placedAreaTotal / usedSheetAreaTotal : 0;
  return result;
}

export const ImprovementSolver: Solver = {
  solve(parts, stock, config) {
    return improveGuillotine(parts, stock, config);
  },
};
