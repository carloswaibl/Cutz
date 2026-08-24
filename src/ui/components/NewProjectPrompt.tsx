import { PRESETS } from '../state/presets';

interface NewProjectPromptProps {
  onCreateProject: (fromTemplate?: string, name?: string) => void;
}

/**
 * Shown on first-ever visit, and again whenever every saved project has been
 * deleted - nothing is assumed or silently preloaded. The same choice
 * (`plan-m6.md` §4) `ProjectMenu`'s "New Project" section offers, at full
 * screen size since there is nothing else to show yet.
 */
export function NewProjectPrompt({ onCreateProject }: NewProjectPromptProps) {
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col items-center justify-center gap-8 p-6 font-sans">
      <div className="text-center">
        <h1 className="text-2xl font-bold tracking-tight text-slate-100">Cutz</h1>
        <p className="text-sm text-slate-400 mt-1">
          No projects yet. Start blank, or from an example.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 w-full max-w-2xl">
        <button
          type="button"
          onClick={() => onCreateProject()}
          className="flex flex-col items-start gap-1 p-4 rounded-xl bg-slate-900/60 border border-slate-800 hover:border-amber-500/50 hover:bg-slate-900 text-left transition-colors"
        >
          <span className="font-semibold text-slate-100">Blank project</span>
          <span className="text-xs text-slate-400">Start with nothing and add your own parts.</span>
        </button>

        {Object.entries(PRESETS).map(([key, preset]) => (
          <button
            key={key}
            type="button"
            onClick={() => onCreateProject(key)}
            className="flex flex-col items-start gap-1 p-4 rounded-xl bg-slate-900/60 border border-slate-800 hover:border-amber-500/50 hover:bg-slate-900 text-left transition-colors"
          >
            <span className="font-semibold text-slate-100">{preset.name}</span>
            <span className="text-xs text-slate-400">{preset.description}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
