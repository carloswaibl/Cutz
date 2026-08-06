/**
 * The printable document: every sheet, then the summary.
 *
 * A separate component tree rather than the interactive UI coerced by media
 * queries. Inverting a dark, zoomable, hover-driven interface into a printable
 * document with CSS overrides works right up until someone adds a card, and
 * then it silently prints a black rectangle. `print.css` hides the app shell
 * outright and shows this instead.
 *
 * It is `hidden` on screen and `block` in print, so it costs one render of each
 * sheet figure. That is the same work the on-screen diagram already does for
 * the active sheet, and it means the print preview is instant and correct
 * rather than assembled at the moment the user hits print.
 */

import type { CutPlan } from '../../../domain/cutplan';
import type {
  Layout,
  Material,
  Part,
  SolverConfig,
  Stock,
  UnplacedPart,
} from '../../../domain/types';
import type { DisplayUnit } from '../../state/types';
import { PrintSheetPage } from './PrintSheetPage';
import { PrintSummaryPage } from './PrintSummaryPage';

export interface PrintableLayout {
  layout: Layout;
  stock: Stock;
  material: Material;
}

export interface PrintDocumentProps {
  /**
   * The sheets to print, already narrowed by the material filter. Print covers
   * exactly what the viewer's tabs and export buttons cover - two controls in
   * one cluster with different scopes would be a trap.
   */
  layouts: readonly PrintableLayout[];
  parts: Part[];
  unplacedParts: readonly UnplacedPart[];
  config: SolverConfig;
  displayUnit: DisplayUnit;
  fractionDenominator: number;
  /** Cut plan per stock instance id. Missing entries print without a sequence. */
  planByInstanceId: ReadonlyMap<string, CutPlan>;
  showCutSequence: boolean;
  materialFilterName?: string | null;
}

export function PrintDocument({
  layouts,
  parts,
  unplacedParts,
  config,
  displayUnit,
  fractionDenominator,
  planByInstanceId,
  showCutSequence,
  materialFilterName = null,
}: PrintDocumentProps) {
  if (layouts.length === 0) return null;

  const plans = layouts
    .map((entry) => planByInstanceId.get(entry.layout.stockInstanceId))
    .filter((plan): plan is CutPlan => plan !== undefined);

  return (
    <div className="cutz-print-document" aria-hidden="true">
      {layouts.map((entry, index) => (
        <PrintSheetPage
          key={entry.layout.stockInstanceId}
          layout={entry.layout}
          stock={entry.stock}
          material={entry.material}
          parts={parts}
          config={config}
          displayUnit={displayUnit}
          fractionDenominator={fractionDenominator}
          plan={planByInstanceId.get(entry.layout.stockInstanceId) ?? null}
          showCutSequence={showCutSequence}
          sheetNumber={index + 1}
          sheetCount={layouts.length}
        />
      ))}

      <PrintSummaryPage
        layouts={layouts}
        parts={parts}
        unplacedParts={unplacedParts}
        config={config}
        displayUnit={displayUnit}
        fractionDenominator={fractionDenominator}
        plans={plans}
        materialFilterName={materialFilterName}
      />
    </div>
  );
}
