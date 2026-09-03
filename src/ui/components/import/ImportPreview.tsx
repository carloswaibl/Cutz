import type { Material, RotationPolicy } from '../../../domain/types';
import type { ImportedPart, ImportOutcome, ScaleSource } from '../../../import/types';
import { formatDisplayLength, toFormatUnit } from '../../format';
import type { DisplayUnit } from '../../state/types';
import { ImportWarnings } from './ImportWarnings';
import { suggestMaterialId } from './materialSuggestion';

type Outcome = Extract<ImportOutcome, { ok: true }>;

/** One row the user can edit or exclude before commit. */
export interface PreviewRow {
  part: ImportedPart;
  label: string;
  qty: number;
  selected: boolean;
  materialId: string;
}

/**
 * One dropped/picked file's own state, from "still reading" through "parsed
 * and ready to review" or "could not be used at all." A file that failed to
 * parse still gets its own entry here rather than aborting the whole drop -
 * `docs/plan-m5.md` §5's "each file is parsed independently" applies to
 * failure as much as success.
 */
export type PreviewFileState =
  | { status: 'reading' }
  | { status: 'error'; message: string }
  | {
      status: 'ready';
      kind: 'svg' | 'stl';
      outcome: Outcome;
      /** STL only - `null` for an SVG file, which has no thickness to report. */
      thicknessMm: Record<string, number> | null;
      rows: PreviewRow[];
      overrideText: string;
      overrideError: string | null;
    };

export interface PreviewFile {
  id: string;
  filename: string;
  state: PreviewFileState;
}

/**
 * A row's thickness, averaged across the `sourceId`s that fed into it -
 * grouping collapses several accepted components into one row when their
 * dimensions match, and they were the same physical panel, so they should
 * report (very nearly) the same thickness. `null` for an SVG row, which has
 * no `thicknessMm` map to look itself up in at all.
 */
