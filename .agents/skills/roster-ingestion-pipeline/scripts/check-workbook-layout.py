#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = ["openpyxl>=3.1,<4"]
# ///
"""Check a saved XLSX against an explicit, task-owned layout contract."""
import argparse
import hashlib
import json
import math
from pathlib import Path
import sys
import xml.etree.ElementTree as ET
from zipfile import ZipFile

from openpyxl import load_workbook
from openpyxl.utils.cell import coordinate_to_tuple, range_boundaries

NS = {"s": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
      "a": "http://schemas.openxmlformats.org/drawingml/2006/main"}
SHEET_FIELDS = {"range", "headers", "dataRows", "font", "rowHeight",
                "headerAlignment", "freezePanes", "autoFilter"}


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def reject_unknown(value, allowed, label):
    if not isinstance(value, dict) or set(value) - allowed:
        raise ValueError(f"{label}: expected object with keys {sorted(allowed)}")


def positive(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value > 0


def rectangle(value):
    if not isinstance(value, str) or "!" in value or "$" in value:
        raise ValueError("range must be a bounded A1 rectangle")
    bounds = range_boundaries(value.upper())
    if any(v is None for v in bounds):
        raise ValueError("range must contain both row and column bounds")
    left, top, right, bottom = bounds
    if not (1 <= left <= right <= 16384 and 1 <= top <= bottom <= 1048576):
        raise ValueError("range outside worksheet bounds")
    return bounds


def validate_contract(contract):
    reject_unknown(contract, {"sheets", "allowExtraSheets"}, "contract")
    sheets = contract.get("sheets")
    if not isinstance(sheets, dict) or not sheets:
        raise ValueError("sheets must contain at least one named sheet")
    if "allowExtraSheets" in contract and not isinstance(contract["allowExtraSheets"], bool):
        raise ValueError("allowExtraSheets must be boolean")
    for name, spec in sheets.items():
        if not isinstance(name, str) or not name:
            raise ValueError("sheet name must be nonempty")
        reject_unknown(spec, SHEET_FIELDS, name)
        left, top, right, bottom = rectangle(spec.get("range"))
        if len(spec) == 1:
            raise ValueError(f"{name}: range alone is not a layout requirement")
        if "headers" in spec:
            headers = spec["headers"]
            if not isinstance(headers, list) or len(headers) != right-left+1 or not all(isinstance(h, str) for h in headers):
                raise ValueError(f"{name}: headers must match the rectangle width")
        if "dataRows" in spec and (type(spec["dataRows"]) is not int or not 0 <= spec["dataRows"] <= bottom-top):
            raise ValueError(f"{name}: invalid dataRows")
        if "font" in spec:
            font = spec["font"]
            reject_unknown(font, {"name", "size"}, name+".font")
            if not font or "name" in font and (not isinstance(font["name"], str) or not font["name"]):
                raise ValueError("font name must be nonempty")
            if "size" in font and not positive(font["size"]):
                raise ValueError("font size must be positive")
        if "rowHeight" in spec and not positive(spec["rowHeight"]):
            raise ValueError("rowHeight must be positive")
        if "headerAlignment" in spec:
            align = spec["headerAlignment"]
            reject_unknown(align, {"horizontal", "vertical"}, name+".headerAlignment")
            if not align or not all(isinstance(v, str) and v for v in align.values()):
                raise ValueError("headerAlignment must specify named alignment values")
        for key in ("freezePanes", "autoFilter"):
            if key in spec and spec[key] is not None:
                if key == "freezePanes":
                    rectangle(spec[key])
                    coordinate_to_tuple(spec[key])
                else:
                    rectangle(spec[key])
    return sheets


def font_metadata(path):
    with ZipFile(path) as archive:
        styles = ET.fromstring(archive.read("xl/styles.xml"))
        fonts = styles.find("s:fonts", NS)
        xfs = styles.find("s:cellXfs", NS)
        default = fonts[int(xfs[0].get("fontId", "0"))]
        if "xl/theme/theme1.xml" in archive.namelist():
            theme = ET.fromstring(archive.read("xl/theme/theme1.xml"))
        else:
            theme = None
    name = default.find("s:name", NS)
    size = default.find("s:sz", NS)
    scheme = default.find("s:scheme", NS)
    return {"name": name.get("val") if name is not None else None,
            "size": float(size.get("val")) if size is not None else None,
            "scheme": scheme.get("val") if scheme is not None else None}, theme


def theme_names(theme, scheme):
    """Latin and Chinese font roles relevant to this roster skill."""
    if theme is None or scheme not in ("major", "minor"):
        return {}
    group = theme.find(f".//a:fontScheme/a:{scheme}Font", NS)
    if group is None:
        return {}
    result = {}
    for role in ("latin", "ea", "cs"):
        item = group.find("a:"+role, NS)
        if item is not None and item.get("typeface"):
            result[role] = item.get("typeface")
    chinese = group.find("a:font[@script='Hans']", NS)
    if chinese is not None and chinese.get("typeface"):
        result["Hans"] = chinese.get("typeface")
    return result


def check(path, contract, max_cells, max_details):
    specs = validate_contract(contract)
    before = digest(path)
    workbook = load_workbook(path, data_only=False, read_only=False, keep_links=True)
    default, theme = font_metadata(path)
    findings, checks, missing, omitted = [], 0, 0, 0

    def compare(sheet, target, rule, actual, expected):
        nonlocal checks, omitted
        checks += 1
        if actual != expected:
            finding = {"sheet": sheet, "target": target, "rule": rule,
                       "actual": actual, "expected": expected}
            if len(findings) < max_details:
                findings.append(finding)
            else:
                omitted += 1

    def compare_font(name, target, actual, expected):
        for field in ("name", "size"):
            if field in expected:
                compare(name, target, "font."+field, actual.get(field), expected[field])
        if "name" in expected and actual.get("scheme"):
            resolved = theme_names(theme, actual["scheme"])
            if not resolved:
                compare(name, target, "font.theme", None, expected["name"])
            for role, family in resolved.items():
                compare(name, target, "font.theme."+role, family, expected["name"])

    try:
        if not contract.get("allowExtraSheets", True):
            compare(None, "workbook", "sheet.names", sorted(workbook.sheetnames), sorted(specs))
        for name, spec in specs.items():
            compare(name, "worksheet", "sheet.exists", name in workbook.sheetnames, True)
            if name not in workbook.sheetnames:
                continue
            sheet = workbook[name]
            left, top, right, bottom = rectangle(spec["range"])
            count = (right-left+1)*(bottom-top+1)
            if count > max_cells:
                missing += 1
                if len(findings) < max_details:
                    findings.append({"sheet": name, "target": spec["range"], "rule": "coverage",
                                     "actual": "not_covered", "expected": f"at most {max_cells} cells; requested {count}"})
                else:
                    omitted += 1
                continue
            if "headers" in spec:
                compare(name, f"row:{top}", "headers", [sheet.cell(top, c).value for c in range(left, right+1)], spec["headers"])
            if "dataRows" in spec:
                populated = sum(any(sheet.cell(r, c).value is not None for c in range(left, right+1)) for r in range(top+1, bottom+1))
                compare(name, spec["range"], "dataRows", populated, spec["dataRows"])
            if "freezePanes" in spec:
                row, col = coordinate_to_tuple(spec["freezePanes"] or "A1")
                pane = sheet.sheet_view.pane
                frozen = pane is not None and pane.state in ("frozen", "frozenSplit")
                # topLeftCell is a scroll offset, not the number of frozen rows.
                actual = [pane.ySplit or 0, pane.xSplit or 0] if frozen else [0, 0]
                compare(name, "pane", "freeze.split", actual, [row-1, col-1])
            if "autoFilter" in spec:
                actual = sheet.auto_filter.ref.upper() if sheet.auto_filter.ref else None
                expected = spec["autoFilter"].upper() if spec["autoFilter"] else None
                compare(name, "autoFilter", "filter.range", actual, expected)
            if "font" in spec:
                compare_font(name, "workbook:default", default, spec["font"])
                for col, dimension in sheet.column_dimensions.items():
                    if dimension.min <= right and dimension.max >= left:
                        font = dimension.font
                        compare_font(name, "column:"+col, {"name": font.name, "size": font.sz, "scheme": font.scheme}, spec["font"])
                for r, dimension in sheet.row_dimensions.items():
                    if top <= r <= bottom and dimension.has_style:
                        font = dimension.font
                        compare_font(name, "row:"+str(r), {"name": font.name, "size": font.sz, "scheme": font.scheme}, spec["font"])
            for r in range(top, bottom+1):
                if "rowHeight" in spec:
                    height = sheet.row_dimensions[r].height
                    compare(name, "row:"+str(r), "row.height", sheet.sheet_format.defaultRowHeight if height is None else height, spec["rowHeight"])
                for col in range(left, right+1):
                    cell = sheet.cell(r, col)
                    if "font" in spec:
                        font = cell.font
                        compare_font(name, cell.coordinate, {"name": font.name, "size": font.sz, "scheme": font.scheme}, spec["font"])
                    if r == top and "headerAlignment" in spec:
                        for axis, value in spec["headerAlignment"].items():
                            compare(name, cell.coordinate, "alignment."+axis, getattr(cell.alignment, axis), value)
    finally:
        workbook.close()
    after = digest(path)
    compare(None, "workbook", "input.sha256", after, before)
    failures = len(findings)+omitted-missing
    status = "fail" if failures else "not_covered" if missing else "pass"
    return {"status": status, "sha256Before": before, "sha256After": after,
            "checks": checks, "failureCount": failures, "uncoveredCount": missing,
            "findings": findings, "omittedFindings": omitted,
            "coverage": "declared rectangles and their defaults; no rendering or business qualification validation"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workbook", required=True, type=Path)
    parser.add_argument("--contract", required=True, type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--max-cells", type=int, default=1000000)
    parser.add_argument("--max-details", type=int, default=200)
    args = parser.parse_args()
    try:
        if args.max_cells < 1 or args.max_details < 1:
            raise ValueError("limits must be positive")
        if args.output:
            for source in (args.workbook, args.contract):
                if args.output.resolve() == source.resolve() or (args.output.exists() and source.exists() and args.output.samefile(source)):
                    raise ValueError("output must differ from both inputs")
        contract = json.loads(args.contract.read_text(encoding="utf-8"))
        report = check(args.workbook, contract, args.max_cells, args.max_details)
    except Exception as error:
        report = {"status": "error", "error": str(error)}
    encoded = json.dumps(report, ensure_ascii=False, indent=2, default=str)+"\n"
    if args.output and report["status"] != "error":
        try:
            args.output.write_text(encoded, encoding="utf-8")
        except OSError as error:
            report = {"status": "error", "error": str(error)}
            encoded = json.dumps(report, ensure_ascii=False, indent=2)+"\n"
    sys.stdout.write(encoded)
    return {"pass": 0, "fail": 1, "not_covered": 2, "error": 2}[report["status"]]


if __name__ == "__main__":
    raise SystemExit(main())
