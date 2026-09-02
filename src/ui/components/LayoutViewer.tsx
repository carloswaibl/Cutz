import { useEffect, useState } from 'react';
import { TransformComponent, TransformWrapper } from 'react-zoom-pan-pinch';
import type { CutPlan } from '../../domain/cutplan';
import type { Layout, Material, Part, SolverConfig, Stock } from '../../domain/types';
import {
  DXF_MIME_TYPE,
  downloadFile,
  downloadFiles,
  type ExportFile,
  SVG_MIME_TYPE,
} from '../../export/download';
import { renderSheetDxf } from '../../export/dxf';
import { sheetFileName } from '../../export/filename';
import type { DisplayUnit } from '../state/types';
import { CutSequenceList } from './print/CutSequenceList';
import { SheetSvg } from './SheetSvg';
import { SolvingChip } from './SolverStatus';

/**
 * The SVG exporter is loaded on demand.
 *
 * It pulls in `react-dom/server`, which is ~60 kB gzipped - most of the app
 * again, paid by every visitor including the ones who never export. So it is a
 * separate chunk, warmed on mount rather than on click: a shop with bad wifi
 * must not find out the chunk is missing at the moment the user asks for a file,
 * and prefetching over the connection that just delivered the app closes all but
 * a few seconds of that window.
 *
 * The DXF writer, by contrast, is imported statically: it is a headless string
 * builder with no renderer behind it, so it costs a few kB and splitting it
 * would buy nothing but a second way for an export to fail offline.
 */
function loadSvgExporter() {
  return import('../../export/svg');
}

type ExportFormat = 'svg' | 'dxf';

const EXPORT_FORMATS: { id: ExportFormat; label: string; hint: string }[] = [
  {
    id: 'svg',
    label: 'SVG',
    hint: 'Standalone drawing for printing or for Inkscape and Illustrator',
  },
  {
    id: 'dxf',
    label: 'DXF',
    hint: 'R12 drawing on named layers, for CAD or a CNC shop. Written in the units shown above.',
  },
];

interface ResolvedLayout {
  layout: Layout;
  stock: Stock;
  material: Material;
}

interface LayoutViewerProps {
  layouts: ResolvedLayout[];
  projectName: string;
  parts: Part[];
  config: SolverConfig;
  displayUnit: DisplayUnit;
  fractionDenominator: number;
  hoveredPartId: string | null;
  onHoverPart: (id: string | null) => void;
  activeSheetIndex: number;
  onActiveSheetChange: (index: number) => void;
  selectedMaterialId: string;
  /** Cut plan per stock instance id. */
  planByInstanceId: ReadonlyMap<string, CutPlan>;
  showCutSequence: boolean;
  onShowCutSequenceChange: (show: boolean) => void;
  cutPlanError: string | null;
  /**
   * A newer solve is running and these layouts are the previous answer. Solving
   * is asynchronous as of M7 PR 7, so this is the difference between a diagram
   * that is current and one that merely looks it.
   */
  isSolving: boolean;
}

