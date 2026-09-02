import { describe, expect, it } from 'vitest';
import { parseStockInstanceId } from '../../src/domain/instances';
import type {
  Part,
  Placement,
  Result,
  RotationPolicy,
  SolverConfig,
  Stock,
  UnplacedPart,
} from '../../src/domain/types';
import {
  checkResult,
  hasErrors,
  type InputIssue,
  type ResultViolation,
  validateInputs,
} from '../../src/domain/validate';

// --- Fixtures -------------------------------------------------------------
//
// Deliberately round numbers on a 1000 x 1000 sheet. Real sheet goods are
// 1220 x 2440, but the arithmetic here has to be checkable by eye, and every
// invariant under test is scale-free.

const CONFIG: SolverConfig = { kerf: 3, edgeTrim: 0, seed: 1 };

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
    qty: 2,
    grainAxis: 'y',
    ...extra,
  };
}

function at(partId: string, x: number, y: number, rotated = false): Placement {
  return { partId, stockInstanceId: 's#0', x, y, angleDeg: rotated ? 90 : 0 };
}

/** A placement at an arbitrary angle, for the orientations only a router reaches. */
function angled(partId: string, x: number, y: number, angleDeg: number): Placement {
  return { partId, stockInstanceId: 's#0', x, y, angleDeg };
}

/**
 * Nest mode. `checkResult` reads `mode` straight off the config it is given, so
 * these tests reach nest-mode behaviour without needing a nesting engine to
 * exist - which is the point: the checker lands before the solver it checks.
 */
const NEST_CONFIG: SolverConfig = { ...CONFIG, mode: 'nest' };

/**
 * Assemble a `Result` with correct waste numbers.
 *
 * Every test other than the waste tests is about some other invariant, and
 * hand-writing a waste percentage in each one would mean every test failing for
 * the same irrelevant reason. The waste tests below use hand-computed literals
 * instead, so the checker's arithmetic is never validated against a copy of
 * itself.
 */
/**
 * The area a part consumes, hand-written rather than imported.
 *
 * A saw cuts the bounding box; a router follows the outline. Spelling both out
 * here keeps the note above true - the checker's arithmetic is never validated
 * against a copy of itself.
 */
function areaOf(part: Part, mode: 'guillotine' | 'nest'): number {
  if (mode === 'guillotine' || part.outline === undefined) return part.width * part.height;
  let twice = 0;
  const ring = part.outline;
  for (let i = 0; i < ring.length; i += 1) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    if (!a || !b) continue;
    twice += a.x * b.y - b.x * a.y;
  }
  return Math.abs(twice) / 2;
}

function resultOf(
  parts: readonly Part[],
  stock: readonly Stock[],
  layouts: readonly { stockInstanceId: string; placements: Placement[] }[],
  unplacedParts: UnplacedPart[] = [],
  mode: 'guillotine' | 'nest' = 'guillotine',
): Result {
  const partsById = new Map(parts.map((p) => [p.id, p]));
  const stockById = new Map(stock.map((s) => [s.id, s]));
  let placedTotal = 0;
  let sheetTotal = 0;

  const built = layouts.map((layout) => {
    const ref = parseStockInstanceId(layout.stockInstanceId);
    const stockEntry = ref === null ? undefined : stockById.get(ref.stockId);
    const sheetArea = stockEntry === undefined ? 0 : stockEntry.width * stockEntry.height;

    let placed = 0;
    for (const placement of layout.placements) {
      const p = partsById.get(placement.partId);
      if (p === undefined) continue;
      placed += areaOf(p, mode);
    }

    placedTotal += placed;
    sheetTotal += sheetArea;
    return {
      stockInstanceId: layout.stockInstanceId,
      placements: layout.placements,
      wastePct: sheetArea > 0 ? 1 - placed / sheetArea : 1,
    };
  });

  return {
    layouts: built,
    unplacedParts,
    totalWastePct: sheetTotal > 0 ? 1 - placedTotal / sheetTotal : 1,
  };
}

const kinds = (issues: readonly { kind: string }[]): string[] => issues.map((i) => i.kind);

function issueOf<K extends InputIssue['kind']>(
  issues: readonly InputIssue[],
  kind: K,
): Extract<InputIssue, { kind: K }> {
  const found = issues.find((issue) => issue.kind === kind);
  if (found === undefined) throw new Error(`expected a "${kind}" issue, got ${kinds(issues)}`);
  return found as Extract<InputIssue, { kind: K }>;
}

function violationOf<K extends ResultViolation['kind']>(
  violations: readonly ResultViolation[],
  kind: K,
): Extract<ResultViolation, { kind: K }> {
  const found = violations.find((violation) => violation.kind === kind);
  if (found === undefined) {
    throw new Error(`expected a "${kind}" violation, got ${kinds(violations)}`);
  }
  return found as Extract<ResultViolation, { kind: K }>;
}

// --- validateInputs -------------------------------------------------------

describe('validateInputs - a project that makes sense', () => {
  it('reports nothing', () => {
    const parts = [part('side', 300, 1800, { qty: 2 }), part('shelf', 280, 900, { qty: 5 })];
    expect(validateInputs(parts, [sheet({ width: 1220, height: 2440 })], CONFIG)).toEqual([]);
  });

  it('accepts a part that exactly fills the usable area', () => {
    const config = { ...CONFIG, edgeTrim: 10 };
    expect(validateInputs([part('panel', 980, 980)], [sheet()], config)).toEqual([]);
  });

  it('accepts a kerf of zero', () => {
    // A user who wants blade width ignored is expressing a real preference.
    expect(validateInputs([part('p', 100, 100)], [sheet()], { ...CONFIG, kerf: 0 })).toEqual([]);
  });
});

