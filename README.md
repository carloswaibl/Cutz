# Cutz

A free, browser-based cut list optimizer for hobbyist woodworkers. Give it your parts and
the sheet goods you have on hand, and it works out how to cut them with the least waste -
respecting saw kerf, grain direction and material thickness.

**[Open it here -> carloswaibl.github.io/Cutz](https://carloswaibl.github.io/Cutz/)**

![The Cutz cut list optimizer, showing a bookshelf's parts packed onto a sheet of 3/4" plywood](docs/screenshot.png)

## What it does

- **Enter parts by hand, or import them.** Drop in an SVG from Inkscape, Illustrator or
  Fusion, or an STL of a single flat panel, and it pulls out the outlines and quantities.
- **Cuts you can actually make.** Every layout is guillotine-decomposable - a sequence of
  edge-to-edge cuts you can make on a table saw. A layout that packs beautifully but needs
  a CNC router is no use if you own a table saw.
- **Kerf, grain and edge trim are real constraints.** Adjacent parts are spaced by the blade
  width. Grain-locked parts are never rotated, because rotating one gives you a visibly wrong
  panel. Factory edges get trimmed off the usable area.
- **Imperial or metric.** Type `23-1/4`, `23 1/4` or `23.25` - all three work.
- **Printable cut sheets**, with an ordered cut sequence you can follow at the saw.
- **SVG and DXF export**, one file per sheet.
- **Multiple projects**, saved locally and still there when you come back.

## It runs entirely in your browser

There is no server, no account and no telemetry. Your parts, your stock and your layouts are
stored in your own browser's IndexedDB and never leave your machine. Once the page has
loaded it keeps working offline, which matters in a shop with bad wifi.

The flip side: projects are local to one browser on one machine. There is no cross-device
sync, by design.

## Running it locally

Node 24 (see [`.nvmrc`](.nvmrc)).

```bash
npm install
npm run dev        # dev server
npm run build      # production build into dist/
npm run preview    # serve that build locally
npm run test:run   # test suite, single run
```

`npm run typecheck` and `npm run lint` round out what CI checks. `npm run bench` runs the
solver benchmark suite against the fixtures in `test/fixtures/`.

## Digging deeper

- [`docs/project-plan.md`](docs/project-plan.md) - what this is, what it deliberately is not,
  and the milestone breakdown.
- [`docs/solver-design.md`](docs/solver-design.md) - how the guillotine packer works, and the
  invariants every layout has to satisfy.
- [`CLAUDE.md`](CLAUDE.md) - architecture constraints, the woodworking glossary, and the
  conventions to follow if you want to contribute.

## License

MIT - see [LICENSE](LICENSE).
