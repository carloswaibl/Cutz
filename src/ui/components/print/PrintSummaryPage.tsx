/**
 * The last page: what the whole job comes to.
 *
 * Deliberately last rather than first. The sheet pages are what an operator
 * works from and they should be on top of the stack; this page is the one they
 * check against before starting and after finishing.
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
import { formatDisplayLength, toFormatUnit } from '../../format';
import type { DisplayUnit } from '../../state/types';
import { CutListTable } from './CutListTable';

export interface PrintSummaryPageProps {
  /** The layouts actually printed, which the material filter may have narrowed. */
  layouts: readonly { layout: Layout; stock: Stock; material: Material }[];
  parts: Part[];
  unplacedParts: readonly UnplacedPart[];
  config: SolverConfig;
  displayUnit: DisplayUnit;
  fractionDenominator: number;
  plans: readonly CutPlan[];
  /** Set when the print covers one material rather than the whole project. */
  materialFilterName?: string | null;
}

export function PrintSummaryPage({
  layouts,
  parts,
  unplacedParts,
  config,
  displayUnit,
  fractionDenominator,
  plans,
  materialFilterName = null,
}: PrintSummaryPageProps) {
  const partsById = new Map(parts.map((part) => [part.id, part]));

  const placedCount = layouts.reduce((sum, entry) => sum + entry.layout.placements.length, 0);
  const unplaced = unplacedParts.filter((entry) => partsById.has(entry.partId));
  const unplacedCount = unplaced.reduce((sum, entry) => sum + entry.qty, 0);

  // Waste over the sheets on this printout, not the solver's project-wide
  // figure: with a material filter on, those are different numbers, and the one
  // that belongs on a page listing three sheets is the one about three sheets.
  const sheetArea = layouts.reduce((sum, entry) => sum + entry.stock.width * entry.stock.height, 0);
  const wasteArea = layouts.reduce(
    (sum, entry) => sum + entry.stock.width * entry.stock.height * entry.layout.wastePct,
    0,
  );
  const wastePct = sheetArea > 0 ? (wasteArea / sheetArea) * 100 : 0;

  const sheetsByMaterial = new Map<string, number>();
  for (const entry of layouts) {
    sheetsByMaterial.set(entry.material.name, (sheetsByMaterial.get(entry.material.name) ?? 0) + 1);
  }

  const incompletePlans = plans.filter((plan) => plan.status !== 'complete').length;

  return (
    <section className="cutz-print-page cutz-print-page-last text-slate-900">
      <header className="flex items-baseline justify-between gap-4 border-b border-slate-400 pb-2">
        <h2 className="text-lg font-bold">Project summary</h2>
        <p className="text-xs text-slate-700">
          {materialFilterName === null
            ? 'All materials'
            : `Filtered to ${materialFilterName} - other materials are not on this printout`}
        </p>
      </header>

      <dl className="mt-4 grid grid-cols-4 gap-4 text-slate-900">
        <Stat label="Sheets" value={String(layouts.length)} />
        <Stat label="Parts placed" value={String(placedCount)} />
        <Stat label="Unplaced" value={String(unplacedCount)} />
        <Stat label="Waste" value={`${wastePct.toFixed(1)}%`} />
      </dl>

      <div className="mt-6 grid grid-cols-2 gap-8 items-start">
        <div>
          <h3 className="text-sm font-semibold border-b border-slate-400 pb-1">Saw settings</h3>
          <dl className="mt-2 text-sm">
            <SettingRow
              label="Kerf"
              value={formatDisplayLength(config.kerf, displayUnit, fractionDenominator)}
            />
            <SettingRow
              label="Edge trim"
              value={formatDisplayLength(config.edgeTrim, displayUnit, fractionDenominator)}
            />
            <SettingRow label="Units" value={unitLabel(displayUnit)} />
            <SettingRow label="Solver effort" value={config.effort ?? 'balanced'} />
            <SettingRow label="Seed" value={String(config.seed)} />
          </dl>
        </div>

        <div>
          <h3 className="text-sm font-semibold border-b border-slate-400 pb-1">Stock used</h3>
          <dl className="mt-2 text-sm">
            {Array.from(sheetsByMaterial.entries()).map(([name, count]) => (
              <SettingRow
                key={name}
                label={name}
                value={`${count} sheet${count === 1 ? '' : 's'}`}
              />
            ))}
          </dl>
        </div>
      </div>

      <div className="mt-6">
        <CutListTable
          layouts={layouts.map((entry) => entry.layout)}
          parts={parts}
          displayUnit={displayUnit}
          fractionDenominator={fractionDenominator}
          variant="print"
          heading="Full cut list"
          caption={`${placedCount} piece${placedCount === 1 ? '' : 's'} across ${layouts.length} sheet${
            layouts.length === 1 ? '' : 's'
          }`}
        />
      </div>

      {unplaced.length > 0 && (
        <div className="mt-6 border border-slate-400 p-3">
          <h3 className="text-sm font-semibold">Not placed - buy more stock</h3>
          <p className="text-xs text-slate-700 mt-1">
            These parts did not fit on the available sheets. They are not on any diagram in this
            printout.
          </p>
          <ul className="mt-2 text-sm">
            {unplaced.map((entry) => (
              <li
                key={entry.partId}
                className="flex justify-between border-b border-slate-300 py-1"
              >
                <span>{partsById.get(entry.partId)?.label ?? entry.partId}</span>
                <span className="font-mono">{entry.qty} missing</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {incompletePlans > 0 && (
        <p className="mt-6 text-xs text-slate-700">
          {incompletePlans} sheet{incompletePlans === 1 ? '' : 's'} on this printout carry no cut
          sequence. Their diagrams are still correct; only the order of operations is missing.
        </p>
      )}

      <p className="mt-6 text-[10px] text-slate-500">
        Cut sequences are a valid order of operations derived from the layout. They are not
        reordered to minimise fence or blade-height changes. Check every dimension before cutting.
      </p>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-slate-400 p-2">
      <dt className="text-[10px] uppercase tracking-wider text-slate-600">{label}</dt>
      <dd className="text-xl font-bold tabular-nums">{value}</dd>
    </div>
  );
}

function SettingRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between border-b border-slate-300 py-1">
      <dt className="text-slate-700">{label}</dt>
      <dd className="font-mono">{value}</dd>
    </div>
  );
}

/**
 * What unit the numbers on this printout are actually in.
 *
 * Still derived from `toFormatUnit` rather than asserted from the `DisplayUnit`
 * name. The two agree now that `metric-cm` is gone, but naming a unit the page's
 * numbers are not in is the one error on a cut sheet that turns a correct layout
 * into scrap, so this reads the same function the numbers were formatted by.
 */
function unitLabel(displayUnit: DisplayUnit): string {
  if (toFormatUnit(displayUnit) === 'in') {
    return displayUnit === 'imperial-fraction' ? 'inches, fractional' : 'inches, decimal';
  }
  return 'millimetres';
}
