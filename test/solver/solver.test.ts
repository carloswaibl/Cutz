import { describe, expect, it } from 'vitest';
import { checkResult } from '../../src/domain/validate';
import {
  DefaultSolver,
  GuillotineSolver,
  ImprovementSolver,
  SolverInputError,
  solve,
} from '../../src/solver';
import { loadFixtures } from '../fixtures/index';

describe('main solver module (src/solver/index.ts)', () => {
  it('exports solve, DefaultSolver, ImprovementSolver, and GuillotineSolver', () => {
    expect(typeof solve).toBe('function');
    expect(typeof DefaultSolver.solve).toBe('function');
    expect(typeof ImprovementSolver.solve).toBe('function');
    expect(typeof GuillotineSolver.solve).toBe('function');
  });

  it('DefaultSolver delegates to solve', () => {
    const fixture = loadFixtures()[0];
    if (!fixture) throw new Error('No fixture');

    const res1 = solve(fixture.parts, fixture.stock, fixture.config);
    const res2 = DefaultSolver.solve(fixture.parts, fixture.stock, fixture.config);

    expect(res1).toEqual(res2);
  });

  // Deliberately every fixture, nest ones included: `solve()` dispatches on each
  // fixture's own mode and `checkResult` validates against that same mode, so
  // this is the one sweep that exercises both engines end to end. It is also why
  // it needs a benchmark's time budget rather than a unit test's.
  it('solves all fixtures cleanly with valid invariants', () => {
    for (const fixture of loadFixtures()) {
      const result = solve(fixture.parts, fixture.stock, fixture.config);
      const outcome = checkResult(result, {
        parts: fixture.parts,
        stock: fixture.stock,
        config: fixture.config,
      });

      expect(outcome.status).toBe('valid');
      expect(outcome.violations).toEqual([]);
    }
  }, 120_000);

  it('defaults to the guillotine engine when no mode is set', () => {
    const fixture = loadFixtures()[0];
    if (!fixture) throw new Error('No fixture');

    const implicit = solve(fixture.parts, fixture.stock, fixture.config);
    const explicit = solve(fixture.parts, fixture.stock, {
      ...fixture.config,
      mode: 'guillotine',
    });

    // A project saved before M7 has no `mode` at all and has to reopen to the
    // layout its owner printed.
    expect(implicit).toEqual(explicit);
  });

  it('dispatches nest mode to the nesting engine, not to guillotine', () => {
    const fixture = loadFixtures()[0];
    if (!fixture) throw new Error('No fixture');

    const nested = solve(fixture.parts, fixture.stock, { ...fixture.config, mode: 'nest' });

    // The registry is the only thing standing between a router project and a
    // table-saw layout, and the two engines are not interchangeable: a nested
    // result is validated against polygons and has no cut sequence at all.
    // Checking it in nest mode is what proves nest mode is what produced it.
    const outcome = checkResult(nested, {
      parts: fixture.parts,
      stock: fixture.stock,
      config: { ...fixture.config, mode: 'nest' },
    });
    expect(outcome.violations).toEqual([]);
  });

  it('re-exports SolverInputError', () => {
    const badPart = {
      id: 'p1',
      label: 'Bad',
      width: -10,
      height: 10,
      qty: 1,
      materialId: 'm1',
      rotationPolicy: 'free90' as const,
    };
    const badStock = {
      id: 's1',
      materialId: 'm1',
      width: 1000,
      height: 1000,
      qty: 1,
      grainAxis: 'x' as const,
    };
    const config = { kerf: 3, edgeTrim: 0, seed: 42 };

    expect(() => solve([badPart], [badStock], config)).toThrow(SolverInputError);
  });
});
