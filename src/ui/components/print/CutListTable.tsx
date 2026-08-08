/**
 * The parts on one sheet, as a checklist.
 *
 * Grouped by part rather than one row per placement: a sheet holding eight
 * identical shelves should read "8x Shelf Panel", not eight lines the operator
 * has to count. The piece letters are listed alongside so each row ties back to
 * the lettered rectangles on the diagram above it.
 *
 * Sizes are the *finished* dimensions of the part. A rotated placement is the
 * same part turned on the sheet, not a different size, so rotation is a note in
 * the grain column rather than swapped width and height - swapping them would
 * have the operator cut a 300x760 shelf as 760x300.
 */

import type { CutPlan } from '../../../domain/cutplan';
import type { Layout, Part } from '../../../domain/types';
import { formatDisplayLength } from '../../format';
import type { DisplayUnit } from '../../state/types';
import { placementKey } from '../SheetFigure';
import { TONES, type ToneVariant } from './tone';

export interface CutListTableProps {
  /**
   * One layout for a sheet page, every layout for the summary page. The rows
   * are the same shape either way, so the two are one component - a summary
   * total that disagrees with the pages it summarises is exactly the bug a
   * second implementation produces.
   */
  layouts: readonly Layout[];
  parts: readonly Part[];
  displayUnit: DisplayUnit;
  fractionDenominator: number;
  /**
   * Supplies the piece letters. Piece letters restart per sheet, so this is
   * only meaningful for a single layout; the summary passes nothing and the
   * column disappears.
   */
  plans?: readonly CutPlan[];
  variant?: ToneVariant;
  heading?: string;
  /** Overrides the "N pieces from this sheet" caption. */
  caption?: string;
}

interface CutListRow {
  partId: string;
  label: string;
  qty: number;
  width: number;
  height: number;
  rotationPolicy: Part['rotationPolicy'];
  rotatedCount: number;
  pieceIds: string[];
}

export function CutListTable({
  layouts,
  parts,
  displayUnit,
  fractionDenominator,
  plans = [],
  variant = 'screen',
  heading = 'Cut list',
  caption,
}: CutListTableProps) {
  const tone = TONES[variant];
  const rows = buildRows(layouts, parts, plans);
  const showPieces = rows.some((row) => row.pieceIds.length > 0);
  const total = rows.reduce((sum, row) => sum + row.qty, 0);

  return (
    <div className={`${tone.text} text-sm`}>
      <div className="flex items-baseline justify-between gap-3">
        <h4 className={`text-sm font-semibold ${tone.heading}`}>{heading}</h4>
        <p className={`text-[11px] ${tone.faint}`}>
          {caption ?? `${total} piece${total === 1 ? '' : 's'} from this sheet`}
        </p>
      </div>

      <table className="w-full mt-3 text-left tabular-nums" style={{ borderCollapse: 'collapse' }}>
        <thead>
          <tr
            className={`text-[10px] uppercase tracking-wider border-b ${tone.rule} ${tone.faint}`}
          >
            {showPieces && <th className="py-1 pr-3 font-semibold w-20">Pieces</th>}
            <th className="py-1 pr-3 font-semibold">Part</th>
            <th className="py-1 pr-3 font-semibold text-right w-10">Qty</th>
            <th className="py-1 pr-3 font-semibold text-right whitespace-nowrap">Finished size</th>
            <th className="py-1 font-semibold">Grain</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.partId}
              className={`border-b last:border-0 ${tone.rule} break-inside-avoid`}
            >
              {showPieces && (
                <td className={`py-1 pr-3 align-top font-mono text-xs ${tone.muted}`}>
                  {row.pieceIds.join(', ')}
                </td>
              )}
              <td className={`py-1 pr-3 align-top ${tone.text}`}>{row.label}</td>
              <td className={`py-1 pr-3 align-top text-right font-mono ${tone.text}`}>{row.qty}</td>
              {/* The one number on the row that gets cut to. It never wraps -
                  a size broken across two lines is the sort of thing a reader
                  glances at and mis-reads as two dimensions. */}
              <td
                className={`py-1 pr-3 align-top text-right font-mono font-semibold whitespace-nowrap ${tone.accent}`}
              >
                {formatDisplayLength(row.width, displayUnit, fractionDenominator)} ×{' '}
                {formatDisplayLength(row.height, displayUnit, fractionDenominator)}
              </td>
              <td className={`py-1 align-top text-xs ${tone.muted}`}>{grainNote(row)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Grain lock is a hard constraint, not a preference, so it is stated on every
 * row. A part marked rotatable that the solver actually turned says so too -
 * that is the row where the diagram will not match the reader's expectation.
 */
function grainNote(row: CutListRow): string {
  const base = row.rotationPolicy === 'locked' ? 'Grain locked' : 'Rotatable';
  if (row.rotatedCount === 0) return base;
  if (row.rotatedCount === row.qty) return `${base} · turned 90°`;
  return `${base} · ${row.rotatedCount} turned 90°`;
}

function buildRows(
  layouts: readonly Layout[],
  parts: readonly Part[],
  plans: readonly CutPlan[],
): CutListRow[] {
  const partsById = new Map(parts.map((part) => [part.id, part]));
  const pieceByPlacement = pieceIdsByPlacement(plans);

  const rows = new Map<string, CutListRow>();
  for (const layout of layouts) {
    for (const placement of layout.placements) {
      const part = partsById.get(placement.partId);
      if (part === undefined) continue;

      let row = rows.get(part.id);
      if (row === undefined) {
        row = {
          partId: part.id,
          label: part.label,
          qty: 0,
          width: part.width,
          height: part.height,
          rotationPolicy: part.rotationPolicy,
          rotatedCount: 0,
          pieceIds: [],
        };
        rows.set(part.id, row);
      }
      row.qty += 1;
      if (placement.rotated) row.rotatedCount += 1;

      const pieceId = pieceByPlacement.get(placementKey(placement));
      if (pieceId !== undefined) row.pieceIds.push(pieceId);
    }
  }

  for (const row of rows.values()) row.pieceIds.sort();
  return Array.from(rows.values());
}

/**
 * Placement -> piece letter, for complete plans.
 *
 * Keyed the same way `SheetFigure` keys the letters it draws on the parts, so a
 * row in this table and a rectangle on the diagram always carry the same letter.
 */
function pieceIdsByPlacement(plans: readonly CutPlan[]): ReadonlyMap<string, string> {
  const byPlacement = new Map<string, string>();
  for (const plan of plans) {
    if (plan.status !== 'complete') continue;
    for (const piece of plan.pieces) {
      if (piece.placement === null) continue;
      byPlacement.set(placementKey(piece.placement), piece.id);
    }
  }
  return byPlacement;
}
