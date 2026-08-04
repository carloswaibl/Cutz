/**
 * App shell. Scaffold only - the parts table, stock config and layout view
 * arrive in M2. Solver invocation and state live at this level; the components
 * below stay presentational.
 */
export function App() {
  return (
    <main className="app">
      <header className="app__header">
        <h1>Cutz</h1>
        <p className="app__tagline">
          Cut list optimizer for woodworkers. Runs entirely in your browser - nothing is uploaded
          anywhere.
        </p>
      </header>

      <section className="app__placeholder">
        <p>Scaffold in place. Next up: M1, the headless solver core.</p>
      </section>
    </main>
  );
}
