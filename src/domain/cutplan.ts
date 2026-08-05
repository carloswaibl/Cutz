/**
 * Guillotine cut-tree derivation: turning a layout into an order of operations.
 *
 * A `Layout` says where the parts sit. It does not say how to get them there,
 * and those are genuinely different things - the layout is the destination, the
 * cut plan is the route. A woodworker at a table saw needs the route: which
 * piece to pick up, which way to run it through the blade, and what to set the
 * fence to.
 *
 * This module owns the search for that route, and `validate.checkGuillotine`
 * delegates to it. The alternative - a checker with its own private copy of the
 * search - is how a checker ends up agreeing with the bug it exists to catch,
 * which is the same argument `geometry.ts` makes for hosting the shared
 * rectangle predicates in one place.
 *
 * The checker's base case is deliberately *not* good enough on its own. It stops
 * when a region holds a single rectangle, reasoning that the region's boundary is
 * itself made of guillotine cuts. That is sound for proving cuttability and
 * useless at a saw: a 300x400 offcut holding a 250x400 part still needs real cuts
 * to bring it to size. So the plan continues past that base case and emits
 * *finishing* cuts, and the checker simply ignores them.
 *
 * Pure and headless. Every dimension is millimetres. Origin is top-left, x right,
 * y down.
 */

import {
  approxGte,
  approxLte,
  bottom,
  EPSILON,
  isEmpty,
  placementRect,
  type Rect,
  right,
  usableArea,
} from './geometry';
import { parseStockInstanceId } from './instances';
import type { Layout, Material, Part, Placement, Result, SolverConfig, Stock } from './types';

// --- Search ---------------------------------------------------------------

/**
 * `unverified` means the search gave up before proving anything either way.
 *
 * It is deliberately distinct from `valid`. A checker that silently downgrades
 * "I ran out of budget" to "looks fine" is worse than no checker at all, since
 * it converts an unknown into a false assurance.
 */
export type CheckStatus = 'valid' | 'invalid' | 'unverified';

/**
 * Step cap for the decomposability search.
 *
 * The search is exponential in the worst case. Memoisation on the region
 * collapses it for realistic layouts - the regions a sequence of full-width
 * cuts can produce are heavily shared - but an adversarial arrangement can
 * still blow up, and hanging is not an acceptable failure mode for a checker.
 */
export const DEFAULT_MAX_GUILLOTINE_STEPS = 200_000;

/** Which axis the blade line divides. `x` is a vertical line at constant x. */
export type CutAxis = 'x' | 'y';

/**
 * A node in the cut tree.
 *
 * A `leaf` is a region the search stopped at: either the single rectangle it
 * holds, or nothing at all when it is pure offcut.
 */
export type CutNode =
  | { kind: 'leaf'; region: Rect; rect: Rect | null }
  | {
      kind: 'split';
      region: Rect;
      axis: CutAxis;
      /** Blade near-face position in sheet coordinates. */
      at: number;
      near: CutNode;
      far: CutNode;
    };

export interface CutTreeOptions {
  /**
   * Axis to try first at every region. A preference only - it changes which
   * valid decomposition is found, never whether one is found.
   */
  preferAxis?: CutAxis;
  maxSteps?: number;
}

export type CutTreeResult =
  | { status: 'valid'; tree: CutNode }
  | { status: 'invalid' | 'unverified' };

/** The winning cut at a region, kept so the tree can be rebuilt without re-searching. */
interface ChosenCut {
  axis: CutAxis;
  at: number;
  nearRegion: Rect;
  farRegion: Rect;
  near: Rect[];
  far: Rect[];
}

/**
 * Can `rects` be produced from `region` by a sequence of guillotine cuts, and if
 * so, which sequence?
 *
 * A guillotine cut runs edge to edge across the whole workpiece, because that
 * is the only cut a table saw can make. A layout that fails this is not merely
 * suboptimal, it is uncuttable with the tool the user owns - the classic
 * example being the pinwheel, four parts rotated around a centre, which has no
 * overlaps at all and no valid cut anywhere.
 *
 * `region` should be the sheet's *usable* area: the edge trim cuts are
 * themselves guillotine cuts and are always valid, so they are not searched.
 * Rectangles are assumed to lie inside `region` and to clear each other by at
 * least `kerf`; both are checked separately by `checkResult`, and this function
 * answers only the cuttability question.
 *
 * Candidate cuts are taken at the far edge of each rectangle only. That is
 * complete rather than a heuristic: any valid cut can be slid back towards the
 * near edge until it rests on the far edge of some rectangle on its near side,
 * and sliding it that way cannot invalidate it. The search backtracks fully
 * over those candidates, because taking the first valid cut is not sound.
 *
 * The tree is reconstructed in a second pass from a memo of winning cuts rather
 * than built during the search. Building nodes as it goes would allocate on
 * every abandoned branch, and this search runs on every solver output in the
 * test suite.
 */
