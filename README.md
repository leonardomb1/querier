# querier

A minimal BI notebook on [basalt](../basalt): SQL and Python cells over one
shared set of tables.

A notebook is a folder, in a workspace folder. Cells run in filename order and
are named by it:

```
notebooks/default/demo/
  01_sales.sql       result is the table `sales`
  02_enrich.py       sees `sales` as a polars DataFrame; its last expression is `enrich`
  03_by_region.sql   SELECT ... FROM enrich — any DataFrame is a table to basalt
  04_notes.md
  05_plot.py         matplotlib figures come back as PNGs
  notebook.json      { "title": ..., "description": ... }  (optional)
```

A **workspace** is a folder of notebooks with settings they share
(`workspace.json` and the server's config): connections, sandbox defaults (vCPUs and
memory, unless a notebook sets its own; allowed destinations add to a notebook's),
the AI clients' default access, and attributes: key/value tags (team, cost center,
classification) that access policies read. A notebook's id is
`workspace/notebook`, its address `#/w/<workspace>/nb/<notebook>`. Notebooks from
before workspaces move into `default/` when the server starts, with their AI
access; old `#/nb/<name>` links still open them.

SQL runs in one `basalt kernel` per session, so a `CREATE CONNECTION`, `PARAM`
or `LET` in one cell holds for every later cell.

```sh
uv venv .venv && uv pip install --python .venv/bin/python polars matplotlib
bun install
bun run build && bun run start     # http://localhost:3000
bun run dev                        # API on :3000 + Vite on :5173 with hot reload
bun scripts/run-notebook.ts notebooks/default/demo -p days=7   # headless
bun test && bun run check
```

Home is the same workbench as a notebook, so moving between them keeps the title,
activity and status bars in place: a Workspaces tree in the side bar (new
workspaces and notebooks, and renames, typed in place, `F2` renames; drag a
notebook onto a workspace to move it), a Welcome tab with recent notebooks, and
per workspace an overview of its notebooks and a settings editor laid out as VS
Code's.

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

**Kernels are each person's own**, as in Microsoft Fabric: two people on one
notebook run in two kernels (two microVMs), so what one runs and sees never
reaches the other, and each runs with what they may use. A kernel unused for
`QUERIER_KERNEL_IDLE_MINUTES` (default 30) stops and its tabs are told why;
`QUERIER_MAX_KERNELS` (default: what the host's memory holds) and
`QUERIER_MAX_KERNELS_PER_USER` (default 3) cap how many run, and a run over a cap
says which.

**Editing together**: everyone with a notebook open edits the same code, live.
Edits made at once in the same cell merge character by character (a Yjs document
per notebook, `server/collab.ts`); the server writes each cell to its file a moment
after it changes, and takes in what changed the files otherwise (a pull, an AI
client, a new cell). Who else is here shows in the title bar; a cell someone is in
has their color around it and their badge beside it, and their cursor and
selection show in its code, named while they move. Undo takes back only your own
edits. Viewers see it all as it is typed and can't change it. Code and presence
are shared; results stay each person's own (their kernel).

**Terminal** (the panel's Terminal tab, Ctrl+`): a shell in your own kernel's
microVM, with its connections, the notebook as its folder and the sandbox's
network rules. The notebook's files are read-only there, and what you write or
install is gone when the kernel restarts: lasting packages belong in the
notebook's Environment settings. It needs `notebook.shell`, which comes with
running (Contributor and up, a Run share and up) and which a policy can take away
on its own; opening one is audited. A kernel that isn't a microVM (the local
runner) has no terminal.

**Connections** give kernels their credentials, so no cell holds a password. A
connection is a named set of environment variables: one named `sr` gives
`SR_USER`/`SR_PASS`, which basalt's `CREATE CONNECTION sr` reads by itself;
`token = env('GH_TOKEN')` works in a connection's options; Python reads
`os.environ`. A connection is a workspace's (its settings → Connections) or
everyone's (User settings → Connections), and its credentials are **shared** (set
once by who manages it) or **each person's own** (everyone enters theirs, in User
settings or when a notebook asks; a kernel runs with its owner's). Who may use one
is policy: a workspace's Contributors use its connections and its Members manage
them, and a connection has its own roles (User, Owner) for anyone else; a kernel
gets exactly the connections its owner may use. Values are stored in
`<config>/connections.json` (mode 600, never in a notebook folder, never sent back
to the browser) and masked in cell output. A literal `password = '…'` in a cell is
flagged in the editor.

