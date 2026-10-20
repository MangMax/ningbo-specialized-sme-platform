"""Prepared black-box REST/MCP comparator. Run only against isolated loopback app stacks.

Manifest requests must be synthetic or redacted. This script never stores response bodies.
It does not start app processes, prove their commit SHA, or provide cold OS-cache control.
"""
import argparse
import concurrent.futures
import hashlib
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def normalized(value, ignored):
    if isinstance(value, dict):
        return {key: normalized(item, ignored) for key, item in value.items() if key not in ignored}
    if isinstance(value, list):
        return [normalized(item, ignored) for item in value]
    return value


def request(base, case, token):
    body = canonical(case["body"]).encode() if "body" in case else None
    headers = {"Accept": "application/json", "Content-Type": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    req = urllib.request.Request(base + case["path"], data=body, method=case["method"], headers=headers)
    start = time.perf_counter_ns()
    try:
        with urllib.request.urlopen(req, timeout=case.get("timeoutSeconds", 30)) as response:
            status, data = response.status, response.read(16 * 1024 * 1024 + 1)
    except urllib.error.HTTPError as error:
        status, data = error.code, error.read(16 * 1024 * 1024 + 1)
    elapsed_ms = (time.perf_counter_ns() - start) / 1e6
    if len(data) > 16 * 1024 * 1024:
        raise RuntimeError("response exceeds 16 MiB harness cap")
    obj = json.loads(data)
    h = hashlib.sha256(canonical(normalized(obj, set(case.get("ignoreKeys", [])))).encode()).hexdigest()
    return {"status": status, "bytes": len(data), "semantic_sha256": h, "elapsed_ms": round(elapsed_ms, 3)}


def pct(values, p):
    values = sorted(values)
    return values[round((len(values) - 1) * p)]


def run_case(base, case, token):
    first = request(base, case, token)
    result = {"first": first, "hot": {}}
    for concurrency in case.get("concurrency", [1, 2, 5]):
        count = case.get("samples", 20)
        begin = time.perf_counter_ns()
        with concurrent.futures.ThreadPoolExecutor(max_workers=concurrency) as pool:
            rows = list(pool.map(lambda _: request(base, case, token), range(count)))
        wall = (time.perf_counter_ns() - begin) / 1e9
        durations = [row["elapsed_ms"] for row in rows]
        result["hot"][str(concurrency)] = {
            "n": count, "p50_ms": pct(durations, 0.5), "p95_ms": pct(durations, 0.95),
            "p99_ms": pct(durations, 0.99), "max_ms": max(durations),
            "wall_throughput_per_s": round(count / wall, 3),
            "status_and_semantics_stable": all(row["status"] == first["status"] and row["semantic_sha256"] == first["semantic_sha256"] for row in rows),
            "min_bytes": min(row["bytes"] for row in rows), "max_bytes": max(row["bytes"] for row in rows),
        }
    return result


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--manifest", required=True)
    p.add_argument("--sqlite-url", required=True)
    p.add_argument("--postgres-url", required=True)
    p.add_argument("--candidate-sha", required=True)
    p.add_argument("--sqlite-auth-env", default="")
    p.add_argument("--postgres-auth-env", default="")
    p.add_argument("--enable-isolated-writes", action="store_true")
    p.add_argument("--output", required=True)
    args = p.parse_args()
    for url in (args.sqlite_url, args.postgres_url):
        parsed = urllib.parse.urlparse(url)
        if parsed.scheme != "http" or parsed.hostname not in ("127.0.0.1", "localhost"):
            p.error("both app stacks must be isolated loopback HTTP endpoints")
    cases = json.loads(Path(args.manifest).read_text())["cases"]
    if any(case.get("write") for case in cases) and not args.enable_isolated_writes:
        p.error("write cases require --enable-isolated-writes")
    for case in cases:
        if not case["path"].startswith("/") or case.get("samples", 20) < 1 or not isinstance(case.get("expectedStatus"), int):
            p.error("invalid case path, sample count or expectedStatus")
    results = {"claimed_candidate_sha_unverified": args.candidate_sha,
               "manifest_sha256": hashlib.sha256(Path(args.manifest).read_bytes()).hexdigest(),
               "limitations": ["first is first measured request, not cold OS cache", "response bodies not retained", "no server RSS/heap/SQL timing"],
               "cases": {}}
    for case in cases:
        left = run_case(args.sqlite_url, case, os.environ.get(args.sqlite_auth_env, "") if args.sqlite_auth_env else "")
        right = run_case(args.postgres_url, case, os.environ.get(args.postgres_auth_env, "") if args.postgres_auth_env else "")
        equivalent = (left["first"]["status"] == right["first"]["status"] == case["expectedStatus"]
                      and left["first"]["semantic_sha256"] == right["first"]["semantic_sha256"]
                      and all(row["status_and_semantics_stable"] for side in (left, right) for row in side["hot"].values()))
        results["cases"][case["name"]] = {"sqlite": left, "postgres": right, "semantic_equivalent": equivalent}
    Path(args.output).write_text(json.dumps(results, ensure_ascii=False, indent=2) + "\n")
    passed = all(row["semantic_equivalent"] for row in results["cases"].values())
    print(canonical({"cases": len(cases), "all_semantic_equivalent": passed}))
    if not passed:
        raise SystemExit(2)


if __name__ == "__main__":
    main()
