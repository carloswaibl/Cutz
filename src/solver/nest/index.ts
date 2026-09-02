/**
 * The free-form nesting engine: v2's second `Solver`, for a CNC router.
 *
 * Nothing outside `solver/nest/` may import from inside it except the registry
 * in `solver/index.ts` - the same firewall `solver/guillotine/` states, now that
 * there is actually a second engine for it to protect.
 *
 * What is different from a table saw, and why it needs its own engine: a router
 * follows an outline rather than cutting a rectangle, so a part consumes only
 * the material inside its shape, and two parts may interlock. Layouts it
 * produces have no edge-to-edge cut sequence and are not cuttable on a saw,
 * which is why `SolverConfig.mode` is an explicit per-project choice rather than
 * something inferred from whether parts happen to carry outlines.
 *
 * The per-material driver, the instance expansion, the shortfall roll-up and the
 * restart/hill-climb harness are all shared with guillotine - `subproblems.ts`
 * and `search.ts`. What lives here is only how a sheet gets filled.
 *
 * **Pure, headless, and 100% deterministic.** All randomness comes from the
 * seeded generator in `rng.ts`; nothing here calls `Math.random()`, and no
 * decision is taken on wall-clock time.
 */

import { area, isEmpty, usableArea } from '../../domain/geometry';
import { partOutline, placedArea, polygonArea } from '../../domain/polygon';
import type {
  Part,
  Placement,
  Result,
  SolverConfig,
  SolverEffort,
  Stock,
} from '../../domain/types';
import { allowedAngles } from '../../domain/validate';
import type { PartInstance, StockInstance } from '../instances';
import { type SolutionScore, scorePack } from '../objective';
import { createRng, type Rng } from '../rng';
import { type SearchBudget, type SearchEngine, search } from '../search';
import { solveByMaterial } from '../subproblems';
import type { PackedResult, PackedSheet, Solver } from '../types';
import { createOccupancy, lastOccupiedRow, orInto } from './collide';
import { type Cursor, findPlacement, type Orientation, orientations } from './place';
import { type CellOffset, cellSizeFor, dilationOffsets } from './raster';

/**
 * Restart budgets, per effort level.
 *
 * Deliberately not `improve.ts`'s 40/250/1500. Those are a table saw's numbers:
 * a guillotine candidate is a few hundred rectangle comparisons, while a nest
 * candidate rasterises every orientation of every part and scans a bitmap of the
 * whole sheet. Two orders of magnitude separate them, and reusing one table
 * would either starve the saw or hang the browser.
 *
 * Chosen so the largest M7 nest fixture solves in roughly three seconds at
 * `balanced` - see the timings `npm run bench` prints. Iteration counts, never
 * wall-clock: a time-based cutoff would make the layout depend on how fast the
 * machine is, which is the determinism the seed exists to protect.
 *
 * `fast` is exactly the four deterministic baselines and no randomized restart
 * at all, which is a meaningful setting here in a way it is not for a saw: a
 * nest candidate is expensive enough that four good starting orders plus the
 * hill climb is a real answer rather than a token one.
 */
export const NEST_RESTART_BUDGETS: Record<SolverEffort, number> = {
  fast: 4,
  balanced: 12,
  thorough: 60,
};

/**
 * Consecutive non-improving hill-climb steps before the climb stops.
 *
 * Lower than guillotine's 20 for the same reason the restart budgets are lower:
 * each step costs a full re-pack.
 */
const NEST_HILL_CLIMB_NON_IMPROVING_LIMIT = 8;

/**
 * The orders a nest candidate can start from.
 *
 * `outline-area-desc` leads because it is the one that is *about* nesting: on a
 * router the material a part consumes is its outline, not its box, so placing by
 * outline area is placing the genuinely large parts first. The box orders are
 * kept because a part's box is what has to physically fit, and a spindly
 * L-shape with a small area can still be the hardest thing to fit on a sheet.
 */
