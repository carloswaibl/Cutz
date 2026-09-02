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
    // The issue messages and nothing else.
    //
    // This used to be prefixed with "the solver was given invalid input:",
    // which was fine while the string only ever reached a console or a test -
    // `name` already says `SolverInputError`, so the prefix was saying it twice.
    // M7 PR 7 is the first release that shows it to a user, under a panel
    // heading that says the same thing a third time, and a red panel whose text
    // began lowercase mid-sentence read as a bug in itself. Each issue message
    // is already a whole sentence written for the person who typed the value.
    super(
      errors
        .map((issue) => issue.message)
        .join(' ')
        .trim() || 'the input could not be solved',
    );
    this.name = 'SolverInputError';
    this.issues = [...issues];
  }
}
