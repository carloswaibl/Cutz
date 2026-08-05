import { afterAll, describe, expect, it } from 'vitest';
import {
  buildCutPlan,
  buildCutPlans,
  buildCutTree,
  type CutPlan,
  type CutStep,
} from '../../src/domain/cutplan';
import { bottom, EPSILON, placementRect, type Rect, right } from '../../src/domain/geometry';
import type { Layout, Material, Part, Placement, Stock } from '../../src/domain/types';
import { solve } from '../../src/solver';
import { loadFixtures } from '../fixtures/index';

// --- Fixtures -------------------------------------------------------------
//
// Round numbers on a 1000 x 1000 sheet, so the expected cut positions in each
// test can be checked by eye. Real sheet goods are 1220 x 2440 and every rule
// under test here is scale-free.

const rect = (x: number, y: number, width: number, height: number): Rect => ({
  x,
  y,
  width,
  height,
});

const PLY: Material = { id: 'ply', name: 'Plywood', thickness: 18, hasGrain: true };
const MDF: Material = { id: 'mdf', name: 'MDF', thickness: 18, hasGrain: false };

function part(id: string, width: number, height: number, extra: Partial<Part> = {}): Part {
  return {
    id,
    label: id,
    width,
    height,
    qty: 1,
    materialId: 'ply',
    rotationPolicy: 'free90',
    ...extra,
  };
}

function sheet(extra: Partial<Stock> = {}): Stock {
  return {
    id: 's',
    materialId: 'ply',
    width: 1000,
    height: 1000,
    qty: 1,
    grainAxis: 'y',
    ...extra,
  };
}

function at(partId: string, x: number, y: number, rotated = false): Placement {
  return { partId, stockInstanceId: 's#0', x, y, rotated };
}

function layoutOf(placements: Placement[]): Layout {
  // `wastePct` is never read by the cut plan - it derives everything from the
  // placements - so a placeholder here is honest rather than lazy.
  return { stockInstanceId: 's#0', placements, wastePct: 0 };
}

interface PlanOptions {
  kerf?: number;
  edgeTrim?: number;
  material?: Material | null;
  stock?: Stock;
  maxSteps?: number;
}

function planOf(
  parts: readonly Part[],
  placements: Placement[],
  options: PlanOptions = {},
): CutPlan {
  return buildCutPlan({
    stock: options.stock ?? sheet(),
    material: options.material === undefined ? PLY : options.material,
    layout: layoutOf(placements),
    parts,
    config: { kerf: options.kerf ?? 3, edgeTrim: options.edgeTrim ?? 0, seed: 1 },
    ...(options.maxSteps === undefined ? {} : { maxSteps: options.maxSteps }),
  });
}

// --- Replay ---------------------------------------------------------------

/**
 * Perform the plan's cuts and report what is left holding the bench.
 *
 * This is the load-bearing check of the whole module, and it is deliberately a
 * second implementation rather than a call into `cutplan.ts`. A replay that
 * shared the generator's arithmetic would agree with it however wrong both were,
 * which is the exact failure `geometry.ts` and `validate.ts` are both written to
 * avoid. Everything here works from `at`, `kerf` and the piece it consumes.
 *
 * Returns the pieces still on the bench when the last cut is made.
 */
