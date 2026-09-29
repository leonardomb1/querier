// A sysadmin password's hash for .env:  bun server/auth/hash.ts
// At a terminal it asks for the password twice, without showing it; piped in
// (printf %s "$P" | bun server/auth/hash.ts) it reads stdin. Either way the
// password stays out of the shell's history.
import { spawnSync } from "node:child_process";

/** A line from the terminal, typed without it showing. */
async function hidden(prompt: string): Promise<string> {
  process.stderr.write(prompt);
  const echo = (on: boolean) => spawnSync("stty", [on ? "echo" : "-echo"], { stdio: ["inherit", "ignore", "ignore"] });
  echo(false);
  try {
    for await (const line of console) return line;
    return "";
  } finally {
    echo(true);
    process.stderr.write("\n");
  }
}

let password: string;
if (process.stdin.isTTY) {
  password = await hidden("New sysadmin password: ");
  if (password && (await hidden("Again: ")) !== password) {
    console.error("They don't match: nothing changed.");
    process.exit(1);
  }
} else password = (await Bun.stdin.text()).replace(/\r?\n$/, "");

if (!password) {
  console.error("No password given: nothing changed.");
  process.exit(1);
}
if (password.length < 12) console.error("(Under 12 characters: consider a longer one.)");
// base64: a hash's $ signs would be expanded by .env readers (Bun's, Compose's)
console.log(`QUERIER_ADMIN_PASSWORD_HASH=b64:${Buffer.from(await Bun.password.hash(password)).toString("base64")}`);
