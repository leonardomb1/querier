// basalt's SQL as a TextMate grammar, for Shiki (lib/monaco.ts): SQL's shape with
// basalt's own words (LOAD INTO, PARAM, CREATE CONNECTION…), its functions, its
// $params, and $$…$$ text (a query sent as it is to another database).
// Built from the lists in basalt.ts, so the colours and the completions agree.

import { FUNCTIONS, KEYWORDS, TYPES } from "./basalt";

const words = (list: string[]) => list.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
const CONSTANTS = ["true", "false", "null"];
// the statement's verbs, coloured as control flow; the rest are plain keywords
const CONTROL = ["select", "from", "where", "group", "order", "having", "limit", "offset", "join", "union", "with", "load", "into", "for", "each", "call", "return", "throw", "case", "when", "then", "else", "end"];

export const basaltGrammar = {
  name: "basalt",
  scopeName: "source.basalt",
  displayName: "basalt SQL",
  patterns: [
    { include: "#comments" },
    { include: "#dollar-quoted" },
    { include: "#strings" },
    { include: "#params" },
    { include: "#numbers" },
    { include: "#functions" },
    { include: "#constants" },
    { include: "#control" },
    { include: "#keywords" },
    { include: "#types" },
    { include: "#operators" },
  ],
  repository: {
    comments: {
      patterns: [
        { name: "comment.line.double-dash.sql", match: "--.*$" },
        { name: "comment.block.sql", begin: "/\\*", end: "\\*/" },
      ],
    },
    "dollar-quoted": { name: "string.quoted.other.dollar.sql", begin: "\\$\\$", end: "\\$\\$" },
    strings: {
      patterns: [
        { name: "string.quoted.single.sql", begin: "'", end: "'", patterns: [{ name: "constant.character.escape.sql", match: "''" }] },
        { name: "variable.other.quoted.sql", begin: '"', end: '"' },
      ],
    },
    params: { name: "variable.parameter.basalt", match: "\\$[A-Za-z_]\\w*" },
    numbers: { name: "constant.numeric.sql", match: "\\b\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?\\b" },
    functions: {
      patterns: [
        { name: "support.function.basalt", match: `(?i)\\b(?:${words(FUNCTIONS.map((f) => f.name))})(?=\\s*\\()` },
        { name: "entity.name.function.sql", match: "\\b[A-Za-z_]\\w*(?=\\s*\\()" },
      ],
    },
    constants: { name: "constant.language.sql", match: `(?i)\\b(?:${words(CONSTANTS)})\\b` },
    control: { name: "keyword.control.sql", match: `(?i)\\b(?:${words(CONTROL)})\\b` },
    keywords: { name: "keyword.other.sql", match: `(?i)\\b(?:${words(KEYWORDS.filter((k) => !CONSTANTS.includes(k) && !CONTROL.includes(k)))})\\b` },
    types: { name: "storage.type.sql", match: `(?i)\\b(?:${words(TYPES)})\\b` },
    operators: { name: "keyword.operator.sql", match: "\\|\\||\\?\\?|<=|>=|<>|!=|[=<>+\\-*/%]" },
  },
};