export function buildCutTree(
  region: Rect,
  rects: readonly Rect[],
  kerf: number,
  options: CutTreeOptions = {},
): CutTreeResult {
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_GUILLOTINE_STEPS;
  const firstAxis: CutAxis = options.preferAxis ?? 'x';
  const secondAxis: CutAxis = firstAxis === 'x' ? 'y' : 'x';

  const memo = new Map<string, CheckStatus>();
  const chosen = new Map<string, ChosenCut>();
  let steps = 0;

  // The set of rectangles inside a region is fully determined by the region, so
  // the region alone is a sound cache key. Float noise can spell the same
  // region two ways, which costs a cache miss and nothing else.
  const key = (r: Rect): string =>
    `${r.x.toFixed(6)},${r.y.toFixed(6)},${r.width.toFixed(6)},${r.height.toFixed(6)}`;

  function cutAlong(
    region: Rect,
    items: readonly Rect[],
    axis: CutAxis,
  ): { status: CheckStatus; cut: ChosenCut | null } {
    const near = (r: Rect): number => (axis === 'x' ? r.x : r.y);
    const far = (r: Rect): number => (axis === 'x' ? right(r) : bottom(r));
    const regionNear = near(region);
    const regionFar = far(region);

    let sawUnverified = false;
    // Sorted rather than taken in placement order, so the decomposition the
    // search settles on is the same one on every run. Reordering the parts of a
    // layout must not reorder the cut list the user is holding.
    const candidates = [...new Set(items.map(far))].sort((a, b) => a - b);

    for (const cut of candidates) {
      // The cut must fall strictly inside the region, and the blade itself has
      // to land on material that is there.
      if (cut <= regionNear + EPSILON) continue;
      if (!approxLte(cut + kerf, regionFar)) continue;

      const before: Rect[] = [];
      const after: Rect[] = [];
      let straddled = false;
      for (const item of items) {
        if (approxLte(far(item), cut)) before.push(item);
        else if (approxGte(near(item), cut + kerf)) after.push(item);
        else {
          // The blade would pass through this part. Not a cut we can make.
          straddled = true;
          break;
        }
      }
      // A cut with everything on one side makes no progress.
      if (straddled || before.length === 0 || after.length === 0) continue;

      const beforeRegion = sliceNear(region, axis, cut);
      const afterRegion = sliceFar(region, axis, cut, kerf);

      const beforeStatus = decompose(beforeRegion, before);
      if (beforeStatus === 'invalid') continue;
      const afterStatus = decompose(afterRegion, after);
      if (afterStatus === 'invalid') continue;
      if (beforeStatus === 'valid' && afterStatus === 'valid') {
        return {
          status: 'valid',
          cut: {
            axis,
            at: cut,
            nearRegion: beforeRegion,
            farRegion: afterRegion,
            near: before,
            far: after,
          },
        };
      }
      sawUnverified = true;
    }

    return { status: sawUnverified ? 'unverified' : 'invalid', cut: null };
  }

  function decompose(region: Rect, items: readonly Rect[]): CheckStatus {
    // One rectangle in a region it fits inside needs no further *proof*: the
    // region's own boundary is the last set of cuts, and those are guillotine
    // cuts by construction. `buildCutPlan` picks up from here and emits the
    // finishing cuts that actually bring the part to size.
    if (items.length <= 1) return 'valid';

    const cacheKey = key(region);
    const cached = memo.get(cacheKey);
    if (cached !== undefined) return cached;

    // Not memoised: this is a budget outcome, not a property of the region.
    if (steps >= maxSteps) return 'unverified';
    steps += 1;

    const first = cutAlong(region, items, firstAxis);
    if (first.status === 'valid' && first.cut !== null) {
      memo.set(cacheKey, 'valid');
      chosen.set(cacheKey, first.cut);
      return 'valid';
    }
    const second = cutAlong(region, items, secondAxis);
    if (second.status === 'valid' && second.cut !== null) {
      memo.set(cacheKey, 'valid');
      chosen.set(cacheKey, second.cut);
      return 'valid';
    }

    const status: CheckStatus =
      first.status === 'unverified' || second.status === 'unverified' ? 'unverified' : 'invalid';
    memo.set(cacheKey, status);
    return status;
  }

  function rebuild(region: Rect, items: readonly Rect[]): CutNode {
    if (items.length <= 1) return { kind: 'leaf', region, rect: items[0] ?? null };

    const cut = chosen.get(key(region));
    if (cut === undefined) {
      // Only reachable if the search reported `valid` without recording how,
      // which would mean the memo and the chosen-cut map had drifted apart.
      throw new Error(`no cut recorded for a region the search proved cuttable: ${key(region)}`);
    }
    return {
      kind: 'split',
      region,
      axis: cut.axis,
      at: cut.at,
      near: rebuild(cut.nearRegion, cut.near),
      far: rebuild(cut.farRegion, cut.far),
    };
  }

  const status = decompose(region, rects);
  if (status !== 'valid') return { status };
  return { status: 'valid', tree: rebuild(region, rects) };
}

