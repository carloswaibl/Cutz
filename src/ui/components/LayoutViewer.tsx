import { TransformComponent, TransformWrapper } from 'react-zoom-pan-pinch';
import type { Layout, Material, Part, SolverConfig, Stock } from '../../domain/types';
import type { DisplayUnit } from '../state/types';
import { SheetSvg } from './SheetSvg';

interface ResolvedLayout {
  layout: Layout;
  stock: Stock;
  material: Material;
}

interface LayoutViewerProps {
  layouts: ResolvedLayout[];
  parts: Part[];
  config: SolverConfig;
  displayUnit: DisplayUnit;
  fractionDenominator: number;
  hoveredPartId: string | null;
  onHoverPart: (id: string | null) => void;
  activeSheetIndex: number;
  onActiveSheetChange: (index: number) => void;
  selectedMaterialId: string;
}

export function LayoutViewer({
  layouts,
  parts,
  config,
  displayUnit,
  fractionDenominator,
  hoveredPartId,
  onHoverPart,
  activeSheetIndex,
  onActiveSheetChange,
  selectedMaterialId,
}: LayoutViewerProps) {
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

      {/* Viewer Container */}
      <div className="relative bg-slate-900/60 border border-slate-800 rounded-xl overflow-hidden min-h-[500px]">
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
              {/* Controls Overlay */}
              <div className="absolute top-4 right-4 z-10 flex flex-col gap-2">
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

              {/* Pan/Zoom Canvas */}
              <TransformComponent
                wrapperStyle={{ width: '100%', height: '500px' }}
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
                  />
                </div>
              </TransformComponent>
            </>
          )}
        </TransformWrapper>
      </div>
      <div className="text-center text-xs text-slate-500">
        Scroll to zoom. Click and drag to pan.
      </div>
    </div>
  );
}