**Environments**: a workspace's settings (and a notebook's, on top) list the
**Python packages** its kernels get and the **npm packages** its report
templates may import. Applying one locks it into the folder (`pyproject.toml` +
`uv.lock`, `package.json` + `bun.lock`, so it travels with git) and builds it on
the server, never in a sandbox: Python as wheels for the guest (nothing compiled)
on a read-only disk the microVM mounts, npm with install scripts off. A notebook's
packages shadow its workspace's, which shadow the image's (polars, altair,
great_tables, matplotlib). What is in force is what an Admin or Member last
applied (`environment.manage`): files changed by an edit or a pull show as
"changed since applied" until someone who may applies them. Builds are cached by
the lock's hash in `QUERIER_ENVS` (`/data/envs` in the image); a published
report keeps the environments it was published with.

**Publishing a report** (the report's toolbar → Publish, for who may share the
notebook) gives it to its viewers, everyone with `report.view` (a workspace's
Viewers, a Read share, a policy), at `#/w/<ws>/nb/<nb>/view`: the report alone,
no code, run on the server in each viewer's own report kernel. Publishing freezes
the code as it is: later edits reach viewers when it is published again (the
report says when the notebook changed since). It runs **as each viewer**, with
their own connections, or **as its owner**, with the publisher's connections
(only they can choose that; viewers never see the credentials, and it runs only
the code they published). A PARAM can be **bound** to a tag of the viewer's
(`region` from their directory `region`): the server sets it on every run, the
viewer can't, and a viewer without the tag can't run it, so each sees their own
rows. A report run as its owner with nothing bound can be **scheduled** (every 15
minutes to daily): the server runs it as the owner and viewers open it already
run, without a kernel of their own until they change a control. Viewers' runs
write nothing back to the notebook's folder. Publishing, unpublishing and each
scheduled run are in the audit log.

**Git**: each notebook can be its own repository; opening an untracked notebook
offers to start. The sidebar's Changes tab shows what changed per cell (a
renumbered cell is "moved", not deleted and added), commits, discards, switches
and creates branches, and pulls (fast-forward, or rebase; a conflict is undone
and reported) and pushes. History shows each commit cell by cell, side by side,
and restores a cell or the whole notebook as uncommitted changes. Editors mark
changed lines in the gutter and show an inline diff on demand. Outputs are never
committed; `.gitignore` leaves columnar data out. HTTPS remotes sign in with
`GIT_TOKEN` from a connection the person pulling or pushing may use, SSH with the
server's keys.

**AI clients (MCP)**: Claude Code, Claude Desktop or any MCP client can work with
notebooks at `/mcp` (Streamable HTTP). Palette → "AI clients and access" makes a
client token (shown once, stored hashed) and gives the command to paste:

```sh
claude mcp add --transport http querier http://localhost:3000/mcp --header "Authorization: Bearer qk_…"
```

Each notebook has an access level, its own or else its workspace's default (set in
the workspace's settings), kept on the server (`<config>/mcp.json`, never in the
notebook folder, so a pulled repo can't raise its own):
**off**; **read** (the default: code, dependencies, schemas, errors, no rows);
**run** (runs cells and scratch queries, sees results and images); **edit**
(writes, renames, moves and deletes cells, lays out the report). Tools:
`list_notebooks`, `read_notebook`, `describe` (DESCRIBE / SHOW TABLES),
`check_sql` (`basalt check`), `basalt_reference` (sections of basalt's
`language.md`), `get_output`, `run_cells` (stale ancestors
first, as the Run button), `run_query`, `write_cell`, `rename_cell`,
`edit_cell` (exact find-and-replace, all or nothing), `move_cell`, `delete_cell`,
`set_report`. Runs and edits go through the same
paths as the UI, so open tabs show them; a token acts as its owner, in their own
kernel with their connections, and output is masked, so credentials never reach a client. Requests
from a browser page on another origin are refused.

