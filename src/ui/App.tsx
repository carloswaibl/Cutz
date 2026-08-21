import { useMemo, useState } from 'react';
import type { CutPlan } from '../domain/cutplan';
import { parseStockInstanceId } from '../domain/instances';
import type { Layout, Material, Stock } from '../domain/types';
import { ConfigBar } from './components/ConfigBar';
import { Header } from './components/Header';
import { ImportDialog } from './components/import/ImportDialog';
import { LayoutViewer } from './components/LayoutViewer';
import { MaterialManager } from './components/MaterialManager';
import { PartTable } from './components/PartTable';
import { PrintDocument } from './components/print/PrintDocument';
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

  // Transient UI state: nothing here is worth undoing or persisting, so it
  // lives outside the reducer, same reasoning as `LayoutViewer`'s exportError.
  const [importOpen, setImportOpen] = useState(false);
  const [droppedImportFile, setDroppedImportFile] = useState<File | null>(null);

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

  /**
   * Cut plans keyed by the sheet they belong to.
   *
   * `cutPlans` is parallel to `result.layouts`, but the viewer and the printed
   * document both work from a filtered list. Keying by stock instance id means
   * neither has to keep an index in step with a list it did not build.
   */
  const planByInstanceId = useMemo(() => {
    const map = new Map<string, CutPlan>();
    for (const plan of state.cutPlans) map.set(plan.stockInstanceId, plan);
    return map;
  }, [state.cutPlans]);

  /**
   * What Print covers: the same sheets the viewer's tabs and export buttons
   * cover. Two controls in one cluster with different scopes would be a trap.
   */
  const printableLayouts = useMemo(
    () =>
      resolvedLayouts.filter(
        (entry) =>
          state.selectedMaterialId === 'all' || entry.material.id === state.selectedMaterialId,
      ),
    [resolvedLayouts, state.selectedMaterialId],
  );

  const materialFilterName =
    state.selectedMaterialId === 'all'
      ? null
      : (state.materials.find((m) => m.id === state.selectedMaterialId)?.name ?? null);

  return (
    <>
      <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans">
        <Header
          displayUnit={state.displayUnit}
          effort={state.config.effort}
          onUnitChange={state.setUnit}
          onEffortChange={(effort) => state.setConfig({ effort })}
          onLoadPreset={state.loadPreset}
          canPrint={printableLayouts.length > 0}
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
                onOpenImport={() => setImportOpen(true)}
                onImportFile={(file) => {
                  setDroppedImportFile(file);
                  setImportOpen(true);
                }}
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
                    planByInstanceId={planByInstanceId}
                    showCutSequence={state.showCutSequence}
                    onShowCutSequenceChange={state.setShowCutSequence}
                    cutPlanError={state.cutPlanError}
                  />
                </>
              )}
            </div>
          </div>
        </main>
      </div>

      <ImportDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        droppedFile={droppedImportFile}
        onDroppedFileConsumed={() => setDroppedImportFile(null)}
        materials={state.materials}
        selectedMaterialId={state.selectedMaterialId}
        displayUnit={state.displayUnit}
        fractionDenominator={fracDenom}
        existingPartCount={state.parts.length}
        onCommit={state.importParts}
      />

      {/* Hidden on screen, and the only thing that prints. See export/print.css. */}
      {state.result && (
        <PrintDocument
          layouts={printableLayouts}
          parts={state.parts}
          unplacedParts={state.result.unplacedParts}
          config={state.config}
          displayUnit={state.displayUnit}
          fractionDenominator={fracDenom}
          planByInstanceId={planByInstanceId}
          showCutSequence={state.showCutSequence}
          materialFilterName={materialFilterName}
        />
      )}
    </>
  );
}

function fractionDenominatorFromUnit(unit: string): number {
  if (unit === 'imperial-fraction') return 16;
  return 1;
}
