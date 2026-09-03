/**
 * The cut diagram itself: a single `<svg>` element and nothing around it.
 *
 * Split out of `SheetSvg` so the same drawing can go to the screen, to paper,
 * and into an exported file. `SheetSvg` keeps the screen chrome - the wrapper
 * div and the waste badge that floats over the diagram - while everything that
 * belongs *inside* the SVG lives here, where an exported file can reach it.
 *
 * The alternative, a separate headless string builder for export, is the thing
 * `docs/plan-m3.md` §3.1 argues against for the cut-plan checker and the same
 * argument applies here: two renderers of one drawing eventually disagree, and
 * the copy nobody looks at every day is the one that drifts.
 *
 * All positions come from `geometry.ts` via `placementRect` and `usableArea`,
 * so the renderer and the invariant checker always agree about where things sit.
 *
 * SVG internals use plain SVG attributes + CSS rather than Tailwind classes.
 * Tailwind stays on the outer wrapper `<div>` in `SheetSvg`. This avoids
 * fighting SVG-specific attribute specificity - `viewBox`, `vector-effect`,
 * `text-anchor`, and `dominant-baseline` have no Tailwind equivalents, and
 * mixing the two produces inconsistent results. It also means an exported file
 * carries no `class=` attributes, which would be dead weight outside the app.
 */

import { type CSSProperties, useMemo } from 'react';
import type { CutPlan, CutStep } from '../../domain/cutplan';
import { type Rect, usableArea } from '../../domain/geometry';
import { parseStockInstanceId } from '../../domain/instances';
import { placementPolygon, placementRect } from '../../domain/polygon';
import type {
  Layout,
  Material,
  Part,
  Placement,
  Point,
  SolverConfig,
  SolverMode,
  Stock,
} from '../../domain/types';
import { formatLength } from '../../domain/units';
import { solverMode } from '../../domain/validate';
import { toFormatUnit } from '../format';
import type { DisplayUnit } from '../state/types';
import type { SheetTheme } from './sheetTheme';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface SheetFigureProps {
  layout: Layout;
  stock: Stock;
  parts: Part[];
  material: Material;
  config: SolverConfig;
  displayUnit: DisplayUnit;
  fractionDenominator: number;
  theme: SheetTheme;

  /**
   * Hover highlighting. Omit both on paper and in exports - a printed sheet has
   * nothing to hover, and the pointer styling would be noise in the file.
   */
  hoveredPartId?: string | null;
  onHoverPart?: (partId: string | null) => void;

  /**
   * Draw a heading above the sheet naming the material, the sheet, and the saw
   * settings. The screen shows that as an HTML badge instead; a file that
   * leaves the app has to say what it is on its own.
   */
  showTitle?: boolean;
  /** 1-based position among the sheets being shown, for the title block. */
  sheetNumber?: number;
  sheetCount?: number;

  /**
   * Paint the background as a rect rather than leaving it to CSS. The screen
   * uses the CSS background so the diagram keeps its rounded corners; a
   * standalone file needs real geometry, because CAD tools and image
   * converters ignore CSS on the root element.
   */
  paintBackground?: boolean;

  /**
   * Explicit physical size for the root element, e.g. `1235.2mm`. Set by the
   * exporter so the drawing imports at true scale. Omitted on screen, where the
   * diagram is responsive and scaled by the zoom wrapper.
   */
  width?: string;
  height?: string;

  /**
   * Cut-plan overlays. Both default off: PR 4 of the milestone turns them on
   * for screen, print, and export together, so the diagram a user is looking at
   * never differs from the file they export.
   */
  cutPlan?: CutPlan | null;
  /** Blade lines with their step numbers. */
  showCutLines?: boolean;
  /** Piece letters (A, B, ...) on each part, matching the printed cut list. */
  showPartNumbers?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function partColor(theme: SheetTheme, partIndex: number): string {
  const palette = theme.partPalette;
  const color = palette[partIndex % palette.length];
  // Palette length is fixed and non-empty, so the modulo always lands in range.
  // biome-ignore lint: this cannot be undefined
  return color!;
}

/** Format a mm value for display inside the SVG diagram. */
function fmtLen(mm: number, displayUnit: DisplayUnit, denominator: number): string {
  return formatLength(mm, {
    unit: toFormatUnit(displayUnit),
    denominator,
    withUnit: false,
    markApproximate: false,
  });
}

/**
 * A point list as an SVG `points` attribute.
 *
 * Coordinates are rounded to 0.001mm - a micron, three orders below anything a
 * router can hold. Full float precision would put seventeen digits per
 * coordinate into every exported file for a shape with hundreds of vertices,
 * which is real weight in a download and buys nothing.
 */
function pointsAttr(points: readonly Point[]): string {
  return points.map((p) => `${round3(p.x)},${round3(p.y)}`).join(' ');
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Minimum part rect dimension (in mm) to show label text. */
const MIN_LABEL_SIZE = 40;
/** Minimum part rect dimension (in mm) to show dimension text below the label. */
const MIN_DIM_SIZE = 60;

/** Floor for the padding inside the SVG viewBox, in mm. */
const MIN_VIEW_PAD = 8;

/** Font size of the sheet's width label, along the top edge. */
function widthLabelFontSize(stock: Stock): number {
  return Math.max(7, Math.min(stock.width * 0.014, 12));
}

/** Font size of the sheet's height label, rotated along the left edge. */
function heightLabelFontSize(stock: Stock): number {
  return Math.max(7, Math.min(stock.height * 0.014, 12));
}

/**
 * Padding inside the SVG viewBox, in mm.
 *
 * The stock dimension labels sit just outside the sheet, and their glyphs run
 * back towards it from a baseline 3mm out - so the padding has to clear a whole
 * font size, not a fixed 8mm. A fixed pad clipped the rotated height label on
 * any sheet big enough to earn a large one, which is every full sheet of ply.
 */
function viewPad(stock: Stock): number {
  const labelFontSize = Math.max(widthLabelFontSize(stock), heightLabelFontSize(stock));
  return Math.max(MIN_VIEW_PAD, labelFontSize + 4);
}

/**
 * Build a stable mapping from partId → index in the order parts appear in the
 * parts array. Used for colour assignment so each part gets a consistent colour
 * regardless of placement order.
 */
function buildPartIndexMap(parts: Part[]): Map<string, number> {
  const map = new Map<string, number>();
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part && !map.has(part.id)) {
      map.set(part.id, i);
    }
  }
  return map;
}

