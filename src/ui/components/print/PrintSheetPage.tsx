/**
 * One stock sheet, printed: heading, diagram, cut list, cut sequence.
 *
 * The section carries `break-after: page`, so the next sheet always starts on a
 * fresh page. It does *not* force everything onto one page - a sheet with a
 * fifty-step cut sequence flows onto a second page rather than shrinking the
 * type to fit. Two pages an operator can read beat one they cannot.
 *
 * Scale note, because it looks like a bug and is not: a 4x8 sheet is 2438mm on
 * its long edge and a page is around 270mm of usable height, so the diagram
 * prints at roughly 1:9 however much of the page it is given. The part labels
 * drawn inside it end up near 5pt. That is why the cut list sits *beside* the
 * diagram rather than on another page - the diagram shows where a part sits,
 * the table is the legible record of what it is, and the piece letters tie the
 * two together.
 *
 * The diagram is sized here, in the markup, rather than by overriding
 * `SheetFigure`'s inline styles from `print.css`. A tall sheet leaves a page
 * two-thirds empty beside it, so the cut list goes in that space; a wide sheet
 * has no such gap and takes the full width with the list underneath. Which of
 * those applies is a property of the stock, which this component has and a
 * stylesheet does not.
 */

import type { CutPlan } from '../../../domain/cutplan';
import type { Layout, Material, Part, SolverConfig, Stock } from '../../../domain/types';
import { formatDisplayLength } from '../../format';
import type { DisplayUnit } from '../../state/types';
import { SheetFigure } from '../SheetFigure';
import { PRINT_THEME } from '../sheetTheme';
import { CutListTable } from './CutListTable';
import { CutSequenceList } from './CutSequenceList';

export interface PrintSheetPageProps {
  layout: Layout;
  stock: Stock;
  material: Material;
  /** Matches `SheetFigure` and the export inputs, which all take `Part[]`. */
  parts: Part[];
  config: SolverConfig;
  displayUnit: DisplayUnit;
  fractionDenominator: number;
  plan: CutPlan | null;
  showCutSequence: boolean;
  sheetNumber: number;
  sheetCount: number;
}

export function PrintSheetPage({
  layout,
  stock,
  material,
  parts,
  config,
  displayUnit,
  fractionDenominator,
  plan,
  showCutSequence,
  sheetNumber,
  sheetCount,
}: PrintSheetPageProps) {
  const overlay = showCutSequence && plan !== null && plan.status === 'complete';
  // A sheet taller than it is wide leaves usable page beside the diagram.
  const tall = stock.height > stock.width;

  return (
    <section className="cutz-print-page text-slate-900">
      <header className="flex items-baseline justify-between gap-4 border-b border-slate-400 pb-2">
        <h2 className="text-lg font-bold">
          Sheet {sheetNumber} of {sheetCount}
          <span className="ml-2 font-normal text-slate-700">{material.name}</span>
        </h2>
        <p className="text-xs text-slate-700 tabular-nums">
          {formatDisplayLength(stock.width, displayUnit, fractionDenominator)} ×{' '}
          {formatDisplayLength(stock.height, displayUnit, fractionDenominator)} ·{' '}
          {(layout.wastePct * 100).toFixed(1)}% waste · kerf{' '}
          {formatDisplayLength(config.kerf, displayUnit, fractionDenominator)} · trim{' '}
          {formatDisplayLength(config.edgeTrim, displayUnit, fractionDenominator)}
        </p>
      </header>

      <div className={`mt-4 gap-6 items-start ${tall ? 'flex' : 'flex flex-col'}`}>
        {/* 45% for a tall sheet. The cut list goes in the column beside it; the
            cut sequence does not, and that was tried. Squeezed into 55% of a
            page its Yields column wraps to three lines a row, which costs more
            page than the diagram saved and makes the one table an operator
            reads line by line the hardest thing on the page. */}
        <div className={`break-inside-avoid ${tall ? 'w-[45%] shrink-0' : 'w-full'}`}>
          <SheetFigure
            layout={layout}
            stock={stock}
            parts={parts}
            material={material}
            config={config}
            displayUnit={displayUnit}
            fractionDenominator={fractionDenominator}
            theme={PRINT_THEME}
            cutPlan={plan}
            showCutLines={overlay}
            showPartNumbers={overlay}
          />
        </div>

        <div className={tall ? 'flex-1 min-w-0' : 'w-full'}>
          <CutListTable
            layouts={[layout]}
            parts={parts}
            displayUnit={displayUnit}
            fractionDenominator={fractionDenominator}
            plans={plan === null ? [] : [plan]}
            variant="print"
          />
        </div>
      </div>

      {/* One switch: with the cut sequence off, neither the blade lines nor the
          step list appear, on screen, on paper, or in an exported file. */}
      {showCutSequence && plan !== null && (
        <div className="mt-6">
          <CutSequenceList
            plan={plan}
            parts={parts}
            displayUnit={displayUnit}
            fractionDenominator={fractionDenominator}
            variant="print"
          />
        </div>
      )}
    </section>
  );
}
