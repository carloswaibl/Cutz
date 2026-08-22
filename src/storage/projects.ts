/**
 * CRUD over saved projects, plus the single small piece of settings state that
 * sits alongside them: which project was open last. All promise-returning,
 * all wrapping one `idb` connection per call via `withDb` (`db.ts`).
 */

import { withDb } from './db';
import type { Project, ProjectSummary } from './types';

const ACTIVE_PROJECT_KEY = 'activeProjectId';

export function listProjects(): Promise<ProjectSummary[]> {
  return withDb(async (db) => {
    const all = await db.getAll('projects');
    return all
      .map(({ id, name, updatedAt }) => ({ id, name, updatedAt }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  });
}

export function getProject(id: string): Promise<Project | undefined> {
  return withDb((db) => db.get('projects', id));
}

export function createProject(
  input: Omit<Project, 'id' | 'createdAt' | 'updatedAt'>,
): Promise<Project> {
  return withDb(async (db) => {
    const now = Date.now();
    const project: Project = {
      ...input,
      id: crypto.randomUUID(),
      createdAt: now,
      updatedAt: now,
    };
    await db.put('projects', project);
    return project;
  });
}

/** Throws if `id` does not name an existing project - a stale UI reference, not user input. */
export function updateProject(
  id: string,
  patch: Partial<Omit<Project, 'id' | 'createdAt'>>,
): Promise<Project> {
  return withDb(async (db) => {
    const existing = await db.get('projects', id);
    if (!existing) {
      throw new Error(`Project not found: ${id}`);
    }
    const updated: Project = { ...existing, ...patch, updatedAt: Date.now() };
    await db.put('projects', updated);
    return updated;
  });
}

export function renameProject(id: string, name: string): Promise<Project> {
  return updateProject(id, { name });
}

export function deleteProject(id: string): Promise<void> {
  return withDb((db) => db.delete('projects', id));
}

export function getActiveProjectId(): Promise<string | undefined> {
  return withDb((db) => db.get('meta', ACTIVE_PROJECT_KEY));
}

export function setActiveProjectId(id: string | null): Promise<void> {
  return withDb(async (db) => {
    if (id === null) {
      await db.delete('meta', ACTIVE_PROJECT_KEY);
    } else {
      await db.put('meta', id, ACTIVE_PROJECT_KEY);
    }
  });
}
