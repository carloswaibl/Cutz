import { ConfigBar } from './components/ConfigBar';
import { Header } from './components/Header';
import { MaterialManager } from './components/MaterialManager';
import { PartTable } from './components/PartTable';
import { StockTable } from './components/StockTable';
import { useCutListState } from './state/useCutListState';

export function App() {
  const state = useCutListState();

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
          fractionDenominator={fractionDenominatorFromUnit(state.displayUnit)}
          onConfigChange={state.setConfig}
          onReSolve={state.reSolve}
        />

        {/* Material Manager */}
        <MaterialManager
          materials={state.materials}
          displayUnit={state.displayUnit}
          fractionDenominator={fractionDenominatorFromUnit(state.displayUnit)}
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
              fractionDenominator={fractionDenominatorFromUnit(state.displayUnit)}
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
              fractionDenominator={fractionDenominatorFromUnit(state.displayUnit)}
              selectedMaterialId={state.selectedMaterialId}
              onAddStock={state.addStock}
              onUpdateStock={state.updateStock}
              onDeleteStock={state.deleteStock}
            />

            {/* Quick Solver Status Indicator */}
            {state.result && (
              <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-4 flex items-center justify-between text-xs font-mono text-slate-400">
                <div className="flex items-center gap-2">
                  <span className="inline-block w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                  <span>Layout solver active</span>
                </div>
                <div>
                  <span>
                    {state.result.layouts.length} sheet(s) used | Waste:{' '}
                    <span className="text-emerald-400 font-bold">
                      {(state.result.totalWastePct * 100).toFixed(1)}%
                    </span>
                  </span>
                </div>
              </div>
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