function replay(plan: CutPlan, sheetRect: Rect, kerf: number): Map<string, Rect> {
  const recorded = new Map(plan.pieces.map((piece) => [piece.id, piece.rect]));
  const first = plan.pieces[0];
  expect(first, 'a plan always starts from the whole sheet').toBeDefined();
  if (first === undefined) throw new Error('unreachable');
  expectRectClose(first.rect, sheetRect, 'the first piece is the whole sheet');

  const alive = new Map<string, Rect>([[first.id, sheetRect]]);
  const produced = new Set<string>([first.id]);

  plan.steps.forEach((step, i) => {
    expect(step.index, 'steps are numbered 1..n in the order they are made').toBe(i + 1);

    const piece = alive.get(step.pieceId);
    expect(
      piece,
      `step ${step.index} cuts piece "${step.pieceId}", which is not on the bench`,
    ).toBeDefined();
    if (piece === undefined) throw new Error('unreachable');
    alive.delete(step.pieceId);

    const nearEdge = step.axis === 'x' ? piece.x : piece.y;
    const farEdge = step.axis === 'x' ? right(piece) : bottom(piece);
    expect(step.fence, `step ${step.index} fence is the distance from the near edge`).toBeCloseTo(
      step.at - nearEdge,
      6,
    );
    // The blade has to land on the piece somewhere, or there is nothing to cut.
    expect(
      step.at + kerf,
      `step ${step.index} blade misses piece "${step.pieceId}"`,
    ).toBeGreaterThan(nearEdge - EPSILON);
    expect(step.at, `step ${step.index} blade misses piece "${step.pieceId}"`).toBeLessThan(
      farEdge + EPSILON,
    );

    const halves: [Rect, Rect] =
      step.axis === 'x'
        ? [
            { x: piece.x, y: piece.y, width: step.at - piece.x, height: piece.height },
            {
              x: step.at + kerf,
              y: piece.y,
              width: right(piece) - step.at - kerf,
              height: piece.height,
            },
          ]
        : [
            { x: piece.x, y: piece.y, width: piece.width, height: step.at - piece.y },
            {
              x: piece.x,
              y: step.at + kerf,
              width: piece.width,
              height: bottom(piece) - step.at - kerf,
            },
          ];

    expect(
      step.produces.some((id) => id !== null),
      `step ${step.index} produced nothing at all`,
    ).toBe(true);

    const sides = [
      { side: 'near', id: step.produces[0], half: halves[0] },
      { side: 'far', id: step.produces[1], half: halves[1] },
    ] as const;

    for (const { side, id, half } of sides) {
      const extent = step.axis === 'x' ? half.width : half.height;

      if (id === null) {
        // The only reason to name no piece is that the blade ran off the edge
        // and the whole of that side fitted inside the kerf.
        expect(
          extent,
          `step ${step.index} dropped a ${side} piece that had real material in it`,
        ).toBeLessThanOrEqual(EPSILON);
        continue;
      }

      expect(produced.has(id), `piece "${id}" is produced twice`).toBe(false);
      produced.add(id);
      expect(
        extent,
        `step ${step.index} named a ${side} piece with no material in it`,
      ).toBeGreaterThan(EPSILON);

      const claimed = recorded.get(id);
      expect(
        claimed,
        `step ${step.index} produces piece "${id}", which the plan never lists`,
      ).toBeDefined();
      if (claimed === undefined) throw new Error('unreachable');
      expectRectClose(half, claimed, `step ${step.index} ${side} piece "${id}"`);
      alive.set(id, half);
    }
  });

  expect(produced.size, 'every piece the plan lists is produced by exactly one cut').toBe(
    plan.pieces.length,
  );
  return alive;
}

function expectRectClose(actual: Rect, expected: Rect, what: string): void {
  for (const field of ['x', 'y', 'width', 'height'] as const) {
    expect(actual[field], `${what}: ${field}`).toBeCloseTo(expected[field], 6);
  }
}

/** The finished parts a plan claims to produce, with the placement each satisfies. */
function finishedPieces(plan: CutPlan): { id: string; placement: Placement; rect: Rect }[] {
  return plan.pieces.flatMap((piece) =>
    piece.placement === null
      ? []
      : [{ id: piece.id, placement: piece.placement, rect: piece.rect }],
  );
}

/**
 * The indices of every cut made to `rootId` or to anything cut from it.
 *
 * Walking forwards works because a piece is always produced before it is
 * consumed, which `replay` asserts separately.
 */
function stepsUnder(plan: CutPlan, rootId: string): number[] {
  const family = new Set([rootId]);
  const indices: number[] = [];
  for (const step of plan.steps) {
    if (!family.has(step.pieceId)) continue;
    indices.push(step.index);
    for (const id of step.produces) if (id !== null) family.add(id);
  }
  return indices;
}

// --- Every fixture, replayed ---------------------------------------------

interface TimingRow {
  Fixture: string;
  Sheets: number;
  'Solve (ms)': string;
  'Plan (ms)': string;
  Steps: number;
}

