import { useCallback, useEffect, useRef, useState } from 'react';
import type { Material, Part, RotationPolicy } from '../../../domain/types';
import { parseLength } from '../../../domain/units';
import { formatDisplayLength, toFormatUnit } from '../../format';
import type { DisplayUnit } from '../../state/types';
import { ImportPreview, initialRows, type PreviewFile, type PreviewRow } from './ImportPreview';

type SvgImporter = typeof import('../../../import/svg');
type StlImporter = typeof import('../../../import/stl');

/**
 * Both importers are loaded on demand, exactly as `LayoutViewer` does with the
 * SVG exporter (`docs/plan-m4.md` §6): the parsing pipelines live in chunks the
 * initial bundle does not pay for. This dialog is mounted unconditionally by
 * `App`, so prefetching starts at page load rather than waiting for the user
 * to open it - a shop with bad wifi must not discover a chunk is missing at
 * the moment it asks for a file.
 */
function loadSvgImporter(): Promise<SvgImporter> {
  return import('../../../import/svg');
}
function loadStlImporter(): Promise<StlImporter> {
  return import('../../../import/stl');
}

type Stage = 'idle' | 'reading' | 'preview';

const ACCEPT = '.svg,image/svg+xml,.stl';

interface ImportDialogProps {
  open: boolean;
  onClose: () => void;
  /** Set by `PartTable`'s drag-and-drop, which skips the dropzone step. */
  droppedFiles: File[] | null;
  onDroppedFilesConsumed: () => void;
  materials: Material[];
  selectedMaterialId: string | 'all';
  displayUnit: DisplayUnit;
  fractionDenominator: number;
  existingPartCount: number;
  onCommit: (parts: Omit<Part, 'id'>[], mode: 'append' | 'replace') => void;
}

/** Strip a leading path and trailing extension segment, case-insensitively. */
function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot === -1 ? '' : filename.slice(dot).toLowerCase();
}

