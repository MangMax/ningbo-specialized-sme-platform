# /// script
# requires-python = ">=3.12"
# dependencies = ["openpyxl>=3.1,<4"]
# ///
"""Public CLI checks using independently constructed small workbooks."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from openpyxl import Workbook
from openpyxl.styles import Alignment, Font

SCRIPT = Path(__file__).with_name("check-workbook-layout.py")


class WorkbookLayoutCli(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.path = self.root/"input.xlsx"
        self.contract = {"allowExtraSheets": False, "sheets": {"名单": {
            "range": "A1:B3", "headers": ["企业名称", "统一社会信用代码"],
            "dataRows": 2, "font": {"name": "微软雅黑", "size": 12},
            "rowHeight": 40, "headerAlignment": {"horizontal": "center", "vertical": "center"},
            "freezePanes": "A2", "autoFilter": "A1:B3"}}}

    def book(self):
        book = Workbook()
        book._fonts[0] = Font(name="微软雅黑", size=12)
        sheet = book.active
        sheet.title = "名单"
        sheet.append(["企业名称", "统一社会信用代码"])
        sheet.append(["样例甲", "123456789012345678"])
        sheet.append(["样例乙", "223456789012345678"])
        for row in sheet:
            for cell in row:
                cell.font = Font(name="微软雅黑", size=12)
        for cell in sheet[1]:
            cell.alignment = Alignment(horizontal="center", vertical="center")
        for row in range(1, 4):
            sheet.row_dimensions[row].height = 40
        sheet.freeze_panes = "A2"
        sheet.auto_filter.ref = "A1:B3"
        return book

    def run_cli(self, book, contract=None, extra=()):
        book.save(self.path)
        spec = self.root/"contract.json"
        spec.write_text(json.dumps(self.contract if contract is None else contract), encoding="utf-8")
        before = hashlib.sha256(self.path.read_bytes()).hexdigest()
        result = subprocess.run([sys.executable, str(SCRIPT), "--workbook", str(self.path),
                                 "--contract", str(spec), *extra], capture_output=True, text=True)
        self.assertEqual(before, hashlib.sha256(self.path.read_bytes()).hexdigest())
        self.assertFalse(result.stderr, result.stderr)
        return result.returncode, json.loads(result.stdout)

    def test_valid_contract_passes_and_scrolled_pane_still_freezes_one_row(self):
        book = self.book()
        book.active.sheet_view.pane.topLeftCell = "A94"
        code, report = self.run_cli(book)
        self.assertEqual((code, report["status"], report["failureCount"]), (0, "pass", 0))

    def test_default_font_mismatch_is_caught_despite_matching_filled_cells(self):
        book = self.book()
        book._fonts[0] = Font(name="Calibri", size=11)
        code, report = self.run_cli(book)
        self.assertEqual(code, 1)
        self.assertTrue(any(f["target"] == "workbook:default" and f["rule"] == "font.name" for f in report["findings"]))

    def test_row_column_defaults_and_used_theme_are_checked(self):
        book = self.book()
        sheet = book.active
        sheet.row_dimensions[2].font = Font(name="宋体", size=12)
        sheet.column_dimensions["B"].font = Font(name="宋体", size=12)
        sheet["A3"].font = Font(name="微软雅黑", size=12, scheme="minor")
        code, report = self.run_cli(book)
        self.assertEqual(code, 1)
        targets = {f["target"] for f in report["findings"]}
        self.assertTrue({"row:2", "column:B", "A3"} <= targets)
        self.assertTrue(any(f["rule"].startswith("font.theme.") for f in report["findings"]))

    def test_unused_alternative_font_does_not_fail(self):
        book = self.book()
        book._fonts.append(Font(name="Arial", size=10))
        code, report = self.run_cli(book)
        self.assertEqual((code, report["status"]), (0, "pass"))

    def test_filter_height_alignment_and_frozen_rows_have_separate_failures(self):
        book = self.book()
        sheet = book.active
        sheet.auto_filter.ref = "A1:B2"
        sheet.row_dimensions[2].height = 24
        sheet["A1"].alignment = Alignment(horizontal="left", vertical="center")
        sheet.freeze_panes = None
        code, report = self.run_cli(book)
        self.assertEqual(code, 1)
        self.assertTrue({"filter.range", "row.height", "alignment.horizontal", "freeze.split"} <= {f["rule"] for f in report["findings"]})

    def test_missing_sheet_and_header_are_failures(self):
        book = self.book()
        book.active["B1"] = "错误表头"
        self.contract["sheets"]["必备附表"] = {"range": "A1", "headers": ["企业名称"]}
        code, report = self.run_cli(book)
        self.assertEqual(code, 1)
        self.assertTrue({"headers", "sheet.exists"} <= {f["rule"] for f in report["findings"]})

    def test_empty_or_unknown_contract_is_error_not_pass(self):
        for contract in ({"sheets": {}}, {"sheets": {"名单": {"range": "A1:B3", "unsupported": True}}}):
            with self.subTest(contract=contract):
                code, report = self.run_cli(self.book(), contract)
                self.assertEqual((code, report["status"]), (2, "error"))

    def test_scope_limit_reports_not_covered(self):
        code, report = self.run_cli(self.book(), extra=("--max-cells", "2"))
        self.assertEqual((code, report["status"], report["uncoveredCount"]), (2, "not_covered", 1))

    def test_unspecified_font_is_not_assumed_and_input_cannot_be_output(self):
        book = self.book()
        contract = {"sheets": {"名单": {"range": "A1:B3", "autoFilter": "A1:B3"}}}
        book.active["A2"].font = Font(name="宋体", size=9)
        code, report = self.run_cli(book, contract)
        self.assertEqual((code, report["status"]), (0, "pass"))
        code, report = self.run_cli(book, contract, extra=("--output", str(self.path)))
        self.assertEqual((code, report["status"]), (2, "error"))

    def test_hardlink_output_cannot_overwrite_workbook(self):
        book = self.book()
        book.save(self.path)
        linked = self.root/"same-inode.json"
        os.link(self.path, linked)
        # run_cli saves the same source inode; its guard must still reject it.
        code, report = self.run_cli(book, extra=("--output", str(linked)))
        self.assertEqual((code, report["status"]), (2, "error"))

    def test_unwritable_output_returns_structured_error(self):
        code, report = self.run_cli(self.book(), extra=("--output", str(self.root/"missing"/"result.json")))
        self.assertEqual((code, report["status"]), (2, "error"))


if __name__ == "__main__":
    unittest.main()
