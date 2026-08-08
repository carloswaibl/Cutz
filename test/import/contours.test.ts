import { describe, expect, it } from 'vitest';
import type { Point } from '../../src/import/geometry';
import {
  CLOSE_GAP_TOLERANCE_MM,
  type Contour,
  classifySubpath,
  nestContours,
} from '../../src/import/svg/contours';
import { flattenPath, type Subpath } from '../../src/import/svg/flatten';
import { IDENTITY } from '../../src/import/svg/transform';

const subpath = (points: Point[], closedByZ = false): Subpath => ({ points, closedByZ });

const p = (x: number, y: number): Point => ({ x, y });

/** Every closed contour in a `d` attribute, which is how the walk will use these. */
function closedContours(d: string): Contour[] {
  const subpaths = flattenPath(d, IDENTITY);
  if (!subpaths) throw new Error(`expected to flatten: ${d}`);
  return subpaths.flatMap((sub) => {
    const classified = classifySubpath(sub);
    return classified.kind === 'closed' ? [classified.contour] : [];
  });
}

describe('classifySubpath', () => {
  it('accepts a path the author closed', () => {
    const result = classifySubpath(subpath([p(0, 0), p(100, 0), p(100, 50), p(0, 50)], true));
    expect(result.kind).toBe('closed');
  });

  it('forgives ends that miss by a drawing artefact, silently', () => {
    // A twentieth of a millimetre is somebody's editor rounding, not a
    // decision, and warning about it would be noise on every real file.
    const result = classifySubpath(subpath([p(0, 0), p(100, 0), p(100, 50), p(0, 0.05)]));
    expect(result.kind).toBe('closed');
  });

  it('reports a real gap, and how big it is', () => {
    // "your outline is open by 4mm" locates the problem; "unsupported path"
    // does not.
    const result = classifySubpath(subpath([p(0, 0), p(100, 0), p(100, 50), p(0, 4)]));
    expect(result).toEqual({ kind: 'open', gapMm: 4 });
  });

  it('draws the line between artefact and gap where the constant says', () => {
    const under = classifySubpath(
      subpath([p(0, 0), p(100, 0), p(100, 50), p(0, CLOSE_GAP_TOLERANCE_MM / 2)]),
    );
    const over = classifySubpath(
      subpath([p(0, 0), p(100, 0), p(100, 50), p(0, CLOSE_GAP_TOLERANCE_MM * 2)]),
    );
    expect(under.kind).toBe('closed');
    expect(over.kind).toBe('open');
  });

  it('calls a construction line degenerate rather than open', () => {
    // It is both. Telling a user to "close the path" on a registration mark
    // they never meant as a part is advice about the wrong thing, and there is
    // one of these per mark.
    expect(classifySubpath(subpath([p(0, 0), p(300, 0)])).kind).toBe('degenerate');
    expect(classifySubpath(subpath([p(0, 0), p(150, 150), p(300, 300)])).kind).toBe('degenerate');
  });

  it('drops a hairline and a stray point', () => {
    expect(
      classifySubpath(subpath([p(0, 0), p(200, 0), p(200, 0.02), p(0, 0.02)], true)).kind,
    ).toBe('degenerate');
    expect(classifySubpath(subpath([p(5, 5), p(5, 5), p(5, 5)], true)).kind).toBe('degenerate');
  });

  it('strips the repeated closing point authors write before Z', () => {
    const result = classifySubpath(
      subpath([p(0, 0), p(100, 0), p(100, 50), p(0, 50), p(0, 0)], true),
    );
    expect(result.kind === 'closed' && result.contour.points).toHaveLength(4);
  });

  it('measures the closed contour it returns', () => {
    const result = classifySubpath(subpath([p(0, 0), p(600, 0), p(600, 200), p(0, 200)], true));
    expect(result.kind === 'closed' && result.contour.box.width).toBeCloseTo(600, 9);
    expect(result.kind === 'closed' && result.contour.box.height).toBeCloseTo(200, 9);
  });
});

describe('nestContours', () => {
  it('turns a donut into one part and one hole', () => {
    // The hole is a cutout the user drills or routs after the sheet is cut; a
    // table saw cannot make it, so it is not part of the layout.
    const contours = closedContours('M 0 0 H 400 V 300 H 0 Z M 100 100 H 200 V 200 H 100 Z');
    const nested = nestContours(contours);
    expect(nested.outers).toHaveLength(1);
    expect(nested.holeCount).toBe(1);
    expect(nested.outers[0]?.box.width).toBeCloseTo(400, 9);
  });

  it('does not let a hole change the size of the part it sits in', () => {
    const solid = nestContours(closedContours('M 0 0 H 400 V 300 H 0 Z'));
    const holed = nestContours(
      closedContours('M 0 0 H 400 V 300 H 0 Z M 100 100 H 300 V 200 H 100 Z'),
    );
    expect(holed.outers[0]?.box.width).toBeCloseTo(solid.outers[0]?.box.width ?? 0, 9);
    expect(holed.outers[0]?.box.height).toBeCloseTo(solid.outers[0]?.box.height ?? 0, 9);
  });

  it('turns two disjoint contours in one path into two parts', () => {
    const nested = nestContours(
      closedContours('M 0 0 H 400 V 300 H 0 Z M 600 0 H 900 V 300 H 600 Z'),
    );
    expect(nested.outers).toHaveLength(2);
    expect(nested.holeCount).toBe(0);
  });

  it('keeps a neighbour whose bounds nest but which is outside the shape', () => {
    // An L-shaped part with a small square parked in its notch. Nested bounds
    // alone would call the square a hole and lose a part.
    const ell = 'M 0 0 H 400 V 160 H 160 V 400 H 0 Z';
    const square = 'M 240 240 H 340 V 340 H 240 Z';
    const nested = nestContours(closedContours(`${ell} ${square}`));
    expect(nested.outers).toHaveLength(2);
    expect(nested.holeCount).toBe(0);
  });

  it('does not let a pair of identical duplicate paths swallow each other', () => {
    // Illustrator emits exact duplicates routinely. If each counted as inside
    // the other, both would vanish and the drawing would import empty.
    const nested = nestContours(closedContours('M 0 0 H 400 V 300 H 0 Z M 0 0 H 400 V 300 H 0 Z'));
    expect(nested.outers).toHaveLength(2);
    expect(nested.holeCount).toBe(0);
  });

  it('counts a shape inside a hole as a hole too', () => {
    // Not a distinction a table saw can act on, and the alternative is a
    // winding-parity rule this cannot honestly claim to implement.
    const nested = nestContours(
      closedContours(
        'M 0 0 H 400 V 400 H 0 Z M 100 100 H 300 V 300 H 100 Z M 150 150 H 250 V 250 H 150 Z',
      ),
    );
    expect(nested.outers).toHaveLength(1);
    expect(nested.holeCount).toBe(2);
  });

  it('handles no contours at all', () => {
    expect(nestContours([])).toEqual({ outers: [], holeCount: 0 });
  });
});
