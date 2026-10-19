# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""Create disposable 0x/2x/5x workload replicas, NEVER semantic fixtures.

Each replica preserves raw HTML/JSON byte distributions and FK topology. Numeric
IDs/FKs and uniqueness coordinates are remapped. Nested JSON IDs/identities are
deliberately untouched: do not use replicas to validate business conclusions.
"""
import argparse
import ctypes
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys

parser = argparse.ArgumentParser()
parser.add_argument("--source", required=True)
parser.add_argument("--output", required=True)
parser.add_argument("--factor", type=int, choices=[0, 2, 5], required=True)
parser.add_argument("--clone-seed", action="store_true", help="Require CoW clone (macOS clonefile; Node elsewhere) of a stable WAL-free isolated seed")
parser.add_argument("--reserve-gib", type=float, default=8, help="Free disk reserve; does not change runtime heap/SLO budgets")
args = parser.parse_args()
source, output = Path(args.source).resolve(), Path(args.output).resolve()
if "/production-docker/" in str(source) or output.exists() or source == output:
    raise SystemExit("Isolated source and new output required")
output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
reserve = max(4, args.reserve_gib) * 1024 ** 3
initial_free = shutil.disk_usage(output.parent).free
estimated = source.stat().st_size * max(1, args.factor - (1 if args.clone_seed else 0))
if initial_free < estimated + reserve:
    raise SystemExit("Disk reserve beyond estimated output not available; reclaim owned replicas first")
if args.clone_seed:
    wal = Path(str(source) + "-wal")
    if wal.exists() and wal.stat().st_size:
        raise SystemExit("Clone seed requires a stable isolated database with no nonempty WAL")
    if sys.platform == 'darwin':
        libc = ctypes.CDLL(None, use_errno=True)
        clone = libc.clonefile
        clone.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_int]
        clone.restype = ctypes.c_int
        if clone(os.fsencode(source), os.fsencode(output), 0) != 0:
            code = ctypes.get_errno()
            raise OSError(code, os.strerror(code))
    else:
        subprocess.run(["node", "--input-type=module", "-e",
                        "import fs from 'node:fs'; fs.copyFileSync(process.argv[1],process.argv[2],fs.constants.COPYFILE_FICLONE_FORCE)",
                        str(source), str(output)], check=True)
src = sqlite3.connect(source.as_uri() + "?mode=ro", uri=True)
dst = sqlite3.connect(output, uri=True)
if not args.clone_seed:
    src.backup(dst)
dst.execute("PRAGMA journal_mode=DELETE")
dst.execute("PRAGMA foreign_keys=OFF")
dst.execute("DELETE FROM service_credential")
tables = [name for (name,) in src.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
          if name not in ["title", "__drizzle_migrations", "service_credential"]]
if args.factor == 0:
    for name in tables:
        dst.execute(f'DELETE FROM "{name}"')
else:
    dst.execute("ATTACH DATABASE ? AS base", (source.as_uri() + "?mode=ro",))
    strides = {name: src.execute(f'SELECT coalesce(max(id),0)+1 FROM "{name}"').fetchone()[0]
               for name in tables if any(c[1] == "id" and c[2].upper() == "INTEGER" for c in src.execute(f'PRAGMA table_info("{name}")'))}
    for replica in range(1, args.factor):
        for name in tables:
            if shutil.disk_usage(output.parent).free < reserve:
                raise RuntimeError("Host disk reserve reached; incomplete replica is not benchmark evidence")
            columns = src.execute(f'PRAGMA table_info("{name}")').fetchall()
            foreign = {row[3]: row[2] for row in src.execute(f'PRAGMA foreign_key_list("{name}")')}
            expressions = []
            for _, col, kind, _, _, primary in columns:
                expr = f'"{col}"'
                target = name if col == "id" and name in strides else foreign.get(col)
                if target in strides:
                    expr = f'{expr}+{strides[target] * replica}'
                elif (primary and kind.upper() == "TEXT") or col in ["uscc_norm", "query_key", "idempotency_key", "rel_path"] or (name == "platform_export_batch" and col == "sha256"):
                    expr = f"{expr} || '~rep{replica}'"
                expressions.append(expr)
            cols = ','.join(f'"{c[1]}"' for c in columns)
            dst.execute(f'INSERT INTO "{name}" ({cols}) SELECT {",".join(expressions)} FROM base."{name}"')
        dst.commit()
dst.commit()
if args.factor == 0:
    dst.execute("VACUUM")
violations = len(dst.execute("PRAGMA foreign_key_check").fetchall())
integrity = dst.execute("PRAGMA integrity_check").fetchone()[0]
counts = {name: dst.execute(f'SELECT count(*) FROM "{name}"').fetchone()[0] for name in tables}
raw_bytes = {f"{name}.{col}": dst.execute(f'SELECT coalesce(sum(length(cast("{col}" as blob))),0) FROM "{name}"').fetchone()[0]
             for name, col in [("platform_query", "raw_response"), ("platform_relation", "raw_fields")]}
dst.close()
src.close()
os.chmod(output, 0o600)
print(json.dumps({"factor": args.factor, "bytes": output.stat().st_size, "integrity": integrity,
                  "clonedSeed": args.clone_seed, "diskReserveGiB": reserve / 1024 ** 3, "initialFreeBytes": initial_free,
                  "foreignKeyViolations": violations, "counts": counts,
                  "rawBytes": raw_bytes,
                  "limits": "Workload only: raw bytes unchanged, new uniqueness coordinates; embedded JSON identities not remapped; not semantic equivalence data"}))
