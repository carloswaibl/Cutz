/**
 * DXF export: one stock sheet as an R12 drawing.
 *
 * Where the SVG export is a picture of the layout, this is the layout as
 * geometry - closed outlines on named layers that a CAD user can snap to,
 * measure, and hand to a CNC shop. That difference is why this file does not go
 * through `SheetFigure` the way `svg.ts` does: there is no drawing to reuse,
 * only coordinates, and every one of them comes from `domain/geometry.ts` so
 * the exporter and the invariant checker cannot disagree about where a part is.
 *
 * ## Why R12
 *
 * R12 (`AC1009`) is the last DXF version a writer can produce completely:
 * `HEADER`, `TABLES`, `ENTITIES`, `EOF` and nothing else. From R13 on, every
 * entity carries a handle and the file wants a `CLASSES` section, model and
 * paper space blocks, and an `OBJECTS` dictionary - scaffolding whose only
 * real test is whether a CAD seat accepts the file, which CI cannot run. R12 is
 * also what old shop software and CNC controllers read.
 *
 * The cost is `POLYLINE`/`VERTEX`/`SEQEND` instead of `LWPOLYLINE`, which is an
 * R13+ entity: five records per corner rather than two per point. That is tens
 * of kilobytes on a full sheet, against an app that already ships ~90 kB of JS.
 * If this is ever revisited, go to R2000 - never R13, which costs the same and
 * is read by less.
 *
 * ## Headless
 *
 * No React, no DOM. This module is a string builder, which is why it is a plain
 * static import in the UI while `svg.ts` is a lazily-loaded chunk - it drags
 * nothing behind it.
 */

import type { CutPlan } from '../domain/cutplan';
import { placementRect, type Rect, usableArea } from '../domain/geometry';
import type { Layout, Material, Part, Placement, SolverConfig, Stock } from '../domain/types';
import { formatLength, type Unit } from '../domain/units';
import type { DisplayUnit } from '../ui/state/types';

export const DXF_LAYERS = {
  /** The stock sheet's full outline. */
  sheet: 'SHEET',
  /** The usable area after edge trim, when there is one. */
  trim: 'TRIM',
  /** One closed outline per placed part. */
  parts: 'PARTS',
  /** Blade lines from the cut plan, when one is supplied. */
  cuts: 'CUTS',
  /** Part labels and dimensions. */
  labels: 'LABELS',
} as const;

export interface SheetDxfInput {
  layout: Layout;
  stock: Stock;
  parts: Part[];
  material: Material;
  config: SolverConfig;
  displayUnit: DisplayUnit;
  fractionDenominator: number;
  /** 1-based position among the sheets being exported, for the provenance header. */
  sheetNumber: number;
  sheetCount: number;
  /** Cut-plan blade lines, off unless a plan is supplied and asked for. */
  cutPlan?: CutPlan | null;
  showCutLines?: boolean;
  /** Injectable so tests are not time-dependent. */
  generatedAt?: Date;
}

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

interface UnitSystem {
  /** Multiplier from canonical millimetres to the exported unit. */
  scale: number;
  /** `$INSUNITS` code: 1 inches, 4 millimeters, 5 centimeters. */
  insunits: number;
}

/**
 * The unit the drawing is written in, from the user's display setting.
 *
 * Unlike the SVG export - which always states millimetres because its physical
 * size is identical either way and only the number differs - a DXF has no
 * physical size at all. It has bare numbers plus a document-level declaration of
 * what they mean, and a CAD user acts on that declaration. Someone working in
 * inches expects an inch drawing, so this is the boundary where the units policy
 * says conversion happens.
 */
function unitSystem(displayUnit: DisplayUnit): UnitSystem {
  switch (displayUnit) {
    case 'imperial-fraction':
    case 'imperial-decimal':
      return { scale: 1 / 25.4, insunits: 1 };
    case 'metric-cm':
      return { scale: 1 / 10, insunits: 5 };
    case 'metric-mm':
      return { scale: 1, insunits: 4 };
  }
}

/** Map `DisplayUnit` to the `formatLength` unit, for label text. */
function toFormatUnit(displayUnit: DisplayUnit): Unit {
  return displayUnit.startsWith('imperial') ? 'in' : 'mm';
}

// ---------------------------------------------------------------------------
// Coordinates
// ---------------------------------------------------------------------------

/** A point in DXF space: exported units, Y up, origin at the sheet's bottom-left. */
export interface DxfPoint {
  x: number;
  y: number;
}

