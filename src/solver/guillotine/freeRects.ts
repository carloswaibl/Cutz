/**
 * The free-rectangle machinery of the guillotine packer.
 *
 * A sheet being packed is represented as a list of disjoint free rectangles.
 * Placing a part consumes one of them and replaces it with at most two children,
 * each of which is itself a rectangle that a later part could be placed in. That
 * representation is what makes the result cuttable: every child is bounded by
 * the edge-to-edge line the saw would follow, so a layout built this way is
 * guillotine-decomposable by construction rather than by luck.
 *
 * Everything here is a pure function of its arguments. There is no randomness in
 * this file or anywhere else under `solver/guillotine/` - the improvement pass
 * chooses which of these knobs to use, and does its choosing with the seeded PRNG.
 *
 * Millimetres throughout, origin top-left. Every dimension comparison goes
 * through the tolerant helpers in `domain/geometry.ts`; a bare `<=` here would
 * reject a part that fits its slot exactly but arrived via inch conversion.
 */

import { approxLte, area, EPSILON, fits, type Rect } from '../../domain/geometry';
import type { Part } from '../../domain/types';

/**
 * How the packer picks which free rectangle to place a part into.
 *
 * All three are from Jylänki's bin-packing survey. They disagree about what
 * "wasteful" means: `best-area` minimises the leftover area, while the two
 * side-fit rules minimise a single leftover dimension and so tend to leave one
 * long usable strip instead of two awkward ones.
 */
export type FitHeuristic = 'best-area' | 'best-short-side' | 'best-long-side';

/**
 * Which of the two possible guillotine cuts is made after a placement.
 *
 * A part in the corner of a free rectangle leaves an L-shaped remainder, and an
 * L is not a rectangle. One edge-to-edge cut splits it into two rectangles, and
 * there are two ways to make that cut. The `-leftover` rules choose based on how
 * much material is left over on each axis; the plain `-axis` rules choose based
 * on the free rectangle's own proportions.
 */
export type SplitRule = 'shorter-leftover' | 'longer-leftover' | 'shorter-axis' | 'longer-axis';

/**
 * The order part instances are offered to the packer in.
 *
 * First-fit-decreasing is the classic: big awkward parts placed while the sheet
 * is still empty, small ones used to fill what is left. `declaration` keeps the
 * user's own order and exists mainly so the improvement pass has an unsorted
 * baseline to perturb.
 */
export type PartOrder = 'area-desc' | 'longest-side-desc' | 'perimeter-desc' | 'declaration';

/** Which of the two cuts to make. See `SplitRule`. */
export type SplitAxis = 'horizontal' | 'vertical';

/** A part's footprint on the sheet in a particular orientation. */
export interface Footprint {
  width: number;
  height: number;
  rotated: boolean;
}

/**
 * The orientations a part may legally be placed in.
 *
 * Grain lock is a hard constraint, not a preference the packer may trade away
 * for a tighter pack: rotating a grain-locked panel puts the visible wood fibre
 * across the piece instead of along it, which is wrong in a way no waste
 * percentage captures. A square part is offered once, because its two
 * orientations are the same footprint and reporting `rotated: true` for one of
 * them would be a meaningless difference in saved output.
 */
export function orientations(part: Part): Footprint[] {
  const upright: Footprint = { width: part.width, height: part.height, rotated: false };
  if (part.rotationPolicy !== 'free90') return [upright];
  if (Math.abs(part.width - part.height) <= EPSILON) return [upright];
  return [upright, { width: part.height, height: part.width, rotated: true }];
}

// --- Fit scoring ---------------------------------------------------------

/**
 * How well a footprint fills a free rectangle. Lower is better.
 *
 * Only called when the footprint fits, so both leftovers are non-negative up to
 * float noise.
 */
export function fitScore(footprint: Footprint, rect: Rect, heuristic: FitHeuristic): number {
  const leftoverX = rect.width - footprint.width;
  const leftoverY = rect.height - footprint.height;
  switch (heuristic) {
    case 'best-area':
      return area(rect) - footprint.width * footprint.height;
    case 'best-short-side':
      return Math.min(leftoverX, leftoverY);
    case 'best-long-side':
      return Math.max(leftoverX, leftoverY);
  }
}

/**
 * Two candidate placements are only distinguishable if their scores differ by
 * more than float noise. Below that the caller's tie-break decides, which is
 * what keeps the packer deterministic across platforms.
 */
export function scoreIsBetter(candidate: number, incumbent: number): boolean {
  return candidate < incumbent - EPSILON;
}

// --- Splitting -----------------------------------------------------------

export function chooseSplitAxis(footprint: Footprint, rect: Rect, rule: SplitRule): SplitAxis {
  switch (rule) {
    case 'shorter-leftover':
      return rect.width - footprint.width < rect.height - footprint.height
        ? 'horizontal'
        : 'vertical';
    case 'longer-leftover':
      return rect.width - footprint.width >= rect.height - footprint.height
        ? 'horizontal'
        : 'vertical';
    case 'shorter-axis':
      return rect.width < rect.height ? 'horizontal' : 'vertical';
    case 'longer-axis':
      return rect.width >= rect.height ? 'horizontal' : 'vertical';
  }
}