type NestOrder = 'outline-area-desc' | 'box-area-desc' | 'longest-side-desc' | 'declaration';

const NEST_ORDERS: readonly NestOrder[] = [
  'outline-area-desc',
  'box-area-desc',
  'longest-side-desc',
  'declaration',
];

function orderKey(part: Part, order: NestOrder): number {
  switch (order) {
    case 'outline-area-desc':
      return polygonArea(partOutline(part));
    case 'box-area-desc':
      return part.width * part.height;
    case 'longest-side-desc':
      return Math.max(part.width, part.height);
    // Every key equal, so the stable sort is the identity and the user's own
    // declaration order survives.
    case 'declaration':
      return 0;
  }
}

function orderInstances(instances: readonly PartInstance[], order: NestOrder): PartInstance[] {
  return [...instances].sort((a, b) => orderKey(b.part, order) - orderKey(a.part, order));
}

/**
 * Every orientation of every part, rasterised once per solve.
 *
 * Rasterising is the expensive part of a nest candidate and it does not depend
 * on the candidate, so it happens once and is reused across every restart and
 * every hill-climb step. Held per solve rather than globally: the masks encode
 * `config.kerf`, and a cache that outlived a config would hand one project's
 * clearance to another's.
 */
interface OrientationCache {
  /** Millimetres per cell, derived from the kerf. See `cellSizeFor`. */
  cellMm: number;
  for: (part: Part) => Orientation[];
}

function createOrientationCache(config: SolverConfig): OrientationCache {
  const byPart = new Map<string, Orientation[]>();
  const cellMm = cellSizeFor(config.kerf);
  const kerfOffsets: readonly CellOffset[] = dilationOffsets(config.kerf, cellMm);

  const build = (part: Part): Orientation[] => {
    const cached = byPart.get(part.id);
    if (cached !== undefined) return cached;

    // `allowedAngles` is the validator's own function, not a copy of it. A
    // grain-locked part is restricted to {0, 180} whatever `rotationSteps` says,
    // and an engine holding a second opinion about that would produce layouts
    // the checker rejects - or worse, ones it accepts that a woodworker would
    // not.
    const built = orientations(
      part,
      partOutline(part),
      allowedAngles(part, 'nest', config),
      cellMm,
      kerfOffsets,
    );
    byPart.set(part.id, built);
    return built;
  };

  return { cellMm, for: build };
}

/**
 * Fill one material's sheets with one candidate ordering.
 *
 * Sheets are opened largest usable area first, stable-sorted so equal sheets
 * keep declaration order and instance ids stay ascending - the same rule
 * `greedyPack` follows, so the two engines at least agree about which sheet a
 * user gets asked to cut into first.
 *
 * A part that fits nowhere on this sheet is not a dead end: a later sheet may be
 * larger, or simply emptier.
 */