/** The piece on the near side of a blade at `at`. */
function sliceNear(r: Rect, axis: CutAxis, at: number): Rect {
  return axis === 'x'
    ? { x: r.x, y: r.y, width: at - r.x, height: r.height }
    : { x: r.x, y: r.y, width: r.width, height: at - r.y };
}

/** The piece on the far side of a blade at `at`, after the blade has eaten `kerf`. */
function sliceFar(r: Rect, axis: CutAxis, at: number, kerf: number): Rect {
  return axis === 'x'
    ? { x: at + kerf, y: r.y, width: right(r) - at - kerf, height: r.height }
    : { x: r.x, y: at + kerf, width: r.width, height: bottom(r) - at - kerf };
}

// --- Cut plan -------------------------------------------------------------

/** Structural role of the cut, independent of grain. */
export type CutRole = 'trim' | 'split' | 'finish';

/**
 * Relation to the sheet's grain, `null` when the material has no grain.
 *
 * A rip runs along the grain, a crosscut across it. They feel different at the
 * saw and need different blades on a fussy setup, so the printed step says which.
 */
export type GrainRelation = 'rip' | 'crosscut' | null;

export interface CutPiece {
  /** `A`, `B`, ... `Z`, `AA`, assigned in creation order so offcuts are trackable. */
  id: string;
  rect: Rect;
  /** Set when this piece is a finished part rather than an intermediate or an offcut. */
  placement: Placement | null;
}

export interface CutStep {
  /** 1-based, in the order the operator makes the cuts. */
  index: number;
  role: CutRole;
  grain: GrainRelation;
  axis: CutAxis;
  /** Blade near-face position in sheet coordinates, mm. */
  at: number;
  /**
   * Distance from the piece's near edge to the blade's near face, mm. This is
   * the fence setting, and the near-side keeper comes off at exactly this
   * dimension.
   *
   * Negative when the blade overhangs the piece's near edge, which happens on a
   * near-side finishing cut whose offcut is thinner than the kerf. That is a
   * real and makeable cut - part of the blade simply runs in air - but there is
   * no fence setting for it, and it should be presented as "trim flush".
   */
  fence: number;
  /** Piece consumed by this cut. */
  pieceId: string;
  /**
   * Pieces produced, `[near, far]`.
   *
   * A side is `null` when the blade ran off the edge of the piece and left no
   * offcut at all - the whole of that side fitted inside the kerf. Never `null`
   * on both sides.
   */
  produces: [string | null, string | null];
  /** Nesting depth, for indenting the printed step list. Trim cuts sit at 0. */
  depth: number;
}

export interface CutPlan {
  stockInstanceId: string;
  steps: CutStep[];
  pieces: CutPiece[];
  /**
   * `unverified` - the search hit its step budget and proved nothing.
   * `invalid` - the search proved no cut order exists, as for a pinwheel.
   *
   * Neither is ever silently downgraded to `complete`, and neither carries a
   * partial step list: half a cut plan is worse than none, because the operator
   * finds out where it stops by running out of sheet.
   */
  status: 'complete' | 'unverified' | 'invalid';
}

export interface CutPlanInput {
  stock: Stock;
  /**
   * Only `hasGrain` is read, to decide whether cuts are labelled rip/crosscut.
   * `null` when the material is unknown, which labels every cut as neither.
   */
  material: Material | null;
  layout: Layout;
  parts: readonly Part[];
  config: SolverConfig;
  maxSteps?: number;
}