/**
 * The one place coordinates are transformed. Everything else in this file works
 * in sheet millimetres and passes through here.
 *
 * DXF is Y-up; our origin is top-left with Y increasing downwards (matching
 * SVG). So a sheet-space Y becomes `stock.height - y`, putting the DXF origin at
 * the sheet's bottom-left corner. Getting this wrong produces a drawing that is
 * mirrored about the horizontal axis - which looks completely plausible, cuts
 * grain-locked parts the wrong way round, and is the reason this is a named,
 * separately tested function rather than an expression repeated at each call.
 */
export function sheetToDxf(stock: Stock, scale: number): (x: number, y: number) => DxfPoint {
  return (x, y) => ({ x: normalizeZero(x * scale), y: normalizeZero((stock.height - y) * scale) });
}

/** `-0` formats as `-0.0`, which is noise in a golden file and in a diff. */
function normalizeZero(n: number): number {
  return n === 0 ? 0 : n;
}

/**
 * A real number as DXF writes them: always with a decimal point, and with the
 * float residue of unit conversion trimmed.
 *
 * `1219.2000000000002` in a drawing makes the whole export look untrustworthy.
 * Trimmed by *significant digits* rather than decimal places, because the same
 * fixed number of decimals means different things in different units - six
 * decimals of a millimetre is far finer than `geometry.EPSILON`, while six
 * decimals of an inch is coarser than it, and rounding an inch drawing to
 * something the invariant checker would call a different number is not a
 * trade this export gets to make. Twelve significant digits leaves every unit
 * several orders of magnitude inside EPSILON and still drops the noise.
 */
function real(n: number): string {
  const trimmed = Number.parseFloat(n.toPrecision(12));
  // Residue near zero would otherwise print as `1e-13`, which is not a number
  // DXF reals are written in and which some readers will not parse.
  const value = Math.abs(trimmed) < 1e-9 ? 0 : trimmed;
  return Number.isInteger(value) ? `${value}.0` : `${value}`;
}

/** A millimetre value for the provenance header, float noise trimmed. */
function mmText(mm: number): string {
  return Number.parseFloat(mm.toFixed(6)).toString();
}

// ---------------------------------------------------------------------------
// Group codes
// ---------------------------------------------------------------------------

/**
 * A DXF file is a flat sequence of (code, value) pairs, one per line.
 *
 * Codes are right-aligned in three columns and integers in six, which is what
 * AutoCAD writes. Parsers trim, so this is cosmetic - but a golden file that
 * looks like a real DXF is one a reviewer can compare against a reference.
 */
class DxfBuilder {
  private readonly lines: string[] = [];

  /**
   * A raw string value: layer names, entity types, text.
   *
   * Line breaks are flattened because the file *is* its line structure - a part
   * labelled over two lines would otherwise be read as a value followed by a
   * stray group code, corrupting everything after it. User text reaches here
   * from part labels and material names, and will reach it from SVG and STL
   * imports in M4/M5.
   */
  str(code: number, value: string): this {
    this.lines.push(pad(code), value.replace(/\r?\n/g, ' '));
    return this;
  }

  /** An integer value, right-aligned as AutoCAD writes them. */
  int(code: number, value: number): this {
    this.lines.push(pad(code), `${value}`.padStart(6));
    return this;
  }

  /** A real value. */
  num(code: number, value: number): this {
    this.lines.push(pad(code), real(value));
    return this;
  }

  /** A comment, legal only at the head of the file. */
  comment(text: string): this {
    return this.str(999, text);
  }

  /** A 3D point as its x/y/z triple, starting at `code` (10, 11, ...). */
  point(code: number, p: DxfPoint): this {
    return this.num(code, p.x)
      .num(code + 10, p.y)
      .num(code + 20, 0);
  }

  build(): string {
    // DXF is a line-oriented format and the final pair needs its terminator.
    return `${this.lines.join('\n')}\n`;
  }
}

function pad(code: number): string {
  return `${code}`.padStart(3);
}

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

/**
 * A closed outline.
 *
 * `66` says vertices follow and `70` bit 1 closes the loop, so four vertices
 * describe four edges rather than three. The dummy `10`/`20`/`30` point on the
 * `POLYLINE` header is unused for 2D polylines but expected by readers that
 * follow the spec literally.
 */
function closedPolyline(dxf: DxfBuilder, layer: string, points: DxfPoint[]): void {
  dxf.str(0, 'POLYLINE').str(8, layer).int(66, 1).int(70, 1).point(10, { x: 0, y: 0 });
  for (const p of points) {
    dxf.str(0, 'VERTEX').str(8, layer).point(10, p);
  }
  dxf.str(0, 'SEQEND').str(8, layer);
}

