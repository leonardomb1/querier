#!/usr/bin/env python3
"""What each cell defines and reads, for ordering and staleness.

stdin:  [{"name": ..., "lang": "sql"|"python", "source": ...}, ...]
stdout: {"<name>": {"defines": [...], "reads": [...]}, ...}

or, to follow a cell rename through the cells below it:
stdin:  {"op": "rename", "cells": [...], "old": ..., "new": ...}
stdout: {"<name>": "<rewritten source>", ...} for the cells that change

A cell always defines its own name (its result). Python reads are every name
it loads that it did not bind first at top level; defines are its top-level
bindings. Names line up with SQL's: a table read in SQL is a Python name.
"""

import ast
import builtins
import json
import sys

from sqlrefs import rewrite_refs, sql_deps

BUILTINS = set(dir(builtins))


def python_deps(src):
    try:
        tree = ast.parse(src)
    except SyntaxError:
        return [], []
    defines, reads = set(), set()

    def bind(target):
        for node in ast.walk(target):
            if isinstance(node, ast.Name):
                defines.add(node.id)

    for stmt in tree.body:
        # reads first: `x = x + 1` reads the x from an earlier cell
        for node in ast.walk(stmt):
            if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load) and node.id not in defines:
                reads.add(node.id)
        if isinstance(stmt, (ast.Assign, ast.AugAssign, ast.AnnAssign)):
            for t in stmt.targets if isinstance(stmt, ast.Assign) else [stmt.target]:
                bind(t)
        elif isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            defines.add(stmt.name)
        elif isinstance(stmt, (ast.Import, ast.ImportFrom)):
            for a in stmt.names:
                defines.add((a.asname or a.name).split(".")[0])
        elif isinstance(stmt, (ast.For, ast.AsyncFor)):
            bind(stmt.target)
        elif isinstance(stmt, (ast.With, ast.AsyncWith)):
            for item in stmt.items:
                if item.optional_vars is not None:
                    bind(item.optional_vars)
    return sorted(defines), sorted(reads - BUILTINS - {"pl", "display"})


def _binds(stmt, name):
    """Does this top-level statement bind `name`?"""
    targets = []
    if isinstance(stmt, ast.Assign):
        targets = stmt.targets
    elif isinstance(stmt, (ast.AugAssign, ast.AnnAssign, ast.For, ast.AsyncFor)):
        targets = [stmt.target]
    elif isinstance(stmt, (ast.With, ast.AsyncWith)):
        targets = [i.optional_vars for i in stmt.items if i.optional_vars is not None]
    elif isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
        return stmt.name == name
    elif isinstance(stmt, (ast.Import, ast.ImportFrom)):
        return any((a.asname or a.name).split(".")[0] == name for a in stmt.names)
    return any(isinstance(n, ast.Name) and n.id == name for t in targets for n in ast.walk(t))


def rename_python(src, old, new):
    """(new source, binds_old): every read of `old` up to the statement that
    rebinds it, found in the syntax tree so attributes, keywords and strings
    are left alone."""
    try:
        tree = ast.parse(src)
    except SyntaxError:
        return src, False
    spans, rebinds = [], False
    for stmt in tree.body:
        for node in ast.walk(stmt):
            if isinstance(node, ast.Name) and node.id == old and isinstance(node.ctx, ast.Load):
                spans.append((node.lineno, node.col_offset, node.end_col_offset))
        if _binds(stmt, old):
            rebinds = True
            break
    lines = src.splitlines(keepends=True)
    starts = [0]
    for line in lines:
        starts.append(starts[-1] + len(line))
    out = src
    for lineno, col, end in sorted(spans, reverse=True):  # ast columns are UTF-8 bytes
        raw = lines[lineno - 1].encode()
        a = starts[lineno - 1] + len(raw[:col].decode())
        b = starts[lineno - 1] + len(raw[:end].decode())
        out = out[:a] + new + out[b:]
    return out, rebinds


def rename(cells, old, new):
    """Sources to rewrite after cell `old` became `new`: the reads of it in the
    cells below, until one of them defines `old` again (later reads mean that)."""
    at = next((i for i, c in enumerate(cells) if c["name"] == new), None)
    if at is None:
        return {}
    changed = {}
    for c in cells[at + 1 :]:
        src = c["source"]
        if c["lang"] == "sql":
            for off, length, _ in sorted(rewrite_refs(src, lambda n: n == old), reverse=True):
                src = src[:off] + new + src[off + length :]
            rebinds = False
        elif c["lang"] == "python":
            src, rebinds = rename_python(src, old, new)
        else:
            continue
        if src != c["source"]:
            changed[c["name"]] = src
        if rebinds:
            break
    return changed


def analyze(cells):
    out = {}
    for c in cells:
        if c["lang"] == "sql":
            defines, reads = sql_deps(c["source"])
        elif c["lang"] == "python":
            defines, reads = python_deps(c["source"])
        else:
            defines, reads = [], []
        out[c["name"]] = {"defines": sorted({c["name"], *defines}) if c["lang"] != "md" else [], "reads": reads}
    return out


if __name__ == "__main__":
    req = json.load(sys.stdin)
    if isinstance(req, dict) and req.get("op") == "rename":
        json.dump(rename(req["cells"], req["old"], req["new"]), sys.stdout)
    else:
        json.dump(analyze(req), sys.stdout)
