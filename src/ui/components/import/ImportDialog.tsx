import { useCallback, useEffect, useRef, useState } from 'react';
import type { Material, Part, RotationPolicy } from '../../../domain/types';
import { parseLength } from '../../../domain/units';
import type { ImportError } from '../../../import/errors';
import type { ImportOutcome } from '../../../import/types';
import { formatDisplayLength, toFormatUnit } from '../../format';
import type { DisplayUnit } from '../../state/types';
import { ImportPreview, initialRows, type PreviewRow } from './ImportPreview';

type Outcome = Extract<ImportOutcome, { ok: true }>;
type Importer = typeof import('../../../import/svg');

/**
 * The importer is loaded on demand, exactly as `LayoutViewer` does with the
 * SVG exporter (`docs/plan-m4.md` §6): `svg-pathdata` and the whole parsing
 * pipeline live in a chunk the initial bundle does not pay for. This dialog is
 * mounted unconditionally by `App`, so its prefetch starts at page load rather
 * than waiting for the user to open it - a shop with bad wifi must not
 * discover the chunk is missing at the moment it asks for a file.
 */
function loadSvgImporter(): Promise<Importer> {
  return import('../../../import/svg');
}

type Stage = 'idle' | 'reading' | 'preview' | 'error';

interface ImportDialogProps {
  open: boolean;
  onClose: () => void;
  /** Set by `PartTable`'s drag-and-drop, which skips the dropzone step. */
  droppedFile: File | null;
  onDroppedFileConsumed: () => void;
  materials: Material[];
  selectedMaterialId: string | 'all';
  displayUnit: DisplayUnit;
  fractionDenominator: number;
  existingPartCount: number;
  onCommit: (parts: Omit<Part, 'id'>[], mode: 'append' | 'replace') => void;
}

