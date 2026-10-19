# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""Read files only at source; recover WAL and sqlite-backup ONLY inside output dir.

Fail closed if main/WAL changes during copying/hash verification. No source
SQLite connection (even a read-only connection can touch shared-memory files).
The source directory must be quiet; retry later if it is not. Never copy SHM.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument("--source", required=True)
parser.add_argument("--output-dir", required=True)
args = parser.parse_args()
source = Path(args.source).resolve(strict=True)
out = Path(args.output_dir).resolve()
if out.exists() or out == source.parent or source.is_relative_to(out):
    raise SystemExit("Output must be a new isolated directory, outside source")
out.mkdir(mode=0o700, parents=True)

def state():
    result = {}
    for path in (source, Path(str(source) + "-wal")):
        if path.exists():
            stat = path.stat()
            result[str(path)] = [stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns]
    return result

def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()

before = state()
try:
    with tempfile.TemporaryDirectory(prefix="capture-", dir=out) as staging:
        stage = Path(staging) / "roster.db"
        hashes = {}
        for name in before:
            original = Path(name)
            target = stage if original == source else Path(str(stage) + "-wal")
            shutil.copyfile(original, target)
            os.chmod(target, 0o600)
            hashes[name] = digest(target)
        if before != state() or any(digest(Path(name)) != sha for name, sha in hashes.items()) or before != state():
            raise RuntimeError("Source main/WAL changed: capture rejected; retry in a quiet interval")
        # Recovery/SHM/checkpoint can only occur on the private staged files.
        src = sqlite3.connect(stage)
        dst = sqlite3.connect(out / "roster.db")
        src.backup(dst)
        if dst.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise RuntimeError("Integrity check failed")
        foreign_keys = dst.execute("PRAGMA foreign_key_check").fetchall()
        counts = {name: dst.execute(f'SELECT count(*) FROM "{name}"').fetchone()[0]
                  for (name,) in dst.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")}
        dst.close()
        src.close()
    os.chmod(out / "roster.db", 0o600)
    provenance = {"source_files": before, "source_sha256": hashes,
                  "snapshot_sha256": digest(out / "roster.db"), "counts": counts,
                  "integrity": "ok", "foreign_key_violations": len(foreign_keys),
                  "method": "stable main/WAL file copy + source hash equality + private recovery + SQLite backup"}
    (out / "provenance.private.json").write_text(json.dumps(provenance, indent=2) + "\n")
    os.chmod(out / "provenance.private.json", 0o600)
    print(json.dumps({"output": str(out), "counts": counts, "integrity": "ok", "foreign_key_violations": len(foreign_keys)}))
except BaseException:
    shutil.rmtree(out)
    raise