/**
 * Resolve a placement to the Part it refers to.
 */
function findPart(parts: Part[], partId: string): Part | undefined {
  return parts.find((p) => p.id === partId);
}

/**
 * Key identifying a placement by its position, which is unique within a layout.
 *
 * Exported because the printed cut list looks up the same piece letters this
 * figure draws on the parts. Two keying schemes for one lookup would put a
 * letter on the diagram that no row in the table matches.
 */
export function placementKey(placement: Placement): string {
  return `${placement.partId}-${placement.x}-${placement.y}`;
}

// ---------------------------------------------------------------------------
// Sub-components rendered inside the SVG
// ---------------------------------------------------------------------------

interface PlacedPartRectProps {
  placement: Placement;
  part: Part;
  rect: Rect;
  /**
   * Which machine this layout is for. It decides what the drawn boundary
   * *means*, so it decides what gets drawn: a saw cuts the bounding box, a
   * router follows the outline. `docs/plan-m7.md` §4.
   */
  mode: SolverMode;
  colorIndex: number;
  isHovered: boolean;
  displayUnit: DisplayUnit;
  fractionDenominator: number;
  theme: SheetTheme;
  pieceId?: string | undefined;
  onHoverPart?: ((partId: string | null) => void) | undefined;
}

function PlacedPartRect({
  placement,
  part,
  rect,
  mode,
  colorIndex,
  isHovered,
  displayUnit,
  fractionDenominator,
  theme,
  pieceId,
  onHoverPart,
}: PlacedPartRectProps) {
  const fill = partColor(theme, colorIndex);
  const showLabel = rect.width >= MIN_LABEL_SIZE && rect.height >= MIN_LABEL_SIZE;
  const showDims = rect.width >= MIN_DIM_SIZE && rect.height >= MIN_DIM_SIZE;

  // Display dimensions are the *part's* original dimensions, not the rect's.
  // A rotated part shows the same label — it's the same part.
  const wDisplay = fmtLen(part.width, displayUnit, fractionDenominator);
  const hDisplay = fmtLen(part.height, displayUnit, fractionDenominator);
  const dimText = `${wDisplay} × ${hDisplay}`;

  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;

  // Font size scales with the smaller dimension, clamped to a readable range.
  const baseFontSize = Math.min(rect.width, rect.height) * 0.12;
  const fontSize = Math.max(8, Math.min(baseFontSize, 16));
  const dimFontSize = fontSize * 0.75;

  const interactive = onHoverPart !== undefined;

  /**
   * The real shape, drawn only when it is not already the rectangle.
   *
   * `placementPolygon` answers for every part, outline or not - it is
   * `partOutline` turned and translated - so the check is on `part.outline`
   * rather than on the returned points: a hand-entered rectangle would come back
   * as four corners exactly coincident with `rect`, and drawing that twice is
   * two hairlines fighting over the same pixels.
   */
  const outlinePoints =
    part.outline !== undefined ? pointsAttr(placementPolygon(part, placement)) : null;

  /**
   * In nest mode the outline is the cut, so it replaces the box entirely. In
   * guillotine mode the box is the cut and the outline is a hint drawn inside it.
   */
  const drawAsPolygon = mode === 'nest' && outlinePoints !== null;
  const drawOutlineHint = mode === 'guillotine' && outlinePoints !== null;

  /**
   * A quarter turn needs no number - `↻` has said "this part is turned" since
   * M1 and every guillotine layout is 0 or 90. An arbitrary nested angle is real
   * information the glyph alone throws away.
   */
  const rotationMarker =
    placement.angleDeg === 0
      ? ''
      : mode === 'nest' && placement.angleDeg !== 90
        ? ` ↻${Math.round(placement.angleDeg)}°`
        : ' ↻';

  const shapeFill = {
    fill,
    fillOpacity: isHovered ? theme.partFillOpacityHovered : theme.partFillOpacity,
    stroke: isHovered ? theme.partStrokeHovered : fill,
    strokeWidth: isHovered ? 2.5 : 1,
    vectorEffect: 'non-scaling-stroke' as const,
  };
  const shapeGlow = {
    fill: 'none',
    stroke: theme.partStrokeHovered,
    strokeWidth: 4,
    strokeOpacity: 0.3,
    vectorEffect: 'non-scaling-stroke' as const,
    style: { pointerEvents: 'none' as const },
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: SVG <g> groups part rects for hover highlighting — no semantic interactive role applies to SVG groups
    <g
      aria-label={`Part: ${part.label}`}
      onMouseEnter={interactive ? () => onHoverPart(placement.partId) : undefined}
      onMouseLeave={interactive ? () => onHoverPart(null) : undefined}
      style={interactive ? { cursor: 'pointer' } : undefined}
    >
      {/* The cut boundary: the outline on a router, the bounding box on a saw.
          `rx` has no polygon equivalent, and a rounded corner would misstate a
          shape the router follows literally, so the polygon branch drops it. */}
      {drawAsPolygon ? (
        <polygon points={outlinePoints} {...shapeFill} />
      ) : (
        // Attribute order matches what this element emitted before M7 PR 8, so
        // a guillotine sheet exports byte-identically to the golden files.
        <rect
          x={rect.x}
          y={rect.y}
          width={rect.width}
          height={rect.height}
          {...shapeFill}
          rx={1.5}
          ry={1.5}
        />
      )}

      {/* The real shape inside the blank, on a saw.
          The rectangle above is what the blade produces; this says what the
          user gets out of it once they cut or rout the curve by hand. Faint on
          purpose - drawn any stronger it reads as a cut the saw is making, which
          is exactly the confusion `docs/plan-m7.md` §1 criterion 9 is about. */}
      {drawOutlineHint && (
        <polygon
          points={outlinePoints}
          fill="none"
          stroke={theme.partOutlineHint}
          strokeOpacity={theme.partOutlineHintOpacity}
          strokeWidth={1}
          strokeDasharray="4 3"
          vectorEffect="non-scaling-stroke"
          style={{ pointerEvents: 'none' }}
        />
      )}

      {/* Hover glow */}
      {isHovered &&
        (drawAsPolygon ? (
          <polygon points={outlinePoints} {...shapeGlow} />
        ) : (
          <rect
            x={rect.x}
            y={rect.y}
            width={rect.width}
            height={rect.height}
            {...shapeGlow}
            rx={1.5}
            ry={1.5}
          />
        ))}

      {/* Part label */}
      {showLabel && (
        <text
          x={cx}
          y={showDims ? cy - dimFontSize * 0.4 : cy}
          textAnchor="middle"
          dominantBaseline="central"
          fill={isHovered ? theme.partLabelTextHovered : theme.partLabelText}
          fontSize={fontSize}
          fontWeight={600}
          fontFamily="ui-sans-serif, system-ui, sans-serif"
          style={{ pointerEvents: 'none', userSelect: 'none' }}
        >
          {part.label}
          {rotationMarker}
        </text>
      )}

      {/* Dimension text */}
      {showDims && (
        <text
          x={cx}
          y={cy + fontSize * 0.6}
          textAnchor="middle"
          dominantBaseline="central"
          fill={isHovered ? theme.partDimTextHovered : theme.partDimText}
          fontSize={dimFontSize}
          fontFamily="ui-mono, monospace"
          style={{ pointerEvents: 'none', userSelect: 'none' }}
        >
          {dimText}
        </text>
      )}

      {/* Piece letter, matching the cut list */}
      {pieceId !== undefined && (
        <PieceBadge rect={rect} label={pieceId} theme={theme} fontSize={fontSize} />
      )}
    </g>
  );
}

