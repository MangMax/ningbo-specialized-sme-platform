# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""Read-only, streaming qualification of an already acquired online backup.

uv run scripts/perf227-snapshot.py RECEIPT.json NEW-REPORT.json
Never connect to a live DB; receipt.localPath must name the isolated backup.
Reports contain hashes/counts/schema only, never row values or credentials.
"""
import datetime
import hashlib
import json
import pathlib
import sqlite3
import sys

receipt_path, report_path = map(pathlib.Path, sys.argv[1:])
assert not report_path.exists(), "preserve prior evidence"
receipt = json.loads(receipt_path.read_text())
path = pathlib.Path(receipt["localPath"]).resolve(strict=True)
assert path.is_absolute() and path.stat().st_size == receipt["bytes"]
assert not any(pathlib.Path(str(path) + suffix).exists() for suffix in ["-wal", "-journal"]), "require finalized standalone backup"
with path.open("rb") as stream:
    digest = hashlib.file_digest(stream, "sha256").hexdigest()
assert digest == receipt["sha256"], "snapshot hash differs from acquisition receipt"
db = sqlite3.connect(path.as_uri() + "?mode=ro&immutable=1", uri=True)
db.execute("pragma query_only=on")
integrity = [r[0] for r in db.execute("pragma integrity_check")]
foreign_keys = sum(1 for _ in db.execute("pragma foreign_key_check"))
report = {"at": datetime.datetime.now(datetime.timezone.utc).isoformat(), "receipt": receipt,
          "sha256": digest, "bytes": path.stat().st_size, "integrity": integrity,
          "fkViolationCount": foreign_keys, "tables": {}, "schema": {}}
for (name,) in db.execute("select name from sqlite_master where type='table' order by name"):
    quoted = '"' + name.replace('"', '""') + '"'
    report["schema"][name] = [r[1] for r in db.execute("pragma table_info(" + quoted + ")")]
    rows_hash, count = hashlib.sha256(), 0
    # Stream one row at a time; include all business and audit columns. No SQL writes.
    for row in db.execute("select * from " + quoted + " order by rowid"):
        rows_hash.update(json.dumps(row, ensure_ascii=False, separators=(",", ":"),
                                   default=lambda x: {"bytes": x.hex()}).encode())
        rows_hash.update(b"\n")
        count += 1
    report["tables"][name] = {"count": count, "rowsSha256": rows_hash.hexdigest()}
db.close()
report_path.parent.mkdir(parents=True, exist_ok=True)
with report_path.open("x") as stream:
    json.dump(report, stream, indent=2)
report_path.chmod(0o600)
assert integrity == ["ok"] and foreign_keys == 0, "qualification failed; report retained"
print(json.dumps({"sha256": digest, "integrity": integrity, "foreignKeys": foreign_keys,
                  "tables": len(report["tables"])}))