describe('buildCutPlan - replayed against every fixture', () => {
  const timings: TimingRow[] = [];

  describe.each(loadFixtures().map((fixture) => [fixture.name, fixture] as const))(
    '%s',
    (_name, fixture) => {
      it('cuts back to exactly the placements the solver produced', () => {
        const solveStart = performance.now();
        const result = solve(fixture.parts, fixture.stock, fixture.config);
        const solveMs = performance.now() - solveStart;

        const planStart = performance.now();
        const plans = buildCutPlans(result, {
          parts: fixture.parts,
          stock: fixture.stock,
          materials: fixture.materials,
          config: fixture.config,
        });
        const planMs = performance.now() - planStart;

        expect(plans).toHaveLength(result.layouts.length);
        timings.push({
          Fixture: fixture.name,
          Sheets: plans.length,
          'Solve (ms)': solveMs.toFixed(2),
          'Plan (ms)': planMs.toFixed(2),
          Steps: plans.reduce((sum, plan) => sum + plan.steps.length, 0),
        });

        const partsById = new Map(fixture.parts.map((p) => [p.id, p]));

        plans.forEach((plan, index) => {
          const layout = result.layouts[index];
          if (layout === undefined) throw new Error('bad fixture');
          const stock = fixture.stock.find(
            (entry) => entry.id === layout.stockInstanceId.split('#')[0],
          );
          if (stock === undefined) throw new Error('bad fixture');

          // Every solver output is guillotine-decomposable - `checkResult`
          // asserts that separately - so a plan that is not complete here means
          // the plan generator and the checker have drifted apart.
          expect(plan.status, `${fixture.name} ${plan.stockInstanceId}`).toBe('complete');
          expect(plan.stockInstanceId).toBe(layout.stockInstanceId);

          const sheetRect = rect(0, 0, stock.width, stock.height);
          const bench = replay(plan, sheetRect, fixture.config.kerf);

          // The pieces the plan calls finished parts are still on the bench when
          // the cutting stops: nothing gets cut up after it is done.
          const finished = finishedPieces(plan);
          for (const entry of finished) {
            expect(bench.has(entry.id), `finished piece "${entry.id}" was cut up again`).toBe(true);
          }

          // One finished piece per placement, at the size and position the
          // solver asked for. This is the whole point of the module.
          expect(finished).toHaveLength(layout.placements.length);
          const unmatched = new Set(layout.placements);
          for (const entry of finished) {
            expect(unmatched.has(entry.placement)).toBe(true);
            unmatched.delete(entry.placement);
            const partForPlacement = partsById.get(entry.placement.partId);
            if (partForPlacement === undefined) throw new Error('bad fixture');
            expectRectClose(
              entry.rect,
              placementRect(partForPlacement, entry.placement),
              `${plan.stockInstanceId} part "${entry.placement.partId}"`,
            );
          }
          expect(unmatched.size, 'every placement is accounted for').toBe(0);
        });
      });
    },
  );

  afterAll(() => {
    if (timings.length === 0) return;
    // Reported, not asserted. This is the measurement M3 PR 4 reads to decide
    // whether the UI builds plans eagerly; a timing threshold in CI would only
    // be a flake waiting for a slow runner.
    console.log('\n--- Cut plan build cost ---');
    console.table(timings);
  });
});

// --- Trim cuts ------------------------------------------------------------

describe('buildCutPlan - edge trim', () => {
  const parts = [part('a', 400, 400)];

  it('emits no trim cuts when there is nothing to trim', () => {
    const plan = planOf(parts, [at('a', 0, 0)], { edgeTrim: 0 });
    expect(plan.steps.filter((step) => step.role === 'trim')).toHaveLength(0);
  });

  it('takes the sheet down to the usable area with four cuts', () => {
    const plan = planOf(parts, [at('a', 10, 10)], { edgeTrim: 10 });
    const trims = plan.steps.filter((step) => step.role === 'trim');
    expect(trims).toHaveLength(4);
    // Every trim is a top-level operation on the whole sheet.
    expect(trims.map((step) => step.depth)).toEqual([0, 0, 0, 0]);

    // Grain runs along y, so the vertical (axis x) cuts are the rips, and rips
    // come first: you break a sheet into strips before crosscutting.
    expect(trims.map((step) => step.axis)).toEqual(['x', 'x', 'y', 'y']);
    expect(trims.map((step) => step.grain)).toEqual(['rip', 'rip', 'crosscut', 'crosscut']);

    const keeperId = trims[3]?.produces[0];
    const keeper = plan.pieces.find((piece) => piece.id === keeperId);
    expect(keeper).toBeDefined();
    expectRectClose(keeper?.rect ?? rect(0, 0, 0, 0), rect(10, 10, 980, 980), 'usable area');
  });

  it('replays back to the placement', () => {
    const plan = planOf(parts, [at('a', 10, 10)], { edgeTrim: 10 });
    replay(plan, rect(0, 0, 1000, 1000), 3);
    expect(finishedPieces(plan)).toHaveLength(1);
  });
});

