# /// script
# requires-python = ">=3.12"
# dependencies = ["openpyxl>=3.1,<4"]
# ///
from copy import deepcopy
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from openpyxl import Workbook, load_workbook
from openpyxl.styles import Font

SCRIPT = Path(__file__).with_name("compare-workbook-values.py")


class ValuesCli(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.before, self.after = self.root/"before.xlsx", self.root/"after.xlsx"
        spec = {"sheet": "名单", "keyColumn": "代码", "fields": {"代码": "代码", "名称": "名称"}}
        self.contract = {"keyKind": "uscc", "sheets": {"名单": {"before": deepcopy(spec), "after": deepcopy(spec), "preserve": ["freezePanes", "autoFilter"]}}}
        self.rows = [["913000000000000001", "企业甲"], ["913000000000000002", "企业乙"]]
        self.book(self.before, self.rows)
        self.book(self.after, self.rows)

    def book(self, path, rows, headers=("代码", "名称")):
        w = Workbook()
        s = w.active
        s.title = "名单"
        s.append(list(headers))
        for row in rows:
            s.append(row)
        s.freeze_panes = "A2"
        s.auto_filter.ref = f"A1:B{len(rows)+1}"
        w.save(path)
        w.close()

    def edit(self, callback):
        w = load_workbook(self.after)
        callback(w)
        w.save(self.after)
        w.close()

    def invoke(self, extra=()):
        contract = self.root/"contract.json"
        contract.write_text(json.dumps(self.contract), encoding="utf-8")
        inputs = [self.before, self.after, contract]
        hashes = {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in inputs}
        run = subprocess.run([sys.executable, str(SCRIPT), "--before", str(self.before), "--after", str(self.after), "--contract", str(contract), *map(str, extra)], capture_output=True, text=True)
        self.assertEqual(run.stderr, "")
        result = json.loads(run.stdout)
        self.assertEqual(hashes, {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in inputs})
        if "inputHashes" in result:
            self.assertEqual(result["inputHashes"], hashes)
            self.assertEqual(result["inputHashesAfter"], hashes)
        return run.returncode, result

    def test_complete_text_code_and_reordered_rows_pass(self):
        self.book(self.after, list(reversed(self.rows)))
        code, r = self.invoke()
        self.assertEqual((code, r["status"]), (0, "pass"))
        self.assertEqual(r["differences"], [])
        self.assertEqual(r["counts"], {"名单": {"before": 2, "after": 2}})
        self.assertIn("not_evaluated", r["rendering"])

    def test_number_replacing_text_code_is_invalid_not_guessed(self):
        self.edit(lambda w: setattr(w.active["A2"], "value", 913000000000000001))
        code, r = self.invoke()
        self.assertEqual((code, r["status"]), (2, "not_covered"))
        issue = r["identityIssues"][0]
        self.assertEqual((issue["side"], issue["sheet"], issue["row"]), ("after", "名单", 2))
        self.assertEqual(issue["actual"]["type"], "n")

    def test_truncated_code_is_not_matched_by_name(self):
        self.edit(lambda w: setattr(w.active["A2"], "value", "91300000000000000"))
        code, r = self.invoke()
        self.assertEqual(code, 2)
        self.assertEqual(r["identityIssues"][0]["actual"]["value"], "91300000000000000")

    def test_native_value_and_type_change_locates_key_field_rows(self):
        self.edit(lambda w: setattr(w.active["B2"], "value", 123))
        code, r = self.invoke()
        self.assertEqual(code, 1)
        diff = r["differences"][0]
        self.assertEqual((diff["logicalSheet"], diff["key"], diff["field"], diff["beforeRow"], diff["afterRow"]), ("名单", self.rows[0][0], "名称", 2, 2))
        self.assertEqual(diff["before"], {"type": "s", "pythonType": "str", "value": "企业甲"})
        self.assertEqual(diff["after"], {"type": "n", "pythonType": "int", "value": 123})

    def test_text_to_numeric_non_key_field_detects_type_even_when_display_matches(self):
        self.book(self.before, [[self.rows[0][0], "123"]])
        self.book(self.after, [[self.rows[0][0], 123]])
        code, r = self.invoke()
        self.assertEqual(code, 1)
        self.assertEqual((r["differences"][0]["before"]["type"], r["differences"][0]["after"]["type"]), ("s", "n"))

    def test_duplicate_blocks_both_sides_and_empty_key_is_explicit(self):
        self.book(self.after, [self.rows[0], self.rows[0], [None, "缺码"]])
        code, r = self.invoke()
        self.assertEqual(code, 2)
        duplicate = next(i for i in r["identityIssues"] if i["problem"] == "duplicate_key")
        self.assertEqual(duplicate["rows"], {"before": [2], "after": [2, 3]})
        self.assertTrue(any(i["problem"] == "invalid_or_missing_key" and i["row"] == 4 for i in r["identityIssues"]))
        self.assertFalse(any(d.get("key") == self.rows[0][0] for d in r["differences"]))

    def test_font_edit_does_not_allow_business_or_freeze_changes(self):
        self.edit(lambda w: setattr(w.active["B2"], "font", Font(name="微软雅黑", size=12)))
        self.assertEqual(self.invoke()[0], 0)
        self.edit(lambda w: setattr(w.active, "freeze_panes", "B3"))
        code, r = self.invoke()
        self.assertEqual(code, 1)
        self.assertEqual([d["kind"] for d in r["differences"]], ["freezePanes"])
        self.edit(lambda w: setattr(w.active["B2"], "value", "误改"))
        self.assertEqual({d["kind"] for d in self.invoke()[1]["differences"]}, {"cell", "freezePanes"})

    def test_filter_change_and_unapproved_member_are_outside_boundary(self):
        self.edit(lambda w: setattr(w.active.auto_filter, "ref", "A1:B2"))
        self.assertEqual([d["kind"] for d in self.invoke()[1]["differences"]], ["autoFilter"])
        self.book(self.after, self.rows[:1])
        self.assertEqual({d["kind"] for d in self.invoke()[1]["differences"]}, {"removed_key", "autoFilter"})

    def test_explicit_members_fields_and_cell_changes_reported_as_permitted(self):
        spec = self.contract["sheets"]["名单"]
        spec["preserve"] = ["freezePanes"]
        spec["after"]["fields"]["备注"] = "备注"
        spec["allow"] = {"addedKeys": ["913000000000000003"], "removedKeys": [self.rows[1][0]], "addedFields": ["备注"], "changedCells": [{"key": self.rows[0][0], "field": "名称"}]}
        self.book(self.after, [[self.rows[0][0], "新名", "备注"], ["913000000000000003", "新企业", ""]], ("代码", "名称", "备注"))
        code, r = self.invoke()
        self.assertEqual((code, r["status"]), (0, "pass"))
        self.assertEqual(r["differences"], [])
        self.assertEqual({d["kind"] for d in r["permittedChanges"]}, {"added_key", "removed_key", "added_field", "cell"})

    def test_unmapped_columns_and_sheets_never_pass(self):
        self.edit(lambda w: setattr(w.active["C1"], "value", "未映射列"))
        code, r = self.invoke()
        self.assertEqual(code, 2)
        self.assertEqual(r["uncovered"][0]["problem"], "unmapped_field")
        self.book(self.after, self.rows)
        self.edit(lambda w: w.create_sheet("底稿"))
        self.assertEqual(self.invoke()[0], 2)
        self.contract["excludedSheets"] = {"after": ["底稿"]}
        self.assertEqual(self.invoke()[0], 0)

    def test_missing_key_mapping_or_field_is_input_error(self):
        spec = self.contract["sheets"]["名单"]["after"]
        spec["keyColumn"] = "不存在"
        self.assertEqual(self.invoke()[0], 2)
        spec["keyColumn"] = "代码"
        spec["fields"]["名称"] = "不存在"
        code, r = self.invoke()
        self.assertEqual((code, r["status"]), (2, "error"))
        self.assertIn("mapped header", r["error"])

    def test_empty_requires_explicit_allowance_and_budget_is_coverage_error(self):
        self.book(self.before, [])
        self.book(self.after, [])
        self.assertEqual(self.invoke()[0], 2)
        for side in ("before", "after"):
            self.contract["sheets"]["名单"][side]["allowEmpty"] = True
        self.assertEqual(self.invoke()[0], 0)
        self.assertEqual(self.invoke(("--max-cells", "1"))[0], 2)

    def test_optional_preserved_properties_are_compared_by_identity(self):
        self.contract["sheets"]["名单"]["preserve"] = ["font", "numberFormat", "rowHeight"]
        def change(w):
            w.active["B2"].font = Font(name="微软雅黑", size=12)
            w.active["B2"].number_format = "@"
            w.active.row_dimensions[2].height = 40
        self.edit(change)
        code, r = self.invoke()
        self.assertEqual(code, 1)
        self.assertEqual({d["kind"] for d in r["differences"]}, {"font", "numberFormat", "rowHeight"})

    def test_readback_receipt_matches_stdout_and_cannot_overwrite_inputs_or_old_output(self):
        output = self.root/"receipt.json"
        code, r = self.invoke(("--output", output))
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(output.read_text()), r)
        old = output.read_bytes()
        code, fail = self.invoke(("--output", output))
        self.assertEqual(code, 2)
        self.assertNotEqual(r["runId"], fail["runId"])
        self.assertEqual(output.read_bytes(), old)
        for target in (self.before, self.root/"hardlink.xlsx", self.root/"symlink.xlsx"):
            if "hardlink" in target.name:
                os.link(self.before, target)
            elif "symlink" in target.name:
                target.symlink_to(self.before)
            self.assertEqual(self.invoke(("--output", target))[0], 2)
        self.assertEqual(self.invoke(("--output", self.root/"absent"/"receipt.json"))[0], 2)
        self.assertEqual(list(self.root.glob(".workbook-values-*")), [])


if __name__ == "__main__":
    unittest.main()
