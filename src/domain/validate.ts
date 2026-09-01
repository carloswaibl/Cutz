/**
 * Input validation and `Result` invariant checking.
 *
 * Two responsibilities, deliberately in one file because both answer "does this
 * data make sense": one guards what goes into the solver, the other guards what
 * comes out.
 *
 * The output side is the more important half. A packing that has no overlaps
 * and is still impossible to cut on a table saw looks completely fine to a
 * naive check, and would be discovered by a woodworker standing at the saw with
 * a sheet of plywood they have already paid for. Everything the solver produces
 * goes through `checkResult` in the test suite for that reason.
 *
 * Nothing here throws on bad user data - it returns typed issues carrying a
 * user-facing message, so the caller always learns *which* input was wrong.
 * Throws are reserved for internal invariants that a caller cannot trigger.
 *
 * Pure and headless. Every dimension is millimetres.
 */

import { buildCutTree, type CheckStatus, DEFAULT_MAX_GUILLOTINE_STEPS } from './cutplan';
import {
  approxEq,
  approxGte,
  clearance,
  containsRect,
  EPSILON,
  fits,
  isEmpty,
  type Rect,
  usableArea,
} from './geometry';
import { parseStockInstanceId } from './instances';
import {
  boundsOf,
  isSelfIntersecting,
  partOutline,
  placedArea,
  placementPolygon,
  placementRect,
  polygonInRect,
  polygonSeparation,
  rotatePolygon,
} from './polygon';
import type { Part, Placement, Point, Result, SolverConfig, SolverMode, Stock } from './types';
import { formatLength } from './units';

// The search itself lives in `cutplan.ts`, which needs the tree this checker
// only needs a verdict from. Re-exported here so both halves of "does this data
// make sense" keep reading as one vocabulary.
export { type CheckStatus, DEFAULT_MAX_GUILLOTINE_STEPS } from './cutplan';

/**
 * Render a millimetre value for a message.
 *
 * Messages carry millimetres because that is the canonical unit and this module
 * has no business picking a display unit - every issue also carries the raw
 * number, so a UI showing inches can re-render it from the structured fields.
 */
function mm(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  return formatLength(value, { unit: 'mm', markApproximate: false });
}

// --- Input validation ----------------------------------------------------

/**
 * `error` means the solver must not run: the input is self-contradictory, or
 * running would produce a meaningless answer. `warning` means it will run and
 * the consequence shows up honestly in `unplacedParts`.
 */
export type IssueSeverity = 'error' | 'warning';

interface IssueMeta {
  severity: IssueSeverity;
  /** User-facing. Always names the part or sheet, and says what to do. */
  message: string;
}

export type InputIssue = IssueMeta &
  (
    | { kind: 'invalid-kerf'; kerf: number }
    | { kind: 'invalid-edge-trim'; edgeTrim: number }
    | { kind: 'invalid-seed'; seed: number }
    | { kind: 'duplicate-part-id'; partId: string }
    | { kind: 'duplicate-stock-id'; stockId: string }
    | { kind: 'invalid-part-dimension'; partId: string; field: 'width' | 'height'; value: number }
    | { kind: 'invalid-part-qty'; partId: string; qty: number }
    | { kind: 'invalid-stock-dimension'; stockId: string; field: 'width' | 'height'; value: number }
    | { kind: 'invalid-stock-qty'; stockId: string; qty: number }
    | { kind: 'edge-trim-leaves-no-usable-area'; stockId: string; edgeTrim: number }
    | { kind: 'no-stock-for-material'; partId: string; materialId: string }
    | { kind: 'part-too-large'; partId: string }
    | { kind: 'part-blocked-by-grain-lock'; partId: string }
    | { kind: 'outline-too-few-points'; partId: string; points: number }
    | { kind: 'outline-bounds-mismatch'; partId: string; bounds: Rect }
    | { kind: 'outline-self-intersecting'; partId: string }
    | { kind: 'unsupported-solver-mode'; mode: SolverMode }
  );

export function hasErrors(issues: readonly InputIssue[]): boolean {
  return issues.some((issue) => issue.severity === 'error');
}

function isPositiveLength(value: number): boolean {
  return Number.isFinite(value) && value > EPSILON;
}

function isValidQty(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1;
}