// --- Finishing cuts -------------------------------------------------------

describe('buildCutPlan - finishing cuts', () => {
  it('emits none when the part fills its region', () => {
    // One part, exactly the sheet. There is nothing left to cut off it.
    const plan = planOf([part('a', 1000, 1000)], [at('a', 0, 0)]);
    expect(plan.steps).toEqual([]);
    expect(finishedPieces(plan)).toHaveLength(1);
  });

  it('emits one cut per edge that does not already coincide', () => {
    // Flush at the sheet's top-left, short of it on the right and the bottom:
    // exactly the shape the packer produces, and exactly two cuts.
    const plan = planOf([part('a', 400, 600)], [at('a', 0, 0)]);
    const finishes = plan.steps.filter((step) => step.role === 'finish');
    expect(finishes).toHaveLength(2);
    expect(finishes.map((step) => step.axis)).toEqual(['x', 'y']);
    expect(finishes.map((step) => step.at)).toEqual([400, 600]);
    // The keeper comes off the near side, so the fence is set to the part.
    expect(finishes.map((step) => step.fence)).toEqual([400, 600]);
  });

  it('emits four when the part floats clear of every region edge', () => {
    const plan = planOf([part('a', 400, 400)], [at('a', 100, 200)]);
    const finishes = plan.steps.filter((step) => step.role === 'finish');
    expect(finishes).toHaveLength(4);
    replay(plan, rect(0, 0, 1000, 1000), 3);
    const finished = finishedPieces(plan);
    expect(finished).toHaveLength(1);
    expectRectClose(finished[0]?.rect ?? rect(0, 0, 0, 0), rect(100, 200, 400, 400), 'the part');
  });

  it('names no offcut when the waste is thinner than the blade', () => {
    // 2mm of waste and a 3mm blade. The cut is still real and still has to be
    // made - the blade simply runs off the edge of the piece and no offcut
    // survives it. Claiming a 2mm offcut here would put a piece on the bench
    // that does not exist.
    const plan = planOf([part('a', 998, 1000)], [at('a', 0, 0)]);
    const finishes = plan.steps.filter((step) => step.role === 'finish');
    expect(finishes).toHaveLength(1);
    expect(finishes[0]?.produces[1]).toBeNull();
    replay(plan, rect(0, 0, 1000, 1000), 3);
  });

  it('reports a negative fence when the blade overhangs the near edge', () => {
    // Same 2mm-of-waste case, but on the near side. There is no fence setting
    // for this cut, and the honest number says so rather than reading as a
    // plausible 1mm.
    const plan = planOf([part('a', 998, 1000)], [at('a', 2, 0)]);
    const finish = plan.steps.find((step) => step.role === 'finish');
    expect(finish?.at).toBe(-1);
    expect(finish?.fence).toBe(-1);
    expect(finish?.produces[0]).toBeNull();
    replay(plan, rect(0, 0, 1000, 1000), 3);
  });
});

// --- Split cuts and ordering ---------------------------------------------

