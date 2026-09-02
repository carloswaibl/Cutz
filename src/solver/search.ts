/**
 * The randomized-restart and local hill-climbing harness, engine-agnostic.
 *
 * A packing engine is greedy and deterministic; the quality comes from running
 * it many times over different candidate configurations and keeping the best
 * answer. That outer loop is the same shape whichever engine is inside it, so
 * it lives here and the engine supplies only its candidate space via
 * `SearchEngine`.
 *
 * **All randomness is threaded, never sourced.** The `Rng` is a parameter, this
 * module never calls `Math.random()`, and the harness makes its draws in a
 * fixed order - baselines consume none, each restart consumes whatever `draw`
 * consumes, each hill-climb step whatever `neighbour` consumes. A layout a user
 * printed and carried to the saw has to come back identical when they reopen
 * the project, and that holds only if the sequence of draws is a pure function
 * of the inputs.
 *
 * Pure and headless.
 */

import { isBetterScore, type SolutionScore } from './objective';
import type { Rng } from './rng';

/**
 * The candidate space one engine explores.
 *
 * `Candidate` is whatever configuration that engine varies - for guillotine a
 * part ordering plus a set of packing knobs - and is opaque here.
 */
export interface SearchEngine<Candidate, Packed> {
  /**
   * Deterministic starting configurations, tried first and in order.
   *
   * Consume no randomness, so the first few candidates of a solve are the same
   * whatever the seed.
   */
  baselines(): readonly Candidate[];
  /**
   * One randomized restart. `null` abandons this restart without packing, and
   * still counts against the budget.
   */
  draw(rng: Rng): Candidate | null;
  /**
   * A small perturbation of the best candidate so far, for hill climbing.
   * `null` means this candidate has no neighbours and the climb should stop -
   * a single-part ordering, for instance, cannot be perturbed.
   */
  neighbour(best: Candidate, rng: Rng): Candidate | null;
  /** Run the engine on one candidate. Must be deterministic. */
  pack(candidate: Candidate): Packed;
  score(packed: Packed): SolutionScore;
  /** What to return when the budget was too small to pack anything at all. */
  fallback(): Packed;
}

export interface SearchBudget {
  /** Total packing attempts across baselines and randomized restarts. */
  restarts: number;
  /** Hill climbing stops after this many consecutive non-improving steps. */
  nonImprovingLimit: number;
}

/**
 * Explore an engine's candidate space and return its best packing.
 *
 * Budgets are iteration counts, never wall-clock. A time-based cutoff would
 * make the layout depend on how fast the machine is, which is the same
 * determinism the seeded generator exists to protect.
 *
 * If the budget is too small for even one baseline, `fallback()` is returned
 * without any hill climbing - the pre-M7 code would have spent
 * `nonImprovingLimit` draws on candidates it had already decided to discard,
 * which was unreachable with any real budget and is not worth reproducing.
 */
export function search<Candidate, Packed>(
  engine: SearchEngine<Candidate, Packed>,
  budget: SearchBudget,
  rng: Rng,
): Packed {
  interface Attempt {
    candidate: Candidate;
    packed: Packed;
    score: SolutionScore;
  }

  function evaluate(candidate: Candidate): Attempt {
    const packed = engine.pack(candidate);
    return { candidate, packed, score: engine.score(packed) };
  }

  let best: Attempt | null = null;

  // 1. Deterministic baselines.
  const baselines = engine.baselines();
  for (let i = 0; i < baselines.length && i < budget.restarts; i += 1) {
    const candidate = baselines[i];
    if (candidate === undefined) continue;
    const attempt = evaluate(candidate);
    if (best === null || isBetterScore(attempt.score, best.score)) best = attempt;
  }

  // 2. Randomized restarts. The baselines have already spent part of the
  //    budget, so this can legitimately be zero or negative.
  const remainingRestarts = budget.restarts - baselines.length;
  for (let i = 0; i < remainingRestarts; i += 1) {
    const candidate = engine.draw(rng);
    if (candidate === null) continue;
    const attempt = evaluate(candidate);
    if (best === null || isBetterScore(attempt.score, best.score)) best = attempt;
  }

  // 3. Local hill climbing around the winner.
  let nonImprovingCount = 0;
  while (best !== null && nonImprovingCount < budget.nonImprovingLimit) {
    const candidate = engine.neighbour(best.candidate, rng);
    if (candidate === null) break;

    const attempt = evaluate(candidate);
    if (isBetterScore(attempt.score, best.score)) {
      best = attempt;
      nonImprovingCount = 0;
    } else {
      nonImprovingCount += 1;
    }
  }

  return best === null ? engine.fallback() : best.packed;
}