interface PieceBadgeProps {
  rect: Rect;
  label: string;
  theme: SheetTheme;
  fontSize: number;
}

/**
 * The piece letter, in the part's top-left corner.
 *
 * Letters rather than numbers because the diagram also numbers cuts, and an
 * operator holding a printout should never have to work out which "3" they are
 * looking at. See `cutplan.pieceLabel`.
 */
function PieceBadge({ rect, label, theme, fontSize }: PieceBadgeProps) {
  const size = fontSize * 1.5;
  const pad = fontSize * 0.35;
  return (
    <g style={{ pointerEvents: 'none' }}>
      <rect
        x={rect.x + pad}
        y={rect.y + pad}
        width={size}
        height={size}
        rx={2}
        ry={2}
        fill={theme.cutNumberFill}
        stroke={theme.cutNumberStroke}
        strokeWidth={0.8}
        vectorEffect="non-scaling-stroke"
      />
      <text
        x={rect.x + pad + size / 2}
        y={rect.y + pad + size / 2}
        textAnchor="middle"
        dominantBaseline="central"
        fill={theme.cutNumberText}
        fontSize={fontSize * 0.85}
        fontWeight={700}
        fontFamily="ui-mono, monospace"
        style={{ userSelect: 'none' }}
      >
        {label}
      </text>
    </g>
  );
}