describe('validateInputs - config', () => {
  it('rejects a negative kerf', () => {
    const issues = validateInputs([part('p', 100, 100)], [sheet()], { ...CONFIG, kerf: -1 });
    expect(issueOf(issues, 'invalid-kerf').severity).toBe('error');
    expect(hasErrors(issues)).toBe(true);
  });

  it('rejects a negative edge trim', () => {
    const issues = validateInputs([part('p', 100, 100)], [sheet()], { ...CONFIG, edgeTrim: -5 });
    expect(issueOf(issues, 'invalid-edge-trim').edgeTrim).toBe(-5);
  });

  it('rejects a seed that is not a whole number', () => {
    // The seed exists so a saved project lays out the same way twice.
    for (const seed of [0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const issues = validateInputs([part('p', 100, 100)], [sheet()], { ...CONFIG, seed });
      expect(kinds(issues)).toContain('invalid-seed');
    }
  });

  it('accepts a seed of zero', () => {
    expect(validateInputs([part('p', 100, 100)], [sheet()], { ...CONFIG, seed: 0 })).toEqual([]);
  });
});

describe('validateInputs - parts', () => {
  it('rejects a non-positive or non-finite dimension', () => {
    for (const width of [0, -100, Number.NaN, Number.POSITIVE_INFINITY]) {
      const issues = validateInputs([part('p', width, 100)], [sheet()], CONFIG);
      const issue = issueOf(issues, 'invalid-part-dimension');
      expect(issue.field).toBe('width');
      expect(issue.severity).toBe('error');
    }
  });

  it('rejects a quantity that is not a whole number of at least one', () => {
    for (const qty of [0, -2, 1.5, Number.NaN]) {
      const issues = validateInputs([part('p', 100, 100, { qty })], [sheet()], CONFIG);
      expect(issueOf(issues, 'invalid-part-qty').qty).toBe(qty);
    }
  });

  it('rejects duplicate part ids', () => {
    const parts = [part('p', 100, 100), part('p', 200, 200)];
    const issues = validateInputs(parts, [sheet()], CONFIG);
    expect(issueOf(issues, 'duplicate-part-id').partId).toBe('p');
  });

  it('does not pile derived complaints on top of a structurally broken part', () => {
    // A part with no width is not also "too large for any sheet". One mistake
    // should read as one mistake.
    const issues = validateInputs([part('p', 0, 100)], [sheet()], CONFIG);
    expect(kinds(issues)).toEqual(['invalid-part-dimension']);
  });
});

describe('validateInputs - stock', () => {
  it('rejects a non-positive dimension', () => {
    const issues = validateInputs([part('p', 100, 100)], [sheet({ height: 0 })], CONFIG);
    expect(issueOf(issues, 'invalid-stock-dimension').field).toBe('height');
  });

  it('rejects a quantity that is not a whole number of at least one', () => {
    const issues = validateInputs([part('p', 100, 100)], [sheet({ qty: 0 })], CONFIG);
    expect(issueOf(issues, 'invalid-stock-qty').qty).toBe(0);
  });

  it('rejects duplicate stock ids', () => {
    const issues = validateInputs([part('p', 100, 100)], [sheet(), sheet()], CONFIG);
    expect(issueOf(issues, 'duplicate-stock-id').stockId).toBe('s');
  });

  it('rejects an edge trim that consumes the whole sheet', () => {
    // The overwhelmingly likely cause is a trim entered in the wrong unit -
    // half an inch typed as 12 when the project is in millimetres is fine,
    // but 12 inches typed as 12 when it meant 305 is not.
    const config = { ...CONFIG, edgeTrim: 600 };
    const issues = validateInputs([part('p', 100, 100)], [sheet()], config);
    const issue = issueOf(issues, 'edge-trim-leaves-no-usable-area');
    expect(issue.severity).toBe('error');
    expect(issue.message).toContain('wrong unit');
  });
});

describe('validateInputs - a part that cannot be placed', () => {
  it('warns when no stock of the part material was listed', () => {
    const parts = [part('door', 400, 400, { materialId: 'oak' })];
    const issues = validateInputs(parts, [sheet()], CONFIG);
    const issue = issueOf(issues, 'no-stock-for-material');
    expect(issue.materialId).toBe('oak');
    // The solver can still run; the part shows up in unplacedParts.
    expect(issue.severity).toBe('warning');
    expect(hasErrors(issues)).toBe(false);
  });

  it('warns when the part is larger than any sheet', () => {
    const issues = validateInputs([part('slab', 1200, 1200)], [sheet()], CONFIG);
    expect(kinds(issues)).toEqual(['part-too-large']);
  });

  it('warns when the part only fits within the untrimmed sheet', () => {
    // Fits the sheet, does not fit what is left after the factory edges come
    // off. Silently packing it would produce a layout that does not cut.
    const config = { ...CONFIG, edgeTrim: 10 };
    const issues = validateInputs([part('panel', 990, 500)], [sheet()], config);
    expect(kinds(issues)).toEqual(['part-too-large']);
  });

  it('blames grain lock, not size, when the part would fit turned', () => {
    // The single most likely user error, and "this part is too large" would
    // send them off to re-measure a part that is exactly the right size.
    const locked: RotationPolicy = 'locked';
    const parts = [part('face', 1200, 400, { rotationPolicy: locked })];
    const issues = validateInputs(parts, [sheet({ width: 500, height: 1300 })], CONFIG);
    expect(kinds(issues)).toEqual(['part-blocked-by-grain-lock']);
    expect(issueOf(issues, 'part-blocked-by-grain-lock').message).toContain('grain');
  });

  it('accepts the same part once rotation is allowed', () => {
    const parts = [part('face', 1200, 400, { rotationPolicy: 'free90' })];
    expect(validateInputs(parts, [sheet({ width: 500, height: 1300 })], CONFIG)).toEqual([]);
  });

  it('does not blame grain lock when the part does not fit either way round', () => {
    const parts = [part('slab', 1200, 1200, { rotationPolicy: 'locked' })];
    const issues = validateInputs(parts, [sheet()], CONFIG);
    expect(kinds(issues)).toEqual(['part-too-large']);
  });

  it('accepts a part that fits only one of several sheet sizes', () => {
    const parts = [part('long', 400, 1300, { rotationPolicy: 'locked' })];
    const stock = [sheet({ id: 'half', height: 500 }), sheet({ id: 'full', height: 1400 })];
    expect(validateInputs(parts, stock, CONFIG)).toEqual([]);
  });
});

// --- checkResult ----------------------------------------------------------

/**
 * Three 400 x 400 parts on a 1000 x 1000 sheet with a 3mm kerf, in an L.
 *
 * Cuttable: rip at x = 400 frees the right column, then a crosscut at y = 400
 * splits the left one. Every test below starts from this and breaks exactly one
 * thing, so a failure names the invariant it came from.
 */
function goodProject(): { parts: Part[]; stock: Stock[]; result: Result } {
  const parts = [part('a', 400, 400), part('b', 400, 400), part('c', 400, 400)];
  const stock = [sheet()];
  const result = resultOf(parts, stock, [
    { stockInstanceId: 's#0', placements: [at('a', 0, 0), at('b', 403, 0), at('c', 0, 403)] },
  ]);
  return { parts, stock, result };
}

const check = (project: { parts: Part[]; stock: Stock[]; result: Result }, config = CONFIG) =>
  checkResult(project.result, { parts: project.parts, stock: project.stock, config });

describe('checkResult - a layout that is actually cuttable', () => {
  it('passes every invariant', () => {
    const outcome = check(goodProject());
    expect(outcome.violations).toEqual([]);
    expect(outcome.unverifiedSheets).toEqual([]);
    expect(outcome.status).toBe('valid');
  });

  it('accepts an empty result', () => {
    const outcome = checkResult(
      { layouts: [], unplacedParts: [], totalWastePct: 0 },
      { parts: [], stock: [sheet()], config: CONFIG },
    );
    expect(outcome.status).toBe('valid');
  });

  it('accepts a part rotated when its grain allows it', () => {
    const parts = [part('wide', 200, 500, { rotationPolicy: 'free90' })];
    const stock = [sheet()];
    // Rotated, so the footprint is 500 x 200 and it clears the 600-wide sheet.
    const result = resultOf(parts, stock, [
      { stockInstanceId: 's#0', placements: [at('wide', 0, 0, true)] },
    ]);
    expect(checkResult(result, { parts, stock, config: CONFIG }).status).toBe('valid');
  });
});

describe('checkResult - invariant 1, kerf separation', () => {
  it('catches parts that overlap', () => {
    const project = goodProject();
    const layout = project.result.layouts[0];
    if (layout === undefined) throw new Error('bad fixture');
    layout.placements = [at('a', 0, 0), at('b', 200, 0), at('c', 0, 403)];

    const violation = violationOf(check(project).violations, 'kerf-separation');
    expect(violation.clearance).toBeLessThan(0);
    expect(violation.message).toContain('overlap');
  });

  it('catches parts closer together than the blade is wide', () => {
    // The failure that a naive overlap check waves through: 2mm of air is not
    // enough room for a 3mm blade, so one of these parts comes out undersized.
    const project = goodProject();
    const layout = project.result.layouts[0];
    if (layout === undefined) throw new Error('bad fixture');
    layout.placements = [at('a', 0, 0), at('b', 402, 0), at('c', 0, 403)];

    const violation = violationOf(check(project).violations, 'kerf-separation');
    expect(violation.clearance).toBeCloseTo(2, 9);
    expect(violation.required).toBe(3);
  });

  it('accepts a gap of exactly the kerf', () => {
    expect(check(goodProject()).violations).toEqual([]);
  });

  it('needs clearance on one axis only', () => {
    // Parts in different columns need no vertical gap between them. Demanding
    // clearance on both axes would reject most correct layouts.
    const parts = [part('a', 400, 400), part('b', 400, 400)];
    const stock = [sheet()];
    const result = resultOf(parts, stock, [
      { stockInstanceId: 's#0', placements: [at('a', 0, 0), at('b', 403, 0)] },
    ]);
    expect(checkResult(result, { parts, stock, config: CONFIG }).status).toBe('valid');
  });

  it('lets touching parts through when the kerf is zero', () => {
    const parts = [part('a', 400, 400), part('b', 400, 400)];
    const stock = [sheet()];
    const result = resultOf(parts, stock, [
      { stockInstanceId: 's#0', placements: [at('a', 0, 0), at('b', 400, 0)] },
    ]);
    const config = { ...CONFIG, kerf: 0 };
    expect(checkResult(result, { parts, stock, config }).status).toBe('valid');
  });
});

describe('checkResult - invariant 2, the usable area', () => {
  it('catches a part outside the trimmed edge', () => {
    const project = goodProject();
    const config = { ...CONFIG, edgeTrim: 10 };
    const violation = violationOf(check(project, config).violations, 'outside-usable-area');
    expect(violation.partId).toBe('a');
    expect(violation.usable).toEqual({ x: 10, y: 10, width: 980, height: 980 });
  });

  it('catches a part running off the far edge', () => {
    const parts = [part('a', 400, 400)];
    const stock = [sheet()];
    const result = resultOf(parts, stock, [
      { stockInstanceId: 's#0', placements: [at('a', 700, 0)] },
    ]);
    const outcome = checkResult(result, { parts, stock, config: CONFIG });
    expect(violationOf(outcome.violations, 'outside-usable-area').partId).toBe('a');
  });

  it('accepts a part flush against the trimmed edge', () => {
    const parts = [part('a', 980, 980)];
    const stock = [sheet()];
    const config = { ...CONFIG, edgeTrim: 10 };
    const result = resultOf(parts, stock, [
      { stockInstanceId: 's#0', placements: [at('a', 10, 10)] },
    ]);
    expect(checkResult(result, { parts, stock, config }).status).toBe('valid');
  });
});

describe('checkResult - invariant 3, rotation legality', () => {
  it('catches a rotated grain-locked part', () => {
    // Not a preference the solver may trade away for a tighter packing: the
    // grain would run visibly the wrong way across a finished panel.
    const parts = [part('face', 400, 400, { rotationPolicy: 'locked' })];
    const stock = [sheet()];
    const result = resultOf(parts, stock, [
      { stockInstanceId: 's#0', placements: [at('face', 0, 0, true)] },
    ]);
    const outcome = checkResult(result, { parts, stock, config: CONFIG });
    expect(violationOf(outcome.violations, 'illegal-rotation').partId).toBe('face');
    expect(outcome.status).toBe('invalid');
  });

  it('accepts a grain-locked part that was left alone', () => {
    const parts = [part('face', 400, 400, { rotationPolicy: 'locked' })];
    const stock = [sheet()];
    const result = resultOf(parts, stock, [
      { stockInstanceId: 's#0', placements: [at('face', 0, 0)] },
    ]);
    expect(checkResult(result, { parts, stock, config: CONFIG }).status).toBe('valid');
  });

  it('accepts a grain-locked part given a half turn', () => {
    // 180° leaves the grain running along the same axis, so it is physically
    // legal where a quarter turn is not - and on an asymmetric outline it is a
    // real packing win that `rotated: boolean` could never express.
    const parts = [part('face', 400, 400, { rotationPolicy: 'locked' })];
    const stock = [sheet()];
    const result = resultOf(parts, stock, [
      { stockInstanceId: 's#0', placements: [angled('face', 0, 0, 180)] },
    ]);
    expect(checkResult(result, { parts, stock, config: NEST_CONFIG }).status).toBe('valid');
  });

  it('catches a grain-locked part turned off axis in nest mode', () => {
    const parts = [part('face', 400, 400, { rotationPolicy: 'locked' })];
    const stock = [sheet()];
    const result = resultOf(parts, stock, [
      { stockInstanceId: 's#0', placements: [angled('face', 100, 100, 45)] },
    ]);
    const outcome = checkResult(result, { parts, stock, config: NEST_CONFIG });
    expect(violationOf(outcome.violations, 'illegal-rotation').angleDeg).toBe(45);
  });

  it('reads -90 and 270 as the same orientation', () => {
    // A solver may spell a quarter turn either way. Rejecting one of them would
    // be a rule about arithmetic rather than about woodworking.
    const parts = [part('face', 400, 400, { rotationPolicy: 'locked' })];
    const stock = [sheet()];
    for (const angleDeg of [-180, 360]) {
      const result = resultOf(parts, stock, [
        { stockInstanceId: 's#0', placements: [angled('face', 0, 0, angleDeg)] },
      ]);
      expect(checkResult(result, { parts, stock, config: CONFIG }).status).toBe('valid');
    }
  });
});

describe('checkResult - a table saw cannot cut off axis', () => {
  it('catches a part placed at 45° in guillotine mode', () => {
    // Not covered by guillotine decomposability: this part's bounding box is
    // the whole sheet's worth of clean rectangle, and a sheet of such boxes
    // tiles perfectly while every part on it is uncuttable.
    const parts = [part('panel', 400, 400)];
    const stock = [sheet()];
    const result = resultOf(parts, stock, [
      { stockInstanceId: 's#0', placements: [angled('panel', 100, 100, 45)] },
    ]);
    const outcome = checkResult(result, { parts, stock, config: CONFIG });
    expect(violationOf(outcome.violations, 'non-quarter-angle').angleDeg).toBe(45);
    expect(outcome.status).toBe('invalid');
  });

  it('says nothing about 45° in nest mode, where a router handles it', () => {
    const parts = [part('panel', 400, 400)];
    const stock = [sheet()];
    const result = resultOf(parts, stock, [
      { stockInstanceId: 's#0', placements: [angled('panel', 100, 100, 45)] },
    ]);
    const outcome = checkResult(result, { parts, stock, config: NEST_CONFIG });
    expect(kinds(outcome.violations)).not.toContain('non-quarter-angle');
  });

  it('accepts every quarter turn in guillotine mode', () => {
    const parts = [part('panel', 400, 300)];
    const stock = [sheet()];
    for (const angleDeg of [0, 90, 180, 270]) {
      const result = resultOf(parts, stock, [
        { stockInstanceId: 's#0', placements: [angled('panel', 0, 0, angleDeg)] },
      ]);
      expect(checkResult(result, { parts, stock, config: CONFIG }).status).toBe('valid');
    }
  });
});

// --- Outlines -------------------------------------------------------------
//
// The whole compatibility claim of this milestone is that a part carrying its
// own outline behaves exactly like the same part without one, because
// `width`/`height` stay the bounding box either way. These are the tests that
// hold that claim up.

describe('outlines - a rectangle that states the obvious', () => {
  const boxOutline = (width: number, height: number) => [
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: width, y: height },
    { x: 0, y: height },
  ];

  it('validates identically to the same part with no outline', () => {
    const plain = [part('a', 400, 300), part('b', 400, 300)];
    const shaped = plain.map((p) => ({ ...p, outline: boxOutline(p.width, p.height) }));
    const stock = [sheet()];
    const layouts = [
      { stockInstanceId: 's#0', placements: [at('a', 0, 0), at('b', 403, 0, true)] },
    ];

    expect(validateInputs(shaped, stock, CONFIG)).toEqual(validateInputs(plain, stock, CONFIG));

    const plainOutcome = checkResult(resultOf(plain, stock, layouts), {
      parts: plain,
      stock,
      config: CONFIG,
    });
    const shapedOutcome = checkResult(resultOf(shaped, stock, layouts), {
      parts: shaped,
      stock,
      config: CONFIG,
    });
    expect(shapedOutcome).toEqual(plainOutcome);
    expect(shapedOutcome.status).toBe('valid');
  });

  it('rejects an outline whose bounds are not the part', () => {
    // width/height stay the bounding box in M7. An outline that disagrees would
    // have the packer reading one shape and the renderer drawing another.
    const parts = [part('a', 400, 300, { outline: boxOutline(400, 500) })];
    const issues = validateInputs(parts, [sheet()], CONFIG);
    expect(issueOf(issues, 'outline-bounds-mismatch').partId).toBe('a');
    expect(hasErrors(issues)).toBe(true);
  });

  it('rejects an outline that does not start at the top-left corner', () => {
    const offset = boxOutline(400, 300).map((p) => ({ x: p.x + 10, y: p.y + 10 }));
    const parts = [part('a', 400, 300, { outline: offset })];
    expect(kinds(validateInputs(parts, [sheet()], CONFIG))).toContain('outline-bounds-mismatch');
  });

  it('rejects an outline with too few points', () => {
    const parts = [
      part('a', 400, 300, {
        outline: [
          { x: 0, y: 0 },
          { x: 400, y: 300 },
        ],
      }),
    ];
    const issues = validateInputs(parts, [sheet()], CONFIG);
    expect(issueOf(issues, 'outline-too-few-points').points).toBe(2);
    expect(hasErrors(issues)).toBe(true);
  });

  it('warns about an outline that crosses itself without blocking the solve', () => {
    const bowTie = [
      { x: 0, y: 0 },
      { x: 400, y: 300 },
      { x: 400, y: 0 },
      { x: 0, y: 300 },
    ];
    const parts = [part('a', 400, 300, { outline: bowTie })];
    const issues = validateInputs(parts, [sheet()], CONFIG);
    expect(issueOf(issues, 'outline-self-intersecting').severity).toBe('warning');
    expect(hasErrors(issues)).toBe(false);
  });

  it('reports one issue per bad part, not a cascade', () => {
    const parts = [
      part('good', 400, 300),
      part('bad', 400, 300, { outline: boxOutline(400, 500) }),
    ];
    const issues = validateInputs(parts, [sheet()], CONFIG);
    expect(kinds(issues)).toEqual(['outline-bounds-mismatch']);
  });
});

