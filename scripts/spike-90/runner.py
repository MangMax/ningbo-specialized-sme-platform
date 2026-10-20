"""Public HTTP/MCP semantic probe and small local timing sampler for poc.py."""
import argparse
import concurrent.futures
import json
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


def call(base, path, payload=None):
    data = json.dumps(payload, ensure_ascii=False).encode() if payload is not None else None
    request = urllib.request.Request(base + path, data=data, headers={"Content-Type": "application/json"})
    start = time.perf_counter_ns()
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            code, body = response.status, response.read()
    except urllib.error.HTTPError as error:
        code, body = error.code, error.read()
    return code, json.loads(body), (time.perf_counter_ns() - start) / 1e6


def mcp(base, name, arguments):
    code, body, elapsed = call(base, "/mcp", {"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                                               "params": {"name": name, "arguments": arguments}})
    return code, json.loads(body["result"]["content"][0]["text"]), body["result"]["isError"], elapsed


def pct(values, p):
    ordered = sorted(values)
    return round(ordered[max(0, min(len(ordered) - 1, int((len(ordered) - 1) * p + 0.5)))], 3)


def summary(values):
    return {"n": len(values), "p50_ms": pct(values, 0.5), "p95_ms": pct(values, 0.95),
            "p99_ms": pct(values, 0.99), "max_ms": round(max(values), 3)}


def sample(base, label, width, count, write, key):
    def one(i):
        if write:
            return call(base, "/api/commit", {"idempotencyKey": f"bench-{label}-{key}-{width}-{i}",
                                               "rawBody": "x" * 32768,
                                               "relations": ["synthetic-a", "synthetic-b"]})
        return call(base, "/api/record?idempotencyKey=" + key)
    begin = time.perf_counter_ns()
    with concurrent.futures.ThreadPoolExecutor(max_workers=width) as pool:
        results = list(pool.map(one, range(count)))
    wall = (time.perf_counter_ns() - begin) / 1e9
    assert all(code == 200 for code, _, _ in results), (label, width, results)
    return {**summary([elapsed for _, _, elapsed in results]), "wall_s": round(wall, 3),
            "wall_throughput_per_s": round(count / wall, 2)}


def probe(base, label, key):
    code, _, _ = call(base, "/health")
    assert code == 200
    request = {"idempotencyKey": key, "rawBody": "synthetic<raw>" * 2048,
               "relations": ["曾用名 A", "现名 B"]}
    code, pre, _ = call(base, "/api/preflight", request)
    assert code == 200 and pre["status"] == "preflight" and pre["auditEvents"] == ["preflight"]
    code, committed, _ = call(base, "/api/commit", request)
    assert code == 200 and committed["status"] == "committed" and committed["auditEvents"] == ["preflight", "commit"]
    code, replay, _ = call(base, "/api/commit", request)
    assert code == 200 and replay == committed
    code, mcp_replay, error, _ = mcp(base, "commit_batch", request)
    assert code == 200 and not error and mcp_replay == committed
    code, conflict, _ = call(base, "/api/commit", {**request, "rawBody": "changed"})
    assert code == 409 and conflict["error"] == "idempotency_conflict"
    code, receipt, _ = call(base, "/api/receipt?idempotencyKey=" + key)
    assert code == 200 and receipt == committed and receipt["auditChainValid"]
    code, mcp_receipt, error, _ = mcp(base, "get_receipt", {"idempotencyKey": key})
    assert code == 200 and not error and mcp_receipt == committed
    code, record, _ = call(base, "/api/record?idempotencyKey=" + key)
    assert code == 200 and record["rawHashValid"] and [r["sequenceNo"] for r in record["relations"]] == [1, 2]
    code, mcp_record, error, _ = mcp(base, "get_record", {"idempotencyKey": key})
    assert code == 200 and not error and mcp_record == record
    # Same key concurrent retries must leave exactly one commit audit event.
    with concurrent.futures.ThreadPoolExecutor(max_workers=5) as pool:
        replay_results = list(pool.map(lambda _: call(base, "/api/commit", request), range(5)))
    assert all(code == 200 and value == committed for code, value, _ in replay_results)
    result = {"preflight": True, "commit": True, "rest_replay": True, "mcp_replay": True,
              "conflict_409": True, "rest_mcp_readback": True, "raw_hash_valid": True,
              "two_relations_preserved": True, "audit_chain_valid": True, "concurrent_replay": True,
              "semantic": {"status": record["status"], "relations": record["relations"],
                           "auditEvents": committed["auditEvents"]}}
    for width in (1, 2, 5):
        for _ in range(3):
            call(base, "/api/record?idempotencyKey=" + key)
        result[f"read_c{width}"] = sample(base, label, width, 30, False, key)
        result[f"write_c{width}"] = sample(base, label, width, 12, True, key)
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    parser.add_argument("--run-id", default=str(int(time.time())))
    args = parser.parse_args()
    results = {}
    for label, port in (("sqlite", 55491), ("postgres", 55492)):
        results[label] = probe(f"http://127.0.0.1:{port}", label, "chain-" + args.run_id)
    assert results["sqlite"]["semantic"] == results["postgres"]["semantic"]
    results["same_semantic_output"] = True
    results["sqlite_db_bytes"] = Path("/tmp/ningbo-perf-83-90/postgres-poc/sqlite.db").stat().st_size
    for label, port in (("sqlite", 55491), ("postgres", 55492)):
        result = subprocess.run(["lsof", "-ti", f"tcp:{port}"], capture_output=True, text=True, check=False)
        pids = [pid for pid in result.stdout.splitlines() if pid.isdigit()]
        if pids:
            rss = subprocess.run(["ps", "-o", "rss=", "-p", pids[0]], capture_output=True, text=True, check=False)
            results[label]["server_rss_kib"] = int(rss.stdout.strip() or "0")
    Path(args.output).write_text(json.dumps(results, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"same_semantic_output": True, "sqlite": {k: v for k, v in results["sqlite"].items() if k not in ("semantic",)},
                      "postgres": {k: v for k, v in results["postgres"].items() if k not in ("semantic",)}}, ensure_ascii=False))


if __name__ == "__main__":
    main()