// ---------------------------------------------------------------------------
// Kerf indicators
// ---------------------------------------------------------------------------

interface KerfLinesProps {
  placements: Placement[];
  parts: Part[];
  usable: Rect;
  kerf: number;
  theme: SheetTheme;
}

/**
 * Render subtle dashed lines between parts where a saw cut occurs.
 *
 * For each placement, draw a kerf line along its right edge and bottom edge,
 * but only if that edge isn't flush with the usable area boundary (no cut
 * happens at sheet edges — the edge trim already handled that).
 */
function KerfLines({ placements, parts, usable, kerf, theme }: KerfLinesProps) {
  if (kerf <= 0) return null;

  const lines: React.ReactElement[] = [];
  const usableRight = usable.x + usable.width;
  const usableBottom = usable.y + usable.height;

  for (const p of placements) {
    const part = findPart(parts, p.partId);
    if (!part) continue;
    const r = placementRect(part, p);

    const partRight = r.x + r.width;
    const partBottom = r.y + r.height;

    // Right edge kerf line — vertical, if not at the usable area boundary
    if (partRight + kerf / 2 < usableRight) {
      lines.push(
        <line
          key={`kerf-r-${p.partId}-${p.x}-${p.y}`}
          x1={partRight + kerf / 2}
          y1={r.y}
          x2={partRight + kerf / 2}
          y2={partBottom}
          stroke={theme.kerfLine}
          strokeWidth={0.8}
          strokeOpacity={theme.kerfLineOpacity}
          strokeDasharray="4 3"
          vectorEffect="non-scaling-stroke"
          style={{ pointerEvents: 'none' }}
        />,
      );
    }

    // Bottom edge kerf line — horizontal, if not at the usable area boundary
    if (partBottom + kerf / 2 < usableBottom) {
      lines.push(
        <line
          key={`kerf-b-${p.partId}-${p.x}-${p.y}`}
          x1={r.x}
          y1={partBottom + kerf / 2}
          x2={partRight}
          y2={partBottom + kerf / 2}
          stroke={theme.kerfLine}
          strokeWidth={0.8}
          strokeOpacity={theme.kerfLineOpacity}
          strokeDasharray="4 3"
          vectorEffect="non-scaling-stroke"
          style={{ pointerEvents: 'none' }}
        />,
      );
    }
  }

  return <g>{lines}</g>;
}

