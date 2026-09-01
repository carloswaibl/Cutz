/**
 * Identical shapes collapse into one row with a quantity.
 *
 * A drawing of a bookshelf has six shelves on it as six rectangles. A parts
 * table wants one row saying six. Getting this wrong in either direction is
 * expensive: six rows is a table nobody wants to edit, and one row of six when
 * they were not actually the same size is a shelf that does not fit.
 *
 * Shared between both importers - originally SVG-only, moved here for M5
 * because grouping applies identically to a slab's projected boxes across a
 * multi-file STL drop (`docs/plan-m5.md` §4.9). Nothing below is specific to
 * either source format.
 */

import { EPSILON } from '../domain/geometry';
import { fitPolygonToBox, type OrientedBox } from '../domain/polygon';
import type { Point } from '../domain/types';
import { sizeSpread } from './errors';
import { isBoxOutline } from './outline';
import type { ImportedPart, ImportWarning, PartFlag } from './types';

/**
 * How far two shapes may disagree and still be the same part.
 *
 * Half a millimetre is below what a table saw can hold and above what curve
 * flattening and float arithmetic introduce, so it separates "the same
 * rectangle drawn twice" from "two rectangles" without a user having to think
 * about either.
 */
export const GROUP_TOLERANCE_MM = 0.5;

/**
 * The spread above which a row says so.
 *
 * Well below the grouping tolerance, because these answer different questions.
 * The tolerance decides whether shapes are the same part; this decides whether
 * the disagreement is large enough that the *drawing* is probably wrong. A
 * fifth of a millimetre across six shelves is a drawing somebody should look at
 * again before cutting.
 */
export const SPREAD_FLAG_MM = 0.2;

/** One shape that survived the walk, before quantities are worked out. */
export interface ShapeRow {
  label: string;
  box: OrientedBox;
  /**
   * The shape's real polygon, part-local and square to `box`, from
   * `partLocalOutline`. Always present here even for a plain rectangle - the
   * decision to *store* one is made once, in `groupRows`, after grouping has
   * settled what the part's dimensions actually are.
   */
  outline: Point[];
  /** The source element's id, or a synthesised stand-in when it had none. */
  sourceId: string;
  sheared: boolean;
}

interface Group {
  /**
   * The first member's dimensions, and what every later candidate is compared
   * against. Comparing against a running maximum instead would let a group
   * drift: each shape within tolerance of the last, the whole chain far wider
   * than the tolerance the user was promised.
   */
  anchorWidth: number;
  anchorHeight: number;
  minWidth: number;
  maxWidth: number;
  minHeight: number;
  maxHeight: number;
  label: string;
  angle: number;
  /**
   * The first member's shape, like `label` and `angle` beside it.
   *
   * Members of a group agree on their dimensions to within
   * `GROUP_TOLERANCE_MM` but say nothing about agreeing on their shape, and
   * there is no meaningful average of six polygons. The first is the one whose
   * label and angle the row already reports, so it is the one a user checking
   * the row against their drawing would look at.
   */
  outline: Point[];
  sourceIds: string[];
  sheared: boolean;
  count: number;
}

/**
 * Collapse rows into parts with quantities.
 *
 * Grouping is on the **oriented** pair, not the unordered one: a 600x300 and a
 * 300x600 stay two rows. They are visually distinct in the drawing, the user
 * drew them that way, and for a grain-locked part they are genuinely different
 * parts - merging them would quietly rotate a part whose grain direction is the
 * entire reason `rotationPolicy: 'locked'` exists. A user who does want them
 * merged edits one row in the preview.
 *
 * Angle is not part of the key. Two identical shelves, one drawn straight and
 * one drawn at 30 degrees, are one part with a quantity of two - the angle is
 * advisory, reported so the user can see the oriented box did the right thing,
 * and it never reaches `Part`.
 *
 * Order is first appearance in the document, so re-importing the same file
 * produces the same table in the same order.
 */
export function groupRows(rows: readonly ShapeRow[]): {
  parts: ImportedPart[];
  warnings: ImportWarning[];
} {
  const groups: Group[] = [];

  for (const row of rows) {
    const { width, height } = row.box;
    const existing = groups.find(
      (group) =>
        Math.abs(width - group.anchorWidth) <= GROUP_TOLERANCE_MM &&
        Math.abs(height - group.anchorHeight) <= GROUP_TOLERANCE_MM,
    );

    if (!existing) {
      groups.push({
        anchorWidth: width,
        anchorHeight: height,
        minWidth: width,
        maxWidth: width,
        minHeight: height,
        maxHeight: height,
        label: row.label,
        angle: row.box.angle,
        outline: row.outline,
        sourceIds: [row.sourceId],
        sheared: row.sheared,
        count: 1,
      });
      continue;
    }

    existing.minWidth = Math.min(existing.minWidth, width);
    existing.maxWidth = Math.max(existing.maxWidth, width);
    existing.minHeight = Math.min(existing.minHeight, height);
    existing.maxHeight = Math.max(existing.maxHeight, height);
    existing.sourceIds.push(row.sourceId);
    existing.sheared = existing.sheared || row.sheared;
    existing.count += 1;
  }

  let flaggedRows = 0;
  let largestSpread = 0;

  const parts = groups.map((group): ImportedPart => {
    const spread = Math.max(group.maxWidth - group.minWidth, group.maxHeight - group.minHeight);
    const flags: PartFlag[] = [];
    if (group.sheared) flags.push({ kind: 'sheared' });
    // Nudged by EPSILON so a spread of exactly the threshold does not flag or
    // not depending on float noise - `800 + 0.2 - 800` is 0.2000000000000455,
    // and a woodworking judgement about a fifth of a millimetre should not turn
    // on the fifteenth decimal place.
    if (spread > SPREAD_FLAG_MM + EPSILON) {
      flags.push({ kind: 'size-spread', spreadMm: spread });
      flaggedRows += 1;
      largestSpread = Math.max(largestSpread, spread);
    }

    // The maximum in each axis, never the mean. A part that imports smaller
    // than it was drawn does not fit; a part that imports 0.3mm larger does.
    const width = group.maxWidth;
    const height = group.maxHeight;

    // Re-fit rather than trust: the anchor's own shape may be up to
    // `GROUP_TOLERANCE_MM` under the maximum the row reports, and an outline
    // whose bounds disagree with the part's dimensions is a hard validation
    // error rather than a rounding complaint.
    const outline = fitPolygonToBox(group.outline, width, height);

    return {
      label: group.label,
      width,
      height,
      qty: group.count,
      angle: group.angle,
      // A shape that is its own bounding box carries no outline: `partOutline()`
      // synthesises exactly those four corners, so storing them would make an
      // imported rectangle structurally different from a typed one for no
      // difference a user could observe.
      ...(isBoxOutline(outline, width, height) ? {} : { outline }),
      flags,
      sourceIds: group.sourceIds,
    };
  });

  // The shear warning is the walk's to emit - it counts shapes as it meets
  // them, and by the time rows reach here several may have folded into one.
  const warnings = flaggedRows > 0 ? [sizeSpread(largestSpread, flaggedRows)] : [];

  return { parts, warnings };
}
