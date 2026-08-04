/**
 * SVG renderer for a single stock sheet layout.
 *
 * Receives a `Layout` from the solver and draws each placed part as a colored
 * rectangle with dimension labels, kerf-cut indicators, a grain direction arrow,
 * and a dashed usable-area boundary. All positions come from `geometry.ts` via
 * `placementRect` and `usableArea`, so the renderer and the invariant checker
 * always agree about where things sit.
 *
 * SVG internals use plain SVG attributes + CSS rather than Tailwind classes.
 * Tailwind stays on the outer wrapper `<div>`. This avoids fighting SVG-specific
 * attribute specificity — `viewBox`, `vector-effect`, `text-anchor`, and
 * `dominant-baseline` have no Tailwind equivalents, and mixing the two produces
 * inconsistent results.
 */

import { useMemo } from 'react';
import { placementRect, type Rect, usableArea } from '../../domain/geometry';
import { parseStockInstanceId } from '../../domain/instances';
import type { Layout, Material, Part, Placement, SolverConfig, Stock } from '../../domain/types';
import { formatLength, type Unit } from '../../domain/units';
import type { DisplayUnit } from '../state/types';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface SheetSvgProps {
  layout: Layout;
  stock: Stock;
  parts: Part[];
  material: Material;
  config: SolverConfig;
  displayUnit: DisplayUnit;
  fractionDenominator: number;
  hoveredPartId: string | null;
  onHoverPart: (partId: string | null) => void;
}

// ---------------------------------------------------------------------------
// Colour palette — 10 visually distinct colours for dark backgrounds.
// Cycles when there are more unique parts than palette entries.
// ---------------------------------------------------------------------------

const PART_PALETTE = [
  '#3b82f6', // blue-500
  '#f59e0b', // amber-500
  '#10b981', // emerald-500
  '#ef4444', // red-500
  '#8b5cf6', // violet-500
  '#ec4899', // pink-500
  '#06b6d4', // cyan-500
  '#f97316', // orange-500
  '#84cc16', // lime-500
  '#6366f1', // indigo-500
] as const;