// ---------------------------------------------------------------------------
// Cut plan overlay
// ---------------------------------------------------------------------------

interface CutLinesProps {
  plan: CutPlan;
  theme: SheetTheme;
  stock: Stock;
  viewBox: Rect;
}

/**
 * Blade lines from the cut plan, numbered in the order the operator makes them.
 *
 * The line is drawn down the middle of the kerf, spanning only the piece the cut
 * consumes - that is what makes it read as an edge-to-edge cut of *that* piece
 * rather than a line ruled across the whole sheet.
 */
function CutLines({ plan, theme, stock, viewBox }: CutLinesProps) {
  if (plan.status !== 'complete') return null;

  const pieceRects = new Map(plan.pieces.map((piece) => [piece.id, piece.rect]));
  const badgeFont = Math.max(6, Math.min(stock.width * 0.012, 11));

  const nodes: React.ReactElement[] = [];
  for (const step of plan.steps) {
    const rect = pieceRects.get(step.pieceId);
    if (!rect) continue;
    nodes.push(
      <CutLine
        key={step.index}
        step={step}
        rect={rect}
        theme={theme}
        fontSize={badgeFont}
        viewBox={viewBox}
      />,
    );
  }
  return <g style={{ pointerEvents: 'none' }}>{nodes}</g>;
}

interface CutLineProps {
  step: CutStep;
  rect: Rect;
  theme: SheetTheme;
  fontSize: number;
  viewBox: Rect;
}

function CutLine({ step, rect, theme, fontSize, viewBox }: CutLineProps) {
  const vertical = step.axis === 'x';
  const x1 = vertical ? step.at : rect.x;
  const x2 = vertical ? step.at : rect.x + rect.width;
  const y1 = vertical ? rect.y : step.at;
  const y2 = vertical ? rect.y + rect.height : step.at;

  // The number sits just outside the near end of the line, so it never lands on
  // top of a part label - but kept inside the viewBox, because the first cuts of
  // a sheet start at its edge and a step number sliced in half by the drawing
  // boundary is worse than one resting on the sheet outline.
  const r = fontSize * 0.9;
  const bx = vertical ? step.at : Math.max(viewBox.x + r, rect.x - r * 1.4);
  const by = vertical ? Math.max(viewBox.y + r, rect.y - r * 1.4) : step.at;

  return (
    <g>
      <line
        x1={x1}
        y1={y1}
        x2={x2}
        y2={y2}
        stroke={theme.cutLine}
        strokeWidth={1.2}
        vectorEffect="non-scaling-stroke"
      />
      <circle
        cx={bx}
        cy={by}
        r={r}
        fill={theme.cutNumberFill}
        stroke={theme.cutNumberStroke}
        strokeWidth={0.8}
        vectorEffect="non-scaling-stroke"
      />
      <text
        x={bx}
        y={by}
        textAnchor="middle"
        dominantBaseline="central"
        fill={theme.cutNumberText}
        fontSize={fontSize}
        fontWeight={700}
        fontFamily="ui-mono, monospace"
        style={{ userSelect: 'none' }}
      >
        {step.index}
      </text>
    </g>
  );
}

