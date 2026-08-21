import type { Material, RotationPolicy } from '../../../domain/types';
import type { ImportedPart, ImportOutcome, ScaleSource } from '../../../import/types';
import { formatDisplayLength, toFormatUnit } from '../../format';
import type { DisplayUnit } from '../../state/types';
import { ImportWarnings } from './ImportWarnings';

type Outcome = Extract<ImportOutcome, { ok: true }>;

/** One row the user can edit or exclude before commit. */
export interface PreviewRow {
  part: ImportedPart;
  label: string;
  qty: number;
  selected: boolean;
}

export function initialRows(outcome: Outcome): PreviewRow[] {
  return outcome.parts.map((part) => ({
    part,
    label: part.label,
    qty: part.qty,
    // Every row that reaches the preview is a part - `flags` are advisory,
    // never a second source of truth on wantedness (docs/plan-m4.md §9 #8/#9).
    // Selection is plain local UI state, ticked by default.
    selected: true,
  }));
}

/**
 * Rows grouped from a near-square or circular outline report an angle that is
 * an artefact of where the flattener placed vertices, not a real orientation -
 * see `docs/plan-m4.md` §7's PR 2 finding. `GROUP_TOLERANCE_MM` mirrors the
 * grouping tolerance in `import/group.ts`: a shape whose box is square to
 * within that tolerance has no meaningful "wide side" to report an angle for.
 */
const GROUP_TOLERANCE_MM = 0.5;

function angleText(part: ImportedPart): string {
  if (Math.abs(part.width - part.height) <= GROUP_TOLERANCE_MM) return '—';
  return `${part.angle.toFixed(1)}°`;
}

function flagText(part: ImportedPart): string | null {
  if (part.flags.length === 0) return null;
  return part.flags
    .map((flag) =>
      flag.kind === 'sheared' ? 'skewed, oversized' : `sizes vary by ${flag.spreadMm.toFixed(1)}mm`,
    )
    .join('; ');
}

function scaleWords(
  scale: ScaleSource,
  drawingWidthMm: number | null,
  displayUnit: DisplayUnit,
  fractionDenominator: number,
): string {
  const wide =
    drawingWidthMm !== null
      ? ` ${formatDisplayLength(drawingWidthMm, displayUnit, fractionDenominator)} wide`
      : '';
  switch (scale.kind) {
    case 'declared':
      return `Declared in the file:${wide}.`;
    case 'assumed-px':
      return `No physical unit given - assumed 96px per inch:${wide}.`;
    case 'user':
      return `Using the width you entered:${wide}.`;
    case 'none':
      return "No scale could be detected in this file. Enter the drawing's width below to continue.";
  }
}

interface ImportPreviewProps {
  outcome: Outcome;
  rows: PreviewRow[];
  onRowChange: (
    index: number,
    patch: Partial<Pick<PreviewRow, 'label' | 'qty' | 'selected'>>,
  ) => void;
  materials: Material[];
  materialId: string;
  onMaterialChange: (id: string) => void;
  rotationPolicy: RotationPolicy;
  onRotationPolicyChange: (policy: RotationPolicy) => void;
  mode: 'append' | 'replace';
  onModeChange: (mode: 'append' | 'replace') => void;
  existingPartCount: number;
  displayUnit: DisplayUnit;
  fractionDenominator: number;
  overrideText: string;
  onOverrideChange: (text: string) => void;
  onOverrideBlur: () => void;
  overrideError: string | null;
  onCommit: () => void;
}