export function LayoutViewer({
  layouts,
  projectName,
  parts,
  config,
  displayUnit,
  fractionDenominator,
  hoveredPartId,
  onHoverPart,
  activeSheetIndex,
  onActiveSheetChange,
  selectedMaterialId,
  planByInstanceId,
  showCutSequence,
  onShowCutSequenceChange,
  cutPlanError,
  isSolving,
}: LayoutViewerProps) {
  const [exportError, setExportError] = useState<string | null>(null);

  useEffect(() => {
    void loadSvgExporter();
  }, []);

  // Filter layouts based on the global material filter
  const filteredLayouts = layouts.filter(
    (l) => selectedMaterialId === 'all' || l.material.id === selectedMaterialId,
  );

  if (filteredLayouts.length === 0) {
    return (
      <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-12 flex flex-col items-center justify-center text-slate-500">
        <svg
          aria-hidden="true"
          xmlns="http://www.w3.org/2000/svg"
          width="48"
          height="48"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="mb-4 opacity-50"
        >
          <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
          <line x1="3" x2="21" y1="9" y2="9" />
          <line x1="9" x2="9" y1="21" y2="9" />
        </svg>
        <p>No layouts to display for the selected material.</p>
      </div>
    );
  }

  // Ensure active sheet index is valid
  const safeIndex =
    activeSheetIndex >= 0 && activeSheetIndex < filteredLayouts.length ? activeSheetIndex : 0;
  const activeLayout = filteredLayouts[safeIndex];
  if (!activeLayout) return null;

  const activePlan = planByInstanceId.get(activeLayout.layout.stockInstanceId) ?? null;
  /**
   * The overlay only goes on when there is a plan that was actually proved. A
   * sheet whose search hit its budget, or whose layout is not cuttable at all,
   * gets the diagram it always had - never a partial set of blade lines the
   * operator would follow off the end of the sheet.
   */
  const activeOverlay = showCutSequence && activePlan !== null && activePlan.status === 'complete';

  /**
   * Build a standalone file for one sheet, in either format.
   *
   * The sheet number is its position in the filtered list, so the file name
   * matches the tab the user clicked rather than an internal instance index.
   *
   * The overlay flags come from the same toggle the on-screen diagram reads, so
   * an exported file always matches the diagram the user was looking at when
   * they asked for it.
   */
  async function exportFileFor(
    format: ExportFormat,
    entry: ResolvedLayout,
    index: number,
  ): Promise<ExportFile> {
    const plan = planByInstanceId.get(entry.layout.stockInstanceId) ?? null;
    const overlay = showCutSequence && plan !== null && plan.status === 'complete';
    const input = {
      layout: entry.layout,
      stock: entry.stock,
      parts,
      material: entry.material,
      config,
      displayUnit,
      fractionDenominator,
      sheetNumber: index + 1,
      sheetCount: filteredLayouts.length,
      cutPlan: plan,
      showCutLines: overlay,
      showPartNumbers: overlay,
    };
    const filename = sheetFileName({
      projectName,
      sheetNumber: index + 1,
      material: entry.material,
      extension: format,
    });

    if (format === 'dxf') {
      return { filename, contents: renderSheetDxf(input), mimeType: DXF_MIME_TYPE };
    }
    const { renderSheetSvg } = await loadSvgExporter();
    return { filename, contents: renderSheetSvg(input), mimeType: SVG_MIME_TYPE };
  }

  /** Run an export, surfacing failures instead of doing nothing visible. */
  async function runExport(work: () => Promise<void>): Promise<void> {
    setExportError(null);
    try {
      await work();
    } catch (err: unknown) {
      setExportError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Sheet Tabs */}
      <div className="flex overflow-x-auto pb-2 -mb-2 gap-2 scrollbar-thin scrollbar-thumb-slate-700 scrollbar-track-transparent">
        {filteredLayouts.map((l, idx) => {
          const isActive = idx === safeIndex;
          const wasteStr = (l.layout.wastePct * 100).toFixed(1);
          return (
            <button
              type="button"
              key={l.layout.stockInstanceId}
              onClick={() => onActiveSheetChange(idx)}
              className={`flex-shrink-0 px-4 py-2 rounded-lg border text-sm font-medium transition-colors ${
                isActive
                  ? 'bg-amber-500/10 border-amber-500/50 text-amber-400'
                  : 'bg-slate-900/60 border-slate-800 text-slate-400 hover:bg-slate-800 hover:text-slate-200'
              }`}
            >
              Sheet {idx + 1}: {l.material.name} (Waste: {wasteStr}%)
            </button>
          );
        })}
      </div>

      {/*
        Diagram and cut sequence.

        Stacked on anything narrower than `xl`, side by side above it. The
        diagram is bound by height, not width (see the pan/zoom comment below),
        so once the results went full width in a `max-w-7xl` page there was
        roughly half the row sitting empty beside a portrait sheet. The cut
        sequence is the one thing an operator reads next to the diagram, so it
        gets that space rather than nothing.

        `items-start` so a short plan's panel does not stretch to the diagram's
        height, and `minmax(0,...)` on both tracks so neither the pan/zoom
        canvas nor the step table can push the grid wider than its container.
      */}
      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] items-start gap-4">
        <div className="flex flex-col gap-3">
          {/* Sheet actions. Not floating over the canvas - see the zoom
              cluster's comment below. `flex-wrap` because the three clusters
              want ~530px and this column is narrower than that on a laptop. */}
          <div className="flex flex-wrap items-start gap-2">
            {/* Cut sequence toggle.
                One switch for the diagram, the printed pages and both export
                formats: a file that shows different cuts from the screen it was
                exported from is worse than no file. The panel's own `<summary>`
                is the second control on this same state. */}
            <button
              type="button"
              onClick={() => onShowCutSequenceChange(!showCutSequence)}
              disabled={activePlan === null}
              aria-pressed={showCutSequence}
              title={
                activePlan === null
                  ? 'No cut plan for this sheet'
                  : 'Show the derived cut order on the diagram, in exports, and in print'
              }
              className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-xs font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                showCutSequence && activePlan !== null
                  ? 'bg-amber-500/15 border-amber-500/50 text-amber-300'
                  : 'bg-slate-900/60 border-slate-800 text-slate-300 hover:bg-slate-800 hover:text-white'
              }`}
            >
              <CutLinesIcon />
              Cut sequence
            </button>

            {/* Export cluster: one row per format */}
            {EXPORT_FORMATS.map((format) => (
              <div
                key={format.id}
                className="flex items-stretch bg-slate-900/60 border border-slate-800 rounded-lg overflow-hidden text-xs"
              >
                <span className="flex items-center px-2.5 font-semibold tracking-wide text-slate-500 select-none">
                  {format.label}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    void runExport(async () => {
                      downloadFile(await exportFileFor(format.id, activeLayout, safeIndex));
                    });
                  }}
                  className="flex items-center gap-1.5 px-3 py-2 border-l border-slate-800 text-slate-300 hover:bg-slate-800 hover:text-white transition-colors"
                  title={format.hint}
                >
                  <DownloadIcon />
                  This sheet
                </button>
                {/* With one sheet, "all sheets" is the same action. */}
                {filteredLayouts.length > 1 && (
                  <button
                    type="button"
                    onClick={() => {
                      void runExport(async () => {
                        await downloadFiles(
                          await Promise.all(
                            filteredLayouts.map((entry, index) =>
                              exportFileFor(format.id, entry, index),
                            ),
                          ),
                        );
                      });
                    }}
                    className="flex items-center gap-1.5 px-3 py-2 border-l border-slate-800 text-slate-300 hover:bg-slate-800 hover:text-white transition-colors"
                    title="One file per sheet. Your browser will ask permission to download multiple files."
                  >
                    <DownloadIcon />
                    All {filteredLayouts.length}
                  </button>
                )}
              </div>
            ))}
          </div>

          {/* Viewer Container.

              Dimmed while a solve is in flight. The zoom cluster is inside it
              and dims too, which is right: what it pans around is stale. Panning
              and exporting still work - the previous layout is a real layout,
              just not the newest one.

              The solving chip floats over the top-left corner rather than
              joining the toolbar above. In the toolbar it was ~250px of extra
              content that wrapped the export cluster onto a second row, so the
              buttons jumped down and back on every edit - a moving target over
              the whole debounce plus solve. Floating costs no layout at all, and
              it is the same idiom (and the opposite corner) as the zoom cluster.
              It sits outside the dimmed element so the one thing explaining the
              dimming is not itself half-faded. */}
          <div className="relative">
            {isSolving && (
              <div className="absolute top-4 left-4 z-20">
                <SolvingChip />
              </div>
            )}
            <div
              className={`relative bg-slate-900/60 border border-slate-800 rounded-xl overflow-hidden min-h-[500px] transition-opacity ${
                isSolving ? 'opacity-50' : ''
              }`}
            >
              <TransformWrapper
                initialScale={1}
                minScale={0.1}
                maxScale={10}
                centerOnInit
                wheel={{ step: 0.01 }}
                pinch={{ step: 1 }}
              >
                {({ zoomIn, zoomOut, resetTransform }) => (
                  <>
                    {/* Zoom controls, and only these, float over the canvas.

                    A floating cluster is the right idiom for pan/zoom, but it
                    has to be small enough to sit in the margin beside the
                    sheet: the sheet is height-bound and centred, so on a 5'x5'
                    panel there is barely any margin at all. The cut-sequence
                    toggle and the export rows used to live here too, 222px of
                    opaque panel that covered the sheet's right-hand parts -
                    the cut diagram is the thing this tool produces, so nothing
                    that wide gets to sit on top of it. They are a toolbar
                    above the canvas now. */}
                    <div className="absolute top-4 right-4 z-10">
                      <div className="flex bg-slate-950/80 backdrop-blur-sm border border-slate-700 rounded-lg shadow-lg overflow-hidden">
                        <button
                          type="button"
                          onClick={() => zoomIn()}
                          className="p-2 text-slate-300 hover:bg-slate-800 hover:text-white transition-colors border-r border-slate-700"
                          title="Zoom In"
                        >
                          <svg
                            aria-hidden="true"
                            xmlns="http://www.w3.org/2000/svg"
                            width="20"
                            height="20"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          >
                            <circle cx="11" cy="11" r="8" />
                            <line x1="21" x2="16.65" y1="21" y2="16.65" />
                            <line x1="11" x2="11" y1="8" y2="14" />
                            <line x1="8" x2="14" y1="11" y2="11" />
                          </svg>
                        </button>
                        <button
                          type="button"
                          onClick={() => zoomOut()}
                          className="p-2 text-slate-300 hover:bg-slate-800 hover:text-white transition-colors border-r border-slate-700"
                          title="Zoom Out"
                        >
                          <svg
                            aria-hidden="true"
                            xmlns="http://www.w3.org/2000/svg"
                            width="20"
                            height="20"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          >
                            <circle cx="11" cy="11" r="8" />
                            <line x1="21" x2="16.65" y1="21" y2="16.65" />
                            <line x1="8" x2="14" y1="11" y2="11" />
                          </svg>
                        </button>
                        <button
                          type="button"
                          onClick={() => resetTransform()}
                          className="p-2 text-slate-300 hover:bg-slate-800 hover:text-white transition-colors"
                          title="Reset View"
                        >
                          <svg
                            aria-hidden="true"
                            xmlns="http://www.w3.org/2000/svg"
                            width="20"
                            height="20"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          >
                            <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                            <path d="M3 3v5h5" />
                          </svg>
                        </button>
                      </div>
                    </div>

                    {/*
                Pan/Zoom Canvas.

                Height, not width, is what sizes the diagram: sheet goods are
                portrait (a 4'x8' is 1:2), so a sheet scaled to fit this box is
                always bound by the shorter dimension. Hence a tall viewport-
                relative box rather than the full page width - widening the
                container alone just adds empty space either side of the sheet.
                Capped so it stays a panel on a very tall display, and floored
                so it does not collapse on a laptop in landscape.

                That same fact is why the cut sequence sits beside this box on
                a wide screen: the width the diagram cannot use is width the
                step table can.
              */}
                    <TransformComponent
                      wrapperStyle={{ width: '100%', height: 'clamp(500px, 72vh, 820px)' }}
                      contentStyle={{
                        width: '100%',
                        height: '100%',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      <div
                        style={{
                          width: '90%',
                          height: '90%',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                      >
                        <SheetSvg
                          key={activeLayout.layout.stockInstanceId}
                          layout={activeLayout.layout}
                          stock={activeLayout.stock}
                          parts={parts}
                          material={activeLayout.material}
                          config={config}
                          displayUnit={displayUnit}
                          fractionDenominator={fractionDenominator}
                          hoveredPartId={hoveredPartId}
                          onHoverPart={onHoverPart}
                          cutPlan={activePlan}
                          showCutLines={activeOverlay}
                          showPartNumbers={activeOverlay}
                        />
                      </div>
                    </TransformComponent>
                  </>
                )}
              </TransformWrapper>
            </div>
          </div>
        </div>
        {/* Cut sequence panel.

          The `<summary>` is a second control on the same state the toolbar
          button drives, so it has to write back: without `onToggle` the panel
          would collapse while the diagram kept its cut lines and the next
          export still carried the overlay, which is exactly the disagreement
          one shared `showCutSequence` exists to prevent.

          Capped to the diagram's own height above `xl` and scrolled inside
          itself, so a forty-step plan does not stretch the row past the sheet
          it belongs to. Below `xl` it is stacked and grows freely. */}
        {activePlan !== null && (
          <details
            open={showCutSequence}
            onToggle={(e) => onShowCutSequenceChange(e.currentTarget.open)}
            className="bg-slate-900/60 border border-slate-800 rounded-xl overflow-hidden"
          >
            <summary className="cursor-pointer select-none px-4 py-3 text-sm font-medium text-slate-200 hover:bg-slate-800/40 transition-colors">
              Cut sequence
              <span className="ml-2 text-xs font-normal text-slate-500">
                {activePlan.status === 'complete'
                  ? `${activePlan.steps.length} cuts on sheet ${safeIndex + 1} · a valid order, not reordered for fewest fence changes`
                  : 'unavailable for this sheet'}
              </span>
            </summary>
            {/* The scroll lives on the list, not the `<details>`, so the summary
              stays visible at the top of the panel instead of scrolling away.
              `2.75rem` is the summary's own height (`py-3` plus its line box). */}
            <div className="px-4 pb-4 xl:max-h-[calc(clamp(500px,72vh,820px)-2.75rem)] xl:overflow-y-auto">
              <CutSequenceList
                plan={activePlan}
                parts={parts}
                displayUnit={displayUnit}
                fractionDenominator={fractionDenominator}
                variant="screen"
                showHeading={false}
              />
            </div>
          </details>
        )}
      </div>

      {cutPlanError && (
        <div className="text-center text-xs text-red-400" role="alert">
          Cut sequence unavailable: {cutPlanError}
        </div>
      )}
      {exportError && (
        <div className="text-center text-xs text-red-400" role="alert">
          Export failed: {exportError}
        </div>
      )}
      <div className="text-center text-xs text-slate-500">
        Scroll to zoom. Click and drag to pan. Exporting all sheets downloads one file each, so your
        browser will ask permission the first time.
      </div>
    </div>
  );
}

/** Blade lines crossing a sheet, for the cut sequence toggle. */
function CutLinesIcon() {
  return (
    <svg
      aria-hidden="true"
      xmlns="http://www.w3.org/2000/svg"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M3 11h18" strokeDasharray="3 2" />
      <path d="M13 11v10" strokeDasharray="3 2" />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg
      aria-hidden="true"
      xmlns="http://www.w3.org/2000/svg"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" x2="12" y1="15" y2="3" />
    </svg>
  );
}
