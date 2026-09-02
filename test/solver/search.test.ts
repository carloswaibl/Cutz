import { describe, expect, it } from 'vitest';
import type { SolutionScore } from '../../src/solver/objective';
import { createRng, type Rng } from '../../src/solver/rng';
import { type SearchBudget, type SearchEngine, search } from '../../src/solver/search';

/**
 * The harness is driven here by an engine that packs nothing at all.
 *
 * That is the point of the file. `search.ts` was lifted out of the guillotine
 * improvement pass, and the only thing separating a real generalisation from a
 * rename is a second engine exercising it - one with its own candidate type,
 * its own scoring, and no free rectangles, sheets or kerf anywhere in sight.
 * The guillotine side is covered by the bench, which must stay bit-identical.
 */

/** A candidate is just a number; lower is better. */
type Candidate = number;

interface Trace {
  packed: Candidate[];
  drawn: number;
  neighbours: number;
}

/**
 * An engine over the integers.
 *
 * `baselines` offers a fixed descending set, `draw` picks one at random, and
 * `neighbour` steps one below the incumbent - so hill climbing always improves
 * until it hits `floor`, which is what lets a test pin where the climb stops.
 */
function numberEngine(options: {
  baselines?: readonly Candidate[];
  floor?: Candidate;
  noNeighbours?: boolean;
  trace?: Trace;
}): SearchEngine<Candidate, { value: Candidate }> {
  const { baselines = [90, 70, 80], floor = 0, noNeighbours = false, trace } = options;

  return {
    baselines: () => baselines,
    draw(rng: Rng): Candidate | null {
      if (trace) trace.drawn += 1;
      return rng.int(100);
    },
    neighbour(best: Candidate): Candidate | null {
      if (trace) trace.neighbours += 1;
      if (noNeighbours) return null;
      return Math.max(floor, best - 1);
    },
    pack(candidate: Candidate) {
      if (trace) trace.packed.push(candidate);
      return { value: candidate };
    },
    score(packed: { value: Candidate }): SolutionScore {
      return { unplacedArea: packed.value, usedStockArea: 0 };
    },
    fallback: () => ({ value: -1 }),
  };
}

const BUDGET: SearchBudget = { restarts: 20, nonImprovingLimit: 5 };

describe('the search harness', () => {
  it('tries every baseline before spending any randomness', () => {
    const trace: Trace = { packed: [], drawn: 0, neighbours: 0 };
    const engine = numberEngine({ trace });

    search(engine, { restarts: 3, nonImprovingLimit: 0 }, createRng(1));

    expect(trace.packed).toEqual([90, 70, 80]);
    expect(trace.drawn).toBe(0);
  });

  it('stops opening baselines once the budget is spent', () => {
    const trace: Trace = { packed: [], drawn: 0, neighbours: 0 };
    const engine = numberEngine({ trace });

    search(engine, { restarts: 2, nonImprovingLimit: 0 }, createRng(1));

    expect(trace.packed).toEqual([90, 70]);
    expect(trace.drawn).toBe(0);
  });

  it('spends the rest of the budget on randomized restarts', () => {
    const trace: Trace = { packed: [], drawn: 0, neighbours: 0 };
    const engine = numberEngine({ trace });

    search(engine, { restarts: 10, nonImprovingLimit: 0 }, createRng(1));

    // Ten attempts total: three baselines, seven draws.
    expect(trace.drawn).toBe(7);
    expect(trace.packed).toHaveLength(10);
  });

  it('falls back without hill climbing when the budget packs nothing', () => {
    const trace: Trace = { packed: [], drawn: 0, neighbours: 0 };
    const engine = numberEngine({ trace });

    const result = search(engine, { restarts: 0, nonImprovingLimit: 5 }, createRng(1));

    expect(result).toEqual({ value: -1 });
    expect(trace.packed).toEqual([]);
    // Nothing to climb around, so no neighbour is asked for and no randomness
    // is consumed on candidates that were never going to be kept.
    expect(trace.neighbours).toBe(0);
    expect(trace.drawn).toBe(0);
  });

  it('stops climbing when a candidate has no neighbour', () => {
    const trace: Trace = { packed: [], drawn: 0, neighbours: 0 };
    const engine = numberEngine({ noNeighbours: true, trace });

    search(engine, { restarts: 3, nonImprovingLimit: 5 }, createRng(1));

    // Asked once, told no, and stopped - not five times.
    expect(trace.neighbours).toBe(1);
    expect(trace.packed).toEqual([90, 70, 80]);
  });

  it('stops climbing after the non-improving limit', () => {
    const trace: Trace = { packed: [], drawn: 0, neighbours: 0 };
    // floor 70 means the winning baseline (70) can never be improved on, so
    // every step is a non-improving one.
    const engine = numberEngine({ floor: 70, trace });

    search(engine, { restarts: 3, nonImprovingLimit: 4 }, createRng(1));

    expect(trace.packed).toEqual([90, 70, 80, 70, 70, 70, 70]);
  });

  it('keeps climbing while it is still improving', () => {
    const engine = numberEngine({ baselines: [50], floor: 0 });

    const result = search(engine, { restarts: 1, nonImprovingLimit: 3 }, createRng(1));

    // Descends one per step to the floor, then burns the three allowed
    // non-improving steps there.
    expect(result).toEqual({ value: 0 });
  });

  it('returns the best candidate, not the last one tried', () => {
    const engine = numberEngine({ baselines: [10, 90], noNeighbours: true });

    expect(search(engine, { restarts: 2, nonImprovingLimit: 5 }, createRng(1))).toEqual({
      value: 10,
    });
  });

  it('is a pure function of the seed', () => {
    // No neighbours, so the winner is decided entirely by the draws rather than
    // by a hill climb that would descend to the same floor whatever the seed -
    // otherwise the equality below would hold for the wrong reason.
    const engine = () => numberEngine({ noNeighbours: true });

    const first = search(engine(), BUDGET, createRng(12345));
    const second = search(engine(), BUDGET, createRng(12345));
    const other = search(engine(), BUDGET, createRng(54321));

    expect(first).toEqual(second);
    expect(other).not.toEqual(first);
  });

  it('threads one generator through, so draws never repeat', () => {
    const trace: Trace = { packed: [], drawn: 0, neighbours: 0 };
    search(
      numberEngine({ baselines: [], trace }),
      { restarts: 8, nonImprovingLimit: 0 },
      createRng(7),
    );

    expect(new Set(trace.packed).size).toBeGreaterThan(1);
  });
});
