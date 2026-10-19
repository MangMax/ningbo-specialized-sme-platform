# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""Copy only DB-registered source files to a NEW private root, verify saved hashes.

Reads the isolated DB, never the source/business DB. Missing source files are
counted explicitly; no private filenames/content are printed.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3

parser = argparse.ArgumentParser()
parser.add_argument("--db", required=True)
parser.add_argument("--source-root", required=True)
parser.add_argument("--output-root", required=True)
args = parser.parse_args()
db_path, source, output = Path(args.db).resolve(), Path(args.source_root).resolve(), Path(args.output_root).resolve()
if "/production-docker/" in str(db_path) or output.exists() or output.is_relative_to(source) or source.is_relative_to(output):
    raise SystemExit("Isolated DB, distinct source and NEW private output required")
db = sqlite3.connect(db_path.as_uri() + "?mode=ro", uri=True)
rows = db.execute("SELECT rel_path,bytes,sha256 FROM stored_file").fetchall()
db.close()
output.mkdir(mode=0o700, parents=True)
copied, missing, total = 0, 0, 0
for relative, expected_size, expected_sha in rows:
    rel = Path(relative)
    original, target = (source / rel).resolve(), output / rel
    if rel.is_absolute() or ".." in rel.parts or not original.is_relative_to(source):
        raise RuntimeError("Unsafe registered path")
    if not original.is_file():
        missing += 1
        continue
    before = original.stat()
    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    shutil.copyfile(original, target)
    os.chmod(target, 0o600)
    with target.open("rb") as stream:
        sha = hashlib.file_digest(stream, "sha256").hexdigest()
    after = original.stat()
    if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns) or target.stat().st_size != expected_size or sha != expected_sha:
        raise RuntimeError("Source changed or differs from saved DB identity; copied input rejected")
    copied += 1
    total += expected_size
print(json.dumps({"registered": len(rows), "copied": copied, "missing": missing, "bytes": total, "verified_hashes": copied}))
