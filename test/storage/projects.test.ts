/**
 * Project CRUD against `fake-indexeddb`. The `/auto` import installs every
 * global `idb` needs (`IDBRequest`, `IDBCursor`, `IDBTransaction`, ...) once;
 * `db.ts` never caches a connection (`withDb` opens and closes per call), so
 * swapping a fresh `IDBFactory` onto `globalThis.indexedDB` in `beforeEach` is
 * enough to isolate every test's data - no `deleteDatabase` teardown needed.
 */

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Material, Part, SolverConfig, Stock } from '../../src/domain/types';
import {
  createProject,
  deleteProject,
  getActiveProjectId,
  getProject,
  listProjects,
  renameProject,
  setActiveProjectId,
  updateProject,
} from '../../src/storage/projects';
import type { Project } from '../../src/storage/types';

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
});

const MATERIAL: Material = {
  id: 'mat-1',
  name: '3/4" Plywood',
  thickness: 19.05,
  hasGrain: true,
};

const PART: Part = {
  id: 'part-1',
  label: 'Side Panel',
  width: 300,
  height: 600,
  qty: 2,
  materialId: 'mat-1',
  rotationPolicy: 'locked',
};

const STOCK: Stock = {
  id: 'stock-1',
  materialId: 'mat-1',
  width: 1220,
  height: 2440,
  qty: 1,
  grainAxis: 'y',
};

const CONFIG: SolverConfig = {
  kerf: 3.175,
  edgeTrim: 6.35,
  seed: 1,
  effort: 'balanced',
};

function projectInput(name: string): Omit<Project, 'id' | 'createdAt' | 'updatedAt'> {
  return {
    name,
    displayUnit: 'imperial-fraction',
    fractionDenominator: 16,
    materials: [MATERIAL],
    parts: [PART],
    stock: [STOCK],
    config: CONFIG,
    showCutSequence: true,
  };
}

describe('project CRUD', () => {
  it('creates and round-trips through get', async () => {
    const created = await createProject(projectInput('Bookshelf'));
    expect(await getProject(created.id)).toEqual(created);
  });

  it('lists as ProjectSummary, not full payloads', async () => {
    const created = await createProject(projectInput('Bookshelf'));
    const list = await listProjects();
    expect(list).toEqual([{ id: created.id, name: 'Bookshelf', updatedAt: created.updatedAt }]);
  });

  it('sorts listings by most recently updated first', async () => {
    // Only `Date` is faked - `fake-indexeddb` schedules its own request
    // callbacks via real timers/microtasks, which faking wholesale would stall.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(1000);
      const first = await createProject(projectInput('First'));
      vi.setSystemTime(2000);
      const second = await createProject(projectInput('Second'));
      vi.setSystemTime(3000);
      await updateProject(first.id, { name: 'First (renamed)' });

      const list = await listProjects();
      expect(list.map((p) => p.id)).toEqual([first.id, second.id]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('advances updatedAt on update without changing createdAt', async () => {
    // Only `Date` is faked - `fake-indexeddb` schedules its own request
    // callbacks via real timers/microtasks, which faking wholesale would stall.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(1000);
      const created = await createProject(projectInput('Bookshelf'));
      vi.setSystemTime(2000);
      const updated = await updateProject(created.id, { name: 'Renamed' });
      expect(updated.createdAt).toBe(created.createdAt);
      expect(updated.updatedAt).toBe(2000);
      expect(updated.name).toBe('Renamed');
    } finally {
      vi.useRealTimers();
    }
  });

  it('renames a project', async () => {
    const created = await createProject(projectInput('Old Name'));
    const renamed = await renameProject(created.id, 'New Name');
    expect(renamed.name).toBe('New Name');
  });

  it('deletes one project without touching another', async () => {
    const a = await createProject(projectInput('A'));
    const b = await createProject(projectInput('B'));
    await deleteProject(a.id);
    expect(await getProject(a.id)).toBeUndefined();
    expect(await getProject(b.id)).toEqual(b);
  });

  it('deleting an unknown project id is a no-op', async () => {
    await expect(deleteProject('missing')).resolves.toBeUndefined();
  });

  it('throws when updating an unknown project id', async () => {
    await expect(updateProject('missing', { name: 'x' })).rejects.toThrow(
      'Project not found: missing',
    );
  });

  it('throws when renaming an unknown project id', async () => {
    await expect(renameProject('missing', 'x')).rejects.toThrow('Project not found: missing');
  });
});

describe('active project id', () => {
  it('is undefined until set', async () => {
    expect(await getActiveProjectId()).toBeUndefined();
  });

  it('round-trips through set and get', async () => {
    await setActiveProjectId('proj-1');
    expect(await getActiveProjectId()).toBe('proj-1');
  });

  it('clears when set to null', async () => {
    await setActiveProjectId('proj-1');
    await setActiveProjectId(null);
    expect(await getActiveProjectId()).toBeUndefined();
  });
});