/**
 * The rectangles left over after placing `footprint` in the top-left of `rect`.
 *
 * `horizontal` runs the full-width cut under the part, so the bottom child
 * inherits the parent's full width and the right child is only as tall as the
 * part. `vertical` runs the full-height cut beside it, so those roles swap.
 *
 * Kerf is charged on the far side of the part, once per cut, and **only when a
 * cut actually happens**. A part flush against the parent's right edge leaves no
 * right child, so no vertical cut is made there and no kerf is consumed - the
 * sheet edge was already an edge. Getting this backwards is the classic error:
 * charging kerf at the sheet boundary loses a blade's width of capacity per
 * side, which is exactly enough to make a part that should fit not fit.
 *
 * A child with no meaningful extent is not created at all rather than returned
 * empty, so the caller never has to filter.
 */
export function split(rect: Rect, footprint: Footprint, kerf: number, axis: SplitAxis): Rect[] {
  const rightX = rect.x + footprint.width + kerf;
  const bottomY = rect.y + footprint.height + kerf;
  const rightWidth = rect.width - footprint.width - kerf;
  const bottomHeight = rect.height - footprint.height - kerf;

  const right: Rect =
    axis === 'horizontal'
      ? { x: rightX, y: rect.y, width: rightWidth, height: footprint.height }
      : { x: rightX, y: rect.y, width: rightWidth, height: rect.height };
  const bottom: Rect =
    axis === 'horizontal'
      ? { x: rect.x, y: bottomY, width: rect.width, height: bottomHeight }
      : { x: rect.x, y: bottomY, width: footprint.width, height: bottomHeight };

  const children: Rect[] = [];
  if (right.width > EPSILON && right.height > EPSILON) children.push(right);
  if (bottom.width > EPSILON && bottom.height > EPSILON) children.push(bottom);
  return children;
}

// --- Free rectangle list -------------------------------------------------

/**
 * The free rectangles of one sheet.
 *
 * Deliberately not a set with merging. Jylänki's rectangle-merge improvement
 * recovers area by fusing adjacent free rectangles back together, and the fused
 * rectangle is generally *not* reachable by any sequence of edge-to-edge cuts -
 * so a packer that merges can quietly start emitting layouts that pass an
 * overlap check and cannot be cut on a table saw. If we ever want it, it goes in
 * behind the invariant checker, not before it.
 */
export class FreeRectList {
  private rects: Rect[];

  constructor(initial: Rect) {
    this.rects = [initial];
  }

  /** The current rectangles, in insertion order. Read-only view. */
  list(): readonly Rect[] {
    return this.rects;
  }

  /**
   * Replace the rectangle at `index` with what is left after a placement.
   *
   * The children take the parent's slot rather than being appended, which keeps
   * the list in rough spatial order and, more importantly, keeps the order a
   * pure function of the placement sequence - the tie-break below is on index.
   */
  place(index: number, footprint: Footprint, kerf: number, rule: SplitRule): void {
    const rect = this.rects[index];
    if (rect === undefined) {
      throw new Error(`free rectangle ${index} does not exist in a list of ${this.rects.length}`);
    }
    this.rects.splice(
      index,
      1,
      ...split(rect, footprint, kerf, chooseSplitAxis(footprint, rect, rule)),
    );
  }

  /**
   * Drop rectangles no remaining part could ever use.
   *
   * Pure bookkeeping - it changes nothing about which parts get placed, it just
   * keeps the list from growing a long tail of slivers that every later
   * placement has to score against.
   */
  prune(smallestWidth: number, smallestHeight: number): void {
    this.rects = this.rects.filter(
      (rect) => approxLte(smallestWidth, rect.width) && approxLte(smallestHeight, rect.height),
    );
  }
}

export interface Candidate {
  rectIndex: number;
  footprint: Footprint;
  score: number;
}

/**
 * The best free rectangle and orientation for a part, or `null` if it fits none.
 *
 * Ties break on free-rectangle index and then on orientation order (unrotated
 * before rotated), because a deterministic tie-break is the whole reason this
 * function returns a single answer instead of a set. `orientations` already
 * excludes anything the part's grain lock forbids, so nothing here has to think
 * about grain.
 */
export function bestFit(
  part: Part,
  rects: readonly Rect[],
  heuristic: FitHeuristic,
): Candidate | null {
  let best: Candidate | null = null;
  const shapes = orientations(part);

  for (let rectIndex = 0; rectIndex < rects.length; rectIndex += 1) {
    const rect = rects[rectIndex];
    if (rect === undefined) continue;
    for (const footprint of shapes) {
      if (!fits(footprint.width, footprint.height, rect)) continue;
      const score = fitScore(footprint, rect, heuristic);
      if (best === null || scoreIsBetter(score, best.score)) {
        best = { rectIndex, footprint, score };
      }
    }
  }

  return best;
}

// --- Part ordering -------------------------------------------------------

/**
 * The sort key for a part, descending. `declaration` returns a constant so the
 * stable sort leaves the input order untouched.
 */
function orderKey(part: Part, order: PartOrder): number {
  switch (order) {
    case 'area-desc':
      return part.width * part.height;
    case 'longest-side-desc':
      return Math.max(part.width, part.height);
    case 'perimeter-desc':
      return 2 * (part.width + part.height);
    case 'declaration':
      return 0;
  }
}

/**
 * Sort part instances for packing, largest first.
 *
 * Copies rather than sorting in place - nothing under `solver/` mutates its
 * input. `Array.prototype.sort` is stable in every engine we target, so equal
 * keys keep declaration order and the result is a pure function of the input.
 */
export function orderParts<T extends { part: Part }>(
  instances: readonly T[],
  order: PartOrder,
): T[] {
  return [...instances].sort((a, b) => orderKey(b.part, order) - orderKey(a.part, order));
}
