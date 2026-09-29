"""Reading table names out of basalt SQL without parsing it: a tokenizer that
steps over strings, comments and raw literals, and the references and
declarations a cell makes. Used by the kernel (to point names at files) and by
the analyzer (to order cells); no polars import, so it loads fast."""

import re

WORD = re.compile(r"[A-Za-z_]\w*")
DOLLAR_QUOTE = re.compile(r"\$([A-Za-z_]\w*)?\$")
PARAM_REF = re.compile(r"\$[A-Za-z_][\w.?]*")


def sql_tokens(src):
    """(kind, text, offset) for words and punctuation; strings, comments and
    raw literals are skipped as units so nothing inside them is rewritten."""
    i, n = 0, len(src)
    while i < n:
        c = src[i]
        if c.isspace():
            i += 1
        elif src.startswith("--", i):
            j = src.find("\n", i)
            i = n if j < 0 else j
        elif src.startswith("/*", i):
            j = src.find("*/", i + 2)
            i = n if j < 0 else j + 2
        elif c in "'\"":
            j = i + 1
            while j < n and not (src[j] == c and src[j + 1 : j + 2] != c):
                j += 2 if src[j] == c else 1
            yield ("str", src[i : j + 1], i)
            i = j + 1
        elif c == "$" and (m := DOLLAR_QUOTE.match(src, i)):
            j = src.find(m.group(0), m.end())
            j = n if j < 0 else j + len(m.group(0))
            yield ("str", src[i:j], i)
            i = j
        elif c == "$" and (m := PARAM_REF.match(src, i)):
            yield ("param", m.group(0), i)
            i = m.end()
        elif m := WORD.match(src, i):
            yield ("word", m.group(0), i)
            i = m.end()
        else:
            yield ("punct", c, i)
            i += 1


def rewrite_refs(src, is_table):
    """Point `FROM name` / `JOIN name` / `DESCRIBE name` at a notebook table's
    exported Arrow file. A CTE of the same name in the cell wins over the table.
    Returns the edits as (offset, old_len, name)."""
    toks = list(sql_tokens(src))
    ctes = {
        toks[i][1]
        for i in range(len(toks) - 2)
        if toks[i][0] == "word" and toks[i + 1][1].upper() == "AS" and toks[i + 2][1] == "("
    }
    edits = []
    for i, (kind, text, off) in enumerate(toks):
        if kind != "word" or i == 0 or text in ctes or not is_table(text):
            continue
        if toks[i - 1][0] != "word" or toks[i - 1][1].upper() not in ("FROM", "JOIN", "DESCRIBE"):
            continue
        if i + 1 < len(toks) and toks[i + 1][1] in (".", "("):
            continue
        edits.append((off, len(text), text))
    return edits


def apply_edits(src, edits, path_of):
    """Splice the paths in. Returns the script and, per edit, (line, col0,
    old_len, new_len) in the original source for mapping errors back."""
    out, last, applied = [], 0, []
    for off, old_len, name in edits:
        new = "'" + path_of(name).replace("'", "''") + "'"
        out += [src[last:off], new]
        line = src.count("\n", 0, off) + 1
        applied.append((line, off - (src.rfind("\n", 0, off) + 1), old_len, len(new)))
        last = off + old_len
    out.append(src[last:])
    return "".join(out), applied


def map_col(applied, line, col):
    """A 1-based column on `line` of the rewritten script back to the original."""
    c, shift = col - 1, 0
    for l, col0, old_len, new_len in applied:
        if l != line:
            continue
        start = col0 + shift
        if c < start:
            break
        if c < start + new_len:  # inside a spliced path: point at the name
            return col0 + 1
        shift += new_len - old_len
    return c - shift + 1


DECLARES = {"CONNECTION": "conn:", "FUNCTION": "fn:", "RESOURCE": "res:"}
# words that precede `(` without being a call
NOT_CALLS = {"AS", "IN", "ON", "USING", "OPTIONS", "OVER", "VALUES", "EXISTS", "AND", "OR", "NOT", "WITH",
             "EXCEPT", "EXCLUDE", "RENAME", "PARTITION", "BODY", "OF", "BY", "COLS", "PUSHDOWN", "INTO"}


def sql_deps(src):
    """(defines, reads) of a SQL cell, as names in one space shared with Python:
    `sales` a table, `$days` a PARAM/LET, `conn:erp` a connection, `fn:inc` a
    function. Over-reading is harmless: a read only becomes an edge when an
    earlier cell defines that name."""
    toks = list(sql_tokens(src))
    words = [t[1].upper() if t[0] == "word" else t[1] for t in toks]
    ctes = {
        toks[i][1]
        for i in range(len(toks) - 2)
        if toks[i][0] == "word" and words[i + 1] == "AS" and toks[i + 2][1] == "("
    }
    defines, reads = set(), set()
    for i, (kind, text, _) in enumerate(toks):
        prev = words[i - 1] if i else ""
        nxt = toks[i + 1][1] if i + 1 < len(toks) else ""
        if kind == "param":
            name = "$" + re.split(r"[.?]", text[1:])[0]
            (defines if prev in ("LET", "PARAM") else reads).add(name)
        elif kind != "word":
            continue
        elif prev in ("LET", "PARAM"):
            defines.add("$" + text)
        elif prev in DECLARES and i >= 2 and words[i - 2] in ("CREATE", "REPLACE"):
            defines.add(DECLARES[prev] + (text + "." + toks[i + 2][1] if nxt == "." and prev == "RESOURCE" else text))
        elif nxt == "(" and prev not in ("FROM", "JOIN"):
            if text.upper() not in NOT_CALLS:
                reads.add("fn:" + text)
        elif prev in ("FROM", "JOIN", "DESCRIBE", "INTO") and nxt == ".":
            reads.add("conn:" + text)
        elif prev in ("FROM", "JOIN", "DESCRIBE") and nxt != "(" and text not in ctes:
            reads.add(text)
        elif prev == "FROM" and nxt == "(":
            reads.add("fn:" + text)  # FROM RANGE(..) / conn.QUERY(..): harmless
    return sorted(defines), sorted(reads - defines)

