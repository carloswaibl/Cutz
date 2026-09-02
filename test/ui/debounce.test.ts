/**
 * `src/ui/state/debounce.ts` - moved out of `projectStore.ts` in M7 PR 7 when a
 * second caller (`solveClient.ts`) appeared. These cases came across unchanged.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDebouncer } from '../../src/ui/state/debounce';

describe('createDebouncer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('coalesces a burst of rapid calls into one fire with the last argument', () => {
    const fn = vi.fn();
    const debouncer = createDebouncer<number>(500, fn);

    debouncer.schedule(1);
    vi.advanceTimersByTime(100);
    debouncer.schedule(2);
    vi.advanceTimersByTime(100);
    debouncer.schedule(3);
    vi.advanceTimersByTime(500);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(3);
  });

  it('flush runs a pending call immediately and clears it', () => {
    const fn = vi.fn();
    const debouncer = createDebouncer<number>(500, fn);

    debouncer.schedule(1);
    debouncer.flush();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(1);

    vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('flush with nothing pending is a no-op', () => {
    const fn = vi.fn();
    createDebouncer<number>(500, fn).flush();
    expect(fn).not.toHaveBeenCalled();
  });

  it('cancel drops a pending call without running it', () => {
    const fn = vi.fn();
    const debouncer = createDebouncer<number>(500, fn);

    debouncer.schedule(1);
    debouncer.cancel();
    vi.advanceTimersByTime(1000);

    expect(fn).not.toHaveBeenCalled();
  });
});
