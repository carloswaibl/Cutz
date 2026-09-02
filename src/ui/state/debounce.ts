/**
 * A generic call debouncer, with no opinion about what it debounces.
 *
 * It lived in `projectStore.ts` while autosave was its only caller. M7's
 * `solveClient.ts` needs the same coalescing - a burst of edits must become one
 * solve, not one per keystroke - and a solve client reaching into a module whose
 * own header calls itself "headless project-persistence logic" would be a
 * dependency in the wrong direction for the sake of thirty lines.
 */

export interface Debouncer<T> {
  /** Schedules `fn(arg)` after the delay, replacing any pending call. */
  schedule: (arg: T) => void;
  /** Runs a pending call immediately, if any, and clears it. */
  flush: () => void;
  /** Drops a pending call without running it. */
  cancel: () => void;
}

/**
 * Coalesces a burst of `schedule` calls into a single `fn` call carrying the
 * last argument. `schedule`'s argument is captured at call time, not re-read
 * from any shared mutable state at fire time - so a caller that closes over an
 * id (e.g. the active project) is safe even if that id changes before the
 * timer fires, as long as it always calls `schedule` again with the new id
 * rather than relying on this to pick it up.
 */
export function createDebouncer<T>(delayMs: number, fn: (arg: T) => void): Debouncer<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: { arg: T } | null = null;

  function clear() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  return {
    schedule(arg: T) {
      pending = { arg };
      clear();
      timer = setTimeout(() => {
        timer = null;
        const p = pending;
        pending = null;
        if (p) fn(p.arg);
      }, delayMs);
    },
    flush() {
      clear();
      const p = pending;
      pending = null;
      if (p) fn(p.arg);
    },
    cancel() {
      clear();
      pending = null;
    },
  };
}
