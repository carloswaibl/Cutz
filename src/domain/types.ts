/**
 * Core domain model.
 *
 * Every dimension in this file is in millimetres, stored as a plain `number`.
 * That is the canonical internal unit across domain/, solver/, import/ and
 * export/ - conversion happens only at the UI and file boundaries. Never store
 * a display string or a unit tag alongside a dimension.
 *
 * Geometry convention: origin is top-left, x increases right, y increases down.
 * This matches SVG, so rendering needs no coordinate flip.
 */

/**
 * Whether a part may be turned 90° by the solver.
 *
 * `locked` means grain direction is visible on this part, so rotating it would
 * produce a visibly wrong result. It is a hard constraint, not a preference the
 * solver may trade away for a tighter packing.
 */
export type RotationPolicy = 'locked' | 'free90';

/**
 * Which packing engine a project is solved with, and therefore which machine
 * its layouts are valid for.
 *
 * `guillotine` is a table saw: every cut runs edge to edge, and a part consumes
 * its whole bounding box. `nest` is a CNC router: parts pack at angles inside
 * each other's concavities, and a part consumes only its outline. The choice is
 * explicit per project rather than inferred from whether parts have outlines -
 * silently changing which machine an output is valid for is a genuinely
 * dangerous surprise in a workshop. `docs/plan-m7.md` §7 decision 5.
 */
export type SolverMode = 'guillotine' | 'nest';

/**
 * A point in millimetres.
 *
 * This lives here rather than in `polygon.ts` with the operations on it because
 * `Part.outline` made it a model type: `types.ts` imports nothing, so anything
 * a model field is built from has to be here or the dependency graph turns into
 * a cycle. `polygon.ts` owns everything you can *do* with one.
 */
export interface Point {
  x: number;
  y: number;
}

export interface Material {
  id: string;
  name: string;
  /** Millimetres. */
  thickness: number;
  hasGrain: boolean;
}

export interface Part {
  id: string;
  label: string;
  /** Millimetres. */
  width: number;
  /** Millimetres. */
  height: number;
  qty: number;
  materialId: string;
  rotationPolicy: RotationPolicy;
  /**
   * The part's true shape, as a closed polygon in part-local millimetres:
   * origin at the bounding box top-left, x right, y down, no repeated final
   * point.
   *
   * Absent means "this part is its bounding box" - a hand-entered rectangle,
   * which stays the common case. Nothing branches on that: `partOutline()` in
   * `polygon.ts` returns the four rectangle corners when this is missing, so
   * call sites see a polygon either way.
   *
   * `width`/`height` remain the bounding box even when this is present. That is
   * what lets the guillotine packer, the cut planner, both renderers and both
   * exporters go on reading the box they always read.
   *
   * Invariant, checked by `validateInputs`: `boundsOf(outline)` equals
   * `{ x: 0, y: 0, width, height }` within `EPSILON`.
   */
  outline?: readonly Point[];
}

export interface Stock {
  id: string;
  materialId: string;
  /** Millimetres. */
  width: number;
  /** Millimetres. */
  height: number;
  qty: number;
  /** Which axis the wood grain runs along on this sheet. */
  grainAxis: 'x' | 'y';
}

export type SolverEffort = 'fast' | 'balanced' | 'thorough';

export interface SolverConfig {
  /** Width of material removed by the blade, in mm. Typically 3mm / 1/8". */
  kerf: number;
  /**
   * Millimetres removed from all four sheet edges before packing. Factory
   * edges on sheet goods are often not square and get trimmed off first.
   */
  edgeTrim: number;
  /** Seed for the solver's PRNG. Same inputs + same seed must give same output. */
  seed: number;
  /**
   * How much computational effort to spend on randomized restarts and hill-climbing.
   * Defaults to 'balanced'.
   */
  effort?: SolverEffort;
  /**
   * Which engine packs this project, and therefore which machine its layouts
   * are valid for. Defaults to 'guillotine'.
   */
  mode?: SolverMode;
  /**
   * How many equally spaced orientations over 360° the nesting engine may try,
   * e.g. 4 gives {0, 90, 180, 270}. Defaults to 4. Ignored in guillotine mode,
   * which has only ever had two.
   *
   * Grain-locked parts are restricted to {0, 180} regardless: a half turn keeps
   * the grain running along the same axis, so it is physically legal where a
   * quarter turn is not.
   *
   * This is a search knob, not a constraint on a finished layout - `checkResult`
   * deliberately does not measure `angleDeg` against it, or re-solving at a
   * coarser step count would retroactively invalidate a layout that is already
   * cut.
   */
  rotationSteps?: 2 | 4 | 12 | 24;
}

export interface Placement {
  partId: string;
  stockInstanceId: string;
  /** Top-left corner of the part, in mm, excluding kerf. */
  x: number;
  /** Top-left corner of the part, in mm, excluding kerf. */
  y: number;
  /**
   * How far the part is turned, in degrees clockwise (y grows downward, so
   * clockwise is the positive direction). Guillotine emits only 0 and 90.
   *
   * `x`/`y` anchor the top-left of the turned part's *axis-aligned bounding
   * box*, not the part's own origin - so for 0 and 90 this says exactly what
   * `rotated: boolean` used to say, and `placementRect` returns exactly what it
   * always returned.
   */
  angleDeg: number;
}

export interface Layout {
  stockInstanceId: string;
  placements: Placement[];
  /**
   * A fraction in 0..1, not a 0..100 percentage, despite the name.
   *
   * `1 - (placed part area on this sheet) / (full sheet area)`. Measured
   * against the *full* sheet, not the usable area: edge trim is material the
   * user bought and lost, so it counts as waste.
   */
  wastePct: number;
}

export interface UnplacedPart {
  partId: string;
  qty: number;
}

export interface Result {
  layouts: Layout[];
  unplacedParts: UnplacedPart[];
  /**
   * A fraction in 0..1, same convention as `Layout.wastePct`.
   *
   * `1 - (all placed part area) / (full area of the sheets actually used)`.
   * Stock instances that were never opened are excluded: owning ten sheets and
   * using two is not 80% waste.
   */
  totalWastePct: number;
}