## Signing in

Every page, API call, kernel socket and AI token needs a signed-in person.

- **The sysadmin** works even when the directory is down, and no policy applies to it.
  - **On the first start** Querier makes it (`admin`) and prints its generated password to the log: `docker compose logs querier`. The first sign-in asks for a password of your own; the account menu changes it later.
  - It is kept hashed in `<config>/sysadmin.json`. **A lost password:** delete that file and restart (`docker compose exec querier rm /data/config/sysadmin.json && docker compose restart`), and a new one is printed.
  - **Or from `.env`** (copy `.env.example`): `QUERIER_ADMIN_USER` with `QUERIER_ADMIN_PASSWORD_HASH`, as printed by `bun server/auth/hash.ts`. It then wins over the file and is changed only there. `compose.yaml` loads `.env` into the container when there is one.
- **Directories and single sign-on:** Administration → Sign-in adds and edits them (presets for Active Directory, OpenLDAP, Entra ID, Keycloak and any OpenID Connect provider), orders the sign-in page, and tries the settings before saving: the directory reached and a person looked up by name without their password (their groups and mapped attributes shown), or the issuer's discovery read and the redirect URI to register. Also session lifetimes. It is all kept in `<config>/auth.json` (mode 600; `auth.example.json` has examples), which can be edited by hand too. A secret there may be `"env:NAME"`, read from `.env`; a stored one is never sent back to the page.
  - **LDAP / Active Directory:** `{ "id": "corp", "type": "ldap", "label": "Corporate AD", "url": "ldaps://dc.corp:636", "caFile": "/data/config/ca.pem", "bindDn": "CN=svc-querier,…", "bindPassword": "env:LDAP_BIND_PASSWORD", "baseDn": "DC=corp,DC=local", "groupBaseDn": "DC=corp,DC=local", "attributes": { "department": "department", "title": "title" } }`
    - The directory's CA certificate is uploaded (or its PEM pasted) in the provider's dialog, which shows whose it is, until when, and its SHA-256 fingerprint to check with IT; it is kept in auth.json as `ca`. `caFile`, a PEM file on the server, still works.
    - Querier searches with the service account, then binds as the person.
    - It uses LDAPS or StartTLS only.
    - Nested AD groups are resolved, and disabled accounts are refused.
  - **OIDC (Microsoft Entra ID, Keycloak, …):** `{ "id": "entra", "type": "oidc", "label": "Microsoft", "issuer": "https://login.microsoftonline.com/<tenant>/v2.0", "clientId": "…", "clientSecret": "env:ENTRA_CLIENT_SECRET", "attributes": { "department": "department" }, "entraGraphOverage": true }`
    - It uses the authorization code flow with PKCE.
    - The redirect URI is `<QUERIER_PUBLIC_URL>/api/auth/oidc/<id>/callback`.
    - `entraGraphOverage` reads a user's groups from Microsoft Graph when there are too many for the token, which needs `GroupMember.Read.All`.
- **Sessions:** an HttpOnly cookie. The person's groups and attributes are refreshed from their provider every 15 minutes, and a disabled account's session ends.
- **Passwords over plain HTTP** are refused except on localhost: serve it over HTTPS (a reverse proxy that ends TLS) and set `QUERIER_PUBLIC_URL` to the `https://` address.
  - **Opting out, for now:** `QUERIER_ALLOW_HTTP=1` in `.env` takes them over plain HTTP from anywhere. Anyone on the network in between can read passwords and session cookies, so only on a network you trust, until a certificate is in place. The server warns on every start.
