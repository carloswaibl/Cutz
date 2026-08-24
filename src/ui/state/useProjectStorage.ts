/**
 * The React wrapper around `projectStore.ts` and `useCutListState`. Loads the
 * active project on mount, autosaves edits (debounced), and exposes the
 * project-list operations `ProjectMenu` and the empty-state prompt call.
 *
 * Thin by design - see `projectStore.ts`'s header comment. Verified manually
 * in the browser (`npm run dev`), same as the rest of `src/ui/`.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getProject,
  listProjects,
  setActiveProjectId,
  createProject as storageCreateProject,
  deleteProject as storageDeleteProject,
  renameProject as storageRenameProject,
  updateProject,
} from '../../storage/projects';
import type { ProjectSummary } from '../../storage/types';
import {
  blankProjectInput,
  createDebouncer,
  pickProjectFields,
  resolveFallbackAfterDelete,
  resolveInitialProject,
  templateProjectInput,
} from './projectStore';
import type { CutListStateReturn, ProjectFields } from './types';
import { useCutListState } from './useCutListState';

/** Rapid edits (typing a label, dragging a dimension) coalesce into one write. */
const AUTOSAVE_DELAY_MS = 500;

export interface ProjectStorageReturn extends CutListStateReturn {
  /** True until the initial load (or empty-state determination) completes. */
  isLoading: boolean;
  /** True once loaded, when there is no active project - the "no projects yet" screen. */
  isEmpty: boolean;
  projects: ProjectSummary[];
  activeProjectId: string | null;
  activeProjectName: string;
  createProject: (fromTemplate?: string, name?: string) => Promise<void>;
  switchProject: (id: string) => Promise<void>;
  renameProject: (id: string, name: string) => Promise<void>;
  deleteProject: (id: string) => Promise<void>;
}

export function useProjectStorage(): ProjectStorageReturn {
  const state = useCutListState();
  const { loadProject } = state;

  const [isLoading, setIsLoading] = useState(true);
  const [isEmpty, setIsEmpty] = useState(false);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [activeProjectId, setActiveProjectIdState] = useState<string | null>(null);
  const [activeProjectName, setActiveProjectName] = useState('');

  // Kept for the autosave effect to read the field it's about to persist
  // under, without making the effect's own dependency list include the id.
  const activeProjectIdRef = useRef<string | null>(null);
  activeProjectIdRef.current = activeProjectId;

  const debouncerRef = useRef(
    createDebouncer<{ id: string; patch: ProjectFields }>(AUTOSAVE_DELAY_MS, ({ id, patch }) => {
      void updateProject(id, patch).then(() => {
        setProjects((prev) =>
          prev
            .map((p) => (p.id === id ? { ...p, updatedAt: Date.now() } : p))
            .sort((a, b) => b.updatedAt - a.updatedAt),
        );
      });
    }),
  );

  const refreshProjectList = useCallback(() => listProjects().then(setProjects), []);

  // Initial load, once.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      const [initial, list] = await Promise.all([resolveInitialProject(), listProjects()]);
      if (cancelled) return;
      setProjects(list);
      if (initial === 'empty') {
        setIsEmpty(true);
        setIsLoading(false);
        return;
      }
      await setActiveProjectId(initial.id);
      if (cancelled) return;
      setActiveProjectIdState(initial.id);
      setActiveProjectName(initial.name);
      loadProject(pickProjectFields(initial));
      setIsLoading(false);
    }
    void load();
    return () => {
      cancelled = true;
    };
    // `loadProject` is a stable useCallback (empty dep array in useCutListState),
    // so this still only runs once on mount despite being listed.
  }, [loadProject]);

  // Debounced autosave of the persisted subset of state. Reads each field by
  // its own member expression, matching what's listed below, rather than
  // passing the whole `state` object through `pickProjectFields` here - that
  // object is a new reference on every dispatch, including the purely
  // transient ones (hover, active sheet, material filter) this effect must
  // not fire for.
  useEffect(() => {
    if (isLoading || isEmpty || !activeProjectId) return;
    debouncerRef.current.schedule({
      id: activeProjectId,
      patch: {
        displayUnit: state.displayUnit,
        fractionDenominator: state.fractionDenominator,
        materials: state.materials,
        parts: state.parts,
        stock: state.stock,
        config: state.config,
        showCutSequence: state.showCutSequence,
      },
    });
  }, [
    isLoading,
    isEmpty,
    activeProjectId,
    state.displayUnit,
    state.fractionDenominator,
    state.materials,
    state.parts,
    state.stock,
    state.config,
    state.showCutSequence,
  ]);

  const activateProject = useCallback(
    async (id: string, name: string, fields: ProjectFields) => {
      await setActiveProjectId(id);
      setActiveProjectIdState(id);
      setActiveProjectName(name);
      loadProject(fields);
      setIsEmpty(false);
    },
    [loadProject],
  );

  const createProject = useCallback(
    async (fromTemplate?: string, name?: string) => {
      debouncerRef.current.flush();
      const input = fromTemplate
        ? templateProjectInput(fromTemplate, name)
        : blankProjectInput(name ?? 'Untitled Project');
      const created = await storageCreateProject(input);
      await activateProject(created.id, created.name, pickProjectFields(created));
      await refreshProjectList();
    },
    [activateProject, refreshProjectList],
  );

  const switchProject = useCallback(
    async (id: string) => {
      if (id === activeProjectIdRef.current) return;
      debouncerRef.current.flush();
      const project = await getProject(id);
      if (!project) return;
      await activateProject(project.id, project.name, pickProjectFields(project));
    },
    [activateProject],
  );

  const renameProject = useCallback(async (id: string, name: string) => {
    const renamed = await storageRenameProject(id, name);
    setProjects((prev) => prev.map((p) => (p.id === id ? { ...p, name: renamed.name } : p)));
    if (id === activeProjectIdRef.current) setActiveProjectName(renamed.name);
  }, []);

  const deleteProject = useCallback(
    async (id: string) => {
      if (id === activeProjectIdRef.current) debouncerRef.current.cancel();
      await storageDeleteProject(id);
      const list = await listProjects();
      setProjects(list);
      if (id !== activeProjectIdRef.current) return;
      const fallback = resolveFallbackAfterDelete(list);
      if (fallback === 'empty') {
        await setActiveProjectId(null);
        setActiveProjectIdState(null);
        setActiveProjectName('');
        setIsEmpty(true);
        return;
      }
      const project = await getProject(fallback.id);
      if (!project) return;
      await activateProject(project.id, project.name, pickProjectFields(project));
    },
    [activateProject],
  );

  return {
    ...state,
    isLoading,
    isEmpty,
    projects,
    activeProjectId,
    activeProjectName,
    createProject,
    switchProject,
    renameProject,
    deleteProject,
  };
}
