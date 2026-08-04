import type { SolverEffort } from '../../domain/types';
import { PRESETS } from '../state/presets';
import type { DisplayUnit } from '../state/types';

interface HeaderProps {
  displayUnit: DisplayUnit;
  effort?: SolverEffort | undefined;
  onUnitChange: (unit: DisplayUnit) => void;
  onEffortChange: (effort: SolverEffort) => void;
  onLoadPreset: (presetKey: string) => void;
}

export function Header({
  displayUnit,
  effort = 'balanced',
  onUnitChange,
  onEffortChange,
  onLoadPreset,
}: HeaderProps) {
  return (
    <header className="bg-slate-900/90 border-b border-slate-800/80 backdrop-blur-md sticky top-0 z-30 px-4 sm:px-6 py-3.5 shadow-lg">
      <div className="max-w-7xl mx-auto flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        {/* Brand & Subtitle */}
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-amber-500 to-amber-600 flex items-center justify-center text-slate-950 font-black text-xl shadow-md shadow-amber-500/20">
            C
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-bold tracking-tight text-slate-100">Cutz</h1>
              <span className="px-2 py-0.5 text-xs font-semibold uppercase tracking-wider bg-amber-500/10 text-amber-400 border border-amber-500/20 rounded-full">
                v0.1
              </span>
            </div>
            <p className="text-xs text-slate-400">
              Browser-based cut list optimizer • 100% client-side & offline ready
            </p>
          </div>
        </div>

        {/* Action Controls Toolbar */}
        <div className="flex flex-wrap items-center gap-3">
          {/* Preset Selector */}
          <div className="flex items-center gap-1.5 bg-slate-950/60 p-1 rounded-lg border border-slate-800">
            <label htmlFor="preset-select" className="text-xs font-medium text-slate-400 px-2">
              Sample Project:
            </label>
            <select
              id="preset-select"
              defaultValue="bookshelf"
              onChange={(e) => onLoadPreset(e.target.value)}
              className="bg-slate-900 text-slate-200 text-xs font-medium rounded-md px-2.5 py-1 border border-slate-700/60 focus:outline-none focus:ring-2 focus:ring-amber-500/50 cursor-pointer"
            >
              {Object.entries(PRESETS).map(([key, preset]) => (
                <option key={key} value={key}>
                  {preset.name}
                </option>
              ))}
            </select>
          </div>

          {/* Unit Toggle Selector */}
          <div className="flex items-center gap-1.5 bg-slate-950/60 p-1 rounded-lg border border-slate-800">
            <label htmlFor="unit-select" className="text-xs font-medium text-slate-400 px-2">
              Units:
            </label>
            <select
              id="unit-select"
              value={displayUnit}
              onChange={(e) => onUnitChange(e.target.value as DisplayUnit)}
              className="bg-slate-900 text-slate-200 text-xs font-medium rounded-md px-2.5 py-1 border border-slate-700/60 focus:outline-none focus:ring-2 focus:ring-amber-500/50 cursor-pointer"
            >
              <option value="imperial-fraction">Imperial (Fractions 1/16")</option>
              <option value="imperial-decimal">Imperial (Decimals in)</option>
              <option value="metric-mm">Metric (mm)</option>
              <option value="metric-cm">Metric (cm)</option>
            </select>
          </div>

          {/* Solver Effort Selector */}
          <div className="flex items-center gap-1.5 bg-slate-950/60 p-1 rounded-lg border border-slate-800">
            <label htmlFor="effort-select" className="text-xs font-medium text-slate-400 px-2">
              Effort:
            </label>
            <select
              id="effort-select"
              value={effort}
              onChange={(e) => onEffortChange(e.target.value as SolverEffort)}
              className="bg-slate-900 text-slate-200 text-xs font-medium rounded-md px-2.5 py-1 border border-slate-700/60 focus:outline-none focus:ring-2 focus:ring-amber-500/50 cursor-pointer"
            >
              <option value="fast">Fast (Quick Draft)</option>
              <option value="balanced">Balanced (Recommended)</option>
              <option value="thorough">Thorough (Deep Search)</option>
            </select>
          </div>
        </div>
      </div>
    </header>
  );
}