// ---------------------------------------------------------------------------
// Grain direction indicator
// ---------------------------------------------------------------------------

interface GrainArrowProps {
  stock: Stock;
  material: Material;
  theme: SheetTheme;
}

/**
 * Small arrow in the top-left corner of the sheet indicating grain direction.
 * Only shown when the material has grain.
 */
function GrainArrow({ stock, material, theme }: GrainArrowProps) {
  if (!material.hasGrain) return null;

  // Arrow sits in the top-left corner, inside a small inset.
  const arrowLen = Math.min(stock.width, stock.height) * 0.06;
  const pad = arrowLen * 0.6;
  const headSize = arrowLen * 0.25;

  const isHorizontal = stock.grainAxis === 'x';
  const cx = pad + arrowLen / 2;
  const cy = pad + arrowLen / 2;

  // Arrow shaft and head
  const x1 = isHorizontal ? cx - arrowLen / 2 : cx;
  const y1 = isHorizontal ? cy : cy - arrowLen / 2;
  const x2 = isHorizontal ? cx + arrowLen / 2 : cx;
  const y2 = isHorizontal ? cy : cy + arrowLen / 2;

  // Arrowhead triangle points
  const headPoints = isHorizontal
    ? `${x2},${y2} ${x2 - headSize},${y2 - headSize * 0.6} ${x2 - headSize},${y2 + headSize * 0.6}`
    : `${x2},${y2} ${x2 - headSize * 0.6},${y2 - headSize} ${x2 + headSize * 0.6},${y2 - headSize}`;

  return (
    <g style={{ pointerEvents: 'none' }}>
      {/* Background pill */}
      <rect
        x={pad * 0.3}
        y={pad * 0.3}
        width={arrowLen + pad * 0.8}
        height={arrowLen + pad * 0.8}
        rx={3}
        ry={3}
        fill={theme.grainPillFill}
        fillOpacity={theme.grainPillFillOpacity}
        stroke={theme.grainPillStroke}
        strokeWidth={0.8}
        vectorEffect="non-scaling-stroke"
      />
      {/* Arrow shaft */}
      <line
        x1={x1}
        y1={y1}
        x2={x2 - (isHorizontal ? headSize * 0.5 : 0)}
        y2={y2 - (isHorizontal ? 0 : headSize * 0.5)}
        stroke={theme.grainArrow}
        strokeWidth={1.5}
        vectorEffect="non-scaling-stroke"
        strokeLinecap="round"
      />
      {/* Arrowhead */}
      <polygon points={headPoints} fill={theme.grainArrow} />
      {/* "GRAIN" label */}
      <text
        x={cx}
        y={cy + arrowLen / 2 + pad * 0.55}
        textAnchor="middle"
        fill={theme.dimensionText}
        fontSize={Math.max(5, arrowLen * 0.22)}
        fontWeight={600}
        fontFamily="ui-sans-serif, system-ui, sans-serif"
        letterSpacing="0.05em"
      >
        GRAIN
      </text>
    </g>
  );
}

// ---------------------------------------------------------------------------
// Title block
// ---------------------------------------------------------------------------

interface TitleBlockMetrics {
  titleFontSize: number;
  subFontSize: number;
  titleBaseline: number;
  subBaseline: number;
  /** Topmost drawn y, used to grow the viewBox. */
  top: number;
}

/**
 * Lay out the heading above the sheet.
 *
 * Sized against the sheet rather than in absolute units: the viewBox is in
 * millimetres of real sheet, so a fixed font size would be a wall of text on a
 * drawer side and unreadable on a full 4x8 sheet.
 */
function titleBlockMetrics(stock: Stock): TitleBlockMetrics {
  const titleFontSize = Math.max(10, Math.min(stock.width * 0.02, 22));
  const subFontSize = titleFontSize * 0.62;
  // Clears the sheet's own width label, which sits inside the top padding.
  const subBaseline = -(viewPad(stock) + widthLabelFontSize(stock));
  const titleBaseline = subBaseline - subFontSize - titleFontSize * 0.5;
  return {
    titleFontSize,
    subFontSize,
    titleBaseline,
    subBaseline,
    top: titleBaseline - titleFontSize,
  };
}

