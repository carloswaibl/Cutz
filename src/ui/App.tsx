import { Header } from './components/Header';
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

      <main className="flex-1 max-w-7xl w-full mx-auto p-4 sm:p-6 lg:p-8">
        {/* Placeholder container for PR 2-4 components */}
        <div className="bg-slate-900/80 border border-slate-800 rounded-2xl p-8 backdrop-blur-sm shadow-xl flex flex-col items-center justify-center text-center my-6">
          <div className="w-12 h-12 rounded-2xl bg-amber-500/10 border border-amber-500/20 text-amber-400 flex items-center justify-center text-2xl mb-4">
            🛠️
          </div>
          <h2 className="text-xl font-bold text-slate-100 mb-2">
            Tailwind Design System & State Management Active
          </h2>
          <p className="text-slate-400 text-sm max-w-md mb-6">
            Current project loaded:{' '}
            <span className="text-amber-400 font-semibold">{state.parts.length} parts</span> across{' '}
            <span className="text-amber-400 font-semibold">{state.stock.length} stock sheets</span>.
            Active unit system:{' '}
            <span className="text-emerald-400 font-semibold">{state.displayUnit}</span>.
          </p>

          <div className="flex flex-wrap justify-center gap-3">
            <span className="px-3 py-1 bg-slate-800 text-slate-300 text-xs font-mono rounded-lg border border-slate-700">
              PR 1 Complete: Tailwind CSS v4 + UI State
            </span>
            <span className="px-3 py-1 bg-amber-500/20 text-amber-300 text-xs font-mono rounded-lg border border-amber-500/30">
              Next: PR 2 (Part, Stock & Material Tables)
            </span>
          </div>
        </div>
      </main>
    </div>
  );
}
