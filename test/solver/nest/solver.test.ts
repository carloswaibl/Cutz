import { describe, expect, it } from 'vitest';
import { placementPolygon, polygonSeparation } from '../../../src/domain/polygon';
import type { Part, Point, Result, SolverConfig, Stock } from '../../../src/domain/types';
import { checkResult } from '../../../src/domain/validate';
import { SolverInputError } from '../../../src/solver/errors';
import { NestSolver, nestSolve } from '../../../src/solver/nest';

function ring(points: readonly [number, number][]): Point[] {
  return points.map(([x, y]) => ({ x, y }));
}

/** A right triangle filling half its box - two of them tile it exactly. */
function triangle(width: number, height: number): Point[] {
  return ring([
    [0, 0],
    [width, 0],
    [0, height],
  ]);
}

function part(overrides: Partial<Part> & Pick<Part, 'id'>): Part {
  return {
    label: overrides.id,
    width: 600,
    height: 400,
    qty: 1,
    materialId: 'ply',
    rotationPolicy: 'free90',
    ...overrides,
  };
}

function stock(overrides: Partial<Stock> = {}): Stock {
  return {
    id: 'sheet',
    materialId: 'ply',
    width: 2440,
    height: 1220,
    qty: 4,
    grainAxis: 'x',
    ...overrides,
  };
}

const CONFIG: SolverConfig = { kerf: 3, edgeTrim: 5, seed: 1, mode: 'nest', effort: 'fast' };

function check(result: Result, parts: readonly Part[], sheets: readonly Stock[], config = CONFIG) {
  return checkResult(result, { parts, stock: sheets, config });
}