/**
 * Spreadsheet-style piece labels: A, B, ... Z, AA, AB, ...
 *
 * Letters rather than numbers because the diagram already numbers cuts, and an
 * operator holding a printout should never have to work out whether "3" is the
 * third cut or the third offcut.
 */
function pieceLabel(index: number): string {
  let n = index;
  let label = '';
  do {
    label = String.fromCharCode(65 + (n % 26)) + label;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return label;
}

/**
 * Derive the order of operations that produces `layout` from a sheet.
 *
 * Trim cuts come first when the sheet has an edge trim, then the layout's own
 * decomposition depth-first: cut the piece, finish the near half completely,
 * then the far half. That matches working one piece at a time and setting the
 * other aside. Breadth-first would have the operator juggling every offcut in
 * the shop at once.
 *
 * Rips are preferred over crosscuts wherever the geometry allows both, because
 * breaking a full sheet down into strips before crosscutting is how the work is
 * actually done and it is far safer to handle.
 *
 * This is *a valid* cut order, not an optimised one. Reordering to minimise
 * fence changes or blade-height changes is a separate problem and explicitly v2.
 *
 * Throws when the layout refers to a part that is not in `parts`. That is an
 * internal inconsistency between a result and the project it came from, not user
 * data - `checkResult` reports it as a violation long before a plan is built.
 */
export function buildCutPlan(input: CutPlanInput): CutPlan {
  const { stock, material, layout, parts, config } = input;
  const kerf = config.kerf;
  const partsById = new Map(parts.map((part) => [part.id, part]));

  const pieces: CutPiece[] = [];
  function addPiece(rect: Rect, placement: Placement | null): CutPiece {
    const piece: CutPiece = { id: pieceLabel(pieces.length), rect, placement };
    pieces.push(piece);
    return piece;
  }

  const sheetPiece = addPiece({ x: 0, y: 0, width: stock.width, height: stock.height }, null);

  // A cut on axis 'x' is a vertical blade line, so it runs along the y
  // direction - which makes it a rip exactly when the grain also runs along y.
  const hasGrain = material?.hasGrain ?? false;
  const ripAxis: CutAxis = stock.grainAxis === 'y' ? 'x' : 'y';
  // With no grain there is no rip to prefer, so fall back to the checker's own
  // axis order and keep the two in step.
  const preferAxis: CutAxis = hasGrain ? ripAxis : 'x';
  const axisOrder: CutAxis[] = preferAxis === 'x' ? ['x', 'y'] : ['y', 'x'];

  function grainOf(axis: CutAxis): GrainRelation {
    if (!hasGrain) return null;
    return axis === ripAxis ? 'rip' : 'crosscut';
  }

  const rects: Rect[] = [];
  const placementByRect = new Map<Rect, Placement>();
  for (const placement of layout.placements) {
    const part = partsById.get(placement.partId);
    if (part === undefined) {
      throw new Error(
        `layout "${layout.stockInstanceId}" places part "${placement.partId}", which is not in the part list`,
      );
    }
    const rect = placementRect(part, placement);
    rects.push(rect);
    placementByRect.set(rect, placement);
  }

  const usable = usableArea(stock, config.edgeTrim);
  const options: CutTreeOptions =
    input.maxSteps === undefined ? { preferAxis } : { preferAxis, maxSteps: input.maxSteps };
  const tree = buildCutTree(usable, rects, kerf, options);
  if (tree.status !== 'valid') {
    return {
      stockInstanceId: layout.stockInstanceId,
      steps: [],
      pieces,
      status: tree.status === 'invalid' ? 'invalid' : 'unverified',
    };
  }

  const steps: CutStep[] = [];

  /** Record one cut, and hand back the pieces it leaves behind. */
  function cut(
    piece: CutPiece,
    axis: CutAxis,
    at: number,
    role: CutRole,
    depth: number,
  ): { near: CutPiece | null; far: CutPiece | null } {
    const nearRect = sliceNear(piece.rect, axis, at);
    const farRect = sliceFar(piece.rect, axis, at, kerf);
    const near = isEmpty(nearRect) ? null : addPiece(nearRect, null);
    const far = isEmpty(farRect) ? null : addPiece(farRect, null);
    if (near === null && far === null) {
      throw new Error(`cut at ${at} on piece "${piece.id}" would leave nothing behind`);
    }
    steps.push({
      index: steps.length + 1,
      role,
      grain: grainOf(axis),
      axis,
      at,
      fence: at - (axis === 'x' ? piece.rect.x : piece.rect.y),
      pieceId: piece.id,
      produces: [near?.id ?? null, far?.id ?? null],
      depth,
    });
    return { near, far };
  }

  /**
   * Bring `piece` down to `target` with up to four cuts.
   *
   * Used for both the edge trim and the finishing cuts at a leaf: in each case
   * the keeper is a rectangle sitting somewhere inside a larger piece, and every
   * edge of it that does not already coincide with the piece's edge costs a cut.
   */
  function reduceTo(piece: CutPiece, target: Rect, role: CutRole, depth: number): CutPiece {
    let current = piece;
    for (const axis of axisOrder) {
      const pieceNear = axis === 'x' ? current.rect.x : current.rect.y;
      const pieceFar = axis === 'x' ? right(current.rect) : bottom(current.rect);
      const targetNear = axis === 'x' ? target.x : target.y;
      const targetFar = axis === 'x' ? right(target) : bottom(target);

      if (targetNear - pieceNear > EPSILON) {
        // Remove the near-side waste: the blade's far face lands on the target's
        // near edge, so the keeper starts exactly where the target does.
        const keeper = cut(current, axis, targetNear - kerf, role, depth).far;
        if (keeper === null) {
          throw new Error(`trimming piece "${current.id}" on ${axis} left no keeper`);
        }
        current = keeper;
      }
      if (pieceFar - targetFar > EPSILON) {
        const keeper = cut(current, axis, targetFar, role, depth).near;
        if (keeper === null) {
          throw new Error(`trimming piece "${current.id}" on ${axis} left no keeper`);
        }
        current = keeper;
      }
    }
    // Snap to the target rather than carrying the arithmetic's residue. The
    // operator cuts *to* a dimension; a keeper that is 1e-13mm off the part it
    // is meant to be is a float artefact, and letting it accumulate would drift
    // the whole plan away from the placements it was derived from.
    current.rect = { ...target };
    return current;
  }

  // The edge trim is real cuts the operator makes before anything else, and they
  // are always guillotine-valid - which is why the search itself starts from the
  // usable area and never sees them.
  const root = config.edgeTrim > EPSILON ? reduceTo(sheetPiece, usable, 'trim', 0) : sheetPiece;

  function walk(node: CutNode, piece: CutPiece, depth: number): void {
    if (node.kind === 'leaf') {
      if (node.rect === null) return; // Pure offcut. Nothing more to do to it.
      const placement = placementByRect.get(node.rect);
      if (placement === undefined) {
        throw new Error('a cut-tree leaf holds a rectangle that came from no placement');
      }
      reduceTo(piece, node.rect, 'finish', depth).placement = placement;
      return;
    }

    const { near, far } = cut(piece, node.axis, node.at, 'split', depth);
    if (near === null || far === null) {
      // The search only takes a cut with parts on both sides, and every part has
      // positive extent, so both halves are always real pieces.
      throw new Error(`split of piece "${piece.id}" produced only one side`);
    }
    walk(node.near, near, depth + 1);
    walk(node.far, far, depth + 1);
  }

  walk(tree.tree, root, 0);

  return { stockInstanceId: layout.stockInstanceId, steps, pieces, status: 'complete' };
}

export interface CutPlansInput {
  parts: readonly Part[];
  stock: readonly Stock[];
  materials: readonly Material[];
  config: SolverConfig;
  maxSteps?: number;
}

/**
 * One plan per layout in a solver result, in the result's own order.
 *
 * Throws when a layout names a stock instance the project does not contain, for
 * the same reason `buildCutPlan` throws on an unknown part: it is a broken
 * result rather than bad user input, and `checkResult` reports it properly.
 */
export function buildCutPlans(result: Result, input: CutPlansInput): CutPlan[] {
  const stockById = new Map(input.stock.map((sheet) => [sheet.id, sheet]));
  const materialsById = new Map(input.materials.map((material) => [material.id, material]));

  return result.layouts.map((layout) => {
    const ref = parseStockInstanceId(layout.stockInstanceId);
    const sheet = ref === null ? undefined : stockById.get(ref.stockId);
    if (sheet === undefined) {
      throw new Error(
        `layout "${layout.stockInstanceId}" names a stock entry that is not in the project`,
      );
    }
    const base: CutPlanInput = {
      stock: sheet,
      material: materialsById.get(sheet.materialId) ?? null,
      layout,
      parts: input.parts,
      config: input.config,
    };
    return buildCutPlan(
      input.maxSteps === undefined ? base : { ...base, maxSteps: input.maxSteps },
    );
  });
}
