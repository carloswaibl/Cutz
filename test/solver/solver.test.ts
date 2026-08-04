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
