// Querier as an MCP server: AI clients (Claude Code, Claude Desktop, ...) read,
// run and edit notebooks through the same paths as the UI, so open tabs follow
// along. Stateless Streamable HTTP: one McpServer per request.
//
// Every call is checked against the notebook's access level (access.ts).
// Credentials never leave: kernels get their owner's connections as environment
// variables, and whatever a cell prints is masked on the way out, as it is for the browser.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resolve } from "node:path";
import { z } from "zod";
import { edges, freshness } from "../../shared/graph";
import { reportBlocks, WIDTHS, PARTS, type Block } from "../../shared/report";
import type { Host } from "../host";
import type { Lang } from "../notebook";
import { NotFound, UserError, type Store } from "../store";
import { checkCli } from "../check";
import { buildTemplate } from "../template";
import { allows, LEVELS, type Access, type ClientInfo, type Level } from "./access";
import { renderEvents, type Content } from "./render";

export interface Ctx {
  store: Store;
  access: Access;
  /** The token owner's host of the notebook (their own kernel), opened if need be (it doesn't start a kernel). */
  host(nb: string): Host;
  /** The npm packages the notebook's templates may import (its environments). */
  templatePackages?(nb: string): Promise<import("../template").TemplatePackages>;
  /** Everyone's hosts of the notebook: a cell renamed or deleted reaches each kernel. */
  hosts(nb: string): Host[];
  /** The notebook's files changed: open tabs reload them. */
  changed(nb: string): void;
  /** This client acted on a notebook (a cell it changed, and where, or ran): whoever has it open sees it there. */
  activity?(nb: string, cell: string | null, offset?: number): void;
  /** May the token's owner do `action` to notebook `nb` (their roles, shares and policies)? */
  may(nb: string, action: "notebook.view" | "notebook.readCode" | "notebook.run" | "notebook.edit"): Promise<boolean>;
}

/** What the owner may do in a notebook, as an AI level: the most a token of theirs can reach there. */
async function ownerLevel(ctx: Ctx, nb: string): Promise<Level> {
  if (await ctx.may(nb, "notebook.edit")) return "edit";
  if (await ctx.may(nb, "notebook.run")) return "run";
  if ((await ctx.may(nb, "notebook.view")) && (await ctx.may(nb, "notebook.readCode"))) return "read";
  return "off";
}
/** The lower of two levels. */
const lower = (a: Level, b: Level): Level => (LEVELS.indexOf(a) < LEVELS.indexOf(b) ? a : b);

const INSTRUCTIONS = `Querier is a BI notebook on basalt, a SQL-driven data engine.

Notebooks live in workspaces (folders of notebooks that share connections, sandbox defaults and an AI access default); a notebook's id is "workspace/notebook". A notebook is a folder of cells run in order: SQL (basalt's dialect), Python (polars) and Markdown.
- A SQL cell's result is a table named after the cell; later SQL cells read it with FROM <cell>, and Python cells see it as a polars DataFrame of that name.
- A Python cell's DataFrames (and its last expression, named after the cell) are tables later SQL cells can query by name.
- CREATE CONNECTION, PARAM and LET in a SQL cell hold for every later cell. $name reads a PARAM.
- Running a cell first runs the stale cells it depends on.
- basalt SQL is not standard SQL (PUSHDOWN, conn.QUERY($$...$$), IDENTIFIER(), LOAD INTO, FOR EACH ROW OF, ...). Call basalt_reference before writing non-trivial SQL, and check_sql before saving it.
- Credentials are Connections, handed to the kernel as environment variables (those the token's owner may use, with their own credentials where a connection is per person): a connection named sr reads SR_USER / SR_PASS, OPTIONS can say token = env('GH_TOKEN'), Python reads os.environ. Never write a password into a cell, and never ask for one; ask the user to add a connection in Querier (or, for a per-person one, to enter their own credentials there).
- Each notebook has an AI access level set by its owner: read (code, dependencies, schemas, errors; no rows), run (also runs cells and queries and sees results), edit (also changes cells and the report). A call beyond it fails; say so rather than working around it.
- A report can instead be a Svelte 5 template (write_report_template), for layouts the blocks can't express: KPI tiles, custom HTML around the cells' outputs. To change part of one, edit_report_template, as edit_cell does a cell's.
- Every notebook is also a report: its cells in order with code hidden, markdown as prose, and controls for its PARAMs. By default it shows markdown and the cells no other cell reads; set_report lays it out as blocks: any order, widths in twelfths, the parts of a cell's output to show, titles, and text of the report's own. Charts are Altair in Python cells. An Altair selection named after a PARAM (alt.selection_point(name="region", fields=["region"])) sets that PARAM when clicked in the report.`;