function nestPack(
  ordering: readonly PartInstance[],
  stockInstances: readonly StockInstance[],
  config: SolverConfig,
  cache: OrientationCache,
): PackedResult {
  const sheets: PackedSheet[] = [];
  let remaining: readonly PartInstance[] = ordering;

  const bySize = [...stockInstances].sort(
    (a, b) =>
      area(usableArea(b.stock, config.edgeTrim)) - area(usableArea(a.stock, config.edgeTrim)),
  );

  for (const sheet of bySize) {
    if (remaining.length === 0) break;

    const usable = usableArea(sheet.stock, config.edgeTrim);
    // `validateInputs` rejects this before the engine runs; packing into a
    // negative-sized rectangle would be nonsense rather than a worse layout.
    if (isEmpty(usable)) continue;

    const occupancy = createOccupancy(
      Math.ceil(usable.width / cache.cellMm),
      Math.ceil(usable.height / cache.cellMm),
    );
    const placements: Placement[] = [];
    const leftover: PartInstance[] = [];
    let sheetPlacedArea = 0;

    // A part that fits nowhere on this sheet can never fit later on it: nothing
    // is ever removed from a sheet, so occupancy only grows. Remembering the
    // failure is exact rather than a heuristic, and it is what makes packing a
    // sheet affordable at all - a cabinet with sixteen identical sides would
    // otherwise scan the whole grid sixteen times to reach the same answer, and
    // a failed scan is the most expensive kind because nothing cuts it short.
    const cannotFit = new Set<string>();
    // Per part, where each of its orientations may resume scanning this sheet.
    // See `Cursor` - the saving is exact, not a heuristic, and it is what stops
    // twenty identical brackets costing twenty scans of the whole grid.
    const cursors = new Map<string, Cursor[]>();

    for (const instance of remaining) {
      if (cannotFit.has(instance.part.id)) {
        leftover.push(instance);
        continue;
      }

      const candidates = cache.for(instance.part);
      let cursor = cursors.get(instance.part.id);
      if (cursor === undefined) {
        cursor = candidates.map(() => ({ row: 0, col: 0 }));
        cursors.set(instance.part.id, cursor);
      }

      const placed = findPlacement(occupancy, candidates, usable, cache.cellMm, cursor);
      if (placed === null) {
        cannotFit.add(instance.part.id);
        leftover.push(instance);
        continue;
      }
      // Only the winning orientation advances. The cell it just took is now
      // occupied and everything before it was already proven taken, so its next
      // copy cannot land earlier. The orientations that lost were scanned under
      // a pruned row limit, so what they covered is not something to reason
      // about loosely - they simply start over.
      const won = cursor[placed.index];
      if (won !== undefined) {
        won.row = placed.row;
        won.col = placed.col;
      }

      // The *exact* mask goes down, never the dilated one - the kerf is charged
      // to whatever is tested next, which is what makes the gap between two
      // parts independent of which was placed first.
      orInto(occupancy, placed.orientation.exact, placed.col, placed.row);
      placements.push({
        partId: instance.part.id,
        stockInstanceId: sheet.id,
        x: usable.x + placed.col * cache.cellMm,
        y: usable.y + placed.row * cache.cellMm,
        angleDeg: placed.orientation.angleDeg,
      });
      // Accumulated in placement order, through the same accessor the validator
      // uses, so the waste figure below is bit-identical to the one
      // `checkResult` recomputes. On a router that is the outline's area, not
      // the box's.
      sheetPlacedArea += placedArea(instance.part, 'nest');
    }

    remaining = leftover;
    if (placements.length === 0) continue;

    const sheetArea = sheet.stock.width * sheet.stock.height;
    sheets.push({
      layout: {
        stockInstanceId: sheet.id,
        placements,
        wastePct: 1 - sheetPlacedArea / sheetArea,
      },
      placedArea: sheetPlacedArea,
      sheetArea,
      // The full-width band of clear material below everything placed.
      //
      // Without a third criterion the objective cannot tell two six-sheet
      // packings apart - identical unplaced area, identical stock area - so
      // every restart and every hill-climb step scores a dead heat and the
      // search does nothing at all. That was measurable: before this, `fast` and
      // `balanced` returned byte-identical layouts on every fixture.
      //
      // A raster nester has no free *rectangles* in the sense `freeRects.ts`
      // means, but it does have this band, and it is the honest one: it is what
      // a woodworker would actually cut off and keep. Maximising it is the same
      // criterion guillotine's `maxFreeRectArea` expresses - consolidate the
      // leftover into one usable piece - and it gives the search the gradient it
      // was missing, because pushing parts higher up one sheet is what
      // eventually empties another.
      maxFreeRectArea:
        (occupancy.rows - 1 - lastOccupiedRow(occupancy)) * cache.cellMm * usable.width,
    });
  }

  return { sheets, unplaced: [...remaining] };
}

interface NestCandidate {
  ordering: readonly PartInstance[];
}

