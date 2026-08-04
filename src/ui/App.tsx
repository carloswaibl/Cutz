import { useMemo } from 'react';
import { parseStockInstanceId } from '../domain/instances';
import type { Layout, Material, Stock } from '../domain/types';
import { ConfigBar } from './components/ConfigBar';
import { Header } from './components/Header';
import { LayoutViewer } from './components/LayoutViewer';
import { MaterialManager } from './components/MaterialManager';
import { PartTable } from './components/PartTable';
import { StockTable } from './components/StockTable';
import { SummaryCard } from './components/SummaryCard';
import { UnplacedAlert } from './components/UnplacedAlert';
import { useCutListState } from './state/useCutListState';

/** Resolve a layout's stockInstanceId to the Stock and Material it belongs to. */
function resolveLayout(
  layout: Layout,
  stockList: Stock[],
  materials: Material[],
): { stock: Stock; material: Material } | null {
  const ref = parseStockInstanceId(layout.stockInstanceId);
  if (!ref) return null;
  const stock = stockList.find((s) => s.id === ref.stockId);
  if (!stock) return null;
  const material = materials.find((m) => m.id === stock.materialId);
  if (!material) return null;
  return { stock, material };
}

export function App() {
  const state = useCutListState();
  const fracDenom = fractionDenominatorFromUnit(state.displayUnit);

  /** Layouts with their resolved stock and material, for rendering. */
  const resolvedLayouts = useMemo(() => {
    if (!state.result) return [];
    return state.result.layouts
      .map((layout) => {
        const resolved = resolveLayout(layout, state.stock, state.materials);
        if (!resolved) return null;
        return { layout, ...resolved };
      })
      .filter(
        (entry): entry is { layout: Layout; stock: Stock; material: Material } => entry !== null,
      );
  }, [state.result, state.stock, state.materials]);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans">
      <Header
        displayUnit={state.displayUnit}
        effort={state.config.effort}
        onUnitChange={state.setUnit}
        onEffortChange={(effort) => state.setConfig({ effort })}
        onLoadPreset={state.loadPreset}
      />

      <main className="flex-1 max-w-7xl w-full mx-auto p-4 sm:p-6 lg:p-8 flex flex-col gap-6">
        {/* Saw & Solver Configuration Bar */}
        <ConfigBar
          config={state.config}
          displayUnit={state.displayUnit}
          fractionDenominator={fracDenom}
          onConfigChange={state.setConfig}
          onReSolve={state.reSolve}
        />

        {/* Material Manager */}
        <MaterialManager
          materials={state.materials}
          displayUnit={state.displayUnit}
          fractionDenominator={fracDenom}
          selectedMaterialId={state.selectedMaterialId}
          onSelectMaterialFilter={state.setSelectedMaterialId}
          onAddMaterial={state.addMaterial}
          onUpdateMaterial={state.updateMaterial}
          onDeleteMaterial={state.deleteMaterial}
        />

        {/* Main Grid: Parts & Stock Entry */}
        <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
          <div className="xl:col-span-7 flex flex-col gap-6">
            <PartTable
              parts={state.parts}
              materials={state.materials}
              displayUnit={state.displayUnit}
              fractionDenominator={fracDenom}
              selectedMaterialId={state.selectedMaterialId}
              hoveredPartId={state.hoveredPartId}
              onHoverPart={state.setHoveredPartId}
              onAddPart={state.addPart}
              onUpdatePart={state.updatePart}
              onDeletePart={state.deletePart}
              onDuplicatePart={state.duplicatePart}
              onClearParts={state.clearParts}
            />
          </div>

          <div className="xl:col-span-5 flex flex-col gap-6">
            <StockTable
              stock={state.stock}
              materials={state.materials}
              displayUnit={state.displayUnit}
              fractionDenominator={fracDenom}
              selectedMaterialId={state.selectedMaterialId}
              onAddStock={state.addStock}
              onUpdateStock={state.updateStock}
              onDeleteStock={state.deleteStock}
            />

            {/* Solver Status & Cut Diagrams */}
            {state.result && (
              <>
                <SummaryCard
                  result={state.result}
                  parts={state.parts}
                  materials={state.materials}
                  stock={state.stock}
                />

                <UnplacedAlert
                  unplacedParts={state.result.unplacedParts}
                  parts={state.parts}
                  stock={state.stock}
                  config={state.config}
                  displayUnit={state.displayUnit}
                  fractionDenominator={fracDenom}
                />

                <LayoutViewer
                  layouts={resolvedLayouts}
                  parts={state.parts}
                  config={state.config}
                  displayUnit={state.displayUnit}
                  fractionDenominator={fracDenom}
                  hoveredPartId={state.hoveredPartId}
                  onHoverPart={state.setHoveredPartId}
                  activeSheetIndex={state.activeSheetIndex}
                  onActiveSheetChange={state.setActiveSheetIndex}
                  selectedMaterialId={state.selectedMaterialId}
                />
              </>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

function fractionDenominatorFromUnit(unit: string): number {
  if (unit === 'imperial-fraction') return 16;
  return 1;
}
