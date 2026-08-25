import type { SolverEffort } from '../../domain/types';
import type { ProjectSummary } from '../../storage/types';
import type { DisplayUnit } from '../state/types';
import { ProjectMenu } from './ProjectMenu';

interface HeaderProps {
  displayUnit: DisplayUnit;
  effort?: SolverEffort | undefined;
  onUnitChange: (unit: DisplayUnit) => void;
  onEffortChange: (effort: SolverEffort) => void;
  activeProjectId: string | null;
  activeProjectName: string;
  projects: ProjectSummary[];
  onSwitchProject: (id: string) => void;
  onRenameProject: (id: string, name: string) => void;
  onCreateProject: (fromTemplate?: string, name?: string) => void;
  onDeleteProject: (id: string) => void;
  /** Disabled until there is something to print. */
  canPrint: boolean;
}

export function Header({
  displayUnit,
  effort = 'balanced',
  onUnitChange,
  onEffortChange,
  activeProjectId,
  activeProjectName,
  projects,
  onSwitchProject,
  onRenameProject,
  onCreateProject,
  onDeleteProject,
  canPrint,
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
                v{__APP_VERSION__}
              </span>
            </div>
            {/* Claims only what is true today. The app has no service worker,
                so a reload with no network does not come back - "offline ready"
                was overstating it. Client-side is the stronger claim anyway:
                it is what makes the privacy promise in the footer real. */}
            <p className="text-xs text-slate-400">
              Browser-based cut list optimizer • 100% client-side - nothing leaves your machine
            </p>
          </div>
        </div>

        {/* Action Controls Toolbar.
            `justify-end` so that when the row wraps - it does below roughly
            1700px, once the Print button joins the three selects - the wrapped
            button lands under the controls rather than orphaned on the far left
            beneath the logo. */}
        <div className="flex flex-wrap items-center justify-end gap-3">
          {/* Project Selector */}
          <ProjectMenu
            activeProjectId={activeProjectId}
            activeProjectName={activeProjectName}
            projects={projects}
            onSwitchProject={onSwitchProject}
            onRenameProject={onRenameProject}
            onCreateProject={onCreateProject}
            onDeleteProject={onDeleteProject}
          />

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

          {/* Print: the milestone's whole point is a sheet you carry to the saw,
              so this is a primary action rather than a menu item. */}
          <button
            type="button"
            onClick={() => window.print()}
            disabled={!canPrint}
            title={
              canPrint
                ? 'Print the cut sheets: one page per sheet, plus a project summary'
                : 'Solve a layout first - there is nothing to print yet'
            }
            className="flex items-center gap-2 px-3.5 py-2 rounded-lg text-xs font-semibold bg-amber-500 text-slate-950 border border-amber-400 hover:bg-amber-400 transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-amber-500"
          >
            <svg
              aria-hidden="true"
              xmlns="http://www.w3.org/2000/svg"
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M6 9V2h12v7" />
              <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
              <rect width="12" height="8" x="6" y="14" />
            </svg>
            Print cut sheets
          </button>
        </div>
      </div>
    </header>
  );
}
