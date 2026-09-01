/**
 * Contour to `Part.outline` - `docs/plan-m7.md` §5 PR 4. Pure, so it runs in
 * the default node environment.
 */

import { describe, expect, it } from 'vitest';
import { EPSILON } from '../../src/domain/geometry';
import { boundsOf, minAreaBox, signedArea2 } from '../../src/domain/polygon';
import type { Point } from '../../src/domain/types';
import type { Contour } from '../../src/import/contours';
import {
  isBoxOutline,
  OUTLINE_SIMPLIFY_TOLERANCE_MM,
  partLocalOutline,
} from '../../src/import/outline';

const p = (x: number, y: number): Point => ({ x, y });

/** A contour as the importers build one: points measured, box derived from them. */
function contour(points: Point[]): Contour {
  return { points, box: minAreaBox(points) };
}

/** `points` turned `degrees` clockwise about the origin, as a drawing would be. */
function drawnAt(points: Point[], degrees: number): Point[] {
  const radians = (degrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return points.map((point) => p(point.x * cos - point.y * sin, point.x * sin + point.y * cos));
}

const RECT: Point[] = [p(0, 0), p(600, 0), p(600, 300), p(0, 300)];
const L_SHAPE: Point[] = [p(0, 0), p(600, 0), p(600, 150), p(300, 150), p(300, 300), p(0, 300)];

/** A circle sampled the way curve flattening produces one: many short chords. */
function flattenedCircle(radius: number, samples: number): Point[] {
  return Array.from({ length: samples }, (_, i) => {
    const t = (i / samples) * Math.PI * 2;
    return p(radius + radius * Math.cos(t), radius + radius * Math.sin(t));
  });
}

function boundsWithin(points: readonly Point[], width: number, height: number): boolean {
  const bounds = boundsOf(points);
  return (
    Math.abs(bounds.x) <= EPSILON &&
    Math.abs(bounds.y) <= EPSILON &&
    Math.abs(bounds.width - width) <= EPSILON &&
    Math.abs(bounds.height - height) <= EPSILON
  );
}

describe('partLocalOutline', () => {
  it('leaves a shape already square to the canvas where it is', () => {
    expect(partLocalOutline(contour(L_SHAPE))).toEqual(L_SHAPE);
  });

  it('squares a shape drawn at an angle to its own bounding box', () => {
    // The whole point of the un-rotation step: a shelf drawn at 30 degrees is a
    // shelf, and `Part.outline` is defined in the part's own frame, not the
    // drawing's. Every corner must come back on the box.
    const measured = contour(drawnAt(RECT, 30));
    const outline = partLocalOutline(measured);
    expect(boundsWithin(outline, measured.box.width, measured.box.height)).toBe(true);
    for (const point of outline) {
      expect(
        (Math.abs(point.x) <= EPSILON || Math.abs(point.x - measured.box.width) <= EPSILON) &&
          (Math.abs(point.y) <= EPSILON || Math.abs(point.y - measured.box.height) <= EPSILON),
      ).toBe(true);
    }
  });

  it.each([0, 12, 30, 45, 67.5, 89])('spans its box exactly when drawn at %s degrees', (angle) => {
    // `outline-bounds-mismatch` is an error that blocks solving for every
    // material at once, so "close enough" is not a category here.
    const measured = contour(drawnAt(L_SHAPE, angle));
    const outline = partLocalOutline(measured);
    expect(boundsWithin(outline, measured.box.width, measured.box.height)).toBe(true);
  });

  it('winds clockwise whichever way the shape was drawn', () => {
    // `partOutline()` documents its return as clockwise and the rectangle it
    // synthesises for an outline-less part is. An SVG path may be drawn either
    // way, so without normalising here that promise would hold by luck.
    const forward = partLocalOutline(contour(L_SHAPE));
    const backward = partLocalOutline(contour([...L_SHAPE].reverse()));
    expect(signedArea2(forward)).toBeGreaterThan(0);
    expect(signedArea2(backward)).toBeGreaterThan(0);
  });

  it('drops the vertices a flattened curve does not need', () => {
    const flattened = flattenedCircle(150, 2000);
    const outline = partLocalOutline(contour(flattened));
    expect(outline.length).toBeLessThan(flattened.length / 8);
    // Still a circle: every kept vertex sits on the radius.
    for (const point of outline) {
      expect(Math.hypot(point.x - 150, point.y - 150)).toBeCloseTo(150, 0);
    }
  });

  it('lands on the same ring however finely the exporter sampled the curve', () => {
    // The vertex count a curve keeps is set by the tolerance and the radius, not
    // by how many segments whatever produced the file happened to emit. That is
    // what makes this a normalisation rather than a compression: the same circle
    // exported from two programs at different flattening settings arrives as the
    // same part, and two copies of it still group into a quantity of two.
    const coarse = partLocalOutline(contour(flattenedCircle(150, 240)));
    const fine = partLocalOutline(contour(flattenedCircle(150, 2000)));
    expect(fine.length).toBe(coarse.length);
  });

  it('keeps a simplified shape within tolerance of the one it came from', () => {
    const flattened = flattenedCircle(150, 240);
    const outline = partLocalOutline(contour(flattened));
    // Every original vertex is still within the tolerance of the kept ring, so
    // the shape a router follows is the shape that was drawn.
    for (const original of flattened) {
      expect(distanceToRing(original, outline)).toBeLessThanOrEqual(
        OUTLINE_SIMPLIFY_TOLERANCE_MM + EPSILON,
      );
    }
  });
});

describe('isBoxOutline', () => {
  it('recognises a rectangle however the path started', () => {
    expect(isBoxOutline(RECT, 600, 300)).toBe(true);
    // Authors and exporters start a rectangle wherever they like; which corner
    // came first is the editor talking, not a different shape.
    expect(isBoxOutline([p(600, 300), p(0, 300), p(0, 0), p(600, 0)], 600, 300)).toBe(true);
  });

  it('rejects a shape that merely fills the same box', () => {
    expect(isBoxOutline(L_SHAPE, 600, 300)).toBe(false);
    // A diamond touches all four edges and no corner. Four points is not enough.
    expect(isBoxOutline([p(300, 0), p(600, 150), p(300, 300), p(0, 150)], 600, 300)).toBe(false);
  });

  it('rejects a rectangle measured against a different box', () => {
    expect(isBoxOutline(RECT, 600, 299)).toBe(false);
  });

  it('agrees with what the importers actually produce for a rectangle', () => {
    // The end-to-end claim: a drawing of rectangular panels stores no outlines
    // at all, so an imported panel is structurally identical to a typed one.
    const measured = contour(RECT);
    expect(isBoxOutline(partLocalOutline(measured), measured.box.width, measured.box.height)).toBe(
      true,
    );
  });
});

/** Shortest distance from a point to a closed ring's boundary. */
function distanceToRing(point: Point, ring: readonly Point[]): number {
  let nearest = Number.POSITIVE_INFINITY;
  for (let i = 0; i < ring.length; i += 1) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    if (!a || !b) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSquared = dx * dx + dy * dy;
    const t =
      lengthSquared === 0
        ? 0
        : Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared));
    nearest = Math.min(nearest, Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy)));
  }
  return nearest;
}
