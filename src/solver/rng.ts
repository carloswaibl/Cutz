/**
 * The solver's only source of randomness.
 *
 * The improvement pass explores part orderings and heuristics at random, but a
 * layout a user saved, printed, and carried to the saw has to come back
 * identical next time they open the project. A seeded generator is what makes
 * those two things compatible: same inputs and same seed, same layout, on any
 * machine. `Math.random()` would still produce valid layouts, just different
 * ones every run, and no test would catch it - which is why a lint rule bans it
 * repo-wide.
 *
 * mulberry32: twelve lines, no dependency, well distributed, and fast enough
 * that the generator is never the bottleneck. The exact output stream is frozen
 * by golden-vector tests, because changing it silently would change every saved
 * layout in the world.
 *
 * Pure and headless, like everything else under `solver/`.
 */

/**
 * Read a slot known to exist.
 *
 * `noUncheckedIndexedAccess` types every indexed read as possibly undefined,
 * which is right for arbitrary indices and wrong for a Fisher-Yates swap where
 * both indices were just derived from the array's own length. Narrowing with an
 * `=== undefined` guard instead would quietly change the permutation when `T`
 * itself includes `undefined`; a bounds check makes the assertion honest for
 * every `T`, and the array is dense because it came from a spread.
 */
function at<T>(xs: readonly T[], index: number): T {
  if (index < 0 || index >= xs.length) {
    throw new Error(`index ${index} is outside an array of length ${xs.length}`);
  }
  return xs[index] as T;
}

export interface Rng {
  /** A float in [0, 1). */
  next(): number;
  /** An integer in [0, bound). */
  int(bound: number): number;
  /** A shuffled copy. Never mutates its input. */
  shuffle<T>(xs: readonly T[]): T[];
}

/**
 * Create a generator from a seed.
 *
 * The seed is reduced to 32 bits, so seeds that differ only above bit 31 give
 * the same stream. `validateInputs` accepts any safe integer seed and this is
 * the one place that matters - it is a collision between two arbitrary large
 * numbers, not a loss of reproducibility, which is the property the seed exists
 * to provide.
 */
export function createRng(seed: number): Rng {
  if (!Number.isFinite(seed)) {
    throw new Error(`rng seed must be a finite number, got ${seed}`);
  }

  // `| 0` also truncates a fractional seed, so 1.5 and 1 share a stream. Callers
  // are expected to pass integers; `validateInputs` reports it when they do not.
  let state = seed | 0;

  function next(): number {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  function int(bound: number): number {
    // A caller bug rather than user data, so this throws where the rest of the
    // codebase returns typed issues - same reasoning as `stockInstanceId`.
    if (!Number.isSafeInteger(bound) || bound < 1) {
      throw new Error(`rng bound must be an integer of 1 or more, got ${bound}`);
    }
    // Modulo bias would need a bound near 2^32 to be measurable; the largest
    // bound here is a part count.
    return Math.floor(next() * bound);
  }

  function shuffle<T>(xs: readonly T[]): T[] {
    // Copying rather than shuffling in place keeps `solver/` free of input
    // mutation, so a caller can reuse a base ordering across iterations. The
    // spread also densifies, which is what makes `at` below sound.
    const out = [...xs];
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = int(i + 1);
      const a = at(out, i);
      out[i] = at(out, j);
      out[j] = a;
    }
    return out;
  }

  return { next, int, shuffle };
}