/**
 * The mode a config asks for, with the default applied.
 *
 * Guillotine is the default and what every project written before M7 opens as,
 * the same way `improve.ts` resolves an absent `effort` to 'balanced'.
 */
export function solverMode(config: SolverConfig): SolverMode {
  return config.mode ?? 'guillotine';
}

/** Equally spaced orientations over 360°, with the default step count applied. */
const DEFAULT_ROTATION_STEPS = 4;

/**
 * The angles a part may be turned to, in degrees.
 *
 * Guillotine has only ever had two: square, or quarter-turned if the grain
 * allows it. Nesting gets the configured step set - except that a grain-locked
 * part is restricted to {0, 180} regardless of how many steps were asked for,
 * because a half turn keeps the grain running along the same axis and every
 * other step does not. On an asymmetric outline that half turn is a real
 * packing win, and one `rotated: boolean` could never express.
 */
function allowedAngles(part: Part, mode: SolverMode, config: SolverConfig): number[] {
  if (part.rotationPolicy === 'locked') return mode === 'guillotine' ? [0] : [0, 180];
  if (mode === 'guillotine') return [0, 90];
  const steps = config.rotationSteps ?? DEFAULT_ROTATION_STEPS;
  return Array.from({ length: steps }, (_, i) => (i * 360) / steps);
}

/**
 * True when the part fits some usable area in an orientation it is allowed to
 * take.
 *
 * In guillotine mode the part is its bounding box, so this is the axis-aligned
 * fit it has always been. In nest mode the part can be turned to angles that
 * are not quarter turns, and a diagonal orientation has a different bounding
 * box - so the test is run against the real outline turned to each allowed
 * angle. Without that, `part-too-large` would warn about parts a nester can
 * place perfectly well.
 */
function fitsAnywhere(
  part: Part,
  areas: readonly Rect[],
  angles: readonly number[],
  mode: SolverMode,
): boolean {
  const outline = mode === 'nest' ? partOutline(part) : null;
  return angles.some((angle) => {
    const box =
      outline === null
        ? // A quarter turn swaps the box; anything else cannot occur here.
          angle % 180 === 0
          ? { width: part.width, height: part.height }
          : { width: part.height, height: part.width }
        : boundsOf(rotatePolygon(outline, angle));
    return areas.some((r) => fits(box.width, box.height, r));
  });
}

/**
 * Check solver inputs before packing.
 *
 * Geometric checks only run on entries that passed their own structural checks,
 * so one bad number produces one issue rather than a cascade of derived ones.
 */
