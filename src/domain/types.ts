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
}

export interface Placement {
  partId: string;
  stockInstanceId: string;
  /** Top-left corner of the part, in mm, excluding kerf. */
  x: number;
  /** Top-left corner of the part, in mm, excluding kerf. */
  y: number;
  /** When true the part is turned 90°, so its footprint is height x width. */
  rotated: boolean;
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
