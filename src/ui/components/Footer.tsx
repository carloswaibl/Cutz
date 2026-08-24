const REPO_URL = 'https://github.com/carloswaibl/Cutz';

/**
 * The only "landing page" content this app has - `docs/plan-m6.md` §4 and §7
 * decision 2 settled that there is no marketing route and no pitch above the
 * fold, so what the project is and how it is licensed has to live down here.
 *
 * Static, not sticky: it is a footer, not a banner. Nothing hides it for print
 * either - `src/export/print.css` already blanks everything under `#root` that
 * is not the print document.
 */
export function Footer() {
  return (
    <footer className="border-t border-slate-800/80 px-4 sm:px-6 py-4 text-xs text-slate-500">
      <div className="max-w-7xl mx-auto flex flex-wrap items-center justify-center sm:justify-between gap-x-4 gap-y-2 text-center sm:text-left">
        <p>
          Your parts, stock and layouts never leave this browser. No account, no server, no upload.
        </p>

        <div className="flex items-center gap-3">
          <a
            href={REPO_URL}
            target="_blank"
            rel="noreferrer"
            className="hover:text-amber-400 transition-colors"
          >
            GitHub
          </a>
          <span aria-hidden="true" className="text-slate-700">
            •
          </span>
          <a
            href={`${REPO_URL}/blob/main/LICENSE`}
            target="_blank"
            rel="noreferrer"
            className="hover:text-amber-400 transition-colors"
          >
            MIT License
          </a>
          <span aria-hidden="true" className="text-slate-700">
            •
          </span>
          <span className="tabular-nums">v{__APP_VERSION__}</span>
        </div>
      </div>
    </footer>
  );
}
