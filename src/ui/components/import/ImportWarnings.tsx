import type { ImportWarning } from '../../../import/types';

interface ImportWarningsProps {
  warnings: ImportWarning[];
}

/**
 * Grouped and counted, collapsed by default - matching the cut-sequence
 * panel's `<details>` pattern in `LayoutViewer`. Each `ImportWarning.message`
 * already names the construct and says what to do; this component only lays
 * them out, per `docs/plan-m4.md` §6.
 */
export function ImportWarnings({ warnings }: ImportWarningsProps) {
  if (warnings.length === 0) return null;

  const total = warnings.reduce((sum, w) => sum + w.count, 0);

  return (
    <details
      open={warnings.length <= 2}
      className="bg-amber-500/5 border border-amber-500/30 rounded-lg overflow-hidden"
    >
      <summary className="cursor-pointer select-none px-3 py-2 text-sm font-medium text-amber-300 hover:bg-amber-500/10 transition-colors">
        {warnings.length === 1 ? '1 warning' : `${warnings.length} warnings`}
        <span className="ml-2 text-xs font-normal text-amber-400/70">
          {total} {total === 1 ? 'item' : 'items'} affected
        </span>
      </summary>
      <ul className="px-3 pb-3 flex flex-col gap-2">
        {warnings.map((warning) => (
          // Warnings are already folded on kind+message by the importer, so
          // that pair is a stable, unique key with no positional index needed.
          <li
            key={`${warning.kind}:${warning.message}`}
            className="text-xs text-slate-300 leading-relaxed"
          >
            {warning.message}
          </li>
        ))}
      </ul>
    </details>
  );
}
