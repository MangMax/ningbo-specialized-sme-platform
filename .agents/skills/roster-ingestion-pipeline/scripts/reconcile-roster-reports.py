#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = ["openpyxl>=3.1,<4"]
# ///
"""Reconcile frozen roster membership and explicitly supplied explanations."""
import argparse
from collections import defaultdict
import csv
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import unicodedata
import uuid

from openpyxl import load_workbook


def sha(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def strict_object(value, fields, label):
    if not isinstance(value, dict) or set(value)-fields:
        raise ValueError(f"{label}: unsupported fields; expected {sorted(fields)}")


def input_spec(value, label):
    strict_object(value, {"sheet", "headerRow", "identityColumn", "nameColumn", "noteColumns", "metadata", "allowEmpty"}, label)
    if "allowEmpty" in value and type(value["allowEmpty"]) is not bool:
        raise ValueError(label+": allowEmpty must be boolean")
    if not isinstance(value.get("identityColumn"), str) or not value["identityColumn"]:
        raise ValueError(label+": identityColumn is required")
    if value.get("nameColumn") is not None and (not isinstance(value["nameColumn"], str) or not value["nameColumn"]):
        raise ValueError(label+": nameColumn must be a nonempty header or null")
    if type(value.get("headerRow", 1)) is not int or value.get("headerRow", 1) < 1:
        raise ValueError(label+": headerRow must be positive")
    if not isinstance(value.get("noteColumns", []), list) or not all(isinstance(c, str) and c for c in value.get("noteColumns", [])):
        raise ValueError(label+": noteColumns must be named headers")
    meta = value.get("metadata")
    strict_object(meta, {"titleCode", "asOf", "ruleVersion", "snapshotId"}, label+".metadata")
    if not all(isinstance(meta.get(k), str) and meta[k] for k in ("titleCode", "asOf", "ruleVersion", "snapshotId")):
        raise ValueError(label+": titleCode/asOf/ruleVersion/snapshotId must be explicit")


def records(path, spec):
    """Project only selected business columns; keep source row coordinates."""
    workbook = None
    stream = None
    try:
        if path.suffix.lower() == ".xlsx":
            workbook = load_workbook(path, read_only=True, data_only=False)
            name = spec.get("sheet")
            if not isinstance(name, str) or name not in workbook.sheetnames:
                raise ValueError("XLSX input needs an existing explicit sheet")
            sheet = workbook[name]
            sheet.reset_dimensions()  # Some platform exports falsely declare A1.
            matrix = sheet.iter_rows(values_only=True)
        elif path.suffix.lower() == ".csv":
            stream = path.open(encoding="utf-8-sig", newline="")
            matrix = csv.reader(stream)
        elif path.suffix.lower() == ".json":
            rows = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(rows, list) or not all(isinstance(row, dict) for row in rows):
                raise ValueError("JSON input must be an array of row objects")
            if spec.get("headerRow", 1) != 1:
                raise ValueError("JSON input does not have header row offsets")
            wanted = [spec["identityColumn"], spec.get("nameColumn"), *spec.get("noteColumns", [])]
            wanted = list(dict.fromkeys(c for c in wanted if c is not None))
            for n, row in enumerate(rows, 1):
                if any(c not in row for c in wanted):
                    raise ValueError(f"JSON row {n}: required mapped field missing")
            return [{"row": n, "rawIdentity": row[spec["identityColumn"]],
                     "name": row.get(spec.get("nameColumn")),
                     "notes": {c: row[c] for c in spec.get("noteColumns", [])}}
                    for n, row in enumerate(rows, 1)]
        else:
            raise ValueError("supported inputs: .xlsx, .csv, .json")
        header_at = spec.get("headerRow", 1)
        headers = None
        selected = []
        for number, row in enumerate(matrix, 1):
            if number < header_at:
                continue
            if number == header_at:
                headers = list(row)
                wanted = [spec["identityColumn"], spec.get("nameColumn"), *spec.get("noteColumns", [])]
                positions = {}
                for key in (k for k in wanted if k is not None):
                    matches = [n for n, value in enumerate(headers) if value == key]
                    if len(matches) != 1:
                        raise ValueError(f"mapped header {key!r} must occur exactly once")
                    positions[key] = matches[0]
                continue
            if not any(value is not None and value != "" for value in row):
                continue
            get = lambda key: row[positions[key]] if positions[key] < len(row) else None
            selected.append({"row": number, "rawIdentity": get(spec["identityColumn"]),
                             "name": get(spec["nameColumn"]) if spec.get("nameColumn") else None,
                             "notes": {k: get(k) for k in spec.get("noteColumns", [])}})
        if headers is None:
            raise ValueError("declared header row is absent")
        return selected
    finally:
        if workbook:
            workbook.close()
        if stream:
            stream.close()


def identity(value, kind):
    if kind == "uscc":
        if not isinstance(value, str):
            return None
        normalized = unicodedata.normalize("NFKC", value).upper()
        normalized = re.sub(r"[\s\u200b-\u200d\ufeff]", "", normalized)
        return normalized if re.fullmatch(r"[0-9A-Z]{18}", normalized) else None
    if isinstance(value, str) and value.strip() and not value.strip().startswith("="):
        return value.strip()
    if type(value) is int:
        return str(value)
    return None


def reconcile(before, after, contract, reasons):
    strict_object(contract, {"keyKind", "before", "after"}, "contract")
    if contract.get("keyKind") not in ("uscc", "id"):
        raise ValueError("keyKind must be uscc or id")
    for side in ("before", "after"):
        input_spec(contract.get(side), side)
    if contract["before"]["metadata"]["titleCode"] != contract["after"]["metadata"]["titleCode"]:
        raise ValueError("cannot compare membership across different titles")
    if not isinstance(reasons, dict):
        raise ValueError("reasons must map canonical identity to explicit claims")
    allowed = {"reason", "source", "investigation", "systemCorrection", "externalAction", "note"}
    for key, value in reasons.items():
        if identity(key, contract["keyKind"]) != key:
            raise ValueError("reason identity must be canonical")
        strict_object(value, allowed, "reason:"+key)
        if not all(isinstance(v, str) for v in value.values()):
            raise ValueError("reason claims must be strings")
    source_rows = {"before": records(before, contract["before"]), "after": records(after, contract["after"])}
    empty_sides = [side for side, rows in source_rows.items() if not rows and not contract[side].get("allowEmpty", False)]
    groups = {side: defaultdict(list) for side in source_rows}
    invalid = []
    for side, rows in source_rows.items():
        for row in rows:
            key = identity(row["rawIdentity"], contract["keyKind"])
            if key is None:
                invalid.append({"side": side, **row, "problem": "missing_or_invalid_identity"})
            else:
                groups[side][key].append({**row, "identity": key})
    ambiguous = {key for side in groups.values() for key, rows in side.items() if len(rows) != 1}
    blocked = [{"identity": key, "problem": "duplicate_identity",
                "before": groups["before"].get(key, []), "after": groups["after"].get(key, [])} for key in sorted(ambiguous)]
    unique = {side: {key: rows[0] for key, rows in group.items() if key not in ambiguous}
              for side, group in groups.items()}
    old, new = set(unique["before"]), set(unique["after"])
    unexplained = []
    used_reasons = set()

    def entry(key, change):
        left, right = unique["before"].get(key), unique["after"].get(key)
        claim = reasons.get(key, {})
        if claim:
            used_reasons.add(key)
        normalized_name = lambda row: str(row["name"]).strip() if row and row["name"] is not None else ""
        name_changed = bool(left and right and normalized_name(left) != normalized_name(right))
        changed = change != "retained" or name_changed
        explained = bool(claim.get("reason", "").strip())
        if changed and not explained:
            unexplained.append(key)
        return {"identity": key, "change": change, "nameChanged": name_changed,
                "before": left, "after": right, "explanationStatus": "provided_not_verified" if explained else "unexplained" if changed else "not_required",
                "claims": claim, "investigation": claim.get("investigation", "unknown"),
                "systemCorrection": claim.get("systemCorrection", "unknown"), "externalAction": claim.get("externalAction", "unknown")}

    changes = {"added": [entry(k, "added") for k in sorted(new-old)],
               "removed": [entry(k, "removed") for k in sorted(old-new)],
               "retained": [entry(k, "retained") for k in sorted(old & new)]}
    metadata = {side: contract[side]["metadata"] for side in source_rows}
    context_changes = {k: {side: metadata[side][k] for side in metadata}
                       for k in metadata["before"] if metadata["before"][k] != metadata["after"][k]}
    status = "identity_issues" if invalid or blocked else "empty_input" if empty_sides else "needs_explanation" if unexplained else "ok"
    mappings = {side: {k: contract[side].get(k, 1 if k == "headerRow" else [] if k == "noteColumns" else None)
                       for k in ("sheet", "headerRow", "identityColumn", "nameColumn", "noteColumns")}
                for side in source_rows}
    return {"status": status, "metadata": metadata, "contextChanges": context_changes,
            "keyKind": contract["keyKind"], "mappings": mappings,
            "nameComparison": "strip; null and empty are equivalent; raw names retained", "emptySides": empty_sides,
            "contextNote": "different rule/time/snapshot is not itself a data repair" if context_changes else "same declared context",
            "counts": {side: {"inputRows": len(source_rows[side]), "validDistinctIdentities": len(groups[side]), "comparableIdentities": len(unique[side])} for side in source_rows},
            "changes": changes, "invalidRows": invalid, "ambiguousIdentities": blocked,
            "unexplainedChanges": unexplained, "unusedReasons": {k: v for k, v in reasons.items() if k not in used_reasons},
            "businessDecisionsMade": False, "completionClaimsVerified": False}


def readable(report):
    if report["status"] == "error":
        return "输入错误："+report["error"]+"\n"
    lines = ["名录成员变化对账", "工具状态："+report["status"],
             "身份口径："+report["keyKind"]+"；列映射："+json.dumps(report["mappings"], ensure_ascii=False),
             "口径变化："+json.dumps(report["contextChanges"], ensure_ascii=False),
             "原因和办理状态均为输入主张，工具没有确认或执行业务决定。"]
    for change, label in (("added", "新增"), ("removed", "移除"), ("retained", "保留")):
        items = report["changes"][change]
        lines.append(f"{label}：{len(items)}")
        for item in items:
            if change == "retained" and not item["nameChanged"]:
                continue
            name = (item["after"] or item["before"])["name"] or "名称未提供"
            reason = item["claims"].get("reason") or "未解释"
            lines.append(f"  {item['identity']} {name}：{reason}；调查={item['investigation']}；系统更正={item['systemCorrection']}；外部办理={item['externalAction']}")
    lines.append(f"无效/缺失标识行：{len(report['invalidRows'])}；歧义标识组：{len(report['ambiguousIdentities'])}")
    for row in report["invalidRows"]:
        lines.append(f"  无效标识：{row['side']}，行{row['row']}，原值={row['rawIdentity']!r}")
    for item in report["ambiguousIdentities"]:
        lines.append(f"  歧义标识：{item['identity']}；原行="+json.dumps({side: [r['row'] for r in item[side]] for side in ('before', 'after')}))
    if report["emptySides"]:
        lines.append("空输入未声明允许："+", ".join(report["emptySides"]))
    return "\n".join(lines)+"\n"


def publish(outputs):
    """Stage every new artifact before publishing; never replace old receipts."""
    staged, created = [], []
    try:
        if any(target.exists() for target, _ in outputs):
            raise ValueError("output already exists; use a new path for this run")
        for target, text in outputs:
            fd, temporary = tempfile.mkstemp(prefix=".roster-reconcile-", dir=target.parent)
            staged.append((Path(temporary), target))
            with os.fdopen(fd, "w", encoding="utf-8") as stream:
                stream.write(text)
        for temporary, target in staged:
            os.link(temporary, target)  # Atomic creation without overwriting races.
            created.append(target)
    except Exception:
        for target in created:
            target.unlink(missing_ok=True)
        raise
    finally:
        for temporary, _ in staged:
            temporary.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("before", "after", "contract"):
        parser.add_argument("--"+name, required=True, type=Path)
    parser.add_argument("--reasons", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    run_id, result = uuid.uuid4().hex, {}
    try:
        inputs = [args.before, args.after, args.contract]+([args.reasons] if args.reasons else [])
        outputs = [p for p in (args.output, args.report) if p]
        for index, target in enumerate(outputs):
            for source in inputs+outputs[:index]:
                if target.resolve() == source.resolve() or target.exists() and source.exists() and target.samefile(source):
                    raise ValueError("output paths must differ from all inputs and each other")
        hashes = {str(path): sha(path) for path in inputs}
        contract = json.loads(args.contract.read_text(encoding="utf-8"))
        reasons = json.loads(args.reasons.read_text(encoding="utf-8")) if args.reasons else {}
        result = reconcile(args.before, args.after, contract, reasons)
        result["runId"] = run_id
        after = {str(path): sha(path) for path in inputs}
        if after != hashes:
            raise ValueError("input hashes changed during reconciliation")
        result["inputHashes"] = hashes
        artifacts = []
        if args.output:
            artifacts.append((args.output, json.dumps(result, ensure_ascii=False, indent=2, default=str)+"\n"))
        if args.report:
            artifacts.append((args.report, readable(result)))
        publish(artifacts)
    except Exception as error:
        result = {**result, "status": "error", "error": str(error), "runId": run_id}
    sys.stdout.write(json.dumps(result, ensure_ascii=False, default=str)+"\n")
    return {"ok": 0, "needs_explanation": 1, "identity_issues": 2, "empty_input": 2, "error": 2}[result["status"]]


if __name__ == "__main__":
    raise SystemExit(main())
