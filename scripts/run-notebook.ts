// Run every cell of a notebook in a fresh session and print what came back.
//   bun scripts/run-notebook.ts notebooks/demo [-p key=value ...]

import { loadNotebook } from "../server/notebook";
import { LocalRunner } from "../server/runner/local";

const args = process.argv.slice(2);
const dir = args.find((a, i) => !a.startsWith("-") && args[i - 1] !== "-p");
if (!dir) {
  console.error("usage: bun scripts/run-notebook.ts <notebook-dir> [-p key=value ...]");
  process.exit(2);
}
const params: Record<string, string> = {};
args.forEach((a, i) => {
  if (a === "-p") {
    const [k, ...v] = args[i + 1].split("=");
    params[k] = v.join("=");
  }
});

const nb = await loadNotebook(dir);
const session = await new LocalRunner().open({ notebookDir: nb.dir });
let failed = false;
try {
  for (const { file, name, lang, source } of nb.cells) {
    if (lang === "md") continue;
    for await (const ev of session.run({ name, lang, source }, params)) {
      switch (ev.type) {
        case "stream":
          process.stdout.write(ev.text.replace(/^/gm, `  ${ev.stream} | `));
          break;
        case "table":
          console.log(`  table ${ev.name ?? "(unnamed)"}: ${ev.rows}${ev.capped ? "+" : ""} rows × ${ev.columns.length} cols ` +
            `[${ev.columns.map((c) => `${c.name}:${c.type}`).join(", ")}]`);
          break;
        case "display":
          console.log(`  display ${ev.mime} (${ev.data.length} bytes)`);
          break;
        case "progress":
          console.log(`  … ${ev.target}: ${ev.rows} rows`);
          break;
        case "error":
          console.log(`  error${ev.line ? ` at ${ev.line}:${ev.col ?? 1}` : ""}: ${ev.message}`);
          break;
        case "done":
          console.log(`${ev.ok ? "ok  " : "FAIL"} ${file} (${ev.ms}ms)`);
          failed ||= !ev.ok;
      }
    }
    if (failed) break;
  }
} finally {
  await session.close();
}
process.exit(failed ? 1 : 0);
