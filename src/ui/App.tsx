import { useMemo, useState } from 'react';
import type { CutPlan } from '../domain/cutplan';
import { parseStockInstanceId } from '../domain/instances';
import type { Layout, Material, Stock } from '../domain/types';
import { ConfigBar } from './components/ConfigBar';
import { Footer } from './components/Footer';
import { Header } from './components/Header';
import { ImportDialog } from './components/import/ImportDialog';
import { LayoutViewer } from './components/LayoutViewer';
import { MaterialManager } from './components/MaterialManager';
import { NewProjectPrompt } from './components/NewProjectPrompt';
import { PartTable } from './components/PartTable';
import { PrintDocument } from './components/print/PrintDocument';
import { SolverErrorPanel, SolvingPlaceholder } from './components/SolverStatus';
import { StockTable } from './components/StockTable';
import { SummaryCard } from './components/SummaryCard';
import { UnplacedAlert } from './components/UnplacedAlert';
import { useProjectStorage } from './state/useProjectStorage';

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
  const state = useProjectStorage();
  const fracDenom = fractionDenominatorFromUnit(state.displayUnit);

  // Transient UI state: nothing here is worth undoing or persisting, so it
  // lives outside the reducer, same reasoning as `LayoutViewer`'s exportError.
  const [importOpen, setImportOpen] = useState(false);
  const [droppedImportFiles, setDroppedImportFiles] = useState<File[] | null>(null);

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

  // Loading (reading IndexedDB on mount) and empty (nothing saved yet) each
  // replace the whole tree rather than rendering it against placeholder data -
  // `docs/plan-m6.md` §1 criterion 3 and §4.
  if (state.isLoading) {
    return <div className="min-h-screen bg-slate-950" />;
  }

  // The footer carries here too, not just on the main app: a first-ever
  // visitor is exactly who needs to be told this is open source, MIT, and
  // running entirely on their own machine.
  if (state.isEmpty) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans">
        <NewProjectPrompt onCreateProject={state.createProject} />
        <Footer />
      </div>
    );
  }

  return (
    <>
      <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans">
        <Header
          displayUnit={state.displayUnit}
          effort={state.config.effort}
          onUnitChange={state.setUnit}
          onEffortChange={(effort) => state.setConfig({ effort })}
          activeProjectId={state.activeProjectId}
          activeProjectName={state.activeProjectName}
          projects={state.projects}
          onSwitchProject={state.switchProject}
          onRenameProject={state.renameProject}
          onCreateProject={state.createProject}
          onDeleteProject={state.deleteProject}
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

          {/*
            One column, full width, top to bottom: materials, parts, stock,
            then the results.

            Parts and stock used to sit side by side, which read as a sensible
            pairing but never actually fit. `main` is capped at `max-w-7xl`
            (1280px), so a half-width column is about 596px at *every* screen
            size, however wide the monitor - and the parts table needs roughly
            672px before its columns start clipping the values inside them
            (see its own `min-w`). The result was a permanent scrollbar under
            the parts table and dimensions rendering as `11-3/`, which is a
            number a woodworker can misread straight into a wrong cut.

            Full width also suits the cut diagram below, which is the thing the
            tool actually produces.
          */}
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
            onImportFiles={(files) => {
              setDroppedImportFiles(files);
              setImportOpen(true);
            }}
          />

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

          {/* Solver Status & Cut Diagrams.

              The solver refusing the input used to render as nothing at all -
              `result` went null and this whole block vanished, taking the
              explanation with it. Every error `solve()` throws is something the
              user typed and can fix, so it is worth a panel. */}
          {state.solverError && <SolverErrorPanel message={state.solverError} />}

          {/* First solve of a project: there is no previous layout to keep on
              screen, so this stands in for one rather than leaving a gap. */}
          {!state.result && !state.solverError && state.isSolving && <SolvingPlaceholder />}

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
                projectName={state.activeProjectName}
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
                isSolving={state.isSolving}
              />
            </>
          )}
        </main>

        <Footer />
      </div>

      <ImportDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        droppedFiles={droppedImportFiles}
        onDroppedFilesConsumed={() => setDroppedImportFiles(null)}
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