export function validateInputs(
  parts: readonly Part[],
  stock: readonly Stock[],
  config: SolverConfig,
): InputIssue[] {
  const issues: InputIssue[] = [];
  const mode = solverMode(config);

  // The nesting engine arrives in a later M7 PR. Until it does, accepting
  // `mode: 'nest'` would produce a guillotine layout while `checkResult` stopped
  // asking whether that layout is cuttable - a config value that quietly
  // weakens validation and changes nothing else. Refusing it is cheap, and this
  // issue is deleted the moment `src/solver/nest/` exists.
  if (mode === 'nest') {
    issues.push({
      kind: 'unsupported-solver-mode',
      severity: 'error',
      mode,
      message:
        'Free-form nesting for a CNC router is not available yet. Set the machine to Table saw.',
    });
  }

  const kerfOk = Number.isFinite(config.kerf) && config.kerf >= 0;
  if (!kerfOk) {
    issues.push({
      kind: 'invalid-kerf',
      severity: 'error',
      kerf: config.kerf,
      message: `Kerf is ${mm(config.kerf)}. It must be zero or more - set it to 0 to ignore blade width.`,
    });
  }

  const edgeTrimOk = Number.isFinite(config.edgeTrim) && config.edgeTrim >= 0;
  if (!edgeTrimOk) {
    issues.push({
      kind: 'invalid-edge-trim',
      severity: 'error',
      edgeTrim: config.edgeTrim,
      message: `Edge trim is ${mm(config.edgeTrim)}. It must be zero or more - set it to 0 to use the full sheet.`,
    });
  }

  // A non-integer or non-finite seed makes the PRNG's output depend on float
  // rounding, which quietly costs us the reproducibility the seed exists for.
  if (!Number.isSafeInteger(config.seed)) {
    issues.push({
      kind: 'invalid-seed',
      severity: 'error',
      seed: config.seed,
      message: `Seed is ${config.seed}. It must be a whole number, so the same project always lays out the same way.`,
    });
  }

  const seenPartIds = new Set<string>();
  const validParts: Part[] = [];
  for (const part of parts) {
    if (seenPartIds.has(part.id)) {
      issues.push({
        kind: 'duplicate-part-id',
        severity: 'error',
        partId: part.id,
        message: `Two parts share the id "${part.id}". Part ids must be unique, or quantities cannot be tracked.`,
      });
      continue;
    }
    seenPartIds.add(part.id);

    let structurallyOk = true;
    for (const field of ['width', 'height'] as const) {
      const value = part[field];
      if (!isPositiveLength(value)) {
        structurallyOk = false;
        issues.push({
          kind: 'invalid-part-dimension',
          severity: 'error',
          partId: part.id,
          field,
          value,
          message: `Part "${part.label}" has a ${field} of ${mm(value)}. It must be greater than zero.`,
        });
      }
    }
    if (!isValidQty(part.qty)) {
      structurallyOk = false;
      issues.push({
        kind: 'invalid-part-qty',
        severity: 'error',
        partId: part.id,
        qty: part.qty,
        message: `Part "${part.label}" has a quantity of ${part.qty}. It must be a whole number of 1 or more.`,
      });
    }

    // The outline is only meaningful once the box it must match is sane, and it
    // is checked against the box rather than on its own terms: `width`/`height`
    // stay the bounding box in M7, and an outline that disagrees with them
    // would have every consumer reading one shape and drawing another.
    if (structurallyOk && part.outline !== undefined) {
      if (part.outline.length < 3) {
        structurallyOk = false;
        issues.push({
          kind: 'outline-too-few-points',
          severity: 'error',
          partId: part.id,
          points: part.outline.length,
          message: `Part "${part.label}" has an outline of ${part.outline.length} point(s). A shape needs at least three.`,
        });
      } else {
        const bounds = boundsOf(part.outline);
        const matches =
          approxEq(bounds.x, 0) &&
          approxEq(bounds.y, 0) &&
          approxEq(bounds.width, part.width) &&
          approxEq(bounds.height, part.height);
        if (!matches) {
          structurallyOk = false;
          issues.push({
            kind: 'outline-bounds-mismatch',
            severity: 'error',
            partId: part.id,
            bounds,
            message: `Part "${part.label}" is ${mm(part.width)} x ${mm(part.height)}, but its outline spans ${mm(bounds.width)} x ${mm(bounds.height)} from (${mm(bounds.x)}, ${mm(bounds.y)}). An outline must sit at the top-left of the part's own bounding box.`,
          });
        } else if (isSelfIntersecting(part.outline)) {
          // A warning, not an error: the packer and the renderer both cope, and
          // the area a self-crossing ring reports is merely odd rather than
          // unusable. The user is the one who can tell whether the drawing was
          // meant that way.
          issues.push({
            kind: 'outline-self-intersecting',
            severity: 'warning',
            partId: part.id,
            message: `Part "${part.label}" has an outline that crosses itself. Its area and its nested fit will be wrong; check the original drawing.`,
          });
        }
      }
    }

    if (structurallyOk) validParts.push(part);
  }

  const seenStockIds = new Set<string>();
  const validStock: Stock[] = [];
  for (const sheet of stock) {
    if (seenStockIds.has(sheet.id)) {
      issues.push({
        kind: 'duplicate-stock-id',
        severity: 'error',
        stockId: sheet.id,
        message: `Two stock entries share the id "${sheet.id}". Stock ids must be unique, or sheets cannot be told apart.`,
      });
      continue;
    }
    seenStockIds.add(sheet.id);

    let structurallyOk = true;
    for (const field of ['width', 'height'] as const) {
      const value = sheet[field];
      if (!isPositiveLength(value)) {
        structurallyOk = false;
        issues.push({
          kind: 'invalid-stock-dimension',
          severity: 'error',
          stockId: sheet.id,
          field,
          value,
          message: `Stock "${sheet.id}" has a ${field} of ${mm(value)}. It must be greater than zero.`,
        });
      }
    }
    if (!isValidQty(sheet.qty)) {
      structurallyOk = false;
      issues.push({
        kind: 'invalid-stock-qty',
        severity: 'error',
        stockId: sheet.id,
        qty: sheet.qty,
        message: `Stock "${sheet.id}" has a quantity of ${sheet.qty}. It must be a whole number of 1 or more.`,
      });
    }

    if (structurallyOk) validStock.push(sheet);
  }

  // Usable areas are only meaningful once both the trim and the sheet are sane.
  const usableByMaterial = new Map<string, Rect[]>();
  if (edgeTrimOk) {
    for (const sheet of validStock) {
      const usable = usableArea(sheet, config.edgeTrim);
      if (isEmpty(usable)) {
        issues.push({
          kind: 'edge-trim-leaves-no-usable-area',
          severity: 'error',
          stockId: sheet.id,
          edgeTrim: config.edgeTrim,
          message: `Trimming ${mm(config.edgeTrim)} off every edge of stock "${sheet.id}" (${mm(sheet.width)} x ${mm(sheet.height)}) leaves nothing to cut from. Check the trim is not in the wrong unit.`,
        });
        continue;
      }
      const areas = usableByMaterial.get(sheet.materialId);
      if (areas === undefined) usableByMaterial.set(sheet.materialId, [usable]);
      else areas.push(usable);
    }
  }

  const materialsInStock = new Set(validStock.map((sheet) => sheet.materialId));
  for (const part of validParts) {
    if (!materialsInStock.has(part.materialId)) {
      issues.push({
        kind: 'no-stock-for-material',
        severity: 'warning',
        partId: part.id,
        materialId: part.materialId,
        message: `Part "${part.label}" is made from material "${part.materialId}", but no stock of that material was listed. It cannot be placed.`,
      });
      continue;
    }

    const areas = usableByMaterial.get(part.materialId);
    // Every matching sheet was already reported as unusable; do not pile on.
    if (areas === undefined || areas.length === 0) continue;

    if (fitsAnywhere(part, areas, allowedAngles(part, mode, config), mode)) continue;

    // Grain lock reads very differently from "too big", and it is by far the
    // more likely mistake: the part does fit, just not the way round the grain
    // allows. Telling the user "too large" here would send them to re-measure
    // a part that is the right size.
    const unlocked = allowedAngles({ ...part, rotationPolicy: 'free90' }, mode, config);
    if (part.rotationPolicy === 'locked' && fitsAnywhere(part, areas, unlocked, mode)) {
      issues.push({
        kind: 'part-blocked-by-grain-lock',
        severity: 'warning',
        partId: part.id,
        message: `Part "${part.label}" (${mm(part.width)} x ${mm(part.height)}) only fits turned 90°, but its grain is locked so it cannot be turned. Unlock the grain, or use a larger sheet.`,
      });
      continue;
    }

    issues.push({
      kind: 'part-too-large',
      severity: 'warning',
      partId: part.id,
      message: `Part "${part.label}" (${mm(part.width)} x ${mm(part.height)}) is larger than the usable area of any stock of material "${part.materialId}". It cannot be placed.`,
    });
  }

  return issues;
}