export function ImportDialog({
  open,
  onClose,
  droppedFiles,
  onDroppedFilesConsumed,
  materials,
  selectedMaterialId,
  displayUnit,
  fractionDenominator,
  existingPartCount,
  onCommit,
}: ImportDialogProps) {
  const svgImporterRef = useRef<SvgImporter | null>(null);
  const stlImporterRef = useRef<StlImporter | null>(null);
  /**
   * Original `File` objects, kept for re-reading on an override blur - a
   * `File` is a `Blob` and may be read more than once, so this avoids holding
   * a second, potentially-large copy of every STL's bytes in component state
   * just for the rare case the user edits the confirmed width.
   */
  const sourceFilesRef = useRef<Map<string, File>>(new Map());
  const [stage, setStage] = useState<Stage>('idle');
  const [isDragOver, setIsDragOver] = useState(false);
  const [files, setFiles] = useState<PreviewFile[]>([]);
  const [rotationPolicy, setRotationPolicy] = useState<RotationPolicy>('free90');
  const [mode, setMode] = useState<'append' | 'replace'>('append');

  const ensureSvgImporter = useCallback(async (): Promise<SvgImporter> => {
    if (!svgImporterRef.current) svgImporterRef.current = await loadSvgImporter();
    return svgImporterRef.current;
  }, []);
  const ensureStlImporter = useCallback(async (): Promise<StlImporter> => {
    if (!stlImporterRef.current) stlImporterRef.current = await loadStlImporter();
    return stlImporterRef.current;
  }, []);

  // Prefetch as soon as this component exists, not when the dialog opens.
  useEffect(() => {
    void ensureSvgImporter();
    void ensureStlImporter();
  }, [ensureSvgImporter, ensureStlImporter]);

  const resetState = useCallback(() => {
    setStage('idle');
    setIsDragOver(false);
    setFiles([]);
    sourceFilesRef.current.clear();
  }, []);

  const handleClose = useCallback(() => {
    resetState();
    onClose();
  }, [resetState, onClose]);

  const buildFileEntry = useCallback(
    async (file: File, index: number): Promise<PreviewFile> => {
      const id = `${file.name}-${index}`;
      sourceFilesRef.current.set(id, file);
      const ext = extensionOf(file.name);

      if (ext === '.svg') {
        try {
          const text = await file.text();
          const { importSvg } = await ensureSvgImporter();
          const result = importSvg(text);
          if (!result.ok) {
            return {
              id,
              filename: file.name,
              state: { status: 'error', message: result.error.message },
            };
          }
          return {
            id,
            filename: file.name,
            state: {
              status: 'ready',
              kind: 'svg',
              outcome: result,
              thicknessMm: null,
              rows: initialRows(result, materials, selectedMaterialId, null),
              overrideText:
                result.drawingWidthMm !== null
                  ? formatDisplayLength(result.drawingWidthMm, displayUnit, fractionDenominator)
                  : '',
              overrideError: null,
            },
          };
        } catch (err: unknown) {
          return {
            id,
            filename: file.name,
            state: {
              status: 'error',
              message: err instanceof Error ? err.message : 'This file could not be read.',
            },
          };
        }
      }

      if (ext === '.stl') {
        try {
          const bytes = await file.arrayBuffer();
          const { importStl } = await ensureStlImporter();
          const result = importStl(bytes, file.name);
          if (!result.ok) {
            return {
              id,
              filename: file.name,
              state: { status: 'error', message: result.error.message },
            };
          }
          return {
            id,
            filename: file.name,
            state: {
              status: 'ready',
              kind: 'stl',
              outcome: result,
              thicknessMm: result.thicknessMm,
              rows: initialRows(result, materials, selectedMaterialId, result.thicknessMm),
              // Pre-filled with the size millimetres-as-raw-units would
              // produce - by far the most common real STL export convention
              // (`docs/plan-m5.md` §4.7 / §8 decision 6) - but never
              // committed silently: `canCommit` still requires this field to
              // hold a confirmed value before import unblocks.
              overrideText:
                result.extentWidth !== null
                  ? formatDisplayLength(result.extentWidth, displayUnit, fractionDenominator)
                  : '',
              overrideError: null,
            },
          };
        } catch (err: unknown) {
          return {
            id,
            filename: file.name,
            state: {
              status: 'error',
              message: err instanceof Error ? err.message : 'This file could not be read.',
            },
          };
        }
      }

      return {
        id,
        filename: file.name,
        state: {
          status: 'error',
          message: `"${file.name}" is not an .svg or .stl file - only those can be imported.`,
        },
      };
    },
    [
      ensureSvgImporter,
      ensureStlImporter,
      materials,
      selectedMaterialId,
      displayUnit,
      fractionDenominator,
    ],
  );

  const handleFiles = useCallback(
    async (fileList: FileList | File[]) => {
      const list = Array.from(fileList);
      if (list.length === 0) return;
      setStage('reading');
      sourceFilesRef.current.clear();
      const entries = await Promise.all(list.map((file, index) => buildFileEntry(file, index)));
      setFiles(entries);
      setRotationPolicy('free90');
      setMode('append');
      setStage('preview');
    },
    [buildFileEntry],
  );

  // Drag-and-drop delivered onto `PartTable`, which opens the dialog directly
  // with files in hand rather than routing through its own dropzone.
  useEffect(() => {
    if (droppedFiles && droppedFiles.length > 0) {
      void handleFiles(droppedFiles);
      onDroppedFilesConsumed();
    }
  }, [droppedFiles, handleFiles, onDroppedFilesConsumed]);

  const handleOverrideChange = useCallback((fileId: string, text: string) => {
    setFiles((prev) =>
      prev.map((f) =>
        f.id === fileId && f.state.status === 'ready'
          ? { ...f, state: { ...f.state, overrideText: text } }
          : f,
      ),
    );
  }, []);

  const handleOverrideBlur = useCallback(
    async (fileId: string) => {
      const file = files.find((f) => f.id === fileId);
      if (file?.state.status !== 'ready') return;
      const { overrideText, kind } = file.state;
      if (overrideText.trim() === '') {
        setFiles((prev) =>
          prev.map((f) =>
            f.id === fileId && f.state.status === 'ready'
              ? { ...f, state: { ...f.state, overrideError: null } }
              : f,
          ),
        );
        return;
      }

      const parsed = parseLength(overrideText, toFormatUnit(displayUnit));
      if (!parsed.ok) {
        setFiles((prev) =>
          prev.map((f) =>
            f.id === fileId && f.state.status === 'ready'
              ? { ...f, state: { ...f.state, overrideError: parsed.error.message } }
              : f,
          ),
        );
        return;
      }

      const extentWidth = file.state.outcome.extentWidth;
      if (extentWidth === null || extentWidth <= 0) {
        setFiles((prev) =>
          prev.map((f) =>
            f.id === fileId && f.state.status === 'ready'
              ? {
                  ...f,
                  state: {
                    ...f.state,
                    overrideError: 'This file has no width to compute a scale from.',
                  },
                }
              : f,
          ),
        );
        return;
      }

      const mmPerUnitOverride = parsed.mm / extentWidth;
      const sourceFile = sourceFilesRef.current.get(fileId);
      if (!sourceFile) return;

      let reparsed: ReturnType<SvgImporter['importSvg']> | ReturnType<StlImporter['importStl']>;
      let newThicknessMm: Record<string, number> | null;
      if (kind === 'svg') {
        const { importSvg } = await ensureSvgImporter();
        reparsed = importSvg(await sourceFile.text(), { mmPerUnitOverride });
        newThicknessMm = null;
      } else {
        const { importStl } = await ensureStlImporter();
        const result = importStl(await sourceFile.arrayBuffer(), sourceFile.name, {
          mmPerUnitOverride,
        });
        reparsed = result;
        newThicknessMm = result.ok ? result.thicknessMm : null;
      }

      if (!reparsed.ok) {
        setFiles((prev) =>
          prev.map((f) =>
            f.id === fileId && f.state.status === 'ready'
              ? {
                  ...f,
                  state: {
                    ...f.state,
                    overrideError: 'That size produced an unusable file - try a different width.',
                  },
                }
              : f,
          ),
        );
        return;
      }

      setFiles((prev) =>
        prev.map((f) => {
          if (f.id !== fileId || f.state.status !== 'ready') return f;
          return {
            ...f,
            state: {
              ...f.state,
              outcome: reparsed,
              thicknessMm: newThicknessMm,
              rows: initialRows(reparsed, materials, selectedMaterialId, newThicknessMm),
              overrideError: null,
            },
          };
        }),
      );
    },
    [files, displayUnit, ensureSvgImporter, ensureStlImporter, materials, selectedMaterialId],
  );

  const handleRowChange = useCallback(
    (
      fileId: string,
      index: number,
      patch: Partial<Pick<PreviewRow, 'label' | 'qty' | 'selected' | 'materialId'>>,
    ) => {
      setFiles((prev) =>
        prev.map((f) => {
          if (f.id !== fileId || f.state.status !== 'ready') return f;
          const rows = f.state.rows.map((row, i) => (i === index ? { ...row, ...patch } : row));
          return { ...f, state: { ...f.state, rows } };
        }),
      );
    },
    [],
  );

  const canCommit =
    materials.length > 0 &&
    files.length > 0 &&
    files.every((f) => {
      if (f.state.status !== 'ready') return true;
      if (f.state.overrideError) return false;
      if (f.state.outcome.scale.kind === 'none' && f.state.overrideText.trim() === '') return false;
      return true;
    }) &&
    files.some((f) => f.state.status === 'ready' && f.state.rows.some((r) => r.selected));

  const handleCommit = useCallback(() => {
    if (!canCommit) return;
    const parts: Omit<Part, 'id'>[] = files.flatMap((f) =>
      f.state.status === 'ready'
        ? f.state.rows
            .filter((row) => row.selected)
            .map((row) => ({
              label: row.label.trim() || row.part.label,
              width: row.part.width,
              height: row.part.height,
              qty: Math.max(1, row.qty),
              materialId: row.materialId,
              rotationPolicy,
            }))
        : [],
    );
    if (parts.length === 0) return;
    onCommit(parts, mode);
    handleClose();
  }, [canCommit, files, rotationPolicy, mode, onCommit, handleClose]);

  const handlePick = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      // `e.target.files` is a live `FileList` - resetting `.value` below
      // clears it in place, so the array copy must happen first or
      // `handleFiles` receives an already-emptied list.
      const picked = Array.from(e.target.files ?? []);
      e.target.value = '';
      if (picked.length > 0) void handleFiles(picked);
    },
    [handleFiles],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setIsDragOver(false);
      if (e.dataTransfer.files.length > 0) void handleFiles(e.dataTransfer.files);
    },
    [handleFiles],
  );

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 backdrop-blur-sm p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Import parts from SVG or STL"
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
            Import parts from SVG or STL
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
              {stage === 'reading' ? 'Reading files…' : 'Drop SVG or STL files here, or'}
            </p>
            {stage === 'idle' && (
              <label className="px-3 py-1.5 bg-amber-500 hover:bg-amber-600 text-slate-950 font-semibold text-xs rounded-lg cursor-pointer transition shadow-sm">
                Choose files
                <input
                  type="file"
                  accept={ACCEPT}
                  multiple
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
                would need to cut them, not their true outline. A part drawn or modeled at an angle
                imports at its real size, with the angle shown so you can check it. Drop several
                files at once - each is read independently and merged into one list below.
              </p>
              <p>
                <strong className="text-slate-300">From an SVG:</strong> paths, rects (including
                rounded corners), circles, ellipses, polygons and polylines, inside groups, layers,{' '}
                <code className="text-slate-300">&lt;use&gt;</code> clones and nested{' '}
                <code className="text-slate-300">&lt;switch&gt;</code>. Hidden layers and elements
                are skipped, as they should be. Text, images, and anything else that isn't a shape
                is skipped and named in a warning.
              </p>
              <p>
                <strong className="text-slate-300">From an STL:</strong> a flat panel, modeled as a
                single body or several disconnected ones in the same file - each becomes its own
                part. A body that isn't flat (a bracket, a box, a carcass modeled as one piece) is
                rejected with a message naming why, never boxed up as though it were a panel.
              </p>
              <p>
                <strong className="text-slate-300">Sizing:</strong> when a file states a physical
                size it's used as-is; when only pixels are given, 96px/inch is assumed and stated on
                screen; an STL file carries no units at all, so every one is followed by a prompt
                for its real width before anything can be imported. Interior cutouts (holes) are
                always discarded, since a table saw cuts edge to edge - drill or rout them after the
                sheet is cut.
              </p>
            </div>
          </details>
        )}

        {stage === 'preview' && (
          <ImportPreview
            files={files}
            onRowChange={handleRowChange}
            materials={materials}
            rotationPolicy={rotationPolicy}
            onRotationPolicyChange={setRotationPolicy}
            mode={mode}
            onModeChange={setMode}
            existingPartCount={existingPartCount}
            displayUnit={displayUnit}
            fractionDenominator={fractionDenominator}
            onOverrideChange={handleOverrideChange}
            onOverrideBlur={handleOverrideBlur}
            canCommit={canCommit}
            onCommit={handleCommit}
          />
        )}
      </div>
    </div>
  );
}