describe('checkResult - nest mode', () => {
  // An L, 400 x 400 overall with the bottom-right quarter bitten out. Two of
  // them interlock: turn one a half turn and its bite receives the other's arm.
  const L = [
    { x: 0, y: 0 },
    { x: 400, y: 0 },
    { x: 400, y: 200 },
    { x: 200, y: 200 },
    { x: 200, y: 400 },
    { x: 0, y: 400 },
  ];
  const shaped = (id: string) => part(id, 400, 400, { outline: L });

  it('does not ask whether a nested layout is guillotine-decomposable', () => {
    // The pinwheel: four parts turned around a centre, no overlaps anywhere and
    // no valid edge-to-edge cut. Invalid on a table saw, fine on a router - and
    // running invariant 4 in nest mode would fail every layout the nester makes.
    const parts = [
      part('a', 400, 300),
      part('b', 300, 400),
      part('c', 400, 300),
      part('d', 300, 400),
    ];
    const stock = [sheet()];
    const layouts = [
      {
        stockInstanceId: 's#0',
        placements: [at('a', 0, 0), at('b', 403, 0), at('c', 303, 403), at('d', 0, 303)],
      },
    ];

    expect(
      kinds(
        checkResult(resultOf(parts, stock, layouts), { parts, stock, config: CONFIG }).violations,
      ),
    ).toContain('not-guillotine-decomposable');
    expect(
      kinds(
        checkResult(resultOf(parts, stock, layouts), { parts, stock, config: NEST_CONFIG })
          .violations,
      ),
    ).not.toContain('not-guillotine-decomposable');
  });

  it('catches two outlines that overlap even though their boxes clear', () => {
    // Placed 210 apart in x, so both bounding boxes still overlap by 190 - but
    // the point is that the check now runs on the real shapes, and these two do
    // collide: the second L's tall arm lands inside the first's.
    const parts = [shaped('a'), shaped('b')];
    const stock = [sheet()];
    const result = resultOf(
      parts,
      stock,
      [{ stockInstanceId: 's#0', placements: [at('a', 0, 0), at('b', 100, 100)] }],
      [],
      'nest',
    );
    const outcome = checkResult(result, { parts, stock, config: NEST_CONFIG });
    expect(violationOf(outcome.violations, 'kerf-separation').clearance).toBeLessThan(0);
  });

  it('accepts two outlines nested into each other beyond the kerf', () => {
    // The second L given a half turn tucks its arm into the first's bite. Their
    // bounding boxes overlap heavily; their outlines clear by more than the
    // blade. This is the packing a bounding-box solver cannot find, and the
    // reason the checker had to learn about polygons.
    const parts = [shaped('a'), shaped('b')];
    const stock = [sheet()];
    const nestResult = resultOf(
      parts,
      stock,
      [{ stockInstanceId: 's#0', placements: [at('a', 0, 0), angled('b', 204, 204, 180)] }],
      [],
      'nest',
    );
    const outcome = checkResult(nestResult, { parts, stock, config: NEST_CONFIG });
    expect(outcome.status).toBe('valid');

    // The same pair is nonsense on a table saw, and guillotine mode says so -
    // there the parts are their boxes, and the boxes are on top of each other.
    const sawnResult = resultOf(parts, stock, [
      { stockInstanceId: 's#0', placements: [at('a', 0, 0), angled('b', 204, 204, 180)] },
    ]);
    expect(kinds(checkResult(sawnResult, { parts, stock, config: CONFIG }).violations)).toContain(
      'kerf-separation',
    );
  });

  it('measures waste from the outline in nest mode and the box in guillotine mode', () => {
    // The L covers 400*400 - 200*200 = 120000mm² of a 1000x1000 sheet, against
    // the 160000mm² its bounding box costs on a saw.
    const parts = [shaped('a')];
    const stock = [sheet()];
    const placements = [at('a', 0, 0)];

    const nested: Result = {
      layouts: [{ stockInstanceId: 's#0', placements, wastePct: 1 - 120000 / 1000000 }],
      unplacedParts: [],
      totalWastePct: 1 - 120000 / 1000000,
    };
    expect(checkResult(nested, { parts, stock, config: NEST_CONFIG }).status).toBe('valid');

    const sawn: Result = {
      layouts: [{ stockInstanceId: 's#0', placements, wastePct: 1 - 160000 / 1000000 }],
      unplacedParts: [],
      totalWastePct: 1 - 160000 / 1000000,
    };
    expect(checkResult(sawn, { parts, stock, config: CONFIG }).status).toBe('valid');

    // And each rejects the other's number, so the two are genuinely distinct.
    expect(kinds(checkResult(sawn, { parts, stock, config: NEST_CONFIG }).violations)).toContain(
      'layout-waste-mismatch',
    );
  });
});