- **Audit:** every sign-in, denial and change is logged in `<config>/querier.db`.
- **Access** is decided by one policy engine ([Cedar](https://www.cedarpolicy.com)) on every request, socket message and AI tool call:
  - **Roles and shares, as in Microsoft Fabric**, given in Manage access to a person, a directory group, everyone, or everyone whose attributes match a condition (`principal.getTag("department").contains("Finance")`): a workspace's Viewer, Contributor, Member or Admin; a notebook's Read, Run, Edit or Reshare; a connection's User or Owner. Running (`notebook.run`) comes with a terminal (`notebook.shell`): `forbid (principal, action == Action::"notebook.shell", resource);` in a policy file takes terminals away from everyone.
  - **Policy files** (Administration → Policies, or `<config>/policies/*.cedar`, git-able): rules roles can't say, over people's directory attributes and workspaces' and notebooks' tags. Checked as they are typed; a file with errors isn't saved, a set that doesn't load keeps the last valid one in force, and a policy that errors counts as a denial. A `forbid` wins over any `permit`.
  - **Administration** (the sysadmin, or whoever a policy gives `admin.manage`; the gear menu): the policy files; **explain a decision** (may this person do this to that, and which policies decided it); **people** (their groups and attributes as policies see them, and what they may do where); and the **audit log** (sign-ins, denials, grants, policy and connection changes), filtered and paged.
  - People who sign in see nothing until something gives them access. **Who may sign in at all** can be narrowed (Administration → Sign-in → Who may sign in, or any policy forbidding `signIn`): by group, directory attribute or provider. Someone who stops matching is signed out at their next request; the system administrator always may.
- **AI tokens** act as the person who made them. Tokens made before accounts existed now belong to the sysadmin.
  - Renaming `QUERIER_ADMIN_USER` makes those tokens someone else's: make new ones.
  - Changing the sysadmin's name or password ends its open sessions.
- **Behind a reverse proxy that ends TLS:**
  - set `QUERIER_PUBLIC_URL`; requests from that origin count as Querier's own;
  - set `QUERIER_TRUSTED_PROXIES` to the proxy's address, so the audit log and login throttling see the real client address;
  - an OIDC sign-in must finish in the browser that started it.

## Running it sandboxed (Docker + Firecracker)

```sh
docker compose up -d             # http://localhost:3000
docker compose logs querier      # the sysadmin's generated password, on the first start
```

**Over HTTPS** (needed for password sign-in anywhere but localhost): put any
reverse proxy that ends TLS in front (nginx, Caddy, Traefik, a load balancer), passing
WebSockets through, and set `QUERIER_PUBLIC_URL` to its `https://` address and
`QUERIER_TRUSTED_PROXIES` to its address. Or, on a network you trust and for now,
`QUERIER_ALLOW_HTTP=1` (see Signing in).

It runs the published image, `ghcr.io/leonardomb1/querier`: each release (a tag
`v0.1.0`) publishes its version and `latest`. `QUERIER_VERSION=0.1.0` in `.env`
pins one; `docker compose pull` updates. To run a build of this checkout instead,
tag it as that image first: `docker build -t ghcr.io/leonardomb1/querier:latest .`

Each notebook session runs in its own Firecracker microVM, built and shipped in
the image (nothing is installed on the host):

- The VM boots a read-only root disk (Python 3.13, polars, altair, great_tables,
  matplotlib, basalt) and a read-only copy of the notebook's files, with a
  throwaway layer on top: nothing it writes comes back.
- Credentials reach it over vsock when the session starts, and are never on a disk.
- Firecracker runs as an unprivileged user under its own seccomp filter; the
  container holds only `NET_ADMIN SETUID SETGID CHOWN KILL`, `/dev/kvm` and
  `/dev/net/tun`, with no-new-privileges.
- Network is off unless the notebook allows destinations (palette → "Sandbox"):
  then TCP to those `host:port`s only, refused otherwise, never to the container
  or to link-local (cloud metadata), and no DNS inside (names are resolved when
  the kernel starts). Each VM's tap lives in the container's network namespace.
- vCPUs and memory are per notebook (default 2 and 2 GB).

`bun scripts/vm-smoke.ts`, run inside the image, boots a VM and checks all of it.

`BASALT_BIN`, `QUERIER_PYTHON`, `QUERIER_CONFIG_DIR` and `QUERIER_MAX_ROWS` (default 1,000,000; a SQL
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
- `web/` is the Svelte 5 UI: Monaco (VS Code's editor) with Shiki's TextMate grammars for the code (Svelte, Python, Markdown, and basalt's own in `lib/basalt-grammar.ts`), a virtualized Arrow table.

## License

Apache License 2.0: see [LICENSE](LICENSE) and [NOTICE](NOTICE).
