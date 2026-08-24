import { useEffect, useRef, useState } from 'react';
import type { ProjectSummary } from '../../storage/types';
import { formatRelativeTime } from '../format';
import { PRESETS } from '../state/presets';

interface ProjectMenuProps {
  activeProjectId: string | null;
  activeProjectName: string;
  /** Every saved project, most recently updated first - including the active one. */
  projects: ProjectSummary[];
  onSwitchProject: (id: string) => void;
  onRenameProject: (id: string, name: string) => void;
  onCreateProject: (fromTemplate?: string, name?: string) => void;
  onDeleteProject: (id: string) => void;
}

/**
 * Replaces the old "Sample Project" `<select>` in `Header`. Current project
 * name shown and editable inline; a panel for switching, creating (blank or
 * from one of the three templates), and deleting. No modal component exists
 * anywhere in this codebase, so deletion is confirmed with `window.confirm`
 * rather than introducing one for this single call site.
 */
export function ProjectMenu({
  activeProjectId,
  activeProjectName,
  projects,
  onSwitchProject,
  onRenameProject,
  onCreateProject,
  onDeleteProject,
}: ProjectMenuProps) {
  const [nameDraft, setNameDraft] = useState(activeProjectName);
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Resync the draft when the active project changes underneath it (switch,
  // create, or a rename committed elsewhere) rather than while the user is
  // mid-edit of the same project.
  useEffect(() => {
    setNameDraft(activeProjectName);
  }, [activeProjectName]);

  useEffect(() => {
    if (!isOpen) return;
    function onPointerDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [isOpen]);

  function commitRename() {
    const trimmed = nameDraft.trim();
    if (activeProjectId && trimmed && trimmed !== activeProjectName) {
      onRenameProject(activeProjectId, trimmed);
    } else {
      setNameDraft(activeProjectName);
    }
  }

  const otherProjects = projects.filter((p) => p.id !== activeProjectId);

  return (
    <div
      ref={containerRef}
      className="relative flex items-center gap-1 bg-slate-950/60 p-1 rounded-lg border border-slate-800"
    >
      <input
        aria-label="Project name"
        value={nameDraft}
        onChange={(e) => setNameDraft(e.target.value)}
        onBlur={commitRename}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') setNameDraft(activeProjectName);
        }}
        className="bg-slate-900 text-slate-200 text-xs font-medium rounded-md px-2.5 py-1 border border-slate-700/60 focus:outline-none focus:ring-2 focus:ring-amber-500/50 w-36"
      />
      <button
        type="button"
        onClick={() => setIsOpen((v) => !v)}
        aria-label="Project menu"
        aria-expanded={isOpen}
        className="px-2 py-1 rounded-md text-xs font-medium text-slate-300 hover:bg-slate-800 border border-transparent hover:border-slate-700/60"
      >
        ▾
      </button>

      {isOpen && (
        <div className="absolute top-full left-0 mt-1 w-64 bg-slate-900 border border-slate-700/60 rounded-lg shadow-xl z-40 py-1 text-xs">
          {otherProjects.length > 0 && (
            <div className="px-1 pb-1 mb-1 border-b border-slate-800">
              <div className="px-2 py-1 text-slate-500 font-semibold uppercase tracking-wider text-[10px]">
                Switch project
              </div>
              {otherProjects.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => {
                    onSwitchProject(p.id);
                    setIsOpen(false);
                  }}
                  className="w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded-md text-slate-200 hover:bg-slate-800 text-left"
                >
                  <span className="truncate">{p.name}</span>
                  <span className="text-slate-500 shrink-0">{formatRelativeTime(p.updatedAt)}</span>
                </button>
              ))}
            </div>
          )}

          <div className="px-1 pb-1 mb-1 border-b border-slate-800">
            <div className="px-2 py-1 text-slate-500 font-semibold uppercase tracking-wider text-[10px]">
              New project
            </div>
            <button
              type="button"
              onClick={() => {
                onCreateProject();
                setIsOpen(false);
              }}
              className="w-full px-2 py-1.5 rounded-md text-slate-200 hover:bg-slate-800 text-left"
            >
              Blank project
            </button>
            {Object.entries(PRESETS).map(([key, preset]) => (
              <button
                key={key}
                type="button"
                onClick={() => {
                  onCreateProject(key);
                  setIsOpen(false);
                }}
                className="w-full px-2 py-1.5 rounded-md text-slate-200 hover:bg-slate-800 text-left"
              >
                From template: {preset.name}
              </button>
            ))}
          </div>

          <div className="px-1">
            <button
              type="button"
              disabled={!activeProjectId}
              onClick={() => {
                if (!activeProjectId) return;
                if (window.confirm(`Delete "${activeProjectName}"? This cannot be undone.`)) {
                  onDeleteProject(activeProjectId);
                }
                setIsOpen(false);
              }}
              className="w-full px-2 py-1.5 rounded-md text-red-400 hover:bg-red-500/10 text-left disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Delete this project
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
