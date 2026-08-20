/** Quantities - §5.6. Pure, so it runs in the default node environment. */

import { describe, expect, it } from 'vitest';
import {
  GROUP_TOLERANCE_MM,
  groupRows,
  type ShapeRow,
  SPREAD_FLAG_MM,
} from '../../src/import/svg/group';

let counter = 0;
function row(width: number, height: number, label = 'Shelf', sheared = false): ShapeRow {
  counter += 1;
  return { label, box: { width, height, angle: 0 }, sourceId: `s${counter}`, sheared };
}

describe('groupRows', () => {
  it('collapses six identical shelves into one row of six', () => {
    const { parts } = groupRows(Array.from({ length: 6 }, () => row(800, 250)));
    expect(parts).toHaveLength(1);
    expect(parts[0]?.qty).toBe(6);
    expect(parts[0]?.width).toBe(800);
  });

  it('keeps genuinely different sizes apart', () => {
    const { parts } = groupRows([row(800, 250), row(600, 250), row(800, 300)]);
    expect(parts).toHaveLength(3);
    expect(parts.map((p) => p.qty)).toEqual([1, 1, 1]);
  });

  it('keeps a 600x300 and a 300x600 as two rows', () => {
    // Grouping is on the oriented pair. For a grain-locked part these are
    // genuinely different parts, and merging them would quietly rotate a part
    // whose grain direction is the entire reason `locked` exists.
    const { parts } = groupRows([row(600, 300), row(300, 600)]);
    expect(parts).toHaveLength(2);
  });

  it('groups within the tolerance and not beyond it', () => {
    const inside = groupRows([row(800, 250), row(800 + GROUP_TOLERANCE_MM, 250)]);
    expect(inside.parts).toHaveLength(1);

    const outside = groupRows([row(800, 250), row(800 + GROUP_TOLERANCE_MM * 2, 250)]);
    expect(outside.parts).toHaveLength(2);
  });

  it('compares against the first member so a group cannot drift', () => {
    // Each of these is within tolerance of the one before it. Comparing against
    // a running maximum would chain them into one row 1.2mm wide at the ends -
    // wider than the tolerance the user was promised.
    const { parts } = groupRows([row(800, 250), row(800.4, 250), row(800.8, 250), row(801.2, 250)]);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts[0]?.qty).toBe(2);
  });

  it('takes the maximum in each axis, never the mean', () => {
    // A part that imports smaller than it was drawn does not fit; a part that
    // imports 0.3mm larger does.
    const { parts } = groupRows([row(800, 250), row(800.3, 249.8), row(799.9, 250.2)]);
    expect(parts).toHaveLength(1);
    expect(parts[0]?.width).toBeCloseTo(800.3, 10);
    expect(parts[0]?.height).toBeCloseTo(250.2, 10);
  });

  it('flags a row whose members disagree, and warns once', () => {
    const { parts, warnings } = groupRows([row(800, 250), row(800.3, 250)]);
    expect(parts[0]?.flags).toContainEqual({
      kind: 'size-spread',
      spreadMm: expect.closeTo(0.3, 10),
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.kind).toBe('size-spread');
    expect(warnings[0]?.message).toContain('0.3mm');
  });

  it('does not flag a spread at or under the threshold', () => {
    const { parts, warnings } = groupRows([row(800, 250), row(800 + SPREAD_FLAG_MM, 250)]);
    expect(parts[0]?.flags).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('counts flagged rows, not flagged shapes, in the one warning', () => {
    const { warnings } = groupRows([
      row(800, 250),
      row(800.3, 250),
      row(600, 250),
      row(600.4, 250),
    ]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.count).toBe(2);
    expect(warnings[0]?.message).toContain('0.4mm');
  });

  it('marks a row sheared when any of its members was', () => {
    const { parts } = groupRows([row(800, 250), row(800, 250, 'Shelf', true)]);
    expect(parts[0]?.flags).toContainEqual({ kind: 'sheared' });
    expect(parts[0]?.qty).toBe(2);
  });

  it('groups shapes drawn at different angles, since angle is advisory', () => {
    const straight: ShapeRow = { ...row(800, 250), box: { width: 800, height: 250, angle: 0 } };
    const tilted: ShapeRow = { ...row(800, 250), box: { width: 800, height: 250, angle: 30 } };
    const { parts } = groupRows([straight, tilted]);
    expect(parts).toHaveLength(1);
    expect(parts[0]?.qty).toBe(2);
    expect(parts[0]?.angle).toBe(0);
  });

  it('takes the first member label and keeps every source id', () => {
    const { parts } = groupRows([row(800, 250, 'Top Shelf'), row(800, 250, 'rect12')]);
    expect(parts[0]?.label).toBe('Top Shelf');
    expect(parts[0]?.sourceIds).toHaveLength(2);
  });

  it('preserves document order, so a re-import produces the same table', () => {
    const { parts } = groupRows([row(600, 300, 'B'), row(800, 250, 'A'), row(600, 300, 'B')]);
    expect(parts.map((p) => p.label)).toEqual(['B', 'A']);
    expect(parts.map((p) => p.qty)).toEqual([2, 1]);
  });

  it('returns nothing for nothing', () => {
    expect(groupRows([])).toEqual({ parts: [], warnings: [] });
  });
});
