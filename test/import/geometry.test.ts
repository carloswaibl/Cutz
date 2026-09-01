import { describe, expect, it } from 'vitest';
import { minAreaBox, type Point } from '../../src/domain/polygon';
import { isDegenerate } from '../../src/import/geometry';

const p = (x: number, y: number): Point => ({ x, y });

describe('isDegenerate', () => {
  it('rejects a hairline that has enough area to pass on area alone', () => {
    // 200 x 0.05mm is 10mm². Area alone would let it through.
    expect(isDegenerate({ width: 200, height: 0.05, angle: 0 })).toBe(true);
  });

  it('rejects a dot too small to be any part', () => {
    expect(isDegenerate({ width: 0.9, height: 0.9, angle: 0 })).toBe(true);
  });

  it('keeps a small but real shape, leaving the call to the user', () => {
    expect(isDegenerate({ width: 20, height: 20, angle: 0 })).toBe(false);
    expect(isDegenerate({ width: 2, height: 2, angle: 0 })).toBe(false);
  });

  it('rejects the zero-height box minAreaBox returns for a straight line', () => {
    // The two halves of one decision: `minAreaBox` deliberately reports a line
    // as having no width rather than falling back to its 100x100 diagonal
    // bounds, and this is the threshold that then drops it.
    expect(isDegenerate(minAreaBox([p(0, 0), p(50, 50), p(100, 100)]))).toBe(true);
  });
});
