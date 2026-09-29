// IntelliSense for Cedar conditions (a grant's "anyone where …", and policies):
// what can come where the cursor is, from the text before it and what the
// server knows people and resources are tagged with (/api/access/vocabulary).
//
//   principal.|                         → hasTag, getTag
//   principal.getTag("department").|    → contains, containsAny, containsAll, isEmpty
//   principal.hasTag("|                 → the tags people have: department, title…
//   ….getTag("department").contains("|  → the values seen: Finance, Sales…
//   principal in Group::"|              → the directory's groups
//   anywhere else                       → principal, resource, and whole conditions to fill in

import type { Suggestion } from "./editor";

export interface CedarVocabulary {
  /** people's tags (directory attributes, claims, username, email…), with values seen */
  tags: Record<string, string[]>;
  groups: string[];
  /** workspaces' and notebooks' tags, with values seen */
  resourceTags: Record<string, string[]>;
  /** writing whole policies (a policy file), not a condition: permit and forbid, actions, workspaces */
  policies?: { actions: string[]; workspaces: string[] };
}

export interface CedarResult {
  /** where the text being completed starts */
  from: number;
  items: Suggestion[];
}

const WHO = { principal: "the person asking", resource: "the workspace or notebook asked for" } as const;

/** Documentation, for hovers and the list. */
export const CEDAR_DOCS: Record<string, string> = {
  principal: "**principal**: the person asking, a `User`. Their directory attributes are tags: `principal.getTag(\"department\")`. Their groups are what they are `in`: `principal in Group::\"finance\"`.",
  resource: "**resource**: what is asked for: a `Workspace`, or a `Notebook` (in its workspace). Their attributes are tags: `resource.getTag(\"classification\")`.",
  context: "**context**: facts about the request itself. Querier passes none yet.",
  action: "**action**: what is being done, as `Action::\"notebook.run\"`.",
  hasTag: "**hasTag(key)** → Bool\n\nWhether the entity has the tag. Put it before every `getTag` of the same key (`&&` stops at the first false): a policy without it is refused, since a missing tag would be an error, and an error is a denial.",
  getTag: "**getTag(key)** → Set<String>\n\nThe tag's values: a set, since a directory attribute can hold several. Test it with `.contains(\"value\")`. Guard it with `hasTag(key) &&`.",
  contains: "**contains(value)** → Bool\n\nWhether the set holds `value`: `principal.getTag(\"department\").contains(\"Finance\")`.",
  containsAny: "**containsAny([a, b])** → Bool\n\nWhether the set holds at least one of the list's values.",
  containsAll: "**containsAll([a, b])** → Bool\n\nWhether the set holds every one of the list's values.",
  isEmpty: "**isEmpty()** → Bool\n\nWhether the set has no values.",
  in: "**in**: membership. `principal in Group::\"finance\"`: the person is in the group (nested groups count, as the directory resolves them). `resource in Workspace::\"sales\"`: a notebook of that workspace.",
  has: "**has**: whether an entity has an attribute. Querier's attributes are tags: use `hasTag`.",
  like: "**like**: a string matched against a pattern, `*` for any text: `\"alice@corp.com\" like \"*@corp.com\"`.",
  is: "**is**: the entity's type: `resource is Notebook`.",
  if: "**if** c **then** a **else** b: `a` when `c` holds, else `b`.",
  when: "**when { … }**: the policy applies only if the condition holds.",
  unless: "**unless { … }**: the policy applies only if the condition doesn't hold.",
  permit: "**permit**: allows what its scope and conditions match, unless a `forbid` also matches.",
  forbid: "**forbid**: denies what its scope and conditions match, over any `permit`.",
  Group: "**Group**: a directory group (AD, Entra, Keycloak), by name: `Group::\"finance\"`.",
  User: "**User**: a person, by id `provider:subject`.",
  Workspace: "**Workspace**: a workspace, by its folder name.",
  Notebook: "**Notebook**: a notebook, by `workspace/notebook`.",
};

const quote = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
/** A snippet's text: $, } and \ escaped. */
const lit = (s: string) => s.replace(/[\\$}]/g, "\\$&");
/** A snippet's tab stop `n`: a choice of `values`, or `fallback` to type over. */
const choice = (values: string[], fallback: string, n = 2) =>
  values.length ? `\${${n}|${values.slice(0, 30).map((v) => quote(v).replace(/[,|\\$}]/g, "\\$&")).join(",")}|}` : `\${${n}:${lit(fallback)}}`;

