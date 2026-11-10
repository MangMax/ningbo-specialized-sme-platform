#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = ["openpyxl>=3.1,<4"]
# ///
"""Compare saved XLSX values/types and explicitly declared edit boundaries."""
import argparse
from collections import defaultdict
from datetime import date, datetime, time
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import uuid

from openpyxl import load_workbook


def sha(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def obj(value, allowed, required, label):
    if not isinstance(value, dict) or set(value)-set(allowed) or set(required)-set(value):
        raise ValueError(label+": missing or unsupported contract fields")


def strings(value, label):
    if not isinstance(value, list) or not all(isinstance(v, str) and v for v in value) or len(set(value)) != len(value):
        raise ValueError(label+": expected unique nonempty strings")
    return value


def key(cell, kind):
    value = cell.value
    if cell.data_type == "f":
        return None
    if kind == "uscc":
        return value if isinstance(value, str) and re.fullmatch(r"[0-9A-Z]{18}", value) else None
    if isinstance(value, str) and value.strip() and not value.startswith("="):
        return value  # Exact stable identifiers; no fuzzy/normalized alignment.
    return str(value) if type(value) is int else None


def native(cell):
    value = cell.value
    return {"type": cell.data_type, "pythonType": type(value).__name__,
            "value": value.isoformat() if isinstance(value, (date, datetime, time)) else value}


def freeze(sheet):
    pane = sheet.sheet_view.pane
    return {"xSplit": pane.xSplit or 0, "ySplit": pane.ySplit or 0, "state": pane.state} if pane else None


def font(cell):
    f = cell.font
    return {"name": f.name, "size": f.sz, "bold": f.b, "italic": f.i, "scheme": f.scheme}


def read_sheet(workbook, spec, kind, max_cells):
    obj(spec, {"sheet", "headerRow", "keyColumn", "fields", "allowEmpty"}, {"sheet", "keyColumn", "fields"}, "sheet input")
    if spec["sheet"] not in workbook.sheetnames:
        raise ValueError("mapped sheet is absent: "+str(spec["sheet"]))
    header = spec.get("headerRow", 1)
    if type(header) is not int or header < 1 or type(spec.get("allowEmpty", False)) is not bool:
        raise ValueError("headerRow/allowEmpty is invalid")
    fields = spec["fields"]
    if not isinstance(fields, dict) or not fields or not all(isinstance(k, str) and k and isinstance(v, str) and v for k, v in fields.items()):
        raise ValueError("fields needs logical-name to header mappings")
    if len(set(fields.values())) != len(fields):
        raise ValueError("field mappings must be one-to-one")
    if not isinstance(spec["keyColumn"], str) or spec["keyColumn"] not in fields.values():
        raise ValueError("keyColumn must also be a mapped business field")
    sheet = workbook[spec["sheet"]]
    if sheet.max_row * sheet.max_column > max_cells:
        raise ValueError("declared cell budget exceeded: "+sheet.title)
    headers = [c.value for c in sheet[header]]
    positions = {}
    for name in fields.values():
        found = [i+1 for i, h in enumerate(headers) if h == name]
        if len(found) != 1:
            raise ValueError("mapped header must occur exactly once: "+name)
        positions[name] = found[0]
    uncovered = []
    for col, name in enumerate(headers, 1):
        populated = name not in (None, "") or any(sheet.cell(r, col).value not in (None, "") for r in range(header+1, sheet.max_row+1))
        if populated and name not in fields.values():
            uncovered.append({"sheet": sheet.title, "column": col, "header": name, "problem": "unmapped_field"})
    groups, invalid = defaultdict(list), []
    for r in range(header+1, sheet.max_row+1):
        if all(sheet.cell(r, c).value in (None, "") for c in range(1, sheet.max_column+1)):
            continue
        identity_cell = sheet.cell(r, positions[spec["keyColumn"]])
        identity = key(identity_cell, kind)
        row = {"row": r, "identityCell": native(identity_cell),
               "cells": {f: sheet.cell(r, positions[h]) for f, h in fields.items()}}
        if identity is None:
            invalid.append({"sheet": sheet.title, "row": r, "problem": "invalid_or_missing_key", "actual": native(identity_cell)})
        else:
            groups[identity].append(row)
    if not groups and not invalid and not spec.get("allowEmpty", False):
        uncovered.append({"sheet": sheet.title, "problem": "empty_input_not_allowed"})
    return sheet, groups, invalid, uncovered


def compare(before, after, contract, max_cells):
    obj(contract, {"keyKind", "sheets", "excludedSheets"}, {"keyKind", "sheets"}, "contract")
    if contract["keyKind"] not in ("id", "uscc") or not isinstance(contract["sheets"], dict) or not contract["sheets"]:
        raise ValueError("keyKind and nonempty sheet mappings are required")
    excluded = contract.get("excludedSheets", {})
    obj(excluded, {"before", "after"}, set(), "excludedSheets")
    for side in excluded:
        strings(excluded[side], "excludedSheets."+side)
    books = {"before": before, "after": after}
    mapped = {side: set() for side in books}
    differences, permitted, issues, uncovered, counts = [], [], [], [], {}
    def record(item, allowed=False):
        (permitted if allowed else differences).append(item)
    for logical, spec in contract["sheets"].items():
        obj(spec, {"before", "after", "allow", "preserve"}, {"before", "after"}, "sheet mapping")
        allow = spec.get("allow", {})
        obj(allow, {"addedKeys", "removedKeys", "addedFields", "removedFields", "changedCells"}, set(), "allow")
        for name in ("addedKeys", "removedKeys", "addedFields", "removedFields"):
            strings(allow.get(name, []), name)
        changes = allow.get("changedCells", [])
        if not isinstance(changes, list):
            raise ValueError("changedCells must be an array")
        for change in changes:
            obj(change, {"key", "field"}, {"key", "field"}, "changed cell")
            if not all(isinstance(v, str) and v for v in change.values()):
                raise ValueError("changed cell key/field must be explicit strings")
        allowed_cells = {(c["key"], c["field"]) for c in changes}
        preserve = strings(spec.get("preserve", []), "preserve")
        if set(preserve)-{"freezePanes", "autoFilter", "rowHeight", "font", "numberFormat"}:
            raise ValueError("unsupported preserved property")
        loaded = {}
        for side, book in books.items():
            sheet, groups, invalid, gaps = read_sheet(book, spec[side], contract["keyKind"], max_cells)
            if sheet.title in mapped[side] or sheet.title in excluded.get(side, []):
                raise ValueError("sheet must be mapped once and not excluded")
            mapped[side].add(sheet.title)
            issues.extend({"logicalSheet": logical, "side": side, **i} for i in invalid)
            uncovered.extend({"logicalSheet": logical, "side": side, **i} for i in gaps)
            loaded[side] = (sheet, groups)
        left, old = loaded["before"]
        right, new = loaded["after"]
        old_fields, new_fields = set(spec["before"]["fields"]), set(spec["after"]["fields"])
        for field in sorted(old_fields ^ new_fields):
            direction = "added" if field in new_fields else "removed"
            record({"logicalSheet": logical, "field": field, "kind": direction+"_field"}, field in allow.get(direction+"Fields", []))
        duplicate = {k for rows in (old, new) for k, values in rows.items() if len(values) != 1}
        for identity in sorted(duplicate):
            issues.append({"logicalSheet": logical, "key": identity, "problem": "duplicate_key",
                           "rows": {side: [r["row"] for r in groups.get(identity, [])] for side, (_, groups) in loaded.items()}})
        counts[logical] = {side: sum(len(v) for v in groups.values()) for side, (_, groups) in loaded.items()}
        for identity in sorted((set(old)|set(new))-duplicate):
            if identity not in old or identity not in new:
                direction = "added" if identity in new else "removed"
                row = (new if direction == "added" else old)[identity][0]
                record({"logicalSheet": logical, "key": identity, "kind": direction+"_key", "row": row["row"]}, identity in allow.get(direction+"Keys", []))
                continue
            a, b = old[identity][0], new[identity][0]
            for field in sorted(set(a["cells"])|set(b["cells"])):
                base = {"logicalSheet": logical, "key": identity, "field": field, "beforeRow": a["row"], "afterRow": b["row"]}
                if field not in a["cells"] or field not in b["cells"]:
                    continue
                x, y = a["cells"][field], b["cells"][field]
                if native(x) != native(y):
                    record({**base, "kind": "cell", "before": native(x), "after": native(y)}, (identity, field) in allowed_cells)
                for prop in set(preserve)&{"font", "numberFormat"}:
                    av, bv = (font(x), font(y)) if prop == "font" else (x.number_format, y.number_format)
                    if av != bv:
                        record({**base, "kind": prop, "before": av, "after": bv})
            if "rowHeight" in preserve:
                av = left.row_dimensions[a["row"]].height or left.sheet_format.defaultRowHeight
                bv = right.row_dimensions[b["row"]].height or right.sheet_format.defaultRowHeight
                if av != bv:
                    record({"logicalSheet": logical, "key": identity, "kind": "rowHeight", "before": av, "after": bv})
        for prop in set(preserve)&{"freezePanes", "autoFilter"}:
            av, bv = (freeze(left), freeze(right)) if prop == "freezePanes" else (left.auto_filter.ref, right.auto_filter.ref)
            if av != bv:
                record({"logicalSheet": logical, "kind": prop, "before": av, "after": bv})
    for side, book in books.items():
        if set(excluded.get(side, []))-set(book.sheetnames):
            raise ValueError("excluded sheet does not exist")
        for name in set(book.sheetnames)-mapped[side]-set(excluded.get(side, [])):
            uncovered.append({"side": side, "sheet": name, "problem": "unmapped_sheet"})
    return {"status": "not_covered" if issues or uncovered else "fail" if differences else "pass",
            "counts": counts, "differences": differences, "permittedChanges": permitted,
            "identityIssues": issues, "uncovered": uncovered,
            "rendering": "not_evaluated; native saved values are independent of preview formatting",
            "contract": contract}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("before", "after", "contract"):
        parser.add_argument("--"+name, type=Path, required=True)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--max-cells", type=int, default=1000000)
    args = parser.parse_args()
    report, books, temporary = {"runId": uuid.uuid4().hex}, [], None
    try:
        inputs = [args.before, args.after, args.contract]
        if args.max_cells < 1:
            raise ValueError("max-cells must be positive")
        if args.output:
            for path in inputs:
                if args.output.resolve() == path.resolve() or args.output.exists() and args.output.samefile(path):
                    raise ValueError("output must differ from inputs, including links")
            if args.output.exists():
                raise ValueError("use a new output path for each run")
        hashes = {str(p): sha(p) for p in inputs}
        for path in (args.before, args.after):
            books.append(load_workbook(path, data_only=False, read_only=False))
        report.update(compare(*books, json.loads(args.contract.read_text(encoding="utf-8")), args.max_cells))
        final = {str(p): sha(p) for p in inputs}
        if final != hashes:
            raise ValueError("input changed during comparison")
        report["inputHashes"] = hashes
        report["inputHashesAfter"] = final
        if args.output:
            fd, temporary = tempfile.mkstemp(prefix=".workbook-values-", dir=args.output.parent)
            with os.fdopen(fd, "w", encoding="utf-8") as stream:
                stream.write(json.dumps(report, ensure_ascii=False, allow_nan=False)+"\n")
            os.link(temporary, args.output)
    except Exception as error:
        report.update(status="error", error=str(error))
    finally:
        for book in books:
            book.close()
        if temporary:
            Path(temporary).unlink(missing_ok=True)
    print(json.dumps(report, ensure_ascii=False, allow_nan=False))
    return {"pass": 0, "fail": 1, "not_covered": 2, "error": 2}[report["status"]]


if __name__ == "__main__":
    raise SystemExit(main())
