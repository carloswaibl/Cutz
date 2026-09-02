import { describe, expect, it } from 'vitest';
import type { Rect } from '../../../src/domain/geometry';
import type { Part, Point } from '../../../src/domain/types';
import { createOccupancy, orInto } from '../../../src/solver/nest/collide';
import { type Cursor, findPlacement, orient, orientations } from '../../../src/solver/nest/place';
import { dilationOffsets } from '../../../src/solver/nest/raster';

const CELL = 10;
const NO_KERF = dilationOffsets(0, CELL);

function ring(points: readonly [number, number][]): Point[] {
  return points.map(([x, y]) => ({ x, y }));
}

function box(width: number, height: number): Point[] {
  return ring([
    [0, 0],
    [width, 0],
    [width, height],
    [0, height],
  ]);
}

function part(overrides: Partial<Part> = {}): Part {
  return {
    id: 'p',
    label: 'Part',
    width: 100,
    height: 100,
    qty: 1,
    materialId: 'm',
    rotationPolicy: 'free90',
    ...overrides,
  };
}

const USABLE: Rect = { x: 5, y: 5, width: 1000, height: 500 };

describe('orient', () => {
  it('re-anchors a turned shape at its own bounds', () => {
    // `rotatePolygon` turns about the origin, so a 90-degree turn lands a part
    // at negative x. Anchoring the turned *bounds* is what keeps a mask at cell
    // (c, r) meaning a placement at that cell, and what makes the packer agree
    // with `placementPolygon` about where the part is.
    const turned = orient(box(200, 100), 90, CELL, NO_KERF);
    expect(turned.width).toBeCloseTo(100);
    expect(turned.height).toBeCloseTo(200);
    expect({ cols: turned.exact.cols, rows: turned.exact.rows }).toEqual({ cols: 10, rows: 20 });
  });
});

describe('orientations', () => {
  it('drops orientations that rasterise to the same shape', () => {
    // A rectangle at 0 and at 180 is the same shape in the same box. Scanning
    // both costs a full sweep of the sheet for an answer already known, and the
    // survivor is the lower angle either way.
    const angles = [0, 90, 180, 270];
    expect(orientations(part(), box(100, 100), angles, CELL, NO_KERF)).toHaveLength(1);
    expect(
      orientations(part(), box(200, 100), angles, CELL, NO_KERF).map((o) => o.angleDeg),
    ).toEqual([0, 90]);
  });

  it('keeps every orientation of a shape that is genuinely different at each', () => {
    const triangle = ring([
      [0, 0],
      [200, 0],
      [0, 100],
    ]);
    const built = orientations(part(), triangle, [0, 90, 180, 270], CELL, NO_KERF);
    expect(built.map((o) => o.angleDeg)).toEqual([0, 90, 180, 270]);
  });
});

describe('findPlacement', () => {
  it('takes the lowest row, then the lowest column', () => {
    const occupancy = createOccupancy(100, 50);
    const square = orientations(part(), box(100, 100), [0], CELL, NO_KERF);

    const first = findPlacement(occupancy, square, USABLE, CELL);
    expect(first).toMatchObject({ row: 0, col: 0 });

    if (first === null) throw new Error('unreachable');
    orInto(occupancy, first.orientation.exact, first.col, first.row);

    // Not below it, and not further right than it has to be: bottom-left fill
    // means the next part sits alongside, not underneath.
    expect(findPlacement(occupancy, square, USABLE, CELL)).toMatchObject({ row: 0, col: 10 });
  });

  it('prefers an orientation that reaches a lower row, earliest angle on a tie', () => {
    // Space only 100mm tall at the top of the sheet: the upright 200x100 part
    // cannot use it, its quarter turn can.
    const occupancy = createOccupancy(100, 50);
    const tall = orientations(part(), box(100, 200), [0, 90], CELL, NO_KERF);

    // Block everything from row 10 down, leaving a 100mm band at the top.
    const wall = orientations(part(), box(1000, 400), [0], CELL, NO_KERF)[0];
    if (!wall) throw new Error('unreachable');
    orInto(occupancy, wall.exact, 0, 10);

    const placed = findPlacement(occupancy, tall, USABLE, CELL);
    expect(placed?.orientation.angleDeg).toBe(90);
    expect(placed?.row).toBe(0);
  });

  it('returns null when the part is larger than the usable area', () => {
    const occupancy = createOccupancy(100, 50);
    const huge = orientations(part(), box(2000, 100), [0], CELL, NO_KERF);
    expect(findPlacement(occupancy, huge, USABLE, CELL)).toBeNull();
  });

  it('never lets a part hang off the sheet, even by a cell', () => {
    // Containment is decided exactly, off the grid - the same predicate
    // `checkResult` applies. A part reported one cell past the usable area is a
    // part the machine cuts air out of.
    const occupancy = createOccupancy(100, 50);
    const tight: Rect = { x: 0, y: 0, width: 995, height: 500 };
    const wide = orientations(part(), box(1000, 100), [0], CELL, NO_KERF);
    expect(findPlacement(occupancy, wide, tight, CELL)).toBeNull();
  });

  it('resuming from a cursor gives the same answer as scanning from scratch', () => {
    // The cursor is an exact optimisation, not a heuristic: occupancy only
    // grows, so the bottom-left-most free position only moves forward. If that
    // reasoning is ever wrong, resuming would skip a legal position and the
    // packing would silently get worse - so the two are compared directly.
    const square = orientations(part(), box(100, 100), [0], CELL, NO_KERF);

    const scratch = createOccupancy(100, 50);
    const resumed = createOccupancy(100, 50);
    const cursors: Cursor[] = [{ row: 0, col: 0 }];

    for (let i = 0; i < 40; i += 1) {
      const a = findPlacement(scratch, square, USABLE, CELL);
      const b = findPlacement(resumed, square, USABLE, CELL, cursors);
      expect({ row: b?.row, col: b?.col }, `placement ${i}`).toEqual({ row: a?.row, col: a?.col });
      if (a === null || b === null) break;
      orInto(scratch, a.orientation.exact, a.col, a.row);
      orInto(resumed, b.orientation.exact, b.col, b.row);
      cursors[b.index] = { row: b.row, col: b.col };
    }
  });

  it('leaves a real gap between two placed parts once a kerf is charged', () => {
    const kerf = 30;
    const offsets = dilationOffsets(kerf, CELL);
    const occupancy = createOccupancy(100, 50);
    const square = orientations(part(), box(100, 100), [0], CELL, offsets);

    const first = findPlacement(occupancy, square, USABLE, CELL);
    if (first === null) throw new Error('unreachable');
    orInto(occupancy, first.orientation.exact, first.col, first.row);

    const second = findPlacement(occupancy, square, USABLE, CELL);
    // 100mm of part plus a 30mm kerf, on a 10mm grid: thirteen cells along.
    expect(second).toMatchObject({ row: 0, col: 13 });
  });
});