/** A rectangle in sheet coordinates as a closed outline, corners clockwise. */
function rectPolyline(
  dxf: DxfBuilder,
  layer: string,
  rect: Rect,
  to: (x: number, y: number) => DxfPoint,
): void {
  closedPolyline(dxf, layer, [
    to(rect.x, rect.y),
    to(rect.x + rect.width, rect.y),
    to(rect.x + rect.width, rect.y + rect.height),
    to(rect.x, rect.y + rect.height),
  ]);
}

function line(dxf: DxfBuilder, layer: string, a: DxfPoint, b: DxfPoint): void {
  dxf.str(0, 'LINE').str(8, layer).point(10, a).point(11, b);
}

/**
 * Centred text.
 *
 * `72`/`73` set horizontal and vertical centring, and when either is non-zero
 * the alignment point at `11`/`21` is the one that positions the text - so both
 * points are written, carrying the same coordinates.
 */
function centeredText(
  dxf: DxfBuilder,
  layer: string,
  at: DxfPoint,
  height: number,
  text: string,
): void {
  dxf
    .str(0, 'TEXT')
    .str(8, layer)
    .point(10, at)
    .num(40, height)
    .str(1, text)
    .int(72, 1)
    .point(11, at)
    .int(73, 2);
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function header(dxf: DxfBuilder, units: UnitSystem, extents: Rect): void {
  dxf.str(0, 'SECTION').str(2, 'HEADER');
  dxf.str(9, '$ACADVER').str(1, 'AC1009');
  dxf.str(9, '$INSUNITS').int(70, units.insunits);
  dxf.str(9, '$EXTMIN').point(10, { x: extents.x, y: extents.y });
  dxf.str(9, '$EXTMAX').point(10, { x: extents.x + extents.width, y: extents.y + extents.height });
  dxf.str(0, 'ENDSEC');
}

/** ACI colour per layer, so the drawing is readable the moment it opens. */
const LAYER_COLORS: Record<string, number> = {
  [DXF_LAYERS.sheet]: 7, // white on dark, black on light
  [DXF_LAYERS.trim]: 8, // dark grey
  [DXF_LAYERS.parts]: 5, // blue
  [DXF_LAYERS.cuts]: 1, // red
  [DXF_LAYERS.labels]: 3, // green
};

function tables(dxf: DxfBuilder): void {
  dxf.str(0, 'SECTION').str(2, 'TABLES');

  // Layers reference a linetype by name, so the linetype table has to define the
  // one they name. A file whose layers point at a missing CONTINUOUS is rejected
  // by strict readers.
  dxf.str(0, 'TABLE').str(2, 'LTYPE').int(70, 1);
  dxf
    .str(0, 'LTYPE')
    .str(2, 'CONTINUOUS')
    .int(70, 0)
    .str(3, 'Solid line')
    .int(72, 65)
    .int(73, 0)
    .num(40, 0);
  dxf.str(0, 'ENDTAB');

  const names = Object.values(DXF_LAYERS);
  dxf.str(0, 'TABLE').str(2, 'LAYER').int(70, names.length);
  for (const name of names) {
    dxf
      .str(0, 'LAYER')
      .str(2, name)
      .int(70, 0)
      .int(62, LAYER_COLORS[name] ?? 7)
      .str(6, 'CONTINUOUS');
  }
  dxf.str(0, 'ENDTAB');

  dxf.str(0, 'ENDSEC');
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

/** Minimum and maximum label height in millimetres, matching `SheetFigure`. */
const MIN_TEXT_MM = 8;
const MAX_TEXT_MM = 16;

/**
 * Label height for a part, scaled to its rect exactly as the SVG diagram does,
 * so the two exports of one layout read the same.
 */
function labelHeightMm(rect: Rect): number {
  return Math.max(MIN_TEXT_MM, Math.min(Math.min(rect.width, rect.height) * 0.12, MAX_TEXT_MM));
}

function partLabels(
  dxf: DxfBuilder,
  part: Part,
  placement: Placement,
  rect: Rect,
  input: SheetDxfInput,
  to: (x: number, y: number) => DxfPoint,
  scale: number,
): void {
  const height = labelHeightMm(rect);
  const dimHeight = height * 0.75;
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;

  // Dimensions are the part's own, not the rect's: a rotated part is the same
  // part and carries the same numbers, which is what a person cuts to.
  const fmt = (mm: number) =>
    formatLength(mm, {
      unit: toFormatUnit(input.displayUnit),
      denominator: input.fractionDenominator,
      withUnit: false,
      markApproximate: false,
    });

  // The diagram marks rotation with '↻'. R12 is an ANSI-era format with no
  // reliable encoding declaration, so anything outside ASCII is a good way to
  // get mojibake in an old viewer - the marker spells itself out here.
  const label = placement.rotated ? `${part.label} (R)` : part.label;

  // Laid out as the SVG does: label above centre, dimensions below it. Sheet Y
  // grows downwards, so the smaller Y is the upper line before the flip.
  centeredText(dxf, DXF_LAYERS.labels, to(cx, cy - dimHeight * 0.4), height * scale, label);
  centeredText(
    dxf,
    DXF_LAYERS.labels,
    to(cx, cy + height * 0.6),
    dimHeight * scale,
    `${fmt(part.width)} x ${fmt(part.height)}`,
  );
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Render one sheet as a complete R12 DXF document.
 *
 * Cut lines are off unless a plan is supplied *and* `showCutLines` is set, so
 * the exported file never shows an operation the on-screen diagram does not.
 */
export function renderSheetDxf(input: SheetDxfInput): string {
  const { stock, config, parts, layout } = input;
  const units = unitSystem(input.displayUnit);
  const to = sheetToDxf(stock, units.scale);

  const dxf = new DxfBuilder();
  for (const text of provenance(input, units)) {
    dxf.comment(text);
  }

  // Extents are the sheet itself. The SVG figure's viewBox carries padding so
  // its dimension labels do not clip, but nothing is drawn outside the sheet
  // here - extents taken from there would frame a border of empty space, and
  // zoom-extents in CAD would show it.
  header(dxf, units, {
    x: 0,
    y: 0,
    width: stock.width * units.scale,
    height: stock.height * units.scale,
  });
  tables(dxf);

  dxf.str(0, 'SECTION').str(2, 'ENTITIES');

  rectPolyline(dxf, DXF_LAYERS.sheet, { x: 0, y: 0, width: stock.width, height: stock.height }, to);

  // No edge trim means no trim line - drawing one on the sheet boundary would
  // imply a cut the operator does not make.
  if (config.edgeTrim > 0) {
    rectPolyline(dxf, DXF_LAYERS.trim, usableArea(stock, config.edgeTrim), to);
  }

  const partsById = new Map(parts.map((part) => [part.id, part]));
  for (const placement of layout.placements) {
    const part = partsById.get(placement.partId);
    if (!part) continue;
    const rect = placementRect(part, placement);
    rectPolyline(dxf, DXF_LAYERS.parts, rect, to);
    partLabels(dxf, part, placement, rect, input, to, units.scale);
  }

  if (input.showCutLines && input.cutPlan) {
    cutLines(dxf, input.cutPlan, to);
  }

  dxf.str(0, 'ENDSEC');
  dxf.str(0, 'EOF');

  return dxf.build();
}

/**
 * Blade lines, each spanning only the piece its cut consumes.
 *
 * A plan that is `unverified` or `invalid` draws nothing: it carries no steps by
 * construction, and a partial set of cut lines is worse than none.
 */
function cutLines(dxf: DxfBuilder, plan: CutPlan, to: (x: number, y: number) => DxfPoint): void {
  if (plan.status !== 'complete') return;

  const pieceRects = new Map(plan.pieces.map((piece) => [piece.id, piece.rect]));
  for (const step of plan.steps) {
    const rect = pieceRects.get(step.pieceId);
    if (!rect) continue;
    const vertical = step.axis === 'x';
    const a = vertical ? to(step.at, rect.y) : to(rect.x, step.at);
    const b = vertical ? to(step.at, rect.y + rect.height) : to(rect.x + rect.width, step.at);
    line(dxf, DXF_LAYERS.cuts, a, b);
  }
}

/**
 * Provenance at the head of the file, as `999` comments.
 *
 * Same information the SVG export carries in its XML comment, and for the same
 * reason: a drawing that does not say what kerf it was packed for cannot be
 * re-cut with confidence on a different blade. `999` is a comment group in the
 * spec and any reader that walks code/value pairs skips it.
 */
function provenance(input: SheetDxfInput, units: UnitSystem): string[] {
  const unitName = units.insunits === 1 ? 'in' : units.insunits === 5 ? 'cm' : 'mm';
  return [
    'Generated by Cutz - cut list optimizer',
    `material: ${input.material.name} (${mmText(input.material.thickness)}mm)`,
    `sheet: ${input.sheetNumber} of ${input.sheetCount}`,
    `stock: ${mmText(input.stock.width)} x ${mmText(input.stock.height)} mm`,
    `kerf: ${mmText(input.config.kerf)}mm, edge trim: ${mmText(input.config.edgeTrim)}mm`,
    `waste: ${(input.layout.wastePct * 100).toFixed(1)}%`,
    `drawing units: ${unitName}`,
    `generated: ${(input.generatedAt ?? new Date()).toISOString()}`,
  ];
}
