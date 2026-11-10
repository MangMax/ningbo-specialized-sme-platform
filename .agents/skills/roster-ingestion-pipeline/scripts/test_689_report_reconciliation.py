# /// script
# requires-python = ">=3.12"
# dependencies = ["openpyxl>=3.1,<4"]
# ///
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from zipfile import ZipFile

from openpyxl import Workbook

SCRIPT = Path(__file__).with_name("reconcile-roster-reports.py")


class ReconciliationCli(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.before, self.after = self.root/"before.json", self.root/"after.json"
        self.contract = {"keyKind": "id", "before": self.spec(), "after": self.spec()}

    def spec(self):
        return {"identityColumn": "ID", "nameColumn": "名称", "noteColumns": ["备注"],
                "metadata": {"titleCode": "specialized_sme", "asOf": "2026-11-10", "ruleVersion": "v11", "snapshotId": "frozen"}}

    def row(self, key, name="示例企业", note=""):
        return {"ID": key, "名称": name, "备注": note}

    def run_cli(self, before, after, reasons=None):
        self.before.write_text(json.dumps(before), encoding="utf-8")
        self.after.write_text(json.dumps(after), encoding="utf-8")
        return self.invoke(reasons)

    def invoke(self, reasons=None, extra=()):
        contract = self.root/"contract.json"
        contract.write_text(json.dumps(self.contract), encoding="utf-8")
        command = [sys.executable, str(SCRIPT), "--before", str(self.before), "--after", str(self.after), "--contract", str(contract)]
        if reasons is not None:
            path = self.root/"reasons.json"
            path.write_text(json.dumps(reasons), encoding="utf-8")
            command += ["--reasons", str(path)]
        inputs = [self.before, self.after, contract]
        hashes = [hashlib.sha256(p.read_bytes()).hexdigest() for p in inputs]
        result = subprocess.run([*command, *extra], capture_output=True, text=True)
        self.assertFalse(result.stderr, result.stderr)
        self.assertEqual(hashes, [hashlib.sha256(p.read_bytes()).hexdigest() for p in inputs])
        return result.returncode, json.loads(result.stdout)

    def test_234_to_232_preserves_two_unexplained_removals(self):
        before = [self.row(str(n)) for n in range(1, 235)]
        after = [self.row(str(n)) for n in range(1, 233)]
        code, report = self.run_cli(before, after)
        self.assertEqual((code, report["status"]), (1, "needs_explanation"))
        self.assertEqual({r["identity"] for r in report["changes"]["removed"]}, {"233", "234"})
        self.assertEqual(len(report["changes"]["retained"]), 232)
        self.assertTrue(all(r["systemCorrection"] == "unknown" and r["externalAction"] == "unknown" for r in report["changes"]["removed"]))

    def test_same_name_different_ids_are_not_merged(self):
        code, report = self.run_cli([self.row("1")], [self.row("2")])
        self.assertEqual(code, 1)
        self.assertEqual([r["identity"] for r in report["changes"]["added"]], ["2"])
        self.assertEqual([r["identity"] for r in report["changes"]["removed"]], ["1"])

    def test_same_id_new_name_is_retained_and_requires_explanation(self):
        code, report = self.run_cli([self.row("1", "旧名")], [self.row("1", "新名")])
        self.assertEqual(code, 1)
        self.assertEqual(report["changes"]["added"], [])
        self.assertEqual(report["changes"]["removed"], [])
        self.assertTrue(report["changes"]["retained"][0]["nameChanged"])

    def test_duplicate_id_blocks_both_sides_and_keeps_all_row_coordinates(self):
        code, report = self.run_cli([self.row("1"), self.row("1"), self.row("")], [self.row("1")])
        self.assertEqual((code, report["status"]), (2, "identity_issues"))
        blocked = report["ambiguousIdentities"][0]
        self.assertEqual([r["row"] for r in blocked["before"]], [1, 2])
        self.assertEqual(len(blocked["after"]), 1)
        self.assertEqual(len(report["invalidRows"]), 1)
        self.assertEqual(report["changes"]["added"], [])

    def test_explicit_claims_and_three_completion_states_remain_distinct(self):
        claims = {"2": {"reason": "人工排除，具体原因为原文说明", "source": "用户说明", "investigation": "completed", "systemCorrection": "not_requested", "externalAction": "pending", "note": "备注原文"}}
        code, report = self.run_cli([self.row("1"), self.row("2")], [self.row("1")], claims)
        self.assertEqual((code, report["status"]), (0, "ok"))
        removed = report["changes"]["removed"][0]
        self.assertEqual(removed["claims"], claims["2"])
        self.assertEqual(removed["explanationStatus"], "provided_not_verified")
        self.assertFalse(report["businessDecisionsMade"])

    def test_rule_change_is_context_not_invented_data_repair(self):
        self.contract["before"]["metadata"]["ruleVersion"] = "v10"
        code, report = self.run_cli([self.row("1")], [self.row("1"), self.row("2")])
        self.assertEqual(code, 1)
        self.assertIn("ruleVersion", report["contextChanges"])
        self.assertEqual(report["changes"]["added"][0]["claims"], {})

    def test_numeric_or_malformed_uscc_is_not_guessed(self):
        self.contract["keyKind"] = "uscc"
        code, report = self.run_cli([self.row(123456789012345678)], [self.row("short")])
        self.assertEqual(code, 2)
        self.assertEqual(len(report["invalidRows"]), 2)

    def test_missing_metadata_and_cross_title_context_are_errors(self):
        for mutation in ("missing", "title"):
            with self.subTest(mutation=mutation):
                self.contract["after"] = self.spec()
                if mutation == "missing":
                    del self.contract["after"]["metadata"]["snapshotId"]
                else:
                    self.contract["after"]["metadata"]["titleCode"] = "little_giant"
                code, report = self.run_cli([], [])
                self.assertEqual((code, report["status"]), (2, "error"))

    def test_xlsx_incorrect_a1_dimension_does_not_truncate_rows(self):
        self.before, self.after = self.root/"before.xlsx", self.root/"after.xlsx"
        for side, path in (("before", self.before), ("after", self.after)):
            self.contract[side]["sheet"] = "名单"
            book = Workbook()
            book.active.title = "名单"
            book.active.append(["ID", "名称", "备注"])
            book.active.append(["1", "甲", "人工原文"])
            book.active.append(["2", "乙", ""])
            book.save(path)
            with ZipFile(path) as archive:
                entries = [(i, archive.read(i.filename)) for i in archive.infolist()]
            with ZipFile(path, "w") as archive:
                for info, data in entries:
                    if info.filename == "xl/worksheets/sheet1.xml":
                        data = data.replace(b'ref="A1:C3"', b'ref="A1"')
                    archive.writestr(info, data)
        code, report = self.invoke()
        self.assertEqual(code, 0)
        self.assertEqual(len(report["changes"]["retained"]), 2)
        self.assertEqual(report["changes"]["retained"][0]["before"]["notes"], {"备注": "人工原文"})

    def test_reordering_is_not_membership_change_and_reports_are_executable(self):
        code, report = self.run_cli([self.row("1"), self.row("2")], [self.row("2"), self.row("1")])
        self.assertEqual(code, 0)
        out, text = self.root/"receipt.json", self.root/"report.txt"
        code, report = self.invoke(extra=("--output", str(out), "--report", str(text)))
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out.read_text())["status"], "ok")
        self.assertIn("移除：0", text.read_text())
        code, report = self.invoke(extra=("--output", str(self.before)))
        self.assertEqual((code, report["status"]), (2, "error"))


if __name__ == "__main__":
    unittest.main()