export function ImportDialog({
  open,
  onClose,
  droppedFile,
  onDroppedFileConsumed,
  materials,
  selectedMaterialId,
  displayUnit,
  fractionDenominator,
  existingPartCount,
  onCommit,
}: ImportDialogProps) {
  const importerRef = useRef<Importer | null>(null);
  const [stage, setStage] = useState<Stage>('idle');
  const [isDragOver, setIsDragOver] = useState(false);
  const [rawText, setRawText] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [parseError, setParseError] = useState<ImportError | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [rows, setRows] = useState<PreviewRow[]>([]);
  const [overrideText, setOverrideText] = useState('');
  const [overrideError, setOverrideError] = useState<string | null>(null);
  const [materialId, setMaterialId] = useState('');
  const [rotationPolicy, setRotationPolicy] = useState<RotationPolicy>('free90');
  const [mode, setMode] = useState<'append' | 'replace'>('append');

  const ensureImporter = useCallback(async (): Promise<Importer> => {
    if (!importerRef.current) {
      importerRef.current = await loadSvgImporter();
    }
    return importerRef.current;
  }, []);

  // Prefetch as soon as this component exists, not when the dialog opens.
  useEffect(() => {
    void ensureImporter();
  }, [ensureImporter]);

  const resetState = useCallback(() => {
    setStage('idle');
    setIsDragOver(false);
    setRawText(null);
    setOutcome(null);
    setParseError(null);
    setReadError(null);
    setRows([]);
    setOverrideText('');
    setOverrideError(null);
  }, []);

  const handleClose = useCallback(() => {
    resetState();
    onClose();
  }, [resetState, onClose]);

  const handleFile = useCallback(
    async (file: File) => {
      setStage('reading');
      setParseError(null);
      setReadError(null);
      try {
        const text = await file.text();
        const { importSvg } = await ensureImporter();
        const result = importSvg(text);
        if (!result.ok) {
          setParseError(result.error);
          setStage('error');
          return;
        }
        setRawText(text);
        setOutcome(result);
        setRows(initialRows(result));
        setOverrideText(
          result.drawingWidthMm !== null
            ? formatDisplayLength(result.drawingWidthMm, displayUnit, fractionDenominator)
            : '',
        );
        setOverrideError(null);
        setMaterialId(selectedMaterialId !== 'all' ? selectedMaterialId : (materials[0]?.id ?? ''));
        setRotationPolicy('free90');
        setMode('append');
        setStage('preview');
      } catch (err: unknown) {
        setReadError(err instanceof Error ? err.message : 'This file could not be read.');
        setStage('error');
      }
    },
    [ensureImporter, displayUnit, fractionDenominator, materials, selectedMaterialId],
  );

  // Drag-and-drop delivered onto `PartTable`, which opens the dialog directly
  // with a file in hand rather than routing through its own dropzone.
  useEffect(() => {
    if (droppedFile) {
      void handleFile(droppedFile);
      onDroppedFileConsumed();
    }
  }, [droppedFile, handleFile, onDroppedFileConsumed]);

  const handleOverrideChange = useCallback((text: string) => {
    setOverrideText(text);
  }, []);

  const handleOverrideBlur = useCallback(() => {
    if (!outcome || rawText === null) return;
    if (overrideText.trim() === '') {
      setOverrideError(null);
      return;
    }
    const parsed = parseLength(overrideText, toFormatUnit(displayUnit));
    if (!parsed.ok) {
      setOverrideError(parsed.error.message);
      return;
    }
    if (outcome.extentWidth === null || outcome.extentWidth <= 0) {
      setOverrideError('This file has no width or viewBox to compute a scale from.');
      return;
    }
    const importer = importerRef.current;
    if (!importer) return;
    const mmPerUnitOverride = parsed.mm / outcome.extentWidth;
    const reparsed = importer.importSvg(rawText, { mmPerUnitOverride });
    if (!reparsed.ok) {
      setOverrideError('That scale produced an unusable file - try a different width.');
      return;
    }
    setOutcome(reparsed);
    setRows(initialRows(reparsed));
    setOverrideError(null);
  }, [outcome, rawText, overrideText, displayUnit]);

  const handleRowChange = useCallback(
    (index: number, patch: Partial<Pick<PreviewRow, 'label' | 'qty' | 'selected'>>) => {
      setRows((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)));
    },
    [],
  );

  const handleCommit = useCallback(() => {
    if (!materialId) return;
    const parts: Omit<Part, 'id'>[] = rows
      .filter((row) => row.selected)
      .map((row) => ({
        label: row.label.trim() || row.part.label,
        width: row.part.width,
        height: row.part.height,
        qty: Math.max(1, row.qty),
        materialId,
        rotationPolicy,
      }));
    if (parts.length === 0) return;
    onCommit(parts, mode);
    handleClose();
  }, [rows, materialId, rotationPolicy, mode, onCommit, handleClose]);

  const handlePick = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (file) void handleFile(file);
    },
    [handleFile],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setIsDragOver(false);
      const file = e.dataTransfer.files[0];
      if (file) void handleFile(file);
    },
    [handleFile],
  );

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 backdrop-blur-sm p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Import parts from SVG"
      onClick={(e) => {
        if (e.target === e.currentTarget) handleClose();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') handleClose();
      }}
    >
      <div className="w-full max-w-4xl max-h-[90vh] overflow-y-auto bg-slate-900 border border-slate-800 rounded-xl shadow-2xl p-5 flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-bold tracking-wide uppercase text-slate-200">
            Import parts from SVG
          </h2>
          <button
            type="button"
            onClick={handleClose}
            className="text-slate-400 hover:text-slate-200 text-sm px-2 py-1"
          >
            Close
          </button>
        </div>

        {(stage === 'idle' || stage === 'reading') && (
          // biome-ignore lint/a11y/noStaticElementInteractions: drag-and-drop file target, no semantic interactive role applies to a native HTML5 drop zone
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setIsDragOver(true);
            }}
            onDragLeave={() => setIsDragOver(false)}
            onDrop={handleDrop}
            className={`flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed p-12 text-center transition-colors ${
              isDragOver ? 'border-amber-500 bg-amber-500/5' : 'border-slate-700 bg-slate-950/40'
            }`}
          >
            <p className="text-sm text-slate-300">
              {stage === 'reading' ? 'Reading file…' : 'Drop an SVG file here, or'}
            </p>
            {stage === 'idle' && (
              <label className="px-3 py-1.5 bg-amber-500 hover:bg-amber-600 text-slate-950 font-semibold text-xs rounded-lg cursor-pointer transition shadow-sm">
                Choose file
                <input
                  type="file"
                  accept=".svg,image/svg+xml"
                  onChange={handlePick}
                  className="hidden"
                />
              </label>
            )}
          </div>
        )}

        {stage === 'idle' && (
          <details className="bg-slate-950/40 border border-slate-800 rounded-lg overflow-hidden">
            <summary className="cursor-pointer select-none px-3 py-2 text-xs font-medium text-slate-300 hover:bg-slate-800/40 transition-colors">
              What can I import?
            </summary>
            <div className="px-3 pb-3 flex flex-col gap-2 text-xs text-slate-400 leading-relaxed">
              <p>
                Shapes become parts as their{' '}
                <strong className="text-slate-300">bounding box</strong> - the size a table saw
                would need to cut them, not their true outline. A part drawn at an angle imports at
                its real size, with the angle shown so you can check it.
              </p>
              <p>
                <strong className="text-slate-300">Read:</strong> paths, rects (including rounded
                corners), circles, ellipses, polygons and polylines, inside groups, layers,{' '}
                <code className="text-slate-300">&lt;use&gt;</code> clones and nested{' '}
                <code className="text-slate-300">&lt;switch&gt;</code>. Hidden layers and elements
                are skipped, as they should be.
              </p>
              <p>
                <strong className="text-slate-300">Skipped, and named in a warning:</strong> text,
                images, and anything else that isn't a shape - convert them to paths first if
                they're meant to be parts. Clipped or masked shapes are read at their full,
                unclipped size. Interior cutouts (holes) are discarded, since a table saw cuts edge
                to edge; drill or rout them after the sheet is cut.
              </p>
              <p>
                <strong className="text-slate-300">Sizing:</strong> when the file states a physical
                size it's used as-is; when it only gives pixels, 96px/inch is assumed and stated on
                screen; when no scale can be found, you'll be asked for the drawing's width before
                anything can be imported.
              </p>
            </div>
          </details>
        )}

        {stage === 'error' && (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-red-300" role="alert">
              {parseError?.message ?? readError}
            </p>
            <label className="self-start px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 font-semibold text-xs rounded-lg cursor-pointer transition">
              Try another file
              <input
                type="file"
                accept=".svg,image/svg+xml"
                onChange={handlePick}
                className="hidden"
              />
            </label>
          </div>
        )}

        {stage === 'preview' && outcome && (
          <ImportPreview
            outcome={outcome}
            rows={rows}
            onRowChange={handleRowChange}
            materials={materials}
            materialId={materialId}
            onMaterialChange={setMaterialId}
            rotationPolicy={rotationPolicy}
            onRotationPolicyChange={setRotationPolicy}
            mode={mode}
            onModeChange={setMode}
            existingPartCount={existingPartCount}
            displayUnit={displayUnit}
            fractionDenominator={fractionDenominator}
            overrideText={overrideText}
            onOverrideChange={handleOverrideChange}
            onOverrideBlur={handleOverrideBlur}
            overrideError={overrideError}
            onCommit={handleCommit}
          />
        )}
      </div>
    </div>
  );
}
