# querier

A minimal BI notebook on [basalt](../basalt): SQL and Python cells over one
shared set of tables.

A notebook is a folder. Cells run in filename order and are named by it:

```
notebooks/demo/
  01_sales.sql       result is the table `sales`
  02_enrich.py       sees `sales` as a polars DataFrame; its last expression is `enrich`
  03_by_region.sql   SELECT ... FROM enrich — any DataFrame is a table to basalt
  04_notes.md
  05_plot.py         matplotlib figures come back as PNGs
  notebook.json      { "title": ..., "description": ... }  (optional)
```

SQL runs in one `basalt kernel` per session, so a `CREATE CONNECTION`, `PARAM`
or `LET` in one cell holds for every later cell.

```sh
uv venv .venv && uv pip install --python .venv/bin/python polars matplotlib
bun install
bun run build && bun run start     # http://localhost:3000
bun run dev                        # API on :3000 + Vite on :5173 with hot reload
bun scripts/run-notebook.ts notebooks/demo -p days=7   # headless
bun test && bun run check
```

The notebook opens in a workbench laid out as VS Code's (and with its icons,
[Codicons](https://github.com/microsoft/vscode-codicons), CC BY 4.0): an activity bar
(Explorer, Search, Source control, Data), a resizable side bar, editors in tabs in one
or two groups side by side, a panel with **Results** and **Problems**, and a status bar
(kernel, branch, problems, cursor). The notebook is one tab, all cells stacked
(notebook mode); each cell also opens as a file with the whole editor (code mode),
its results in the panel. The report and `report.svelte` are tabs too: edit the
template on the left with the report on the right (Split, or "Open the report to the
side"). `ctrl+k` palette, `ctrl+b` side bar, `ctrl+j` panel, `ctrl+shift+e/f/g`
explorer/search/source control, `ctrl+\` split.

In the UI, cells know what they read. `FROM sales` or a Python name that an
earlier cell defines makes an edge. A cell turns **stale** when its code, a
`$param` it reads, or anything upstream changed since it ran, and running it
first runs whatever stale cells it needs.

Keys (press `?` in the UI for the full list):
- `shift+enter` runs with dependencies and moves to the next cell; `ctrl+enter`
  runs and stays; `ctrl+shift+enter` runs everything; `ctrl+k` opens the
  palette; `ctrl+b` the sidebar; `ctrl+=`/`ctrl+-`/`ctrl+0` zoom (default 112.5%).
- The editor works like VS Code's: suggestions as you type or on `tab` /
  `ctrl+space` (keywords, basalt functions with their docs, notebook tables and
  their columns, Python names with their types), parameter hints inside a
  function call, hover cards for tables and `$params`, `ctrl+/` comments,
  `ctrl+f` finds, alt+click and `ctrl+d` add cursors.
- SQL cells are checked as you type (basalt's `check`, nothing runs): every
  problem is underlined, against the running kernel when there is one (its
  connections, `PARAM`s, `LET`s and the real columns of other cells' results),
  else against the notebook's names.
- `esc` enters command mode: `j`/`k` move, `enter` edits, `a`/`b` add a cell
  above/below, `y`/`p`/`m` switch to SQL/Python/Markdown, `J`/`K` move the
  cell, `h`/`o` hide code/output, `dd` deletes, `ii` stops, `00` restarts.

The sidebar lists the session's tables with their columns, the data files in
the notebook folder, and basalt connections, whose tables it lists with
`SHOW TABLES`. Clicking a name inserts it into the editor you last used.
Result tables sort by clicking a header and show column stats on hover. Search
takes `000600` (any column), `customer:000600` (one column), `state=BA` / `!=`,
`total>1000` (and `>=`, `<`, `<=`; dates as `2025-01-31`), `-text` to leave rows out
and `"a phrase"`, ANDed, with what matched highlighted. When a result is longer
than the rows the page holds (5,000), the search runs in the kernel over all of it.
Cells select like a spreadsheet (drag, shift+click, the row numbers, Ctrl+A);
Ctrl+C copies tab-separated for pasting into a sheet, and right-click copies with
headers, as CSV, Markdown, JSON, or a column as a SQL `IN (...)` list.

**Report**: every notebook is also a report (header → Report): its cells in order
with the code hidden, markdown as prose, outputs as they are (tables, Altair and
`df.plot` charts drawn with Vega-Lite in the app's theme, Great Tables,
matplotlib). By default it shows the markdown and the cells nothing else reads, so
intermediate steps stay out. **Arrange** lays it out as blocks on a 12-column grid:
drag them into any order, give each a width (¼ ⅓ ½ ⅔ ¾ or the full row; blocks share a
row while they fit), choose what of a cell's output it shows (its chart, its table,
what it printed), add a title or caption, duplicate a cell to show its chart in one
place and its table in another, and write text blocks of the report's own. The
layout is `report.blocks` in `notebook.json`, so it travels with the notebook in git
and follows renames; **Reset layout** returns to the default.

**Templates**: for what blocks can't express, the report can be a Svelte 5
component, `report.svelte` in the notebook folder (report ⋯ → "Write as a Svelte
template" starts one from the current layout; it opens as a tab, with the report
beside it, completion and hover for the cells, columns, PARAMs and hooks, and
build errors in place and in Problems). It imports hooks from
`"querier"`: `<Output cell parts>`, `<Chart cell>`, `<Table cell columns>`,
`<Value cell column label format compare>` (a KPI), `<Control param options>` and
`setParam`, and gets `cells` (`cells.monthly.rows` as plain objects, up to 5,000,
with `.columns`, `.rowCount`, `.state`) and `params`. The server compiles and
bundles it (`server/template.ts`), and it may import only `svelte` and `querier`;
it runs in an `allow-scripts` iframe with no origin of its own, so it cannot reach
Querier's pages, storage or API, and learns only what the report sends it. For the
same reason every request that changes something, and every notebook socket, must
come from Querier's own origin.

The notebook's `PARAM`s are the report's controls: changing one re-runs only the
cells that depend on it. `PARAM from` / `PARAM to` get Grafana's time picker
(presets like "Last 7 days", stored relative so refreshes move with the clock);
**Controls** (while arranging) turn a `PARAM` into a dropdown fed by a cell's
column or a fixed list. Click-to-filter is code: an Altair selection named after a
`PARAM` sets it when clicked (`alt.selection_point(name="region",
fields=["region"])`), and clicking the same value again clears it. Reports refresh
on an interval while visible and go full screen.

**Results as files**: a result table's download button (↓) exports the cell's
whole result from the kernel, not just the rows shown, as Parquet or CSV. Cells can
write files to the notebook's `output/` folder (`LOAD INTO 'output/x.parquet' AS …`,
`df.write_parquet("output/x.parquet")`). It is the one place a sandboxed cell
can write back to: after each run the kernel sends what changed there to the server,
which keeps it in the notebook folder (paths are checked to stay inside `output/`;
files over 2 GB stay in the sandbox). Anything else a cell writes vanishes with its
microVM. `output/` is kept out of git, and its files list in the sidebar.

**Secrets** (palette → "Secrets", or the sidebar) become environment variables of
the notebook's kernel, so no cell holds a password: a connection named `sr` reads
`SR_USER`/`SR_PASS` by basalt's convention, `token = env('GH_TOKEN')` works in a
connection's options, and Python reads `os.environ`. They are set for one notebook
or for all, stored in `~/.config/querier/secrets.json` (mode 600, never in a
notebook folder, never sent back to the browser), and masked in cell output. A
literal `password = '…'` in a cell is flagged in the editor.

**Git**: each notebook can be its own repository; opening an untracked notebook
offers to start. The sidebar's Changes tab shows what changed per cell (a
renumbered cell is "moved", not deleted and added), commits, discards, switches
and creates branches, and pulls (fast-forward, or rebase; a conflict is undone
and reported) and pushes. History shows each commit cell by cell, side by side,
and restores a cell or the whole notebook as uncommitted changes. Editors mark
changed lines in the gutter and show an inline diff on demand. Outputs are never
committed; `.gitignore` leaves columnar data out. HTTPS remotes sign in with a
`GIT_TOKEN` secret, SSH with the server's keys.

**AI clients (MCP)**: Claude Code, Claude Desktop or any MCP client can work with
notebooks at `/mcp` (Streamable HTTP). Palette → "AI clients and access" makes a
client token (shown once, stored hashed) and gives the command to paste:

```sh
claude mcp add --transport http querier http://localhost:3000/mcp --header "Authorization: Bearer qk_…"
```

Each notebook has an access level, kept on the server (`mcp.json` next to
`secrets.json`, never in the notebook folder, so a pulled repo can't raise its own):
**off**; **read** (the default: code, dependencies, schemas, errors, no rows);
**run** (runs cells and scratch queries, sees results and images); **edit**
(writes, renames, moves and deletes cells, lays out the report). Tools:
`list_notebooks`, `read_notebook`, `describe` (DESCRIBE / SHOW TABLES),
`check_sql` (`basalt check`), `basalt_reference` (sections of basalt's
`language.md`), `get_output`, `run_cells` (stale ancestors
first, as the Run button), `run_query`, `write_cell`, `rename_cell`,
`edit_cell` (exact find-and-replace, all or nothing), `move_cell`, `delete_cell`,
`set_report`. Runs and edits go through the same
paths as the UI, so open tabs show them; kernels get secrets as environment
variables and output is masked, so secret values never reach a client. Requests
from a browser page on another origin are refused.

## Running it sandboxed (Docker + Firecracker)

```sh
docker compose up --build        # http://localhost:3000
```

Each notebook session runs in its own Firecracker microVM, built and shipped in
the image (nothing is installed on the host):

- The VM boots a read-only root disk (Python 3.13, polars, altair, great_tables,
  matplotlib, basalt) and a read-only copy of the notebook's files, with a
  throwaway layer on top: nothing it writes comes back.
- Secrets reach it over vsock when the session starts, and are never on a disk.
- Firecracker runs as an unprivileged user under its own seccomp filter; the
  container holds only `NET_ADMIN SETUID SETGID CHOWN KILL`, `/dev/kvm` and
  `/dev/net/tun`, with no-new-privileges.
- Network is off unless the notebook allows destinations (palette → "Sandbox"):
  then TCP to those `host:port`s only, refused otherwise, never to the container
  or to link-local (cloud metadata), and no DNS inside (names are resolved when
  the kernel starts). Each VM's tap lives in the container's network namespace.
- vCPUs and memory are per notebook (default 2 and 2 GB).

`bun scripts/vm-smoke.ts`, run inside the image, boots a VM and checks all of it.

`BASALT_BIN`, `QUERIER_PYTHON`, `QUERIER_SECRETS` and `QUERIER_MAX_ROWS` (default 1,000,000; a SQL
result is cut there) override the defaults.

## Layout

- `kernel/kernel.py`: the session. It holds the Python namespace, drives
  `basalt kernel`, exports DataFrames to basalt as Arrow files, and speaks a
  framed protocol (stdin/stdout now, vsock in the microVM).
- `server/runner/`: the `Runner`/`Session` interface, the protocol and the local
  process runner.
- `server/notebook.ts` loads a notebook folder, and `server/store.ts` edits it
  (renumbering the files on every add, move or delete).
- `server/host.ts` holds one session per open notebook: a run queue, each
  cell's last output, and a broadcast to every tab (a reload replays outputs).
- `kernel/analyze.py` (with `kernel/sqlrefs.py`) works out what each cell
  defines and reads, and `shared/graph.ts` turns that into edges,
  staleness and run plans.
- `server/mcp/`: the MCP server for AI clients (tools, access levels, tokens).
- `server/app.ts` serves REST for files, a WebSocket per notebook, `/mcp`, and the built UI.
- `web/` is the Svelte 5 UI: CodeMirror editor, virtualized Arrow table.