function thicknessForRow(
  row: PreviewRow,
  thicknessMm: Record<string, number> | null,
): number | null {
  if (!thicknessMm) return null;
  const values = row.part.sourceIds
    .map((id) => thicknessMm[id])
    .filter((v): v is number => v !== undefined);
  if (values.length === 0) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

export function initialRows(
  outcome: Outcome,
  materials: readonly Material[],
  selectedMaterialId: string | 'all',
  thicknessMm: Record<string, number> | null,
): PreviewRow[] {
  const fallbackId = selectedMaterialId !== 'all' ? selectedMaterialId : (materials[0]?.id ?? '');
  return outcome.parts.map((part) => {
    const thickness = thicknessMm
      ? (part.sourceIds.map((id) => thicknessMm[id]).find((v) => v !== undefined) ?? null)
      : null;
    return {
      part,
      label: part.label,
      qty: part.qty,
      // Every row that reaches the preview is a part - `flags` are advisory,
      // never a second source of truth on wantedness (docs/plan-m4.md §9 #8/#9).
      // Selection is plain local UI state, ticked by default.
      selected: true,
      materialId: suggestMaterialId(thickness, materials, fallbackId),
    };
  });
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
  if (Math.abs(part.width - part.height) <= GROUP_TOLERANCE_MM) return '-';
  return `${part.angle.toFixed(1)}°`;
}

/**
 * The shape the importer actually found, at thumbnail size.
 *
 * The cheapest possible end-to-end check that outline retention works: if this
 * draws a rectangle for a bracket, the outline died somewhere upstream and the
 * router would cut a rectangle too.
 *
 * No transform and no y-flip are needed. `src/import/outline.ts` guarantees the
 * outline is in part-local millimetres with the origin at the bounding box's
 * top-left, y growing down exactly as SVG's does, and bounds equal to the
 * reported width/height - so the part's own box *is* the viewBox.
 *
 * A row with no outline is its own bounding box (`isBoxOutline` in `group.ts`
 * drops the field in that case), so it draws as the rectangle it is rather than
 * as a blank cell - the column then means "this is the shape", never "we have no
 * idea".
 */
function ShapeThumbnail({ part }: { part: ImportedPart }) {
  const points =
    part.outline !== undefined
      ? part.outline.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ')
      : `0,0 ${part.width},0 ${part.width},${part.height} 0,${part.height}`;

  return (
    <svg
      viewBox={`0 0 ${part.width} ${part.height}`}
      preserveAspectRatio="xMidYMid meet"
      width="28"
      height="28"
      role="img"
      aria-label={part.outline !== undefined ? 'Shaped part' : 'Rectangular part'}
      className="text-amber-400/70"
    >
      <title>{part.outline !== undefined ? 'Shaped part' : 'Rectangular part'}</title>
      {/* `non-scaling-stroke` keeps the hairline a hairline: the viewBox spans
          hundreds of millimetres inside a 28px box, so a plain stroke width
          would scale down to nothing. */}
      <polygon
        points={points}
        fill="currentColor"
        fillOpacity={0.2}
        stroke="currentColor"
        strokeWidth={1}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
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
      return 'No scale could be detected in this file. Enter its width below to continue.';
  }
}

interface FileRowsProps {
  file: PreviewFile;
  onRowChange: (
    fileId: string,
    index: number,
    patch: Partial<Pick<PreviewRow, 'label' | 'qty' | 'selected' | 'materialId'>>,
  ) => void;
  materials: Material[];
  displayUnit: DisplayUnit;
  fractionDenominator: number;
  onOverrideChange: (fileId: string, text: string) => void;
  onOverrideBlur: (fileId: string) => void;
  showFilename: boolean;
}

function FileSection({
  file,
  onRowChange,
  materials,
  displayUnit,
  fractionDenominator,
  onOverrideChange,
  onOverrideBlur,
  showFilename,
}: FileRowsProps) {
  const { state } = file;

  if (state.status === 'reading') {
    return <p className="text-sm text-slate-400">{file.filename}: reading…</p>;
  }

  if (state.status === 'error') {
    return (
      <p className="text-sm text-red-300" role="alert">
        {showFilename ? `${file.filename}: ` : ''}
        {state.message}
      </p>
    );
  }

  const { outcome, rows, overrideText, overrideError, thicknessMm } = state;

  return (
    <div className="flex flex-col gap-2">
      {showFilename && (
        <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide">
          {file.filename}
        </p>
      )}

      <div className="flex flex-col gap-2">
        <p className="text-sm text-slate-300">
          {scaleWords(outcome.scale, outcome.drawingWidthMm, displayUnit, fractionDenominator)}
        </p>
        <label className="flex items-center gap-2 text-xs text-slate-400">
          {showFilename ? 'This file is' : 'Drawing is'}
          <input
            type="text"
            value={overrideText}
            onChange={(e) => onOverrideChange(file.id, e.target.value)}
            onBlur={() => onOverrideBlur(file.id)}
            placeholder={toFormatUnit(displayUnit) === 'in' ? `e.g. 24"` : 'e.g. 600mm'}
            className={`w-28 bg-slate-950/80 border ${
              overrideError ? 'border-red-500 text-red-300' : 'border-slate-800 text-slate-100'
            } text-xs font-mono rounded px-2 py-1 focus:outline-none focus:border-amber-500`}
          />
          wide
        </label>
        {overrideError && <span className="text-[11px] text-red-400">{overrideError}</span>}
      </div>

      <div className="overflow-x-auto border border-slate-800 rounded-lg">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-slate-800 text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
              <th className="px-2 py-2 w-8" />
              <th className="px-2 py-2 w-12">Shape</th>
              <th className="px-2 py-2">Label</th>
              <th className="px-2 py-2 w-24">Width</th>
              <th className="px-2 py-2 w-24">Height</th>
              <th className="px-2 py-2 w-16 text-center">Qty</th>
              <th className="px-2 py-2 w-16 text-center">Angle</th>
              {thicknessMm && <th className="px-2 py-2 w-20">Thickness</th>}
              <th className="px-2 py-2 w-36">Material</th>
              <th className="px-2 py-2">Notes</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => {
              const thickness = thicknessForRow(row, thicknessMm);
              return (
                <tr
                  key={row.part.sourceIds.join(',') || row.part.label}
                  className="border-b border-slate-800/60"
                >
                  <td className="px-2 py-1.5 text-center">
                    <input
                      type="checkbox"
                      checked={row.selected}
                      onChange={(e) => onRowChange(file.id, index, { selected: e.target.checked })}
                    />
                  </td>
                  <td className="px-2 py-1.5">
                    <ShapeThumbnail part={row.part} />
                  </td>
                  <td className="px-2 py-1.5">
                    <input
                      type="text"
                      value={row.label}
                      onChange={(e) => onRowChange(file.id, index, { label: e.target.value })}
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
                        onRowChange(file.id, index, {
                          qty: Math.max(1, parseInt(e.target.value, 10) || 1),
                        })
                      }
                      className="w-16 bg-slate-950/80 border border-slate-800 text-slate-100 text-xs font-mono rounded px-2 py-1 text-center focus:outline-none focus:border-amber-500"
                    />
                  </td>
                  <td className="px-2 py-1.5 text-xs font-mono text-center text-slate-400">
                    {angleText(row.part)}
                  </td>
                  {thicknessMm && (
                    <td className="px-2 py-1.5 text-xs font-mono text-slate-300">
                      {thickness !== null
                        ? formatDisplayLength(thickness, displayUnit, fractionDenominator)
                        : ''}
                    </td>
                  )}
                  <td className="px-2 py-1.5">
                    {materials.length === 0 ? (
                      <span className="text-xs text-red-400">none</span>
                    ) : (
                      <select
                        value={row.materialId}
                        onChange={(e) =>
                          onRowChange(file.id, index, { materialId: e.target.value })
                        }
                        className="w-full bg-slate-950/80 border border-slate-800 text-slate-200 text-xs rounded px-2 py-1 focus:outline-none focus:border-amber-500"
                      >
                        {materials.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.name} (
                            {formatDisplayLength(m.thickness, displayUnit, fractionDenominator)})
                          </option>
                        ))}
                      </select>
                    )}
                  </td>
                  <td className="px-2 py-1.5 text-xs text-amber-400/80">{flagText(row.part)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <ImportWarnings warnings={outcome.warnings} />
    </div>
  );
}