/** The string the cursor is inside, if it is: where it opens. */
function openString(before: string): number | null {
  let open: number | null = null;
  for (let i = 0; i < before.length; i++) {
    const c = before[i];
    if (open != null && c === "\\") i++;
    else if (c === '"') open = open == null ? i : null;
    else if (open == null && c === "/" && before[i + 1] === "/") {
      const nl = before.indexOf("\n", i);
      if (nl < 0) return null;
      i = nl;
    }
  }
  return open;
}

export function cedarComplete(doc: string, pos: number, v: CedarVocabulary): CedarResult | null {
  const before = doc.slice(0, pos);

  // -- inside a string: a tag's name, a tag's value, a group
  const s = openString(before);
  if (s != null) {
    const lead = before.slice(0, s);
    const from = s + 1;
    let m = /\b(principal|resource)\s*\.\s*(hasTag|getTag)\s*\(\s*$/.exec(lead);
    if (m) {
      const tags = m[1] === "principal" ? v.tags : v.resourceTags;
      return {
        from,
        items: Object.entries(tags).map(([k, vals]) => ({
          label: k,
          kind: "property",
          detail: `${m![1] === "principal" ? "person's" : "resource's"} tag`,
          doc: vals.length ? `Seen: ${vals.slice(0, 12).map((x) => `\`${x}\``).join(", ")}${vals.length > 12 ? "…" : ""}` : undefined,
          insert: quote(k),
        })),
      };
    }
    m = /\b(principal|resource)\s*\.\s*getTag\s*\(\s*"((?:[^"\\]|\\.)*)"\s*\)\s*\.\s*(?:contains|containsAny|containsAll)\s*\(\s*\[?\s*(?:"(?:[^"\\]|\\.)*"\s*,\s*)*$/.exec(lead);
    if (m) {
      const vals = (m[1] === "principal" ? v.tags : v.resourceTags)[m[2]] ?? [];
      return { from, items: vals.map((x) => ({ label: x, kind: "constant", detail: m![2], insert: quote(x) })) };
    }
    if (/\bGroup\s*::\s*$/.test(lead)) return { from, items: v.groups.map((g) => ({ label: g, kind: "class", detail: "group", insert: quote(g) })) };
    if (v.policies && /\bAction\s*::\s*$/.test(lead)) return { from, items: v.policies.actions.map((a) => ({ label: a, kind: "function", detail: "action", insert: quote(a) })) };
    if (v.policies && /\bWorkspace\s*::\s*$/.test(lead)) return { from, items: v.policies.workspaces.map((w) => ({ label: w, kind: "namespace", detail: "workspace", insert: quote(w) })) };
    return null;
  }

  // -- after a dot: an entity's methods, or a set's
  const dot = /(\b[A-Za-z_]\w*|\))\s*\.\s*([A-Za-z_]\w*)?$/.exec(before);
  if (dot) {
    const from = pos - (dot[2]?.length ?? 0);
    if (dot[1] === "principal" || dot[1] === "resource") {
      const tags = Object.keys(dot[1] === "principal" ? v.tags : v.resourceTags);
      const first = tags[0] ?? (dot[1] === "principal" ? "department" : "classification");
      return {
        from,
        items: [
          { label: "hasTag", kind: "method", detail: "(key) → Bool", doc: CEDAR_DOCS.hasTag, insert: `hasTag("\${1:${lit(first)}}")`, snippet: true, boost: 2 },
          { label: "getTag", kind: "method", detail: "(key) → Set<String>", doc: CEDAR_DOCS.getTag, insert: `getTag("\${1:${lit(first)}}")`, snippet: true, boost: 1 },
        ],
      };
    }
    if (dot[1] === ")") {
      return {
        from,
        items: [
          { label: "contains", kind: "method", detail: "(value) → Bool", doc: CEDAR_DOCS.contains, insert: 'contains("$1")', snippet: true, boost: 3 },
          { label: "containsAny", kind: "method", detail: "([values]) → Bool", doc: CEDAR_DOCS.containsAny, insert: 'containsAny(["$1"])', snippet: true },
          { label: "containsAll", kind: "method", detail: "([values]) → Bool", doc: CEDAR_DOCS.containsAll, insert: 'containsAll(["$1"])', snippet: true },
          { label: "isEmpty", kind: "method", detail: "() → Bool", doc: CEDAR_DOCS.isEmpty, insert: "isEmpty()" },
        ],
      };
    }
    return null;
  }

  // -- anywhere else: a word, and whole conditions
  const word = /[A-Za-z_]\w*$/.exec(before)?.[0] ?? "";
  const from = pos - word.length;
  const items: Suggestion[] = [];
  for (const [k, vals] of Object.entries(v.tags)) {
    items.push({
      label: `principal ${k}`,
      kind: "snippet",
      detail: "their tag is…",
      doc: `People whose \`${k}\` is a value.${vals.length ? `\n\nSeen: ${vals.slice(0, 12).map((x) => `\`${x}\``).join(", ")}` : ""}`,
      insert: `principal.hasTag("${lit(quote(k))}") && principal.getTag("${lit(quote(k))}").contains("${choice(vals, "value")}")`,
      snippet: true,
      boost: 4,
    });
  }
  for (const [k, vals] of Object.entries(v.resourceTags)) {
    items.push({
      label: `resource ${k}`,
      kind: "snippet",
      detail: "its tag is…",
      doc: `Workspaces or notebooks whose \`${k}\` is a value.${vals.length ? `\n\nSeen: ${vals.slice(0, 12).map((x) => `\`${x}\``).join(", ")}` : ""}`,
      insert: `resource.hasTag("${lit(quote(k))}") && resource.getTag("${lit(quote(k))}").contains("${choice(vals, "value")}")`,
      snippet: true,
      boost: 3,
    });
  }
  if (v.policies) {
    const actions = v.policies.actions.length ? `\${2|${v.policies.actions.join(",")}|}` : "${2:notebook.view}";
    items.push(
      {
        label: "permit",
        kind: "snippet",
        detail: "allow, when…",
        doc: CEDAR_DOCS.permit,
        insert: `permit (\n  principal\${1},\n  action == Action::"${actions}",\n  resource\${3}\n)\nwhen { \${4:true} };`,
        snippet: true,
        boost: 6,
      },
      {
        label: "forbid",
        kind: "snippet",
        detail: "deny, over any permit",
        doc: CEDAR_DOCS.forbid,
        insert: `forbid (\n  principal\${1},\n  action == Action::"${actions}",\n  resource\${3}\n)\nwhen { \${4:true} };`,
        snippet: true,
        boost: 6,
      },
      { label: "action in", kind: "snippet", detail: "any of these actions", insert: 'action in [Action::"${1:notebook.view}", Action::"${2:report.view}"]', snippet: true },
      { label: "resource in Workspace", kind: "snippet", detail: "a workspace, and what is in it", insert: 'resource in Workspace::"${1}"', snippet: true },
      { label: "unless", kind: "keyword", detail: "unless { … }", doc: CEDAR_DOCS.unless, insert: "unless { ${1:false} }", snippet: true },
      { label: "when", kind: "keyword", detail: "when { … }", doc: CEDAR_DOCS.when, insert: "when { ${1:true} }", snippet: true },
      { label: "@id", kind: "snippet", detail: "a policy's name", insert: '@id("${1:name}")', snippet: true },
    );
  }
  items.push(
    { label: "principal in Group", kind: "snippet", detail: "in a group", doc: CEDAR_DOCS.in, insert: `principal in Group::"${choice(v.groups, "group", 1)}"`, snippet: true, boost: 4 },
    { label: "principal", kind: "variable", detail: WHO.principal, doc: CEDAR_DOCS.principal, boost: 5 },
    { label: "resource", kind: "variable", detail: WHO.resource, doc: CEDAR_DOCS.resource, boost: 5 },
    { label: "context", kind: "variable", doc: CEDAR_DOCS.context },
    { label: "if", kind: "keyword", detail: "if … then … else …", doc: CEDAR_DOCS.if, insert: "if ${1:condition} then ${2:true} else ${3:false}", snippet: true },
    { label: "in", kind: "keyword", doc: CEDAR_DOCS.in },
    { label: "like", kind: "keyword", doc: CEDAR_DOCS.like },
    { label: "is", kind: "keyword", doc: CEDAR_DOCS.is },
    { label: "has", kind: "keyword", doc: CEDAR_DOCS.has },
    { label: "true", kind: "constant" },
    { label: "false", kind: "constant" },
  );
  return { from, items };
}

/** What a word means, for hovers. */
export function cedarHover(word: string): string | null {
  return CEDAR_DOCS[word] ?? null;
}