describe('nestSolve', () => {
  it('produces a layout that satisfies every invariant in nest mode', () => {
    const parts = [part({ id: 'gusset', qty: 12, outline: triangle(600, 400) })];
    const result = nestSolve(parts, [stock()], CONFIG);

    expect(check(result, parts, [stock()]).violations).toEqual([]);
    expect(result.unplacedParts).toEqual([]);
  });

  it('is deterministic given the same seed, and reacts to a different one', () => {
    const parts = [part({ id: 'gusset', qty: 12, outline: triangle(600, 400) })];
    const once = nestSolve(parts, [stock()], CONFIG);
    const again = nestSolve(parts, [stock()], CONFIG);
    expect(again).toEqual(once);

    // Not asserting the layouts differ - a small problem can be solved the same
    // way from every start - only that the seed is genuinely an input and the
    // other seed's answer is just as valid.
    const other = nestSolve(parts, [stock()], { ...CONFIG, seed: 99 });
    expect(check(other, parts, [stock()]).violations).toEqual([]);
  }, 60_000);

  it('leaves every pair of parts at least a kerf apart, at any kerf', () => {
    // The grid's whole job, measured against the exact Euclidean predicate
    // rather than against itself. `checkResult` covers this too; doing it here
    // over a spread of kerfs is what would catch a `dilationOffsets` change that
    // happens to stay sound at 3mm and not at 3.175mm.
    for (const kerf of [0, 1, 3, 3.175, 12]) {
      const config = { ...CONFIG, kerf };
      const parts = [part({ id: 'gusset', qty: 8, outline: triangle(600, 400) })];
      const result = nestSolve(parts, [stock()], config);

      for (const layout of result.layouts) {
        for (let i = 0; i < layout.placements.length; i += 1) {
          for (let j = i + 1; j < layout.placements.length; j += 1) {
            const a = layout.placements[i];
            const b = layout.placements[j];
            if (a === undefined || b === undefined) continue;
            const gap = polygonSeparation(
              placementPolygon(parts[0] as Part, a),
              placementPolygon(parts[0] as Part, b),
            );
            expect(
              gap,
              `kerf ${kerf}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`,
            ).toBeGreaterThanOrEqual(kerf - 1e-6);
          }
        }
      }
      expect(check(result, parts, [stock()], config).violations).toEqual([]);
    }
  });

  it('beats a table saw on parts that are half their bounding box', () => {
    // Two right triangles tile their own box, so a router should need about half
    // the sheets a saw does. This is the milestone's reason to exist, in the
    // smallest form that shows it.
    const parts = [part({ id: 'gusset', qty: 16, outline: triangle(600, 400) })];
    const nested = nestSolve(parts, [stock()], CONFIG);
    expect(nested.layouts).toHaveLength(1);
    expect(nested.unplacedParts).toEqual([]);
  });

  it('never turns a grain-locked part off its axis, whatever the step count', () => {
    // A locked part may be left square or given a half turn - both keep the
    // grain running the same way - and nothing else, however many rotation steps
    // the search was configured with.
    const parts = [
      part({ id: 'panel', qty: 10, rotationPolicy: 'locked', outline: triangle(600, 400) }),
    ];
    const result = nestSolve(parts, [stock()], { ...CONFIG, rotationSteps: 24 });

    const angles = new Set(result.layouts.flatMap((l) => l.placements.map((p) => p.angleDeg)));
    expect([...angles].every((angle) => angle === 0 || angle === 180)).toBe(true);
    expect(check(result, parts, [stock()], { ...CONFIG, rotationSteps: 24 }).violations).toEqual(
      [],
    );
  });

  it('actually uses the extra rotation steps it is given', () => {
    // A 130 x 10 bar does not fit a 100mm square sheet square-on, at a quarter
    // turn, or at any multiple of 30 degrees - only near 45. With four steps it
    // is a shortfall; with twenty-four it is placed on the diagonal. That is the
    // difference `rotationSteps` exists to make, and it is also the only test
    // here that exercises a placement angle a table saw could never cut.
    const bar = part({
      id: 'bar',
      width: 130,
      height: 10,
      qty: 1,
      outline: ring([
        [0, 0],
        [130, 0],
        [130, 10],
        [0, 10],
      ]),
    });
    const sheets = [stock({ width: 100, height: 100, qty: 1 })];
    const config: SolverConfig = { kerf: 0, edgeTrim: 0, seed: 1, mode: 'nest', effort: 'fast' };

    const coarse = nestSolve([bar], sheets, { ...config, rotationSteps: 4 });
    expect(coarse.unplacedParts).toEqual([{ partId: 'bar', qty: 1 }]);

    const fine = nestSolve([bar], sheets, { ...config, rotationSteps: 24 });
    expect(fine.unplacedParts).toEqual([]);
    const angle = fine.layouts[0]?.placements[0]?.angleDeg;
    expect(angle !== undefined && angle % 90 !== 0).toBe(true);
    expect(check(fine, [bar], sheets, { ...config, rotationSteps: 24 }).violations).toEqual([]);
  });

  it('reports a shortfall rather than overfilling the stock', () => {
    const parts = [part({ id: 'gusset', qty: 40, outline: triangle(600, 400) })];
    const sheets = [stock({ qty: 1 })];
    const result = nestSolve(parts, sheets, CONFIG);

    const placed = result.layouts.reduce((n, l) => n + l.placements.length, 0);
    const unplaced = result.unplacedParts.reduce((n, p) => n + p.qty, 0);
    expect(placed + unplaced).toBe(40);
    expect(unplaced).toBeGreaterThan(0);
    expect(check(result, parts, sheets).violations).toEqual([]);
  });

  it('keeps materials in separate subproblems', () => {
    const parts = [
      part({ id: 'ply-gusset', qty: 4, outline: triangle(600, 400) }),
      part({ id: 'mdf-gusset', qty: 4, materialId: 'mdf', outline: triangle(600, 400) }),
    ];
    const sheets = [stock(), stock({ id: 'mdf-sheet', materialId: 'mdf' })];
    const result = nestSolve(parts, sheets, CONFIG);

    expect(check(result, parts, sheets).violations).toEqual([]);
    for (const layout of result.layouts) {
      const material = layout.stockInstanceId.startsWith('mdf-sheet') ? 'mdf' : 'ply';
      for (const placement of layout.placements) {
        expect(placement.partId.startsWith(material)).toBe(true);
      }
    }
  });

  it('packs a plain rectangle with no outline, same as anything else', () => {
    // `partOutline` supplies the four corners, so nothing in the engine branches
    // on whether a part has a shape. A hand-entered rectangle set to CNC is an
    // ordinary case, not a special one.
    const parts = [part({ id: 'shelf', width: 780, height: 300, qty: 8 })];
    const result = nestSolve(parts, [stock()], CONFIG);
    expect(result.unplacedParts).toEqual([]);
    expect(check(result, parts, [stock()]).violations).toEqual([]);
  });

  it('rejects a bad config with the typed error, before the engine sets anything up', () => {
    // The mask cache and the generator are both built inside the packer factory,
    // which `solveByMaterial` calls only once validation has passed. Seeding
    // first would throw a bare `Error` about the seed over the `SolverInputError`
    // the caller is owed.
    const parts = [part({ id: 'gusset', outline: triangle(600, 400) })];
    expect(() => nestSolve(parts, [stock()], { ...CONFIG, seed: Number.NaN })).toThrow(
      SolverInputError,
    );
  });

  it('exposes the engine through the Solver interface', () => {
    const parts = [part({ id: 'gusset', qty: 4, outline: triangle(600, 400) })];
    expect(NestSolver.solve([...parts], [stock()], CONFIG)).toEqual(
      nestSolve(parts, [stock()], CONFIG),
    );
  });
});