interface ImportPreviewProps {
  files: PreviewFile[];
  onRowChange: (
    fileId: string,
    index: number,
    patch: Partial<Pick<PreviewRow, 'label' | 'qty' | 'selected' | 'materialId'>>,
  ) => void;
  materials: Material[];
  rotationPolicy: RotationPolicy;
  onRotationPolicyChange: (policy: RotationPolicy) => void;
  mode: 'append' | 'replace';
  onModeChange: (mode: 'append' | 'replace') => void;
  existingPartCount: number;
  displayUnit: DisplayUnit;
  fractionDenominator: number;
  onOverrideChange: (fileId: string, text: string) => void;
  onOverrideBlur: (fileId: string) => void;
  canCommit: boolean;
  onCommit: () => void;
}

export function ImportPreview({
  files,
  onRowChange,
  materials,
  rotationPolicy,
  onRotationPolicyChange,
  mode,
  onModeChange,
  existingPartCount,
  displayUnit,
  fractionDenominator,
  onOverrideChange,
  onOverrideBlur,
  canCommit,
  onCommit,
}: ImportPreviewProps) {
  const noMaterials = materials.length === 0;

  const selectedRows = files
    .flatMap((f) => (f.state.status === 'ready' ? f.state.rows : []))
    .filter((r) => r.selected);
  const selectedParts = selectedRows.length;
  const selectedPieces = selectedRows.reduce((sum, r) => sum + Math.max(0, r.qty), 0);

  return (
    <div className="flex flex-col gap-4">
      {files.map((file) => (
        <FileSection
          key={file.id}
          file={file}
          onRowChange={onRowChange}
          materials={materials}
          displayUnit={displayUnit}
          fractionDenominator={fractionDenominator}
          onOverrideChange={onOverrideChange}
          onOverrideBlur={onOverrideBlur}
          showFilename={files.length > 1}
        />
      ))}

      {noMaterials && (
        <p className="text-sm text-red-400">
          No materials yet - add one in the material manager above before importing.
        </p>
      )}

      {/* Defaults */}
      <div className="flex flex-wrap items-end gap-4">
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
