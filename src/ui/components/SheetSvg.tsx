/**
 * On-screen cut diagram for a single stock sheet.
 *
 * Screen chrome only: the wrapper the zoom/pan canvas positions, and the waste
 * badge floating over the top-right corner. The drawing itself lives in
 * `SheetFigure`, because print and export need it without any of this.
 *
 * The badge is deliberately HTML rather than SVG. On screen it should stay
 * crisp and unscaled while the diagram zooms; the equivalent for paper and for
 * exported files is `SheetFigure`'s `showTitle` block, which is inside the SVG
 * where a standalone file can carry it.
 */

import { parseStockInstanceId } from '../../domain/instances';
import type { Layout, Material, Part, SolverConfig, Stock } from '../../domain/types';
import type { DisplayUnit } from '../state/types';
import { SheetFigure } from './SheetFigure';
import { SCREEN_THEME } from './sheetTheme';

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
  const sheetLabel = sheetLabelFor(layout.stockInstanceId);

  return (
    <div className="relative">
      <SheetFigure
        layout={layout}
        stock={stock}
        parts={parts}
        material={material}
        config={config}
        displayUnit={displayUnit}
        fractionDenominator={fractionDenominator}
        theme={SCREEN_THEME}
        hoveredPartId={hoveredPartId}
        onHoverPart={onHoverPart}
      />

      {/* Sheet label overlay */}
      <div className="absolute top-2 right-2 bg-slate-900/80 text-slate-400 text-xs font-mono px-2 py-0.5 rounded border border-slate-700/60">
        {material.name} {sheetLabel} — {(layout.wastePct * 100).toFixed(1)}% waste
      </div>
    </div>
  );
}

/** `#1`, `#2`, ... from a stock instance id, or empty when it cannot be parsed. */
function sheetLabelFor(stockInstanceId: string): string {
  const ref = parseStockInstanceId(stockInstanceId);
  return ref ? `#${ref.index + 1}` : '';
}
