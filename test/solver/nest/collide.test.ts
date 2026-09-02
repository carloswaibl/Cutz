import { describe, expect, it } from 'vitest';
import {
  collides,
  createOccupancy,
  lastOccupiedRow,
  orInto,
} from '../../../src/solver/nest/collide';
import { createMask, getBit, type Mask } from '../../../src/solver/nest/raster';

/**
 * Build a mask from an ASCII picture, `#` occupied.
 *
 * The whole file is about bit arithmetic across word boundaries, which is
 * exactly the kind of code where a hand-computed expectation is as likely to be
 * wrong as the implementation. Drawing the shapes instead keeps the intent
 * legible at 32-column offsets.
 */
function mask(rows: readonly string[]): Mask {
  const cols = Math.max(...rows.map((row) => row.length));
  const built = createMask(cols, rows.length);
  rows.forEach((row, r) => {
    [...row].forEach((cell, c) => {
      if (cell === '#') {
        const index = r * built.stride + (c >>> 5);
        const current = built.bits[index] ?? 0;
        built.bits[index] = (current | (1 << (c & 31))) >>> 0;
      }
    });
  });
  return built;
}

const BLOCK = mask(['##', '##']);

describe('collides', () => {
  it('finds an overlap and misses a near miss', () => {
    const occupancy = createOccupancy(40, 10);
    orInto(occupancy, BLOCK, 5, 5);

    expect(collides(occupancy, BLOCK, 5, 5)).toBe(true);
    expect(collides(occupancy, BLOCK, 6, 6)).toBe(true);
    expect(collides(occupancy, BLOCK, 7, 5)).toBe(false);
    expect(collides(occupancy, BLOCK, 5, 7)).toBe(false);
    expect(collides(occupancy, BLOCK, 3, 5)).toBe(false);
  });

  it('is right across a word boundary, in both directions', () => {
    // A shape straddling column 32 is split over two words and shifted by a
    // different amount into each. Every placement past the first 32 columns of a
    // sheet depends on this being right, so it is checked at the seam itself.
    const occupancy = createOccupancy(96, 4);
    orInto(occupancy, BLOCK, 31, 1);

    for (let col = 28; col <= 34; col += 1) {
      const overlapping = col >= 30 && col <= 32;
      expect(collides(occupancy, BLOCK, col, 1), `col ${col}`).toBe(overlapping);
    }
  });

  it('treats everything off the sheet as clear, not as blocked', () => {
    // A dilated mask hangs a kerf halo over the sheet edge by design. A sheet
    // edge is not a saw cut, so no clearance is owed there - blocking on it
    // would quietly shrink every sheet by a kerf on all four sides.
    const occupancy = createOccupancy(40, 10);
    orInto(occupancy, BLOCK, 0, 0);

    expect(collides(occupancy, BLOCK, -2, 0)).toBe(false);
    expect(collides(occupancy, BLOCK, 0, -2)).toBe(false);
    expect(collides(occupancy, BLOCK, -1, 0)).toBe(true);
    expect(collides(occupancy, BLOCK, 39, 9)).toBe(false);
  });

  it('reports nothing on an untouched sheet, whatever is asked of it', () => {
    const occupancy = createOccupancy(96, 96);
    expect(collides(occupancy, BLOCK, 0, 0)).toBe(false);
    expect(collides(occupancy, mask(['#'.repeat(90)]), 0, 40)).toBe(false);
  });
});

describe('orInto', () => {
  it('writes the shape where it says it does', () => {
    const occupancy = createOccupancy(64, 8);
    orInto(occupancy, mask(['#.#', '.#.']), 30, 2);

    const written: [number, number][] = [
      [30, 2],
      [32, 2],
      [31, 3],
    ];
    for (const [col, row] of written) {
      expect(collides(occupancy, mask(['#']), col, row), `${col},${row}`).toBe(true);
    }
    expect(collides(occupancy, mask(['#']), 31, 2)).toBe(false);
  });

  it('never wraps a bit round to column zero of the same row', () => {
    // The final word of a row has spare bits past `cols`, and the collision test
    // clips the right edge by trusting they stay clear. A wrapped bit would read
    // as a phantom part at the other side of the sheet.
    const occupancy = createOccupancy(34, 2);
    orInto(occupancy, mask(['####']), 32, 0);

    expect(collides(occupancy, mask(['#']), 0, 0)).toBe(false);
    expect(collides(occupancy, mask(['#']), 33, 0)).toBe(true);
  });

  it('keeps the empty-row index in step with what was written', () => {
    // `collides` skips straight over empty rows using this, so an index that
    // lags behind a write would silently stop reporting real collisions.
    const occupancy = createOccupancy(40, 10);
    expect(occupancy.nextOccupied[0]).toBe(10);
    expect(lastOccupiedRow(occupancy)).toBe(-1);

    orInto(occupancy, BLOCK, 3, 4);
    expect(occupancy.nextOccupied[0]).toBe(4);
    expect(occupancy.nextOccupied[5]).toBe(5);
    expect(occupancy.nextOccupied[6]).toBe(10);
    expect(lastOccupiedRow(occupancy)).toBe(5);

    orInto(occupancy, BLOCK, 3, 8);
    expect(occupancy.nextOccupied[6]).toBe(8);
    expect(lastOccupiedRow(occupancy)).toBe(9);
  });
});

describe('the bit layout raster.ts and collide.ts share', () => {
  it('agrees on which bit is which column', () => {
    // Two files index the same words; if they ever disagree about bit order,
    // every mask would be mirrored inside each 32-column block and nothing else
    // in the engine would notice.
    const built = mask(['.#..#']);
    expect(getBit(built, 0, 0)).toBe(false);
    expect(getBit(built, 1, 0)).toBe(true);
    expect(getBit(built, 4, 0)).toBe(true);
  });
});