describe('validateInputs - solver mode', () => {
  it('accepts a nest-mode config now that the engine exists', () => {
    // Until M7 PR 6, `unsupported-solver-mode` refused this outright: accepting
    // it would have produced a guillotine layout while `checkResult` quietly
    // stopped asking whether that layout was cuttable. The issue is gone with
    // the engine that made it necessary.
    expect(validateInputs([part('a', 400, 300)], [sheet()], NEST_CONFIG)).toEqual([]);
  });

  it('says nothing for the default and the explicit guillotine mode', () => {
    const parts = [part('a', 400, 300)];
    expect(validateInputs(parts, [sheet()], CONFIG)).toEqual([]);
    expect(validateInputs(parts, [sheet()], { ...CONFIG, mode: 'guillotine' })).toEqual([]);
  });
});

describe('checkResult - invariant 4, guillotine decomposability', () => {
  it('catches a pinwheel', () => {
    // No overlaps, every gap at least the kerf, packs beautifully, and cannot
    // be cut on a table saw. If this passed, the checker would be worthless.
    const parts = [part('nw', 60, 40), part('ne', 40, 60), part('sw', 40, 60), part('se', 60, 40)];
    const stock = [sheet({ width: 106, height: 106 })];
    const result = resultOf(parts, stock, [
      {
        stockInstanceId: 's#0',
        placements: [at('nw', 0, 0), at('ne', 63, 0), at('sw', 0, 43), at('se', 43, 63)],
      },
    ]);

    const outcome = checkResult(result, { parts, stock, config: CONFIG });
    // Nothing else fires: the pinwheel is legal by every other measure.
    expect(kinds(outcome.violations)).toEqual(['not-guillotine-decomposable']);
    expect(outcome.status).toBe('invalid');
  });

  it('reports unverified, never valid, when the search runs out of budget', () => {
    const project = goodProject();
    const outcome = checkResult(project.result, {
      parts: project.parts,
      stock: project.stock,
      config: CONFIG,
      maxGuillotineSteps: 0,
    });
    expect(outcome.status).toBe('unverified');
    expect(outcome.violations).toEqual([]);
    expect(outcome.unverifiedSheets).toEqual(['s#0']);
  });

  it('lets a real violation outrank an unverified sheet', () => {
    const project = goodProject();
    const layout = project.result.layouts[0];
    if (layout === undefined) throw new Error('bad fixture');
    layout.placements = [at('a', 0, 0), at('b', 200, 0), at('c', 0, 403)];

    const outcome = checkResult(project.result, {
      parts: project.parts,
      stock: project.stock,
      config: CONFIG,
      maxGuillotineSteps: 0,
    });
    expect(outcome.status).toBe('invalid');
    expect(outcome.unverifiedSheets).toEqual(['s#0']);
  });
});