// --- Guillotine decomposability ------------------------------------------

/**
 * Can `rects` be produced from `region` by a sequence of guillotine cuts?
 *
 * A guillotine cut runs edge to edge across the whole workpiece, because that
 * is the only cut a table saw can make. A layout that fails this is not merely
 * suboptimal, it is uncuttable with the tool the user owns - the classic
 * example being the pinwheel, four parts rotated around a centre, which has no
 * overlaps at all and no valid cut anywhere.
 *
 * The search lives in `cutplan.ts`, which needs the cut sequence it walks. This
 * checker needs only the verdict, and delegating is what stops the two from
 * ever disagreeing: a private second copy of the search here would eventually
 * bless a layout the printed cut plan cannot produce.
 *
 * `region` should be the sheet's *usable* area, and rectangles are assumed to
 * lie inside it and to clear each other by at least `kerf` - `checkResult`
 * covers both separately. See `buildCutTree` for why the candidate cuts it
 * enumerates are complete rather than a heuristic.
 */
export function checkGuillotine(
  region: Rect,
  rects: readonly Rect[],
  kerf: number,
  maxSteps: number = DEFAULT_MAX_GUILLOTINE_STEPS,
): CheckStatus {
  return buildCutTree(region, rects, kerf, { maxSteps }).status;
}

// --- Result invariant checking -------------------------------------------

interface ViolationMeta {
  /** Describes the specific defect, not just which rule was broken. */
  message: string;
}