export function ImportPreview({
  outcome,
  rows,
  onRowChange,
  materials,
  materialId,
  onMaterialChange,
  rotationPolicy,
  onRotationPolicyChange,
  mode,
  onModeChange,
  existingPartCount,
  displayUnit,
  fractionDenominator,
  overrideText,
  onOverrideChange,
  onOverrideBlur,
  overrideError,
  onCommit,
}: ImportPreviewProps) {
  const noMaterials = materials.length === 0;
  const noScale = outcome.scale.kind === 'none' && overrideText.trim() === '';
  const canCommit = !noMaterials && !noScale && !overrideError;

  const selectedRows = rows.filter((r) => r.selected);
  const selectedParts = selectedRows.length;
  const selectedPieces = selectedRows.reduce((sum, r) => sum + Math.max(0, r.qty), 0);

  return (
    <div className="flex flex-col gap-4">
      {/* Scale */}
      <div className="flex flex-col gap-2">
        <p className="text-sm text-slate-300">
          {scaleWords(outcome.scale, outcome.drawingWidthMm, displayUnit, fractionDenominator)}
        </p>
        <label className="flex items-center gap-2 text-xs text-slate-400">
          Drawing is
          <input
            type="text"
            value={overrideText}
            onChange={(e) => onOverrideChange(e.target.value)}
            onBlur={onOverrideBlur}
            placeholder={toFormatUnit(displayUnit) === 'in' ? `e.g. 24"` : 'e.g. 600mm'}
            className={`w-28 bg-slate-950/80 border ${
              overrideError ? 'border-red-500 text-red-300' : 'border-slate-800 text-slate-100'
            } text-xs font-mono rounded px-2 py-1 focus:outline-none focus:border-amber-500`}
          />
          wide
        </label>
        {overrideError && <span className="text-[11px] text-red-400">{overrideError}</span>}
      </div>

      <ImportWarnings warnings={outcome.warnings} />

      {/* Parts */}
      <div className="overflow-x-auto border border-slate-800 rounded-lg">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-slate-800 text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
              <th className="px-2 py-2 w-8" />
              <th className="px-2 py-2">Label</th>
              <th className="px-2 py-2 w-24">Width</th>
              <th className="px-2 py-2 w-24">Height</th>
              <th className="px-2 py-2 w-16 text-center">Qty</th>
              <th className="px-2 py-2 w-16 text-center">Angle</th>
              <th className="px-2 py-2">Notes</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr
                key={row.part.sourceIds.join(',') || row.part.label}
                className="border-b border-slate-800/60"
              >
                <td className="px-2 py-1.5 text-center">
                  <input
                    type="checkbox"
                    checked={row.selected}
                    onChange={(e) => onRowChange(index, { selected: e.target.checked })}
                  />
                </td>
                <td className="px-2 py-1.5">
                  <input
                    type="text"
                    value={row.label}
                    onChange={(e) => onRowChange(index, { label: e.target.value })}
                    className="w-full bg-slate-950/80 border border-slate-800 text-slate-100 text-xs rounded px-2 py-1 focus:outline-none focus:border-amber-500"
                  />
                </td>
                <td className="px-2 py-1.5 text-xs font-mono text-slate-300">
                  {formatDisplayLength(row.part.width, displayUnit, fractionDenominator)}
                </td>
                <td className="px-2 py-1.5 text-xs font-mono text-slate-300">
                  {formatDisplayLength(row.part.height, displayUnit, fractionDenominator)}
                </td>
                <td className="px-2 py-1.5">
                  <input
                    type="number"
                    min="1"
                    value={row.qty}
                    onChange={(e) =>
                      onRowChange(index, { qty: Math.max(1, parseInt(e.target.value, 10) || 1) })
                    }
                    className="w-16 bg-slate-950/80 border border-slate-800 text-slate-100 text-xs font-mono rounded px-2 py-1 text-center focus:outline-none focus:border-amber-500"
                  />
                </td>
                <td className="px-2 py-1.5 text-xs font-mono text-center text-slate-400">
                  {angleText(row.part)}
                </td>
                <td className="px-2 py-1.5 text-xs text-amber-400/80">{flagText(row.part)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Defaults */}
      <div className="flex flex-wrap items-end gap-4">
        <div className="flex flex-col gap-1 text-xs text-slate-400">
          <label htmlFor="import-material">Material</label>
          {noMaterials ? (
            <span className="text-red-400">
              No materials yet - add one in the material manager above before importing.
            </span>
          ) : (
            <select
              id="import-material"
              value={materialId}
              onChange={(e) => onMaterialChange(e.target.value)}
              className="bg-slate-950/80 border border-slate-800 text-slate-200 text-xs rounded px-2 py-1.5 focus:outline-none focus:border-amber-500"
            >
              {materials.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          )}
        </div>

        <label className="flex flex-col gap-1 text-xs text-slate-400">
          Rotation
          <select
            value={rotationPolicy}
            onChange={(e) => onRotationPolicyChange(e.target.value as RotationPolicy)}
            className="bg-slate-950/80 border border-slate-800 text-slate-200 text-xs rounded px-2 py-1.5 focus:outline-none focus:border-amber-500"
          >
            <option value="free90">Free 90{'°'}</option>
            <option value="locked">Grain locked</option>
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs text-slate-400">
          Add to project
          <select
            value={mode}
            onChange={(e) => onModeChange(e.target.value as 'append' | 'replace')}
            className="bg-slate-950/80 border border-slate-800 text-slate-200 text-xs rounded px-2 py-1.5 focus:outline-none focus:border-amber-500"
          >
            <option value="append">Append to the {existingPartCount} existing parts</option>
            <option value="replace">Replace all {existingPartCount} existing parts</option>
          </select>
        </label>
      </div>

      <button
        type="button"
        onClick={onCommit}
        disabled={!canCommit}
        className="self-end px-4 py-2 bg-amber-500 hover:bg-amber-600 disabled:bg-slate-800 disabled:text-slate-500 disabled:cursor-not-allowed text-slate-950 font-semibold text-sm rounded-lg transition shadow-sm"
      >
        Add {selectedParts} {selectedParts === 1 ? 'part' : 'parts'} ({selectedPieces}{' '}
        {selectedPieces === 1 ? 'piece' : 'pieces'})
      </button>
    </div>
  );
}