describe('checkResult - invariant 5, material match', () => {
  it('catches a part placed on the wrong material', () => {
    const parts = [part('shelf', 400, 400, { materialId: 'mdf' })];
    const stock = [sheet({ materialId: 'ply' })];
    const result = resultOf(parts, stock, [
      { stockInstanceId: 's#0', placements: [at('shelf', 0, 0)] },
    ]);
    const violation = violationOf(
      checkResult(result, { parts, stock, config: CONFIG }).violations,
      'material-mismatch',
    );
    expect(violation.partMaterialId).toBe('mdf');
    expect(violation.stockMaterialId).toBe('ply');
  });
});

describe('checkResult - invariant 6, quantity accounting', () => {
  it('catches a part that was silently dropped', () => {
    // The failure mode this exists for. Placing 3 of 4 and reporting nothing
    // unplaced looks like a clean solve until someone counts the diagrams.
    const parts = [part('a', 400, 400, { qty: 4 })];
    const stock = [sheet()];
    const result = resultOf(parts, stock, [
      {
        stockInstanceId: 's#0',
        placements: [at('a', 0, 0), at('a', 403, 0), at('a', 0, 403)],
      },
    ]);

    const violation = violationOf(
      checkResult(result, { parts, stock, config: CONFIG }).violations,
      'quantity-mismatch',
    );
    expect(violation).toMatchObject({ requested: 4, placed: 3, unplaced: 0 });
  });

  it('accepts a shortfall that is reported honestly', () => {
    const parts = [part('a', 400, 400, { qty: 4 })];
    const stock = [sheet()];
    const result = resultOf(
      parts,
      stock,
      [
        {
          stockInstanceId: 's#0',
          placements: [at('a', 0, 0), at('a', 403, 0), at('a', 0, 403)],
        },
      ],
      [{ partId: 'a', qty: 1 }],
    );
    expect(checkResult(result, { parts, stock, config: CONFIG }).status).toBe('valid');
  });

  it('catches more parts placed than were asked for', () => {
    const parts = [part('a', 400, 400, { qty: 2 })];
    const stock = [sheet()];
    const result = resultOf(parts, stock, [
      {
        stockInstanceId: 's#0',
        placements: [at('a', 0, 0), at('a', 403, 0), at('a', 0, 403)],
      },
    ]);
    const violation = violationOf(
      checkResult(result, { parts, stock, config: CONFIG }).violations,
      'quantity-mismatch',
    );
    expect(violation).toMatchObject({ requested: 2, placed: 3 });
  });

  it('catches a part missing from the result entirely', () => {
    const parts = [part('a', 400, 400), part('forgotten', 100, 100)];
    const stock = [sheet()];
    const result = resultOf(parts, stock, [
      { stockInstanceId: 's#0', placements: [at('a', 0, 0)] },
    ]);
    expect(
      violationOf(
        checkResult(result, { parts, stock, config: CONFIG }).violations,
        'quantity-mismatch',
      ).partId,
    ).toBe('forgotten');
  });

  it('rejects a negative shortfall that would balance the books by cancellation', () => {
    // Five of four parts placed and minus one "unplaced" adds up to exactly
    // four, and loses a part anyway.
    const parts = [part('a', 400, 400, { qty: 4 })];
    const stock = [sheet()];
    const result = resultOf(
      parts,
      stock,
      [
        {
          stockInstanceId: 's#0',
          placements: [
            at('a', 0, 0),
            at('a', 403, 0),
            at('a', 0, 403),
            at('a', 403, 403),
            at('a', 806, 0),
          ],
        },
      ],
      [{ partId: 'a', qty: -1 }],
    );
    const outcome = checkResult(result, { parts, stock, config: CONFIG });
    expect(violationOf(outcome.violations, 'invalid-unplaced-qty').qty).toBe(-1);
    expect(violationOf(outcome.violations, 'quantity-mismatch')).toMatchObject({
      requested: 4,
      placed: 5,
      unplaced: 0,
    });
  });

  it('sums repeated unplaced entries for the same part', () => {
    const parts = [part('a', 400, 400, { qty: 3 })];
    const stock = [sheet()];
    const result = resultOf(
      parts,
      stock,
      [{ stockInstanceId: 's#0', placements: [at('a', 0, 0)] }],
      [
        { partId: 'a', qty: 1 },
        { partId: 'a', qty: 1 },
      ],
    );
    expect(checkResult(result, { parts, stock, config: CONFIG }).status).toBe('valid');
  });
});

