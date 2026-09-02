/**
 * The three ways the app says something about the solver rather than about a
 * layout: it is working, it is working and what you can see is the previous
 * answer, or it could not answer at all.
 *
 * All three arrived with M7 PR 7. The first two exist because solving moved off
 * the render path (`docs/plan-m7.md` §1 criterion 8): a nest solve takes
 * seconds, and §3.6 keeps the last good layout on screen throughout, so
 * something has to say that the diagram is stale. The third fixes a gap that
 * had been open since M1 - `solverError` was computed and rendered nowhere, so
 * invalid input made the whole results section disappear with no explanation.
 */

/**
 * Shown beside the diagram while a solve is in flight.
 *
 * Deliberately additive rather than a spinner replacing the sheet: the previous
 * layout is still useful to look at, and a woodworker mid-cut should not have
 * the diagram yanked away because they touched a field.
 */
export function SolvingChip() {
  return (
    <div
      className="flex items-center gap-2 px-3 py-2 rounded-lg border border-sky-500/40 bg-sky-500/10 text-xs font-medium text-sky-300"
      role="status"
    >
      <span className="w-3 h-3 rounded-full border-2 border-sky-400/30 border-t-sky-300 animate-spin" />
      Solving. Showing the previous layout.
    </div>
  );
}

/**
 * Stands in for the results section on the very first solve of a project, when
 * there is no previous layout to keep on screen.
 */
export function SolvingPlaceholder() {
  return (
    <div
      className="bg-slate-900/60 border border-slate-800 rounded-xl p-6 flex items-center justify-center gap-3 min-h-[160px] text-sm text-slate-400"
      role="status"
    >
      <span className="w-4 h-4 rounded-full border-2 border-slate-600 border-t-sky-300 animate-spin" />
      Solving your cut list.
    </div>
  );
}

/**
 * The solver refused the input.
 *
 * `solve()` only throws when `validateInputs` found an error - a duplicate part
 * id, a kerf that is not a positive number, an imported outline that no longer
 * matches its bounding box. Those are all things the user typed and can fix,
 * which is exactly why showing them beats the silence this replaces.
 */
export function SolverErrorPanel({ message }: { message: string }) {
  return (
    <div
      className="bg-red-500/10 border border-red-500/30 rounded-xl p-4 sm:p-5 flex gap-4 items-start"
      role="alert"
    >
      <svg
        className="mt-0.5 flex-shrink-0 w-5 h-5 text-red-400"
        viewBox="0 0 20 20"
        fill="currentColor"
        aria-hidden="true"
      >
        <path
          fillRule="evenodd"
          d="M10 18a8 8 0 100-16 8 8 0 000 16zM9 5a1 1 0 012 0v6a1 1 0 11-2 0V5zm1 10a1.25 1.25 0 100-2.5 1.25 1.25 0 000 2.5z"
          clipRule="evenodd"
        />
      </svg>
      <div>
        <h3 className="text-base font-semibold text-red-400 mb-1">Cannot solve this cut list</h3>
        <p className="text-sm text-red-200/90">{message}</p>
      </div>
    </div>
  );
}