const text = (t: string): { content: Content[] } => ({ content: [{ type: "text", text: t }] });
const fail = (t: string) => ({ content: [{ type: "text" as const, text: t }], isError: true });

class Denied extends Error {}

const DOCS = [process.env.QUERIER_BASALT_DOCS, "/opt/querier/basalt-language.md", resolve(import.meta.dir, "../../../basalt/language.md")].filter(Boolean) as string[];

async function docs(): Promise<string | null> {
  for (const p of DOCS) {
    const f = Bun.file(p);
    if (await f.exists()) return f.text();
  }
  return null;
}

/** language.md as sections, by its ## and ### headings. */
function sections(md: string) {
  const out: { title: string; depth: number; body: string }[] = [];
  let cur = { title: "Introduction", depth: 1, body: "" };
  let fence = false;
  for (const line of md.split("\n")) {
    if (line.startsWith("```")) fence = !fence;
    const m = !fence && /^(#{2,3})\s+(.*)$/.exec(line);
    if (m) {
      out.push(cur);
      cur = { title: m[2], depth: m[1].length, body: "" };
    }
    cur.body += line + "\n";
  }
  out.push(cur);
  return out;
}


/** Find-and-replace edits, as edit_cell and edit_report_template take them. */
const editsArg = (what: string) =>
  z
    .array(
      z.object({
        old: z.string().min(1).describe(`Text to find, exactly as in ${what}`),
        new: z.string().describe("Its replacement"),
        all: z.boolean().optional().describe("Replace every occurrence (default: exactly one)"),
      }),
    )
    .min(1);

/** Apply edits in order, all or nothing: each `old` must occur once (or `all`). The lines changed, for an excerpt. */
export function applyEdits(source: string, edits: { old: string; new: string; all?: boolean }[], what: string): { src: string; changed: number[]; at: number } {
  let src = source;
  const changed: number[] = [];
  let first = -1;
  edits.forEach((e, i) => {
    const n = src.split(e.old).length - 1;
    const which = edits.length > 1 ? `Edit ${i + 1}: ` : "";
    if (n === 0) throw new Error(`${which}\`old\` isn't in ${what} (after the edits before it). Nothing was changed.`);
    if (n > 1 && !e.all) throw new Error(`${which}\`old\` occurs ${n} times in ${what}: add context to make it unique, or set \`all\`. Nothing was changed.`);
    const at = src.indexOf(e.old);
    src = e.all ? src.split(e.old).join(e.new) : src.slice(0, at) + e.new + src.slice(at + e.old.length);
    changed.push(src.slice(0, at).split("\n").length);
    if (first < 0) first = at + e.new.length;
  });
  return { src, changed, at: Math.max(0, first) };
}

/** The changed lines with a little context, numbered, so the next edit can aim. */
function excerpt(src: string, changed: number[]): string {
  const lines = src.split("\n");
  const shown = new Set<number>();
  for (const l of changed) for (let k = Math.max(1, l - 2); k <= Math.min(lines.length, l + 4); k++) shown.add(k);
  let prev = 0;
  const out: string[] = [];
  for (const k of [...shown].sort((a, b) => a - b)) {
    if (prev && k > prev + 1) out.push("…");
    out.push(`${String(k).padStart(4)}  ${lines[k - 1]}`);
    prev = k;
  }
  return out.join("\n");
}

export function mcpServer(ctx: Ctx, client: ClientInfo): McpServer {
  const server = new McpServer({ name: "querier", version: "0.1.0" }, { instructions: INSTRUCTIONS });
  const { store, access } = ctx;

  /** The notebook, if this call's level allows it. */
  async function open(nb: string, need: Exclude<Level, "off">, tool: string) {
    store.dir(nb); // validates the name
    const have = await access.level(nb);
    const mine = await ownerLevel(ctx, nb);
    // the token's owner can't see it either: it doesn't exist, as far as this client knows
    if (have === "off" || mine === "off") throw new Denied(`There is no notebook \`${nb}\` available to this client.`);
    if (!allows(have, need))
      throw new Denied(`\`${tool}\` needs ${need} access to \`${nb}\`, which has ${have}. Its owner can change that in Querier (notebook menu → AI access).`);
    if (!allows(mine, need)) throw new Denied(`\`${tool}\` needs ${need} access to \`${nb}\`; this token's owner has ${mine} there.`);
    return lower(have, mine);
  }

  // every handler: failures come back as tool errors the model can read
  const tool = <A extends z.ZodRawShape>(
    name: string,
    meta: { title: string; description: string; readOnly?: boolean; destructive?: boolean },
    args: A,
    fn: (a: z.infer<z.ZodObject<A>>) => Promise<{ content: Content[] }>,
  ) =>
    server.registerTool(
      name,
      {
        title: meta.title,
        description: meta.description,
        inputSchema: args,
        annotations: { readOnlyHint: !!meta.readOnly, destructiveHint: !!meta.destructive, openWorldHint: false },
      },
      (async (a: any) => {
        try {
          return await fn(a);
        } catch (e: any) {
          // a plain Error is a message for the model; anything else is a bug here
          if (!(e instanceof Denied) && e?.constructor !== Error && !(e instanceof UserError) && !(e instanceof NotFound))
            console.error(`mcp ${name} (${client.name}):`, e);
          return fail(String(e?.message ?? e));
        }
      }) as any,
    );

  const nbArg = z.string().describe('Notebook id, "workspace/notebook", as list_notebooks gives it.');
  const paramsArg = z.record(z.string(), z.string()).optional().describe("PARAM values by name; unset ones take their DEFAULT.");

  // -- reading

  tool(
    "list_notebooks",
    { title: "List notebooks", description: "Every notebook available to AI clients: name, title, description, cell counts, and this client's access to it.", readOnly: true },
    {},
    async () => {
      const lines: string[] = [];
      for (const n of await store.list()) {
        // what this client may reach: the notebook's AI level, and no more than its owner
        const level = lower(await access.level(n.id), await ownerLevel(ctx, n.id));
        if (level === "off") continue;
        lines.push(
          `- ${n.id}: ${n.title}${n.description ? ` — ${n.description}` : ""} (${n.sql} SQL, ${n.python} Python, ${n.text} text; access: ${level})${n.problem ? ` [does not load: ${n.problem}]` : ""}`,
        );
      }
      return text(lines.length ? lines.join("\n") : "No notebooks are available to AI clients.");
    },
  );

  tool(
    "list_cells",
    {
      title: "List a notebook's cells",
      description:
        "The cells in order, one line each: name, language, size, whether it is fresh, stale or never run (or failed), and what it defines and reads. No sources or outputs: read_notebook has those, get_output a cell's rows. The names are what the other tools (edit_cell, delete_cell, run_cells…) take.",
      readOnly: true,
    },
    { notebook: nbArg },
    async ({ notebook }) => {
      await open(notebook, "read", "list_cells");
      const h = ctx.host(notebook);
      await h.analyzeNow();
      const book = await store.load(notebook);
      const snap = h.snapshot();
      const order = book.cells.map((c) => c.name);
      const up = edges(order, snap.deps);
      const ran = Object.fromEntries([...snap.outputs].map(([k, o]) => [k, o.ran]));
      const sources = Object.fromEntries(book.cells.map((c) => [c.name, c.source]));
      const code = new Set(book.cells.filter((c) => c.lang !== "md").map((c) => c.name));
      const fresh = freshness(order, up, snap.deps, ran, sources, {}, code);
      if (!book.cells.length) return text(`\`${notebook}\` has no cells.`);
      const lines = book.cells.map((c, i) => {
        const o = snap.outputs.get(c.name);
        const d = snap.deps[c.name];
        const n = c.source.split("\n").filter((l, k, all) => l || k < all.length - 1).length;
        const size = `${n} line${n === 1 ? "" : "s"}`;
        const state = c.lang === "md" ? "" : `, ${o?.state === "error" ? "failed" : o?.state === "running" || o?.state === "queued" ? o.state : fresh[c.name]}`;
        const reads = d?.reads.filter((r) => !r.startsWith("fn:")) ?? [];
        const deps = c.lang === "md" || !d ? "" : `; defines ${d.defines.join(", ") || "—"}; reads ${reads.join(", ") || "—"}`;
        return `${i + 1}. ${c.name} (${c.lang}, ${size}${state})${deps}`;
      });
      return text(`${book.title} (\`${notebook}\`), ${book.cells.length} cell${book.cells.length === 1 ? "" : "s"}${book.template != null ? ", and report.svelte" : ""}:\n${lines.join("\n")}`);
    },
  );

  tool(
    "read_notebook",
    {
      title: "Read a notebook",
      description:
        "A notebook's cells in order: source, what each defines and reads, whether it is fresh, and its last output's shape (result columns and row counts, errors). Also its PARAMs, data files and how it reads as a report. Rows are left out: get_output shows them.",
      readOnly: true,
    },
    { notebook: nbArg },
    async ({ notebook }) => {
      const level = await open(notebook, "read", "read_notebook");
      const h = ctx.host(notebook);
      await h.analyzeNow();
      const book = await store.load(notebook);
      const snap = h.snapshot();
      const order = book.cells.map((c) => c.name);
      const up = edges(order, snap.deps);
      const ran = Object.fromEntries([...snap.outputs].map(([k, o]) => [k, o.ran]));
      const sources = Object.fromEntries(book.cells.map((c) => [c.name, c.source]));
      const code = new Set(book.cells.filter((c) => c.lang !== "md").map((c) => c.name));
      const fresh = freshness(order, up, snap.deps, ran, sources, {}, code);
      const out: string[] = [`# ${book.title} (\`${notebook}\`, access: ${level})`];
      if (book.description) out.push(book.description);
      out.push(`Kernel: ${snap.session === "ready" ? `running (${Object.entries(snap.info).map(([k, v]) => `${k} ${v}`).join(", ")})` : "not started"}`);
      if (book.params.length)
        out.push(`PARAMs: ${book.params.map((p) => `$${p.name} ${p.type}${p.default ? ` DEFAULT ${p.default}` : ""} (in ${p.cell})`).join("; ")}`);
      if (book.files.length) out.push(`Data files: ${book.files.join(", ")}`);
      const report = book.report ?? {};
      const blocks = reportBlocks(report, book.cells, up);
      const desc = (b: (typeof blocks)[number]) =>
        `${b.cell ?? "text"}${b.width && b.width !== 12 ? ` ${b.width}/12` : ""}${b.parts ? ` [${b.parts.join("+")}]` : ""}${b.title ? ` “${b.title}”` : ""}`;
      if (book.template != null)
        out.push(`Report template: report.svelte (${book.template.length} characters), shown ${report.view === "blocks" ? "only when chosen: the blocks are shown" : "instead of the blocks"}; read_report_template reads it.`);
      out.push(
        `Report${report.blocks ? "" : " (default layout)"}: ${blocks.map(desc).join(", ") || "empty"}` +
          `${report.refresh ? `; refreshes every ${report.refresh}` : ""}${report.variables ? `; controls ${JSON.stringify(report.variables)}` : ""}`,
      );
      for (const c of book.cells) {
        const o = snap.outputs.get(c.name);
        const d = snap.deps[c.name];
        const state = c.lang === "md" ? "" : ` — ${o?.state === "running" || o?.state === "queued" ? o.state : fresh[c.name]}${o?.ms != null ? `, ${o.ms} ms` : ""}`;
        out.push(`\n## ${c.name} (${c.lang}, ${c.file})${state}`);
        const reads = d?.reads.filter((r) => !r.startsWith("fn:"));
        if (d && c.lang !== "md") out.push(`defines: ${d.defines.join(", ") || "—"}; reads: ${reads!.join(", ") || "—"}`);
        out.push("```" + (c.lang === "python" ? "python" : c.lang) + "\n" + c.source.replace(/\n$/, "") + "\n```");
        if (o?.events.length) {
          const r = renderEvents(o.events, 0, false).filter((x) => x.type === "text");
          if (r.length) out.push(`Output:\n${r.map((x) => (x as any).text).join("\n")}`.replace(/\n*Rows, printed text and visuals are shown at `run` access or above\./, ""));
        }
      }
      return text(out.join("\n"));
    },
  );

  tool(
    "describe",
    {
      title: "Describe a source",
      description:
        "Columns and types of anything a SQL cell can read: a notebook table (a cell's result or a Python DataFrame), a file in the notebook folder, or a connection's conn.schema.table. With `connection` instead, lists that connection's tables (SHOW TABLES). With neither, lists the kernel's tables and declarations. Starts the notebook's kernel if it isn't running; a connection is only known once the cell declaring it has run.",
      readOnly: true,
    },
    {
      notebook: nbArg,
      source: z.string().optional().describe("e.g. `sales`, `data/orders.parquet`, `pg.public.orders`"),
      connection: z.string().optional().describe("A connection (optionally `.schema`) whose tables to list"),
      like: z.string().optional().describe("With `connection`: a LIKE pattern for table names"),
    },
    async ({ notebook, source, connection, like }) => {
      await open(notebook, "read", "describe");
      const h = ctx.host(notebook);
      const NAME = /^[A-Za-z_][\w$]*(\.[A-Za-z_][\w$]*){0,3}$/;
      if (source) {
        const src = NAME.test(source) ? source : /^[\w./-]+$/.test(source) && !source.includes("..") ? `'${source}'` : null;
        if (!src) throw new Error("`source` must be a name (a.b.c) or a relative file path.");
        const r = await h.describe(`DESCRIBE ${src};`);
        if (r.error) throw new Error(r.error);
        return text(r.rows.map((row) => `${row[0]} ${row[1]}${row[2] === false ? " NOT NULL" : ""}`).join("\n") || "(no columns)");
      }
      if (connection) {
        if (!NAME.test(connection)) throw new Error("`connection` must be a name, or name.schema.");
        const pat = like ? ` LIKE '${like.replace(/'/g, "''")}'` : "";
        const r = await h.describe(`SHOW TABLES FROM ${connection}${pat};`);
        if (r.error) throw new Error(r.error);
        return text([r.columns.join("\t"), ...r.rows.slice(0, 1000).map((x) => x.join("\t"))].join("\n"));
      }
      const { namespace, session } = h.snapshot();
      if (session !== "ready") return text("The kernel isn't running, so it holds no tables yet. Run cells (run_cells) or describe a source by name.");
      const lines = namespace.tables.map((t) => `- ${t.name}: ${t.rows.toLocaleString("en")} rows; ${t.columns.map((c) => `${c.name} ${c.type}`).join(", ")}`);
      const decl = namespace.declared.map((d) => `- ${d.kind} ${d.name}`);
      return text([`Tables:`, ...(lines.length ? lines : ["(none)"]), `Declared:`, ...(decl.length ? decl : ["(none)"])].join("\n"));
    },
  );

  tool(
    "check_sql",
    {
      title: "Check basalt SQL",
      description:
        "Validate basalt SQL without running it: every parse and name error, with its line and column. With `notebook`, against that notebook: its cells' tables (with their real columns once they have run), connections, PARAMs and LETs.",
      readOnly: true,
    },
    { source: z.string(), notebook: nbArg.optional() },
    async ({ source, notebook }) => {
      let diags;
      if (notebook) {
        await open(notebook, "read", "check_sql");
        const h = ctx.host(notebook);
        await h.analyzeNow();
        diags = await h.check(source);
      } else diags = await checkCli(source, [], new Set());
      if (!diags.length) return text("OK: no problems found.");
      return text(diags.map((d) => `${d.level} at line ${d.line}, col ${d.col}${d.end_col ? `-${d.end_col}` : ""}: ${d.msg}`).join("\n"));
    },
  );

  tool(
    "basalt_reference",
    {
      title: "basalt SQL reference",
      description:
        "basalt's language reference (language.md). Without `topic`, its table of contents; with one, the sections whose title (or else text) matches, e.g. `connections`, `LOAD INTO`, `window functions`, `FOR EACH`, `DESCRIBE`.",
      readOnly: true,
    },
    { topic: z.string().optional() },
    async ({ topic }) => {
      const md = await docs();
      if (!md) throw new Error("basalt's language reference isn't installed with this server (set QUERIER_BASALT_DOCS).");
      const all = sections(md);
      if (!topic) return text(all.map((s) => `${s.depth === 3 ? "  " : ""}- ${s.title}`).join("\n"));
      const t = topic.toLowerCase();
      let hit = all.filter((s) => s.title.toLowerCase().includes(t));
      // a ## section brings its ### sections along
      if (hit.length === 1 && hit[0].depth === 2) {
        const i = all.indexOf(hit[0]);
        for (let j = i + 1; j < all.length && all[j].depth === 3; j++) hit.push(all[j]);
      }
      if (!hit.length) hit = all.filter((s) => s.body.toLowerCase().includes(t)).slice(0, 3);
      if (!hit.length) return text(`Nothing in the reference matches “${topic}”. Call without a topic for the contents.`);
      let body = hit.map((s) => s.body.trim()).join("\n\n");
      if (body.length > 16000) body = `${body.slice(0, 16000)}\n… (cut: ask for a narrower topic)`;
      return text(body);
    },
  );

  // -- running

  tool(
    "get_output",
    { title: "Get a cell's output", description: "A cell's last output in full: result rows, what it printed, its visuals (images come back as images).", readOnly: true },
    { notebook: nbArg, cell: z.string(), rows: z.number().int().min(1).max(500).optional().describe("Rows to show (default 20)") },
    async ({ notebook, cell, rows }) => {
      await open(notebook, "run", "get_output");
      const o = ctx.host(notebook).snapshot().outputs.get(cell);
      if (!o) return text(`\`${cell}\` hasn't run in this kernel.`);
      const r = renderEvents(o.events, rows ?? 20);
      return { content: [{ type: "text", text: `${cell}: ${o.state}${o.ms != null ? `, ${o.ms} ms` : ""}` }, ...r] };
    },
  );

  tool(
    "run_cells",
    {
      title: "Run cells",
      description:
        "Run cells, each after the stale cells it depends on (as the Run button does), and return their outputs. Open Querier tabs show the run. Returns early if it takes longer than wait_seconds; the run goes on and get_output reads it later.",
    },
    {
      notebook: nbArg,
      cells: z.array(z.string()).min(1).describe("Cell names; e.g. every cell to run the whole notebook"),
      params: paramsArg,
      rows: z.number().int().min(0).max(200).optional().describe("Rows of each result to show (default 10)"),
      wait_seconds: z.number().int().min(1).max(600).optional().describe("Default 60"),
    },
    async ({ notebook, cells, params, rows, wait_seconds }) => {
      await open(notebook, "run", "run_cells");
      const h = ctx.host(notebook);
      ctx.activity?.(notebook, cells.at(-1) ?? null);
      const { cells: ran, finished } = await h.runAndWait(cells, params ?? {}, (wait_seconds ?? 60) * 1000);
      if (!ran.length) return text("Nothing to run: those are Markdown cells.");
      const outputs = h.snapshot().outputs;
      const content: Content[] = [{ type: "text", text: finished ? `Ran ${ran.join(", ")}.` : `Still running after ${wait_seconds ?? 60}s (${ran.join(", ")}); call get_output later.` }];
      for (const c of ran) {
        const o = outputs.get(c);
        content.push({ type: "text", text: `## ${c}: ${o?.state ?? "not run"}${o?.ms != null && o.state !== "running" ? `, ${o.ms} ms` : ""}` });
        if (o && o.state !== "queued" && o.state !== "idle") content.push(...renderEvents(o.events, rows ?? 10));
      }
      return { content };
    },
  );

  tool(
    "run_query",
    {
      title: "Run a scratch query",
      description:
        "Run SQL or Python in the notebook's kernel without adding a cell, to explore: it sees every table and declaration the notebook's cells made. Nothing is saved; a Python snippet's variables do stay in the kernel.",
    },
    {
      notebook: nbArg,
      lang: z.enum(["sql", "python"]),
      source: z.string(),
      params: paramsArg,
      rows: z.number().int().min(0).max(500).optional().describe("Rows to show (default 20)"),
    },
    async ({ notebook, lang, source, params, rows }) => {
      await open(notebook, "run", "run_query");
      const r = await ctx.host(notebook).scratch(lang, source, params ?? {});
      return { content: [{ type: "text", text: `${r.ok ? "ok" : "failed"}, ${r.ms} ms` }, ...renderEvents(r.events, rows ?? 20)] };
    },
  );

  // -- editing

  tool(
    "write_cell",
    {
      title: "Write a cell",
      description:
        "Replace a cell's whole source, or add a cell when none has that name (after `after`, or at the end). To change part of a cell, edit_cell is cheaper. Open tabs reload it. Doesn't run it: run_cells does.",
    },
    {
      notebook: nbArg,
      cell: z.string().regex(/^[A-Za-z_]\w*$/).describe("Cell name: a SQL cell's result table and a Python cell's name"),
      source: z.string(),
      lang: z.enum(["sql", "python", "md"]).optional().describe("Required for a new cell; changes an existing cell's language"),
      after: z.string().optional().describe("For a new cell: the cell it goes after; omit for the end"),
    },
    async ({ notebook, cell, source, lang, after }) => {
      await open(notebook, "edit", "write_cell");
      const book = await store.load(notebook);
      const cur = book.cells.find((c) => c.name === cell);
      if (cur) {
        if (lang && lang !== cur.lang) await store.setLang(notebook, cell, lang as Lang);
        await store.save(notebook, cell, source);
        ctx.changed(notebook);
        ctx.activity?.(notebook, cell, source.length);
        return text(`Saved \`${cell}\`.`);
      }
      if (!lang) throw new Error(`There's no cell \`${cell}\`; give \`lang\` to add one.`);
      if (after && !book.cells.some((c) => c.name === after)) throw new Error(`There's no cell \`${after}\`.`);
      await store.add(notebook, lang as Lang, after ?? book.cells.at(-1)?.name ?? null, source, cell);
      ctx.changed(notebook);
      ctx.activity?.(notebook, cell, source.length);
      return text(`Added \`${cell}\`${after ? ` after \`${after}\`` : " at the end"}.`);
    },
  );

  tool(
    "edit_cell",
    {
      title: "Edit a cell",
      description:
        "Change part of a cell: each edit replaces `old` with `new`, exactly as written (whitespace included), in order. `old` must occur once, unless `all` is set. Either every edit applies or none does. Cheaper and safer than rewriting the cell with write_cell.",
    },
    {
      notebook: nbArg,
      cell: z.string(),
      edits: editsArg("the cell"),
    },
    async ({ notebook, cell, edits }) => {
      await open(notebook, "edit", "edit_cell");
      const cur = (await store.load(notebook)).cells.find((c) => c.name === cell);
      if (!cur) throw new Error(`There's no cell \`${cell}\`.`);
      const { src, changed, at } = applyEdits(cur.source, edits, `\`${cell}\``);
      if (src === cur.source) return text(`\`${cell}\` is unchanged.`);
      await store.save(notebook, cell, src);
      ctx.changed(notebook);
      ctx.activity?.(notebook, cell, at);
      return text(`Edited \`${cell}\` (${edits.length} edit${edits.length === 1 ? "" : "s"}):\n${excerpt(src, changed)}`);
    },
  );

  tool(
    "rename_cell",
    { title: "Rename a cell", description: "Rename a cell; the cells below that read it by name are rewritten to follow." },
    { notebook: nbArg, cell: z.string(), to: z.string().regex(/^[A-Za-z_]\w*$/) },
    async ({ notebook, cell, to }) => {
      await open(notebook, "edit", "rename_cell");
      const updated = await store.rename(notebook, cell, to);
      for (const h of ctx.hosts(notebook)) await h.renamed(cell, to);
      ctx.changed(notebook);
      ctx.activity?.(notebook, to);
      return text(`Renamed \`${cell}\` to \`${to}\`${updated.length ? `; updated ${updated.join(", ")}` : ""}.`);
    },
  );

  tool(
    "move_cell",
    { title: "Move a cell", description: "Move a cell to just after another (or to the top with after = null)." },
    { notebook: nbArg, cell: z.string(), after: z.string().nullable() },
    async ({ notebook, cell, after }) => {
      await open(notebook, "edit", "move_cell");
      const order = (await store.load(notebook)).cells.map((c) => c.name);
      const from = order.indexOf(cell);
      if (from < 0) throw new Error(`There's no cell \`${cell}\`.`);
      const rest = order.filter((n) => n !== cell);
      const at = after == null ? 0 : rest.indexOf(after) + 1;
      if (after != null && at === 0) throw new Error(`There's no cell \`${after}\`.`);
      if (at !== from) await store.move(notebook, cell, at - from);
      ctx.changed(notebook);
      ctx.activity?.(notebook, cell);
      return text(`Moved \`${cell}\`${after ? ` after \`${after}\`` : " to the top"}.`);
    },
  );

  tool(
    "delete_cell",
    {
      title: "Delete a cell",
      description: "Delete a cell (by its name, as list_cells gives it) and its file. If the notebook is under git, the deletion shows as a change until committed.",
      destructive: true,
    },
    { notebook: nbArg, cell: z.string() },
    async ({ notebook, cell }) => {
      await open(notebook, "edit", "delete_cell");
      await store.remove(notebook, cell);
      for (const h of ctx.hosts(notebook)) await h.removed(cell);
      ctx.changed(notebook);
      ctx.activity?.(notebook, null);
      return text(`Deleted \`${cell}\`.`);
    },
  );

  tool(
    "read_report_template",
    { title: "Read the report template", description: "The notebook's report.svelte, if it has one, and whether it builds.", readOnly: true },
    { notebook: nbArg },
    async ({ notebook }) => {
      await open(notebook, "read", "read_report_template");
      const source = await store.template(notebook);
      if (source == null) return text("This notebook has no report template; its report is laid out as blocks (set_report).");
      const b = await buildTemplate(source, await ctx.templatePackages?.(notebook));
      return text(`${b.error ? `It doesn't build: ${b.error.line ? `line ${b.error.line}${b.error.col ? `:${b.error.col}` : ""}: ` : ""}${b.error.message}\n\n` : ""}\`\`\`svelte\n${source}\n\`\`\``);
    },
  );

  tool(
    "write_report_template",
    {
      title: "Write the report template",
      description: `Write the notebook's report as a Svelte 5 template (report.svelte), shown instead of the blocks layout. It runs sandboxed in the viewer's browser and may import only "svelte" and "querier":
  import { Output, Chart, Table, Value, Control, setParam } from "querier";
  let { cells, params } = $props();     // cells.<cell>.rows (plain objects, up to 5,000), .columns, .rowCount, .state, .text, .error; params.<name>
  <Output cell="x" parts={["chart"]} />  a cell's output: all, or some of chart / table / text
  <Chart cell="x" />   <Table cell="x" columns={["a", "b"]} />
  <Value cell="x" column="revenue" row={0} label="Revenue" format="number|currency|percent|compact" currency="BRL" decimals={0} compare={1} />
  <Control param="region" options={["north", "south"]} />   or setParam("region", value) from your own markup
The app's theme is there as CSS variables (--ink, --ink-2, --muted, --surface, --hair, --accent, --sans, --mono) in light and dark; use them rather than fixed colours. Returns the build's errors, with line and column, so they can be fixed. To change part of an existing template, edit_report_template is cheaper.`,
    },
    { notebook: nbArg, source: z.string() },
    async ({ notebook, source }) => {
      await open(notebook, "edit", "write_report_template");
      await store.saveTemplate(notebook, source);
      ctx.activity?.(notebook, null);
      const book = await store.load(notebook);
      if (book.report?.view === "blocks") await store.settings(notebook, { report: { ...book.report, view: "template" } });
      ctx.changed(notebook);
      const b = await buildTemplate(source, await ctx.templatePackages?.(notebook));
      return b.error
        ? fail(`Saved, but it doesn't build: ${b.error.line ? `line ${b.error.line}${b.error.col ? `:${b.error.col}` : ""}: ` : ""}${b.error.message}`)
        : text(`Saved report.svelte; it builds, and the report shows it.`);
    },
  );

  tool(
    "edit_report_template",
    {
      title: "Edit the report template",
      description:
        "Change part of report.svelte, as edit_cell does a cell's: each edit replaces `old` with `new`, exactly as written (whitespace included), in order. `old` must occur once, unless `all` is set. Either every edit applies or none does. Cheaper and safer than rewriting it with write_report_template. Returns the changed lines, numbered, and the build's errors with line and column.",
    },
    { notebook: nbArg, edits: editsArg("report.svelte") },
    async ({ notebook, edits }) => {
      await open(notebook, "edit", "edit_report_template");
      const cur = await store.template(notebook);
      if (cur == null) throw new Error("This notebook has no report template: write one with write_report_template.");
      const { src, changed } = applyEdits(cur, edits, "report.svelte");
      if (src === cur) return text("report.svelte is unchanged.");
      await store.saveTemplate(notebook, src);
      ctx.changed(notebook);
      ctx.activity?.(notebook, null);
      const b = await buildTemplate(src, await ctx.templatePackages?.(notebook));
      const lines = `Edited report.svelte (${edits.length} edit${edits.length === 1 ? "" : "s"}):\n${excerpt(src, changed)}`;
      return b.error
        ? fail(`${lines}\n\nSaved, but it doesn't build: ${b.error.line ? `line ${b.error.line}${b.error.col ? `:${b.error.col}` : ""}: ` : ""}${b.error.message}`)
        : text(`${lines}\n\nIt builds, and the report shows it.`);
    },
  );

  tool(
    "set_report",
    {
      title: "Lay out the report",
      description: `Set how the notebook reads as a report. \`blocks\` replaces the layout: a list, in order, of
{ id, cell?, text?, width?, parts?, title?, caption? } — a block shows a cell's output (cell) or markdown of the report's own (text);
width is in twelfths of the row (${WIDTHS.join(", ")}; default 12), consecutive blocks share a row while they fit;
parts picks what of the output shows (${PARTS.join(", ")}; default all: charts are Altair/matplotlib, table the result table or Great Tables, text what the cell printed);
the same cell may appear in several blocks (its chart here, its table there). null for blocks returns to the default layout
(markdown and the cells nothing reads). \`refresh\` re-runs the report while open (30s, 1m, 5m, 15m, 1h; null for off).
\`variables\` sets how a PARAM shows: { control: text | select | time, source?: { cell, column? } | { values: [..] } }; null for the default.
Omitted fields stay as they are; read_notebook shows the current layout.`,
    },
    {
      notebook: nbArg,
      blocks: z
        .array(
          z.object({
            id: z.string(),
            cell: z.string().optional(),
            text: z.string().optional(),
            width: z.number().int().optional(),
            parts: z.array(z.enum(PARTS as [string, ...string[]])).optional(),
            title: z.string().optional(),
            caption: z.string().optional(),
          }),
        )
        .nullable()
        .optional(),
      refresh: z.enum(["30s", "1m", "5m", "15m", "1h"]).nullable().optional(),
      variables: z.record(z.string(), z.any().nullable()).optional(),
    },
    async ({ notebook, blocks, refresh, variables }) => {
      await open(notebook, "edit", "set_report");
      const book = await store.load(notebook);
      const names = new Set(book.cells.map((c) => c.name));
      const bad = (blocks ?? []).filter((b) => b.cell && !names.has(b.cell)).map((b) => b.cell);
      if (bad.length) throw new Error(`No such cells: ${[...new Set(bad)].join(", ")}`);
      const r = structuredClone(book.report ?? {});
      if (blocks === null) delete r.blocks;
      else if (blocks) {
        r.blocks = blocks as Block[];
        delete r.show;
        delete r.half;
      }
      if (refresh !== undefined) (refresh ? (r.refresh = refresh) : delete r.refresh);
      if (variables) {
        r.variables = { ...(r.variables ?? {}) };
        for (const [k, v] of Object.entries(variables)) if (v == null) delete r.variables[k]; else r.variables[k] = v;
      }
      await store.settings(notebook, { report: r });
      ctx.changed(notebook);
      return text(`Saved the report of \`${notebook}\`.`);
    },
  );

  return server;
}