describe('checkResult - references that do not resolve', () => {
  it('catches a placement naming a part that does not exist', () => {
    const parts = [part('a', 400, 400)];
    const stock = [sheet()];
    const result = resultOf(parts, stock, [
      { stockInstanceId: 's#0', placements: [at('a', 0, 0), at('ghost', 403, 0)] },
    ]);
    expect(
      violationOf(checkResult(result, { parts, stock, config: CONFIG }).violations, 'unknown-part')
        .partId,
    ).toBe('ghost');
  });

  it('reports an unknown part once however often it appears', () => {
    const stock = [sheet()];
    const result = resultOf([], stock, [
      { stockInstanceId: 's#0', placements: [at('ghost', 0, 0), at('ghost', 403, 0)] },
    ]);
    const violations = checkResult(result, { parts: [], stock, config: CONFIG }).violations;
    expect(violations.filter((v) => v.kind === 'unknown-part')).toHaveLength(1);
  });

  it('catches a malformed stock instance id', () => {
    const parts = [part('a', 400, 400)];
    const stock = [sheet()];
    const result: Result = {
      layouts: [{ stockInstanceId: 's', placements: [at('a', 0, 0)], wastePct: 0.84 }],
      unplacedParts: [],
      totalWastePct: 0.84,
    };
    expect(
      violationOf(
        checkResult(result, { parts, stock, config: CONFIG }).violations,
        'unknown-stock-instance',
      ).message,
    ).toContain('stockId#index');
  });

  it('catches a layout on stock that was never listed', () => {
    const parts = [part('a', 400, 400)];
    const stock = [sheet()];
    const result: Result = {
      layouts: [{ stockInstanceId: 'oak#0', placements: [at('a', 0, 0)], wastePct: 0.84 }],
      unplacedParts: [],
      totalWastePct: 0.84,
    };
    expect(
      violationOf(
        checkResult(result, { parts, stock, config: CONFIG }).violations,
        'unknown-stock-instance',
      ).message,
    ).toContain('no stock entry');
  });

  it('catches a layout on more sheets than the user owns', () => {
    // qty 2 means instances 0 and 1. Instance 2 is a sheet nobody bought.
    const parts = [part('a', 400, 400)];
    const stock = [sheet({ qty: 2 })];
    const result: Result = {
      layouts: [
        {
          stockInstanceId: 's#2',
          placements: [{ ...at('a', 0, 0), stockInstanceId: 's#2' }],
          wastePct: 0.84,
        },
      ],
      unplacedParts: [],
      totalWastePct: 0.84,
    };
    expect(
      violationOf(
        checkResult(result, { parts, stock, config: CONFIG }).violations,
        'unknown-stock-instance',
      ).message,
    ).toContain('that many sheets');
  });

  it('catches two layouts for the same physical sheet', () => {
    // Each per-sheet check would see half the parts and pass, while the sheet
    // is quietly double-booked.
    const parts = [part('a', 400, 400, { qty: 2 })];
    const stock = [sheet()];
    const result = resultOf(parts, stock, [
      { stockInstanceId: 's#0', placements: [at('a', 0, 0)] },
      { stockInstanceId: 's#0', placements: [at('a', 0, 0)] },
    ]);
    expect(
      violationOf(
        checkResult(result, { parts, stock, config: CONFIG }).violations,
        'duplicate-layout',
      ).stockInstanceId,
    ).toBe('s#0');
  });
});