function partColor(partIndex: number): string {
  const color = PART_PALETTE[partIndex % PART_PALETTE.length];
  // PART_PALETTE length is fixed, modulo always lands in range
  // biome-ignore lint: this cannot be undefined
  return color!;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Map DisplayUnit to the formatLength `Unit`. */
function toFormatUnit(du: DisplayUnit): Unit {
  return du.startsWith('imperial') ? 'in' : 'mm';
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

/** Minimum part rect dimension (in mm) to show label text. */
const MIN_LABEL_SIZE = 40;
/** Minimum part rect dimension (in mm) to show dimension text below the label. */
const MIN_DIM_SIZE = 60;

/** Padding inside the SVG viewBox, in mm. Keeps labels from clipping at edges. */
const VIEW_PAD = 8;

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

// ---------------------------------------------------------------------------
// Sub-components rendered inside the SVG
// ---------------------------------------------------------------------------

interface PlacedPartRectProps {
  placement: Placement;
  part: Part;
  rect: Rect;
  colorIndex: number;
  isHovered: boolean;
  displayUnit: DisplayUnit;
  fractionDenominator: number;
  onHoverPart: (partId: string | null) => void;
}

function PlacedPartRect({
  placement,
  part,
  rect,
  colorIndex,
  isHovered,
  displayUnit,
  fractionDenominator,
  onHoverPart,
}: PlacedPartRectProps) {
  const fill = partColor(colorIndex);
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

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: SVG <g> groups part rects for hover highlighting — no semantic interactive role applies to SVG groups
    <g
      aria-label={`Part: ${part.label}`}
      onMouseEnter={() => onHoverPart(placement.partId)}
      onMouseLeave={() => onHoverPart(null)}
      style={{ cursor: 'pointer' }}
    >
      {/* Part rectangle */}
      <rect
        x={rect.x}
        y={rect.y}
        width={rect.width}
        height={rect.height}
        fill={fill}
        fillOpacity={isHovered ? 0.45 : 0.25}
        stroke={isHovered ? '#fbbf24' : fill}
        strokeWidth={isHovered ? 2.5 : 1}
        vectorEffect="non-scaling-stroke"
        rx={1.5}
        ry={1.5}
      />

      {/* Hover glow */}
      {isHovered && (
        <rect
          x={rect.x}
          y={rect.y}
          width={rect.width}
          height={rect.height}
          fill="none"
          stroke="#fbbf24"
          strokeWidth={4}
          strokeOpacity={0.3}
          vectorEffect="non-scaling-stroke"
          rx={1.5}
          ry={1.5}
          style={{ pointerEvents: 'none' }}
        />
      )}

      {/* Part label */}
      {showLabel && (
        <text
          x={cx}
          y={showDims ? cy - dimFontSize * 0.4 : cy}
          textAnchor="middle"
          dominantBaseline="central"
          fill={isHovered ? '#fef3c7' : '#f1f5f9'}
          fontSize={fontSize}
          fontWeight={600}
          fontFamily="ui-sans-serif, system-ui, sans-serif"
          style={{ pointerEvents: 'none', userSelect: 'none' }}
        >
          {part.label}
          {placement.rotated ? ' ↻' : ''}
        </text>
      )}

      {/* Dimension text */}
      {showDims && (
        <text
          x={cx}
          y={cy + fontSize * 0.6}
          textAnchor="middle"
          dominantBaseline="central"
          fill={isHovered ? '#fde68a' : '#94a3b8'}
          fontSize={dimFontSize}
          fontFamily="ui-mono, monospace"
          style={{ pointerEvents: 'none', userSelect: 'none' }}
        >
          {dimText}
        </text>
      )}
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
}

/**
 * Render subtle dashed lines between parts where a saw cut occurs.
 *
 * For each placement, draw a kerf line along its right edge and bottom edge,
 * but only if that edge isn't flush with the usable area boundary (no cut
 * happens at sheet edges — the edge trim already handled that).
 */
function KerfLines({ placements, parts, usable, kerf }: KerfLinesProps) {
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
          stroke="#ef4444"
          strokeWidth={0.8}
          strokeOpacity={0.4}
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
          stroke="#ef4444"
          strokeWidth={0.8}
          strokeOpacity={0.4}
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
// Grain direction indicator
// ---------------------------------------------------------------------------

interface GrainArrowProps {
  stock: Stock;
  material: Material;
}

/**
 * Small arrow in the top-left corner of the sheet indicating grain direction.
 * Only shown when the material has grain.
 */
function GrainArrow({ stock, material }: GrainArrowProps) {
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
        fill="#0f172a"
        fillOpacity={0.7}
        stroke="#334155"
        strokeWidth={0.8}
        vectorEffect="non-scaling-stroke"
      />
      {/* Arrow shaft */}
      <line
        x1={x1}
        y1={y1}
        x2={x2 - (isHorizontal ? headSize * 0.5 : 0)}
        y2={y2 - (isHorizontal ? 0 : headSize * 0.5)}
        stroke="#94a3b8"
        strokeWidth={1.5}
        vectorEffect="non-scaling-stroke"
        strokeLinecap="round"
      />
      {/* Arrowhead */}
      <polygon points={headPoints} fill="#94a3b8" />
      {/* "GRAIN" label */}
      <text
        x={cx}
        y={cy + arrowLen / 2 + pad * 0.55}
        textAnchor="middle"
        fill="#64748b"
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
// Main component
// ---------------------------------------------------------------------------

export function SheetSvg({
  layout,
  stock,
  parts,
  material,
  config,
  displayUnit,
  fractionDenominator,
  hoveredPartId,
  onHoverPart,
}: SheetSvgProps) {
  const usable = useMemo(() => usableArea(stock, config.edgeTrim), [stock, config.edgeTrim]);

  const partIndexMap = useMemo(() => buildPartIndexMap(parts), [parts]);

  // Resolve the sheet instance number for labelling (e.g. "Sheet 1")
  const instanceRef = parseStockInstanceId(layout.stockInstanceId);
  const sheetLabel = instanceRef ? `#${instanceRef.index + 1}` : '';

  // SVG viewBox with padding
  const vbX = -VIEW_PAD;
  const vbY = -VIEW_PAD;
  const vbW = stock.width + VIEW_PAD * 2;
  const vbH = stock.height + VIEW_PAD * 2;

  // Stock dimension labels
  const wLabel = fmtLen(stock.width, displayUnit, fractionDenominator);
  const hLabel = fmtLen(stock.height, displayUnit, fractionDenominator);
  const unitSuffix = displayUnit.startsWith('imperial') ? '"' : ' mm';

  return (
    <div className="relative">
      <svg
        viewBox={`${vbX} ${vbY} ${vbW} ${vbH}`}
        xmlns="http://www.w3.org/2000/svg"
        role="img"
        aria-label={`Cut diagram for ${material.name} sheet ${sheetLabel}`}
        style={{
          width: '100%',
          height: 'auto',
          maxHeight: '70vh',
          display: 'block',
          background: '#0f172a',
          borderRadius: '8px',
        }}
      >
        <title>{`Cut diagram — ${material.name} ${sheetLabel}`}</title>
        {/* Full sheet outline */}
        <rect
          x={0}
          y={0}
          width={stock.width}
          height={stock.height}
          fill="#1e293b"
          stroke="#334155"
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
            stroke="#475569"
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
            fill="#64748b"
            fontSize={Math.max(6, Math.min(stock.width * 0.012, 11))}
            fontFamily="ui-sans-serif, system-ui, sans-serif"
            style={{ pointerEvents: 'none', userSelect: 'none' }}
          >
            trim {fmtLen(config.edgeTrim, displayUnit, fractionDenominator)}
            {unitSuffix}
          </text>
        )}

        {/* Kerf cut indicators */}
        <KerfLines
          placements={layout.placements}
          parts={parts}
          usable={usable}
          kerf={config.kerf}
        />

        {/* Placed parts */}
        {layout.placements.map((placement) => {
          const part = findPart(parts, placement.partId);
          if (!part) return null;
          const rect = placementRect(part, placement);
          const colorIndex = partIndexMap.get(part.id) ?? 0;
          const isHovered = hoveredPartId === placement.partId;

          return (
            <PlacedPartRect
              key={`${placement.partId}-${placement.x}-${placement.y}`}
              placement={placement}
              part={part}
              rect={rect}
              colorIndex={colorIndex}
              isHovered={isHovered}
              displayUnit={displayUnit}
              fractionDenominator={fractionDenominator}
              onHoverPart={onHoverPart}
            />
          );
        })}

        {/* Grain direction arrow */}
        <GrainArrow stock={stock} material={material} />

        {/* Stock width dimension (top) */}
        <text
          x={stock.width / 2}
          y={-3}
          textAnchor="middle"
          fill="#64748b"
          fontSize={Math.max(7, Math.min(stock.width * 0.014, 12))}
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
          fill="#64748b"
          fontSize={Math.max(7, Math.min(stock.height * 0.014, 12))}
          fontFamily="ui-mono, monospace"
          transform={`translate(${-3}, ${stock.height / 2}) rotate(-90)`}
          style={{ pointerEvents: 'none', userSelect: 'none' }}
        >
          {hLabel}
          {unitSuffix}
        </text>
      </svg>

      {/* Sheet label overlay */}
      <div className="absolute top-2 right-2 bg-slate-900/80 text-slate-400 text-xs font-mono px-2 py-0.5 rounded border border-slate-700/60">
        {material.name} {sheetLabel} — {(layout.wastePct * 100).toFixed(1)}% waste
      </div>
    </div>
  );
}