describe('buildCutPlan - cut order', () => {
  // Both parts sit short of the region the split leaves them, so both halves
  // have finishing cuts of their own and the two families can interleave if the
  // walk gets it wrong.
  const parts = [part('l', 380, 980), part('r', 577, 960)];
  const placements = [at('l', 0, 0), at('r', 403, 0)];

  it('cuts the piece, then finishes the near half before touching the far half', () => {
    const plan = planOf(parts, placements);
    const split = plan.steps[0];
    expect(split?.role).toBe('split');
    expect(split?.axis).toBe('x');
    expect(split?.at).toBe(380);
    expect(split?.depth).toBe(0);

    const [nearId, farId] = split?.produces ?? [null, null];
    if (nearId === null || farId === null) throw new Error('a split always has two sides');

    // Depth-first: everything done to the near piece and its descendants happens
    // before the far piece is picked up at all. Breadth-first would have the
    // operator juggling every offcut in the shop at once.
    const nearSteps = stepsUnder(plan, nearId);
    const farSteps = stepsUnder(plan, farId);
    expect(nearSteps.length).toBeGreaterThan(0);
    expect(farSteps.length).toBeGreaterThan(0);
    expect(Math.max(...nearSteps)).toBeLessThan(Math.min(...farSteps));

    // Cuts to a piece the split produced are one level in from the split itself.
    for (const step of plan.steps.slice(1)) expect(step.depth).toBe(1);
  });

  it('prefers the rip axis at every level', () => {
    // Grain along x makes the horizontal (axis y) cuts the rips, so the same
    // two-column layout is now reached by ripping first where it can be.
    const alongX = planOf(
      [part('t', 1000, 400), part('b', 1000, 597)],
      [at('t', 0, 0), at('b', 0, 403)],
      { stock: sheet({ grainAxis: 'x' }) },
    );
    expect(alongX.steps[0]?.axis).toBe('y');
    expect(alongX.steps[0]?.grain).toBe('rip');
  });
});

// --- Grain labelling ------------------------------------------------------

describe('buildCutPlan - grain labelling', () => {
  const parts = [part('a', 400, 400)];
  const placements = [at('a', 0, 0)];

  it('calls a vertical cut a rip when the grain runs down the sheet', () => {
    // A cut on axis x is a vertical blade line, so it runs *along* a grain that
    // also runs vertically. Getting this backwards would tell a woodworker to
    // crosscut where they should rip.
    const plan = planOf(parts, placements, { stock: sheet({ grainAxis: 'y' }) });
    const byAxis = new Map(plan.steps.map((step) => [step.axis, step.grain]));
    expect(byAxis.get('x')).toBe('rip');
    expect(byAxis.get('y')).toBe('crosscut');
  });

  it('calls a vertical cut a crosscut when the grain runs across the sheet', () => {
    const plan = planOf(parts, placements, { stock: sheet({ grainAxis: 'x' }) });
    const byAxis = new Map(plan.steps.map((step) => [step.axis, step.grain]));
    expect(byAxis.get('x')).toBe('crosscut');
    expect(byAxis.get('y')).toBe('rip');
  });

  it('labels nothing on a material with no grain', () => {
    // MDF and melamine have no visible fibre, so "rip" and "crosscut" are
    // meaningless and printing either would be inventing information.
    const plan = planOf(parts, placements, { material: MDF });
    expect(plan.steps.length).toBeGreaterThan(0);
    expect(plan.steps.every((step) => step.grain === null)).toBe(true);
  });

  it('labels nothing when the material is unknown', () => {
    const plan = planOf(parts, placements, { material: null });
    expect(plan.steps.every((step) => step.grain === null)).toBe(true);
  });
});

// --- Layouts with no plan -------------------------------------------------

describe('buildCutPlan - layouts it cannot plan', () => {
  const pinwheelParts = [
    part('nw', 60, 40),
    part('ne', 40, 60),
    part('sw', 40, 60),
    part('se', 60, 40),
  ];
  const pinwheel = [at('nw', 0, 0), at('ne', 63, 0), at('sw', 0, 43), at('se', 43, 63)];
  const pinwheelSheet = sheet({ width: 106, height: 106 });

  it('reports a pinwheel as invalid, with no steps to follow', () => {
    const plan = planOf(pinwheelParts, pinwheel, { stock: pinwheelSheet });
    expect(plan.status).toBe('invalid');
    expect(plan.steps).toEqual([]);
    // Half a cut plan is worse than none: the operator finds out where it stops
    // by running out of sheet.
    expect(plan.pieces).toHaveLength(1);
  });

  it('reports unverified, never complete, when the search runs out of budget', () => {
    const parts = [part('a', 400, 400), part('b', 400, 400), part('c', 400, 400)];
    const placements = [at('a', 0, 0), at('b', 403, 0), at('c', 0, 403)];
    expect(planOf(parts, placements, { maxSteps: 0 }).status).toBe('unverified');
    expect(planOf(parts, placements).status).toBe('complete');
  });

  it('keeps unverified distinct from invalid on the same layout', () => {
    // The one thing this module must never do is let "I gave up" and "this
    // cannot be cut" print the same way.
    expect(planOf(pinwheelParts, pinwheel, { stock: pinwheelSheet, maxSteps: 0 }).status).toBe(
      'unverified',
    );
  });
});