describe('checkResult - waste arithmetic', () => {
  // Hand-computed, not taken from the checker: one 400 x 400 part is
  // 160,000mm² on a 1,000,000mm² sheet, so 84% of the sheet is waste.
  const parts = [part('a', 400, 400)];
  const stock = [sheet()];

  it('accepts the correct number', () => {
    const result: Result = {
      layouts: [{ stockInstanceId: 's#0', placements: [at('a', 0, 0)], wastePct: 0.84 }],
      unplacedParts: [],
      totalWastePct: 0.84,
    };
    expect(checkResult(result, { parts, stock, config: CONFIG }).status).toBe('valid');
  });

  it('catches a wrong per-sheet number', () => {
    const result: Result = {
      layouts: [{ stockInstanceId: 's#0', placements: [at('a', 0, 0)], wastePct: 0.5 }],
      unplacedParts: [],
      totalWastePct: 0.84,
    };
    const violation = violationOf(
      checkResult(result, { parts, stock, config: CONFIG }).violations,
      'layout-waste-mismatch',
    );
    expect(violation.reported).toBe(0.5);
    expect(violation.actual).toBeCloseTo(0.84, 9);
  });

  it('catches a wrong total', () => {
    const result: Result = {
      layouts: [{ stockInstanceId: 's#0', placements: [at('a', 0, 0)], wastePct: 0.84 }],
      unplacedParts: [],
      totalWastePct: 0.2,
    };
    expect(
      violationOf(
        checkResult(result, { parts, stock, config: CONFIG }).violations,
        'total-waste-mismatch',
      ).actual,
    ).toBeCloseTo(0.84, 9);
  });

  it('measures against the full sheet, not the usable area', () => {
    // Edge trim is material the user paid for and threw away. Measuring
    // against the trimmed area would quietly flatter every layout.
    const config = { ...CONFIG, edgeTrim: 100 };
    const result: Result = {
      layouts: [{ stockInstanceId: 's#0', placements: [at('a', 100, 100)], wastePct: 0.84 }],
      unplacedParts: [],
      totalWastePct: 0.84,
    };
    expect(checkResult(result, { parts, stock, config }).status).toBe('valid');
  });

  it('ignores stock that was never opened', () => {
    // Two sheets owned, one used. That is 84% waste, not 92%.
    const result: Result = {
      layouts: [{ stockInstanceId: 's#0', placements: [at('a', 0, 0)], wastePct: 0.84 }],
      unplacedParts: [],
      totalWastePct: 0.84,
    };
    expect(checkResult(result, { parts, stock: [sheet({ qty: 2 })], config: CONFIG }).status).toBe(
      'valid',
    );
  });

  it('averages across sheets by area, not by sheet', () => {
    // A full sheet and a half sheet do not contribute equally.
    const twoParts = [part('a', 400, 400), part('b', 400, 400)];
    const twoSheets = [sheet({ id: 'full' }), sheet({ id: 'half', height: 500 })];
    const placedArea = 2 * 400 * 400;
    const usedArea = 1000 * 1000 + 1000 * 500;
    const result: Result = {
      layouts: [
        {
          stockInstanceId: 'full#0',
          placements: [{ partId: 'a', stockInstanceId: 'full#0', x: 0, y: 0, angleDeg: 0 }],
          wastePct: 1 - 160000 / 1000000,
        },
        {
          stockInstanceId: 'half#0',
          placements: [{ partId: 'b', stockInstanceId: 'half#0', x: 0, y: 0, angleDeg: 0 }],
          wastePct: 1 - 160000 / 500000,
        },
      ],
      unplacedParts: [],
      totalWastePct: 1 - placedArea / usedArea,
    };
    expect(checkResult(result, { parts: twoParts, stock: twoSheets, config: CONFIG }).status).toBe(
      'valid',
    );
  });

  it('counts a rotated part by its real footprint', () => {
    const wide = [part('wide', 200, 500)];
    const result: Result = {
      layouts: [
        {
          stockInstanceId: 's#0',
          placements: [at('wide', 0, 0, true)],
          wastePct: 1 - 100000 / 1000000,
        },
      ],
      unplacedParts: [],
      totalWastePct: 1 - 100000 / 1000000,
    };
    expect(checkResult(result, { parts: wide, stock, config: CONFIG }).status).toBe('valid');
  });
});