/** Perturb an ordering with `k` random pair swaps. */
function mutateOrdering(instances: readonly PartInstance[], k: number, rng: Rng): PartInstance[] {
  const result = [...instances];
  if (result.length <= 1) return result;
  for (let step = 0; step < k; step += 1) {
    const i = rng.int(result.length);
    const j = rng.int(result.length);
    if (i === j) continue;
    const first = result[i];
    const second = result[j];
    if (first === undefined || second === undefined) continue;
    result[i] = second;
    result[j] = first;
  }
  return result;
}

/**
 * The nester's candidate space, for one material subproblem.
 *
 * A candidate is an ordering and nothing else. Orientation is not part of it:
 * `findPlacement` already tries every angle a part is allowed and keeps the
 * bottom-left-most result, so an ordering fully determines a layout. Putting
 * angles in the candidate as well would multiply the search space by a factor
 * the placement rule has already searched exhaustively.
 */
function nestEngine(
  partInstances: readonly PartInstance[],
  stockInstances: readonly StockInstance[],
  config: SolverConfig,
  cache: OrientationCache,
): SearchEngine<NestCandidate, PackedResult> {
  const pack = (ordering: readonly PartInstance[]): PackedResult =>
    nestPack(ordering, stockInstances, config, cache);

  return {
    baselines(): readonly NestCandidate[] {
      return NEST_ORDERS.map((order) => ({ ordering: orderInstances(partInstances, order) }));
    },

    draw(rng: Rng): NestCandidate | null {
      const base = NEST_ORDERS[rng.int(NEST_ORDERS.length)];
      if (base === undefined) return null;
      const ordered = orderInstances(partInstances, base);
      const maxSwaps = Math.max(1, Math.floor(ordered.length / 2));
      return { ordering: mutateOrdering(ordered, rng.int(maxSwaps) + 1, rng) };
    },

    neighbour(best: NestCandidate, rng: Rng): NestCandidate | null {
      if (best.ordering.length <= 1) return null;
      return { ordering: mutateOrdering(best.ordering, 1, rng) };
    },

    pack(candidate: NestCandidate): PackedResult {
      return pack(candidate.ordering);
    },

    score(packed: PackedResult): SolutionScore {
      return scorePack(packed, 'nest');
    },

    fallback(): PackedResult {
      return pack(partInstances);
    },
  };
}

/** Run restarts and hill climbing for one material subproblem. */
export function nestSubproblem(
  partInstances: readonly PartInstance[],
  stockInstances: readonly StockInstance[],
  config: SolverConfig,
  rng: Rng,
  cache: OrientationCache,
): PackedResult {
  const budget: SearchBudget = {
    restarts: NEST_RESTART_BUDGETS[config.effort ?? 'balanced'],
    nonImprovingLimit: NEST_HILL_CLIMB_NON_IMPROVING_LIMIT,
  };
  return search(nestEngine(partInstances, stockInstances, config, cache), budget, rng);
}

/**
 * Nest a cut list for a CNC router.
 *
 * The engine behind `mode: 'nest'`. Everything about materials, quantities,
 * shortfalls and the overall waste figure is `solveByMaterial`'s, exactly as it
 * is for the guillotine engine.
 */
export function nestSolve(
  parts: readonly Part[],
  stock: readonly Stock[],
  config: SolverConfig,
): Result {
  return solveByMaterial(parts, stock, config, () => {
    // Both the generator and the mask cache are created inside the factory,
    // which `solveByMaterial` calls only once validation has passed - so a
    // project with an unusable seed or kerf gets the typed `SolverInputError` it
    // is owed rather than a bare throw from somewhere further in.
    //
    // One generator for the whole solve, threaded across materials in turn, so a
    // seed reproduces the project rather than each subproblem independently.
    const rng = createRng(config.seed);
    const cache = createOrientationCache(config);
    return (partInstances, stockInstances) =>
      nestSubproblem(partInstances, stockInstances, config, rng, cache);
  });
}

export const NestSolver: Solver = {
  solve(parts, stock, config) {
    return nestSolve(parts, stock, config);
  },
};