export type ResultViolation = ViolationMeta &
  (
    | { kind: 'unknown-part'; partId: string }
    | { kind: 'unknown-stock-instance'; stockInstanceId: string }
    | { kind: 'duplicate-layout'; stockInstanceId: string }
    | {
        kind: 'kerf-separation';
        stockInstanceId: string;
        a: Placement;
        b: Placement;
        clearance: number;
        required: number;
      }
    | {
        kind: 'outside-usable-area';
        stockInstanceId: string;
        partId: string;
        footprint: Rect;
        usable: Rect;
      }
    | { kind: 'illegal-rotation'; stockInstanceId: string; partId: string; angleDeg: number }
    | { kind: 'non-quarter-angle'; stockInstanceId: string; partId: string; angleDeg: number }
    | { kind: 'not-guillotine-decomposable'; stockInstanceId: string }
    | {
        kind: 'material-mismatch';
        stockInstanceId: string;
        partId: string;
        partMaterialId: string;
        stockMaterialId: string;
      }
    | {
        kind: 'quantity-mismatch';
        partId: string;
        requested: number;
        placed: number;
        unplaced: number;
      }
    | { kind: 'invalid-unplaced-qty'; partId: string; qty: number }
    | { kind: 'layout-waste-mismatch'; stockInstanceId: string; reported: number; actual: number }
    | { kind: 'total-waste-mismatch'; reported: number; actual: number }
  );

export interface ResultCheckOptions {
  parts: readonly Part[];
  stock: readonly Stock[];
  config: SolverConfig;
  /** Override the guillotine search budget. Tests use this to exercise the cap. */
  maxGuillotineSteps?: number;
}

export interface ResultCheck {
  status: CheckStatus;
  violations: ResultViolation[];
  /** Sheets whose guillotine search ran out of budget and proved nothing. */
  unverifiedSheets: string[];
}

/**
 * Waste is a ratio in 0..1 built from sums of areas, so its float error is
 * relative and tiny. This is not `EPSILON`, which is a tolerance in millimetres
 * and would be far too loose here - 1e-6 of waste on a 4x8 sheet is 3mm².
 */
const WASTE_TOLERANCE = 1e-9;

/**
 * The angle, folded into `[0, 360)` so the tests below can be written once.
 *
 * A solver is free to emit -90 or 450; both name an orientation this checker
 * already has an opinion about, and rejecting them for their spelling would be
 * a rule about arithmetic rather than about woodworking.
 */
function normalizeAngle(angleDeg: number): number {
  if (!Number.isFinite(angleDeg)) return Number.NaN;
  return ((angleDeg % 360) + 360) % 360;
}

/** True when the part is left square to the sheet, or turned a half turn. */
function isHalfTurn(angleDeg: number): boolean {
  const a = normalizeAngle(angleDeg);
  return approxEq(a, 0) || approxEq(a, 180) || approxEq(a, 360);
}

/** True when the part is square to the sheet or on a quarter turn from it. */
function isQuarterTurn(angleDeg: number): boolean {
  const a = normalizeAngle(angleDeg);
  return [0, 90, 180, 270, 360].some((q) => approxEq(a, q));
}

/**
 * True when this placement should be measured as its bounding box rather than
 * as its real outline.
 *
 * **Mode decides this, not shape.** In guillotine mode a part *is* its bounding
 * box: the saw cuts a rectangle, so the material inside the box is gone whether
 * the drawn shape fills it or not - which is the same reason `placedArea`
 * charges the box in this mode. Measuring an imported outline here instead
 * would let two parts' boxes overlap as long as their curves cleared, and that
 * layout is exactly the uncuttable one this checker exists to catch.
 *
 * In nest mode the router follows the outline, so the polygon is the truth -
 * except for a part with no outline sitting on a quarter turn, where the box is
 * the same answer arrived at more cheaply.
 */
function isPlainBox(part: Part, placement: Placement, mode: SolverMode): boolean {
  if (mode === 'guillotine') return true;
  return part.outline === undefined && isQuarterTurn(placement.angleDeg);
}

