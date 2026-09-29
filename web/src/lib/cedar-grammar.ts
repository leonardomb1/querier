// Cedar (cedarpolicy.com), the policy language access control is written in, as
// a TextMate grammar for Shiki (lib/monaco.ts): whole policies (permit, forbid,
// their scope, when/unless, @annotations) and conditions alone, as a grant's.
// The scopes are the ones VS Code's themes colour.

export const cedarGrammar = {
  name: "cedar",
  scopeName: "source.cedar",
  displayName: "Cedar",
  patterns: [{ include: "#comments" }, { include: "#annotations" }, { include: "#expression" }],
  repository: {
    comments: {
      patterns: [{ name: "comment.line.double-slash.cedar", match: "//.*$" }],
    },
    annotations: {
      patterns: [
        {
          match: "(@)([A-Za-z_]\\w*)",
          captures: { 1: { name: "punctuation.definition.annotation.cedar" }, 2: { name: "storage.type.annotation.cedar" } },
        },
      ],
    },
    expression: {
      patterns: [
        { include: "#comments" },
        { include: "#strings" },
        { include: "#entities" },
        { include: "#numbers" },
        { name: "keyword.control.effect.cedar", match: "\\b(permit|forbid)\\b" },
        { name: "keyword.control.cedar", match: "\\b(when|unless|if|then|else)\\b" },
        { name: "keyword.other.cedar", match: "\\b(in|has|like|is)\\b" },
        { name: "variable.language.cedar", match: "\\b(principal|action|resource|context)\\b" },
        { name: "constant.language.boolean.cedar", match: "\\b(true|false)\\b" },
        // a method: .contains(…), .hasTag(…)
        {
          match: "(\\.)\\s*([A-Za-z_]\\w*)(?=\\s*\\()",
          captures: { 1: { name: "punctuation.accessor.cedar" }, 2: { name: "entity.name.function.cedar" } },
        },
        // an attribute: .department
        {
          match: "(\\.)\\s*([A-Za-z_]\\w*)",
          captures: { 1: { name: "punctuation.accessor.cedar" }, 2: { name: "variable.other.property.cedar" } },
        },
        // extension functions: ip("…"), decimal("…"), datetime("…"), duration("…")
        { name: "support.function.cedar", match: "\\b(ip|decimal|datetime|duration)(?=\\s*\\()" },
        { name: "keyword.operator.logical.cedar", match: "&&|\\|\\||!(?!=)" },
        { name: "keyword.operator.comparison.cedar", match: "==|!=|<=|>=|<|>" },
        { name: "keyword.operator.arithmetic.cedar", match: "[+\\-*]" },
        { name: "punctuation.separator.cedar", match: "[,;]" },
      ],
    },
    strings: {
      name: "string.quoted.double.cedar",
      begin: '"',
      end: '"',
      patterns: [{ name: "constant.character.escape.cedar", match: '\\\\(?:[nrt0\\\\"\'*]|u\\{[0-9a-fA-F]{1,6}\\})' }],
    },
    // Group::"finance", Action::"notebook.run", Namespace::Type::"id"
    entities: {
      patterns: [
        {
          match: "\\b((?:[A-Za-z_]\\w*::)*[A-Za-z_]\\w*)(::)(?=\\s*\")",
          captures: { 1: { name: "entity.name.type.cedar" }, 2: { name: "punctuation.separator.namespace.cedar" } },
        },
      ],
    },
    numbers: {
      patterns: [{ name: "constant.numeric.cedar", match: "\\b\\d+\\b" }],
    },
  },
};