/**
 * The figure's viewBox, in millimetres of real sheet.
 *
 * Exported because the exporter has to state the drawing's physical size on the
 * root element, and that size is the viewBox. Recomputing it there would let an
 * exported file claim a size it does not have, which is the one error a CAD
 * user cannot see - the drawing would just be silently the wrong scale.
 */
export function figureViewBox(stock: Stock, showTitle: boolean): Rect {
  const pad = viewPad(stock);
  const top = showTitle ? titleBlockMetrics(stock).top : 0;
  const y = Math.min(0, top) - pad;
  return {
    x: -pad,
    y,
    width: stock.width + pad * 2,
    height: stock.height + pad - y,
  };
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function SheetFigure({
  layout,
  stock,
  parts,
  material,
  config,
  displayUnit,
  fractionDenominator,
  theme,
  hoveredPartId = null,
  onHoverPart,
  showTitle = false,
  sheetNumber,
  sheetCount,
  paintBackground = false,
  width,
  height,
  cutPlan = null,
  showCutLines = false,
  showPartNumbers = false,
}: SheetFigureProps) {
  const usable = useMemo(() => usableArea(stock, config.edgeTrim), [stock, config.edgeTrim]);
  const mode = solverMode(config);

  const partIndexMap = useMemo(() => buildPartIndexMap(parts), [parts]);

  // Resolve the sheet instance number for labelling (e.g. "Sheet 1")
  const instanceRef = parseStockInstanceId(layout.stockInstanceId);
  const sheetLabel = instanceRef ? `#${instanceRef.index + 1}` : '';

  // Stock dimension labels
  const wLabel = fmtLen(stock.width, displayUnit, fractionDenominator);
  const hLabel = fmtLen(stock.height, displayUnit, fractionDenominator);
  const unitSuffix = displayUnit.startsWith('imperial') ? '"' : ' mm';
  const widthDimFontSize = widthLabelFontSize(stock);

  // SVG viewBox with padding, grown upwards when a title block is drawn.
  const title = showTitle ? titleBlockMetrics(stock) : null;
  const { x: vbX, y: vbY, width: vbW, height: vbH } = figureViewBox(stock, showTitle);

  // Piece letters come from the cut plan, keyed by the placement they finish.
  const pieceIdByPlacement = new Map<string, string>();
  if (showPartNumbers && cutPlan && cutPlan.status === 'complete') {
    for (const piece of cutPlan.pieces) {
      if (piece.placement) {
        pieceIdByPlacement.set(placementKey(piece.placement), piece.id);
      }
    }
  }

  const rootStyle: CSSProperties =
    width === undefined && height === undefined
      ? {
          width: '100%',
          height: 'auto',
          maxHeight: '70vh',
          display: 'block',
          background: theme.background,
          borderRadius: '8px',
        }
      : { display: 'block', background: theme.background };

  return (
    <svg
      viewBox={`${vbX} ${vbY} ${vbW} ${vbH}`}
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label={`Cut diagram for ${material.name} sheet ${sheetLabel}`}
      {...(width === undefined ? {} : { width })}
      {...(height === undefined ? {} : { height })}
      style={rootStyle}
    >
      <title>{`Cut diagram — ${material.name} ${sheetLabel}`}</title>

      {/* Painted background, for files where CSS does not travel */}
      {paintBackground && <rect x={vbX} y={vbY} width={vbW} height={vbH} fill={theme.background} />}

      {/* Title block */}
      {title && (
        <g style={{ pointerEvents: 'none' }}>
          <text
            x={0}
            y={title.titleBaseline}
            fill={theme.titleText}
            fontSize={title.titleFontSize}
            fontWeight={700}
            fontFamily="ui-sans-serif, system-ui, sans-serif"
          >
            {material.name}
            {sheetNumber !== undefined && sheetCount !== undefined
              ? ` - Sheet ${sheetNumber} of ${sheetCount}`
              : ` ${sheetLabel}`}
          </text>
          <text
            x={0}
            y={title.subBaseline}
            fill={theme.titleSubText}
            fontSize={title.subFontSize}
            fontFamily="ui-mono, monospace"
          >
            {(layout.wastePct * 100).toFixed(1)}% waste · kerf{' '}
            {fmtLen(config.kerf, displayUnit, fractionDenominator)}
            {unitSuffix} · trim {fmtLen(config.edgeTrim, displayUnit, fractionDenominator)}
            {unitSuffix}
          </text>
        </g>
      )}

      {/* Full sheet outline */}
      <rect
        x={0}
        y={0}
        width={stock.width}
        height={stock.height}
        fill={theme.sheetFill}
        stroke={theme.sheetStroke}
        strokeWidth={1.5}
        vectorEffect="non-scaling-stroke"
        rx={2}
        ry={2}
      />

      {/* Usable area boundary (after edge trim) */}
      {config.edgeTrim > 0 && (
        <rect
          x={usable.x}
          y={usable.y}
          width={usable.width}
          height={usable.height}
          fill="none"
          stroke={theme.usableStroke}
          strokeWidth={1}
          strokeDasharray="6 4"
          vectorEffect="non-scaling-stroke"
        />
      )}

      {/* Edge trim label */}
      {config.edgeTrim > 0 && (
        <text
          x={usable.x + 4}
          y={usable.y - 3}
          fill={theme.dimensionText}
          fontSize={Math.max(6, Math.min(stock.width * 0.012, 11))}
          fontFamily="ui-sans-serif, system-ui, sans-serif"
          style={{ pointerEvents: 'none', userSelect: 'none' }}
        >
          trim {fmtLen(config.edgeTrim, displayUnit, fractionDenominator)}
          {unitSuffix}
        </text>
      )}

      {/* Kerf cut indicators.
          Guillotine only. These are two axis-aligned dashes off a part's
          bounding box, which is what a blade leaves. A router's clearance is an
          offset band following the outline all the way round; drawing the saw's
          version beside a nested part would claim a cut nobody is making.
          A correct router version needs polygon offsetting, which `plan-m7.md`
          §2 keeps out of this milestone. */}
      {mode === 'guillotine' && (
        <KerfLines
          placements={layout.placements}
          parts={parts}
          usable={usable}
          kerf={config.kerf}
          theme={theme}
        />
      )}

      {/* Placed parts */}
      {layout.placements.map((placement) => {
        const part = findPart(parts, placement.partId);
        if (!part) return null;
        const rect = placementRect(part, placement);
        const colorIndex = partIndexMap.get(part.id) ?? 0;
        const isHovered = hoveredPartId === placement.partId;

        return (
          <PlacedPartRect
            key={placementKey(placement)}
            placement={placement}
            part={part}
            rect={rect}
            mode={mode}
            colorIndex={colorIndex}
            isHovered={isHovered}
            displayUnit={displayUnit}
            fractionDenominator={fractionDenominator}
            theme={theme}
            pieceId={pieceIdByPlacement.get(placementKey(placement))}
            onHoverPart={onHoverPart}
          />
        );
      })}

      {/* Cut plan overlay */}
      {showCutLines && cutPlan && (
        <CutLines
          plan={cutPlan}
          theme={theme}
          stock={stock}
          viewBox={{ x: vbX, y: vbY, width: vbW, height: vbH }}
        />
      )}

      {/* Grain direction arrow */}
      <GrainArrow stock={stock} material={material} theme={theme} />

      {/* Stock width dimension (top) */}
      <text
        x={stock.width / 2}
        y={-3}
        textAnchor="middle"
        fill={theme.dimensionText}
        fontSize={widthDimFontSize}
        fontFamily="ui-mono, monospace"
        style={{ pointerEvents: 'none', userSelect: 'none' }}
      >
        {wLabel}
        {unitSuffix}
      </text>

      {/* Stock height dimension (left, rotated) */}
      <text
        x={0}
        y={0}
        textAnchor="middle"
        fill={theme.dimensionText}
        fontSize={heightLabelFontSize(stock)}
        fontFamily="ui-mono, monospace"
        transform={`translate(${-3}, ${stock.height / 2}) rotate(-90)`}
        style={{ pointerEvents: 'none', userSelect: 'none' }}
      >
        {hLabel}
        {unitSuffix}
      </text>
    </svg>
  );
}