/** Degrees for a message: whole numbers stay whole, the rest keep one decimal. */
function formatAngle(angleDeg: number): string {
  if (!Number.isFinite(angleDeg)) return `${angleDeg}°`;
  const rounded = Math.round(angleDeg * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}°`;
}

type StockLookup =
  | { ok: true; stock: Stock }
  | { ok: false; reason: 'malformed-id' | 'unknown-stock' | 'index-out-of-range' };

/**
 * Check a solver `Result` against every invariant.
 *
 * Returns specific violations rather than a boolean, because "this layout is
 * invalid" is not actionable and "these two parts on sheet ply18#0 are 1.5mm
 * apart but the blade is 3mm wide" is.
 */
export function checkResult(result: Result, options: ResultCheckOptions): ResultCheck {
  const { parts, stock, config } = options;
  const mode = solverMode(config);
  const partsById = new Map(parts.map((part) => [part.id, part]));
  const stockById = new Map(stock.map((sheet) => [sheet.id, sheet]));

  const violations: ResultViolation[] = [];
  const unverifiedSheets: string[] = [];

  // One report per missing part, however many places refer to it.
  const reportedUnknownParts = new Set<string>();
  function requirePart(partId: string): Part | null {
    const part = partsById.get(partId);
    if (part !== undefined) return part;
    if (!reportedUnknownParts.has(partId)) {
      reportedUnknownParts.add(partId);
      violations.push({
        kind: 'unknown-part',
        partId,
        message: `The result refers to part "${partId}", which is not in the part list.`,
      });
    }
    return null;
  }

  function lookUpStock(stockInstanceId: string): StockLookup {
    const ref = parseStockInstanceId(stockInstanceId);
    if (ref === null) return { ok: false, reason: 'malformed-id' };
    const sheet = stockById.get(ref.stockId);
    if (sheet === undefined) return { ok: false, reason: 'unknown-stock' };
    // Instance 3 of a stock entry with qty 3 is a sheet the user does not own.
    if (ref.index >= sheet.qty) return { ok: false, reason: 'index-out-of-range' };
    return { ok: true, stock: sheet };
  }

  // Invariant 6: quantity accounting, over every placement and unplaced entry.
  // Run across the whole result first, so a layout skipped below for a bad
  // stock reference still has its parts counted.
  const placedByPart = new Map<string, number>();
  for (const layout of result.layouts) {
    for (const placement of layout.placements) {
      placedByPart.set(placement.partId, (placedByPart.get(placement.partId) ?? 0) + 1);
    }
  }
  const unplacedByPart = new Map<string, number>();
  for (const entry of result.unplacedParts) {
    // Without this, a negative shortfall would let the accounting below balance
    // by cancellation - placing five of four parts and "unplacing" minus one
    // adds up perfectly and loses a part anyway.
    if (!Number.isSafeInteger(entry.qty) || entry.qty < 1) {
      violations.push({
        kind: 'invalid-unplaced-qty',
        partId: entry.partId,
        qty: entry.qty,
        message: `Part "${entry.partId}" is reported unplaced with a quantity of ${entry.qty}. A shortfall must be a whole number of 1 or more.`,
      });
      continue;
    }
    unplacedByPart.set(entry.partId, (unplacedByPart.get(entry.partId) ?? 0) + entry.qty);
  }
  for (const partId of new Set([...placedByPart.keys(), ...unplacedByPart.keys()])) {
    requirePart(partId);
  }
  for (const part of parts) {
    const placed = placedByPart.get(part.id) ?? 0;
    const unplaced = unplacedByPart.get(part.id) ?? 0;
    // Equality, not "at most": a part that is neither placed nor reported as
    // unplaced has been silently dropped, and nothing else would notice.
    if (placed + unplaced !== part.qty) {
      violations.push({
        kind: 'quantity-mismatch',
        partId: part.id,
        requested: part.qty,
        placed,
        unplaced,
        message: `Part "${part.label}" was requested ${part.qty} time(s) but the result accounts for ${placed + unplaced} (${placed} placed, ${unplaced} unplaced).`,
      });
    }
  }

  let placedAreaTotal = 0;
  let usedSheetAreaTotal = 0;
  let totalWasteComputable = true;
  const seenLayouts = new Set<string>();

  for (const layout of result.layouts) {
    const sheetId = layout.stockInstanceId;

    if (seenLayouts.has(sheetId)) {
      // Two layouts for one physical sheet means the per-sheet overlap checks
      // each see half the parts and both pass while the sheet is double-booked.
      violations.push({
        kind: 'duplicate-layout',
        stockInstanceId: sheetId,
        message: `Two layouts were produced for stock instance "${sheetId}". Each sheet may appear once.`,
      });
      totalWasteComputable = false;
      continue;
    }
    seenLayouts.add(sheetId);

    const lookup = lookUpStock(sheetId);
    if (!lookup.ok) {
      const detail =
        lookup.reason === 'malformed-id'
          ? 'it is not of the form "stockId#index"'
          : lookup.reason === 'unknown-stock'
            ? 'no stock entry has that id'
            : 'that stock entry does not have that many sheets';
      violations.push({
        kind: 'unknown-stock-instance',
        stockInstanceId: sheetId,
        message: `A layout was produced for stock instance "${sheetId}", but ${detail}.`,
      });
      totalWasteComputable = false;
      continue;
    }
    const sheet = lookup.stock;
    const usable = usableArea(sheet, config.edgeTrim);

    // Placements paired with the geometry they imply. Placements whose part is
    // unknown are dropped here, because without the part there is no footprint
    // and nothing geometric can be said - the unknown-part violation covers it.
    const placed: { placement: Placement; part: Part; footprint: Rect; polygon: Point[] }[] = [];
    let layoutComplete = true;
    let sheetPlacedArea = 0;

    for (const placement of layout.placements) {
      const part = requirePart(placement.partId);
      if (part === null) {
        layoutComplete = false;
        totalWasteComputable = false;
        continue;
      }

      const footprint = placementRect(part, placement);
      const polygon = placementPolygon(part, placement);
      placed.push({ placement, part, footprint, polygon });
      sheetPlacedArea += placedArea(part, mode);

      // Invariant 3: rotation legality. Grain lock is a hard constraint - a
      // rotated grain-locked panel is visibly wrong on a finished piece. A half
      // turn is legal even so: it leaves the grain running along the same axis.
      //
      // Measured against what the grain permits, deliberately not against
      // `config.rotationSteps` - that is a knob on the search, and a layout
      // already cut must not become invalid because someone re-solved the
      // project at a coarser step count.
      if (part.rotationPolicy !== 'free90' && !isHalfTurn(placement.angleDeg)) {
        violations.push({
          kind: 'illegal-rotation',
          stockInstanceId: sheetId,
          partId: part.id,
          angleDeg: placement.angleDeg,
          message: `Part "${part.label}" is placed at ${formatAngle(placement.angleDeg)} on "${sheetId}", but its grain is locked so it may only be left square or turned a half turn.`,
        });
      }

      // A table saw cuts square to the sheet and nothing else. This is not
      // covered by invariant 4 below: a part turned 45° still has a rectangular
      // bounding box, and a sheet of those boxes can tile guillotine-cleanly
      // while every part on it is uncuttable.
      if (mode === 'guillotine' && !isQuarterTurn(placement.angleDeg)) {
        violations.push({
          kind: 'non-quarter-angle',
          stockInstanceId: sheetId,
          partId: part.id,
          angleDeg: placement.angleDeg,
          message: `Part "${part.label}" is placed at ${formatAngle(placement.angleDeg)} on "${sheetId}". A table saw can only cut parts square to the sheet.`,
        });
      }

      // Invariant 5: material match.
      if (part.materialId !== sheet.materialId) {
        violations.push({
          kind: 'material-mismatch',
          stockInstanceId: sheetId,
          partId: part.id,
          partMaterialId: part.materialId,
          stockMaterialId: sheet.materialId,
          message: `Part "${part.label}" is made from "${part.materialId}" but is placed on "${sheetId}", which is "${sheet.materialId}".`,
        });
      }

      // Invariant 2: inside the usable area. The bounding box is the cheap and
      // exactly equivalent test for a part that is its own box; a real outline
      // at an angle needs the polygon, whose box can poke outside the sheet at
      // a corner while every part of the shape stays on it.
      const contained = isPlainBox(part, placement, mode)
        ? containsRect(usable, footprint)
        : polygonInRect(polygon, usable);
      if (!contained) {
        violations.push({
          kind: 'outside-usable-area',
          stockInstanceId: sheetId,
          partId: part.id,
          footprint,
          usable,
          message: `Part "${part.label}" at (${mm(footprint.x)}, ${mm(footprint.y)}) extends outside the usable area of "${sheetId}", which is ${mm(usable.width)} x ${mm(usable.height)} starting at (${mm(usable.x)}, ${mm(usable.y)}).`,
        });
      }
    }

    // Invariant 1: kerf separation. Every gap between two parts on a sheet was
    // made by a cut, and every cut eats a kerf of material - so parts that
    // clear each other by less than the kerf cannot both survive it.
    //
    // Which gap that is depends on the machine, and the two rules must not be
    // reconciled. A saw cut has an axis, so two boxes are separated as soon as
    // they clear on *one* of them - `clearance` takes the larger axis gap, and
    // inflating both parts would demand 2 * kerf and reject good layouts. A
    // router bit has no axis, so the real gap between two nested parts is the
    // Euclidean one. `polygon.ts` documents the divergence at length.
    for (let i = 0; i < placed.length; i += 1) {
      for (let j = i + 1; j < placed.length; j += 1) {
        const a = placed[i];
        const b = placed[j];
        if (a === undefined || b === undefined) continue;

        const gap =
          isPlainBox(a.part, a.placement, mode) && isPlainBox(b.part, b.placement, mode)
            ? clearance(a.footprint, b.footprint)
            : polygonSeparation(a.polygon, b.polygon);
        if (approxGte(gap, config.kerf)) continue;

        violations.push({
          kind: 'kerf-separation',
          stockInstanceId: sheetId,
          a: a.placement,
          b: b.placement,
          clearance: gap,
          required: config.kerf,
          message:
            gap < -EPSILON
              ? `Parts "${a.part.label}" and "${b.part.label}" overlap on "${sheetId}" by ${mm(-gap)}.`
              : `Parts "${a.part.label}" and "${b.part.label}" are only ${mm(gap)} apart on "${sheetId}", but the blade removes ${mm(config.kerf)}.`,
        });
      }
    }

    // Invariant 4: the layout must be cuttable on a table saw. Guillotine mode
    // only - a nested layout has no edge-to-edge cut sequence by construction,
    // so running this on one would fail every result the nester ever produces.
    if (mode === 'guillotine') {
      const guillotine = checkGuillotine(
        usable,
        placed.map((entry) => entry.footprint),
        config.kerf,
        options.maxGuillotineSteps,
      );
      if (guillotine === 'invalid') {
        violations.push({
          kind: 'not-guillotine-decomposable',
          stockInstanceId: sheetId,
          message: `The layout on "${sheetId}" cannot be produced by edge-to-edge cuts, so it is not cuttable on a table saw.`,
        });
      } else if (guillotine === 'unverified') {
        unverifiedSheets.push(sheetId);
      }
    }

    // Check 7: waste. Measured against the full sheet, since edge trim is
    // material that was bought and lost.
    const sheetArea = sheet.width * sheet.height;
    if (sheetArea > 0) {
      placedAreaTotal += sheetPlacedArea;
      usedSheetAreaTotal += sheetArea;
      const expected = 1 - sheetPlacedArea / sheetArea;
      // A layout with an unknown part has an unknowable area, so a mismatch
      // here would be an artefact of the missing part rather than a real one.
      if (layoutComplete && Math.abs(layout.wastePct - expected) > WASTE_TOLERANCE) {
        violations.push({
          kind: 'layout-waste-mismatch',
          stockInstanceId: sheetId,
          reported: layout.wastePct,
          actual: expected,
          message: `Layout "${sheetId}" reports ${(layout.wastePct * 100).toFixed(2)}% waste, but its placements give ${(expected * 100).toFixed(2)}%.`,
        });
      }
    } else {
      totalWasteComputable = false;
    }
  }

  // Only sheets that were actually opened count towards the total: owning ten
  // sheets and using two is not 80% waste.
  if (totalWasteComputable && usedSheetAreaTotal > 0) {
    const expected = 1 - placedAreaTotal / usedSheetAreaTotal;
    if (Math.abs(result.totalWastePct - expected) > WASTE_TOLERANCE) {
      violations.push({
        kind: 'total-waste-mismatch',
        reported: result.totalWastePct,
        actual: expected,
        message: `The result reports ${(result.totalWastePct * 100).toFixed(2)}% total waste, but the layouts give ${(expected * 100).toFixed(2)}%.`,
      });
    }
  }

  let status: CheckStatus = 'valid';
  if (violations.length > 0) status = 'invalid';
  else if (unverifiedSheets.length > 0) status = 'unverified';

  return { status, violations, unverifiedSheets };
}
