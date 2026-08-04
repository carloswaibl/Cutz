/**
 * The one thing a `Solver` throws.
 *
 * `Solver.solve` returns a `Result`, so it has nowhere to put "your input does
 * not make sense". That is deliberate: the caller is expected to run
 * `validateInputs` first and show the issues to the user, who is the only one
 * who can fix them. Reaching this error means that step was skipped.
 *
 * Consistent with the rest of the codebase's split - `domain/validate.ts`
 * returns typed issues for data a user typed and owes them a message they can
 * act on, and throws are reserved for a caller who ignored them.
 */

import type { InputIssue } from '../domain/validate';

export class SolverInputError extends Error {
  readonly issues: InputIssue[];

  constructor(issues: readonly InputIssue[]) {
    const errors = issues.filter((issue) => issue.severity === 'error');
    super(
      `the solver was given invalid input: ${errors.map((issue) => issue.message).join(' ')}`.trim(),
    );
    this.name = 'SolverInputError';
    this.issues = [...issues];
  }
}
