/**
 * `src/ui/state/projectStore.ts` - the headless logic behind `useProjectStorage`.
 * Against `fake-indexeddb` exactly like `test/storage/projects.test.ts`, since
 * `resolveInitialProject`/`resolveFallbackAfterDelete` wrap `storage/projects.ts`.
 * No React renderer involved - see the module's own header comment.
 */

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import { createProject, listProjects, setActiveProjectId } from '../../src/storage/projects';
import type { Project } from '../../src/storage/types';
import { BOOKSHELF_PRESET } from '../../src/ui/state/presets';
import {
  blankProjectInput,
  pickProjectFields,
  resolveFallbackAfterDelete,
  resolveInitialProject,
  templateProjectInput,
} from '../../src/ui/state/projectStore';

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
});

function makeProjectInput(name: string): Omit<Project, 'id' | 'createdAt' | 'updatedAt'> {
  return blankProjectInput(name);
}

describe('blankProjectInput', () => {
  it('starts with nothing to solve', () => {
    const input = blankProjectInput('Untitled Project');
    expect(input.name).toBe('Untitled Project');
    expect(input.materials).toEqual([]);
    expect(input.parts).toEqual([]);
    expect(input.stock).toEqual([]);
  });
});

describe('templateProjectInput', () => {
  it('carries a preset’s data under the preset’s name by default', () => {
    const input = templateProjectInput('bookshelf');
    expect(input.name).toBe(BOOKSHELF_PRESET.name);
    expect(input.materials).toBe(BOOKSHELF_PRESET.materials);
    expect(input.parts).toBe(BOOKSHELF_PRESET.parts);
    expect(input.stock).toBe(BOOKSHELF_PRESET.stock);
    expect(input.config).toBe(BOOKSHELF_PRESET.config);
  });

  it('accepts a name override', () => {
    expect(templateProjectInput('bookshelf', 'My Bookshelf').name).toBe('My Bookshelf');
  });

  it('throws on an unknown preset key - a stale UI reference, not user input', () => {
    expect(() => templateProjectInput('not-a-real-preset')).toThrow(/Unknown preset/);
  });
});

describe('pickProjectFields', () => {
  it('drops everything outside the seven persisted fields', () => {
    const project: Project = {
      id: 'abc',
      createdAt: 1,
      updatedAt: 2,
      ...blankProjectInput('Bookshelf'),
    };
    const fields = pickProjectFields(project);
    expect(fields).toEqual({
      displayUnit: 'imperial-fraction',
      fractionDenominator: 16,
      materials: [],
      parts: [],
      stock: [],
      config: project.config,
      showCutSequence: true,
    });
    expect(fields).not.toHaveProperty('id');
    expect(fields).not.toHaveProperty('name');
  });
});

describe('resolveInitialProject', () => {
  it('resolves to the active project when its id is set and still exists', async () => {
    const a = await createProject(makeProjectInput('A'));
    await createProject(makeProjectInput('B'));
    await setActiveProjectId(a.id);

    const resolved = await resolveInitialProject();
    expect(resolved).not.toBe('empty');
    expect((resolved as Project).id).toBe(a.id);
  });

  it('falls back to the most recently updated project when the active id is stale', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(1000);
      await createProject(makeProjectInput('Older'));
      vi.setSystemTime(2000);
      const newer = await createProject(makeProjectInput('Newer'));
      await setActiveProjectId('some-deleted-id');

      const resolved = await resolveInitialProject();
      expect(resolved).not.toBe('empty');
      expect((resolved as Project).id).toBe(newer.id);
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back to the most recently updated project when no active id was ever set', async () => {
    const only = await createProject(makeProjectInput('Solo'));
    const resolved = await resolveInitialProject();
    expect(resolved).not.toBe('empty');
    expect((resolved as Project).id).toBe(only.id);
  });

  it('resolves to ‘empty’ when nothing is saved', async () => {
    expect(await resolveInitialProject()).toBe('empty');
  });
});

describe('resolveFallbackAfterDelete', () => {
  it('picks the first (most recently updated) remaining project', async () => {
    await createProject(makeProjectInput('A'));
    await createProject(makeProjectInput('B'));
    const remaining = await listProjects();
    expect(resolveFallbackAfterDelete(remaining)).toEqual(remaining[0]);
  });

  it('resolves to ‘empty’ when nothing remains', () => {
    expect(resolveFallbackAfterDelete([])).toBe('empty');
  });
});
