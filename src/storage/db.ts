/**
 * IndexedDB access, via `idb`.
 *
 * `withDb` opens a connection, runs one operation, and always closes it again -
 * deliberately not a cached module-level singleton. A held-open connection
 * blocks a future `deleteDatabase` (tests) and a future schema-version bump
 * (production) until it closes; opening fresh per call sidesteps both, and at
 * this app's scale (20-100 parts, an occasional debounced autosave) the cost
 * of open+close per call is not worth avoiding.
 */

import { type DBSchema, type IDBPDatabase, openDB } from 'idb';
import type { Project } from './types';

interface CutzDB extends DBSchema {
  projects: {
    key: string;
    value: Project;
  };
  /** Small out-of-line key/value settings, e.g. the active project id. */
  meta: {
    key: string;
    value: string;
  };
}

const DB_NAME = 'cutz';
const DB_VERSION = 1;

function open(): Promise<IDBPDatabase<CutzDB>> {
  return openDB<CutzDB>(DB_NAME, DB_VERSION, {
    upgrade(db) {
      db.createObjectStore('projects', { keyPath: 'id' });
      db.createObjectStore('meta');
    },
  });
}

export async function withDb<T>(fn: (db: IDBPDatabase<CutzDB>) => Promise<T>): Promise<T> {
  const db = await open();
  try {
    return await fn(db);
  } finally {
    db.close();
  }
}