// --- Determinism ----------------------------------------------------------

describe('buildCutPlan - determinism', () => {
  it('produces the identical plan on repeated runs', () => {
    const parts = [
      part('a', 400, 500),
      part('b', 400, 494),
      part('c', 597, 300),
      part('d', 300, 400),
    ];
    const placements = [at('a', 0, 0), at('b', 0, 503), at('c', 403, 0), at('d', 403, 303)];
    const first = planOf(parts, placements);
    expect(planOf(parts, placements)).toEqual(first);
  });

  it('does not depend on the order the placements arrive in', () => {
    // Candidate cuts are sorted rather than taken in placement order, so
    // reshuffling the parts list cannot reshuffle the cut list the user is
    // holding at the saw.
    const parts = [part('l', 400, 1000), part('r', 597, 1000)];
    const forwards = planOf(parts, [at('l', 0, 0), at('r', 403, 0)]);
    const backwards = planOf(parts, [at('r', 403, 0), at('l', 0, 0)]);
    const shape = (plan: CutPlan): Pick<CutStep, 'axis' | 'at' | 'role'>[] =>
      plan.steps.map(({ axis, at: cutAt, role }) => ({ axis, at: cutAt, role }));
    expect(shape(backwards)).toEqual(shape(forwards));
  });
});

// --- Errors ---------------------------------------------------------------

describe('buildCutPlan - broken results', () => {
  it('throws when a layout places a part the project does not have', () => {
    expect(() => planOf([part('a', 400, 400)], [at('ghost', 0, 0)])).toThrow(/ghost/);
  });

  it('throws when a layout names a stock entry the project does not have', () => {
    expect(() =>
      buildCutPlans(
        { layouts: [layoutOf([])], unplacedParts: [], totalWastePct: 0 },
        { parts: [], stock: [], materials: [], config: { kerf: 3, edgeTrim: 0, seed: 1 } },
      ),
    ).toThrow(/s#0/);
  });
});

// --- The tree the checker shares ------------------------------------------

describe('buildCutTree', () => {
  it('returns a tree whose regions tile the sheet', () => {
    const region = rect(0, 0, 1000, 1000);
    const rects = [rect(0, 0, 400, 1000), rect(403, 0, 597, 1000)];
    const outcome = buildCutTree(region, rects, 3);
    expect(outcome.status).toBe('valid');
    if (outcome.status !== 'valid') throw new Error('unreachable');
    expect(outcome.tree.kind).toBe('split');
    if (outcome.tree.kind !== 'split') throw new Error('unreachable');
    expect(outcome.tree.at).toBe(400);
    expectRectClose(outcome.tree.near.region, rect(0, 0, 400, 1000), 'near region');
    expectRectClose(outcome.tree.far.region, rect(403, 0, 597, 1000), 'far region');
  });

  it('carries no tree when it proves nothing', () => {
    const pinwheel = [
      rect(0, 0, 60, 40),
      rect(63, 0, 40, 60),
      rect(0, 43, 40, 60),
      rect(43, 63, 60, 40),
    ];
    expect(buildCutTree(rect(0, 0, 106, 106), pinwheel, 3)).toEqual({ status: 'invalid' });
  });

  it('finds a decomposition on either preferred axis', () => {
    // The preference picks between valid answers. It must never decide whether
    // there is one.
    const region = rect(0, 0, 1000, 1000);
    const rects = [rect(0, 0, 400, 400), rect(403, 0, 400, 400), rect(0, 403, 400, 400)];
    for (const preferAxis of ['x', 'y'] as const) {
      expect(buildCutTree(region, rects, 3, { preferAxis }).status).toBe('valid');
    }
  });
});