describe('checkResult - reporting', () => {
  it('collects every violation rather than stopping at the first', () => {
    const parts = [
      part('a', 400, 400, { rotationPolicy: 'locked', materialId: 'mdf' }),
      part('b', 400, 400),
    ];
    const stock = [sheet()];
    const result = resultOf(parts, stock, [
      { stockInstanceId: 's#0', placements: [at('a', 0, 0, true), at('b', 200, 0)] },
    ]);
    const outcome = checkResult(result, { parts, stock, config: CONFIG });
    // The overlap makes the sheet uncuttable as well, so all four fire.
    expect(new Set(kinds(outcome.violations))).toEqual(
      new Set([
        'illegal-rotation',
        'material-mismatch',
        'kerf-separation',
        'not-guillotine-decomposable',
      ]),
    );
  });

  it('says which parts and by how much', () => {
    // "This layout is invalid" is not actionable. The numbers are.
    const project = goodProject();
    const layout = project.result.layouts[0];
    if (layout === undefined) throw new Error('bad fixture');
    layout.placements = [at('a', 0, 0), at('b', 402, 0), at('c', 0, 403)];

    const message = violationOf(check(project).violations, 'kerf-separation').message;
    expect(message).toContain('"a"');
    expect(message).toContain('"b"');
    expect(message).toContain('2 mm');
    expect(message).toContain('3 mm');
  });
});
