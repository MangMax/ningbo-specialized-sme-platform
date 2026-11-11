# T05c explicit offline observation finalization (#716)

This command only accepts an isolated target with completed T04, T05a and T05b from the same retained frozen source protocol. It replays T05b's full binding validation before its first DDL. It is not registered in ordinary migrations and must never run during startup. Use Node24, existing dependencies, rollback-journal offline source/target, distinct inodes and at least8GiB free on both filesystems.

```sh
node upgrade/run-finalize-observations.mjs FROZEN_SOURCE EXISTING_T05B_TARGET NEW_EVIDENCE_DIRECTORY T05C_RUN_ID T05B_RUN_ID T05A_RUN_ID T04_RUN_ID
```

Create a new evidence directory first; output files use exclusive-create. Restart with the same run IDs and a new evidence directory. The CLI retains the frozen source guard through source/target manifests, full FK/index/trigger catalog, receipt and stdout. A completed repeat validates the original source/file/schema/phase binding, exact finalized schema, target cell manifest, other runs/checkpoints and its entire final checkpoint, then returns without rewriting facts. Changed inputs refuse; there is no fallback or partial final state.

One immediate transaction copies the existing observation and its six incoming owners into temporary tables, drops children before parent with FK enforcement ON, rebuilds the same physical names, restores all explicit columns/IDs and sequence watermarks, then restores triggers/indexes. All cells except the removed observation.relation_id compare by storage class, SQLite CAST bytes and exact REAL bits before commit. The six owners are assignment, observation archive refs, legacy relation aliases, apply/business/recognized projections. All incoming FKs now reference observation.id; projection composite version/record FKs, source/archive ownership, append-only assignment and immutable/sealed/REPLACE guards remain. Page ownership and external collection/source guards are rebound as needed. Failure at drop/create/copy/restore/receipt rolls back the entire DDL and facts. No FK OFF or writable_schema.

The final observation has independent id PK, mandatory collection_id/sequence_no/position_state and no relation_id. Its original IDs, identity/content/indexing fields, source keys, #714 not_indexed NULL branch, version/hash/canonical bytes, assignments, aliases, archive IDs/metadata/seals and per-observation source facts remain. SQLite's id allocation proceeds above retained IDs; safe-integer CHECKs refuse exhaustion. Target alias ownership uses observation.collection_id, a typed collection and query alias mapping; it does not join old query/relation entities.

`upgrade/target-schema.ts` uses the same shared builders/constraints as the temporary expand declarations in db/schema.ts, rebinding only actual observation ownership and mandatory fields. It addresses the same physical tables, not parallel tables/views. `upgrade/target-archive.ts` is the target evidence seam; shared archive operations have schema-generic database types and unchanged SQL behavior. The old resolver in lib/platform/immutable-archive.ts serves only the uncut expand runtime. W/R adopt the target declarations and correct binary capability; Z removes the expand declarations and transitional resolver. This is temporary development coexistence, not a permanent parallel model or runtime switch.

Finalization sets user_version=71605 atomically. db/client runtime/initialization and the three direct worker entries reject a nonzero offline version before business execution; initialization checks before WAL/migration writes. No environment flag opens this target using old readers. The target is not currently a usable application database. Final compatible binary/cutover and rollback retaining later writes remain W/R/H/C/Z acceptance. Opening an arbitrary SQLite handle outside these managed entry points is not a supported runtime capability.

Old platform_query/platform_relation physical deletion is Z ownership. Scope/error's old keys/triggers and old canonical inline column remain pending their actual writer/reader transition and Z cleanup. H1's correspondence/difference/other historical refs remain outside this boundary and still reference old entities. No historical IDs/namespaces/hash/audit/receipt or archived data are deleted. This slice does not claim complete T05, #706 or real-history migration acceptance.

Native SQL is limited to PRAGMA/catalog, temporary DDL/rebuild/copy, sqlite_sequence preservation and byte manifests. The source/target schema binding is checked before transforming accepted catalog DDL; unexpected incoming owners refuse. Ordinary migration receipts/checkpoints and target CRUD/archive/alias joins use Drizzle. Synthetic literal/cell/byte, populated rollback/restart, typed CRUD, owner/REPLACE and source-lock oracles are in platform-observation-finalize.test.ts. Existing performance #705 FAIL, B409 and all raw failures remain. Actual history/business DBs, production3482/historical3497, complete migration, full build/suite, Docker, live public HTTP/MCP, workbooks and deployment are UNRUN. Independent parent review is required.

## #720 W4a-pre: explicit collection scope successor

After completed T05c **71605**, run the same launcher with an explicit phase and
its predecessor run ID. The old invocation remains T05c only:

```sh
node upgrade/run-finalize-observations.mjs --collection-scopes FROZEN_SOURCE EXISTING_71605_TARGET NEW_EVIDENCE_DIRECTORY SUCCESSOR_RUN_ID T05B_RUN_ID T05A_RUN_ID T04_RUN_ID T05C_RUN_ID
```

The successor validates completed T05c before first DDL, checks frozen scope/error
PKs and raw SQLite bytes and every query alias/collection owner, and rejects
unknown incoming FK, index, trigger or view owners. With FK ON, one immediate
transaction rebuilds only the same two scope/error tables with collection PK/FK
(RESTRICT), removes query_id and its transitional indexes, and drops exactly the
three migration0027 scope triggers. Safe positive IDs and explicit NOT NULL apply.
Other facts, triggers, archives, aliases and historical phase receipts remain.
`lib/platform/target-schema.ts` overrides these two final declarations;
ordinary `db/schema.ts` and startup migrations remain expand-only.

Successor **71606** has its own transform, run and checkpoint. Its replay binds
source, predecessor receipts/checkpoints, catalog and complete target byte
manifest without re-running old query_id-dependent phases. T05c replay on 71606
rejects; historical 71605 receipts are never rewritten to claim a new schema.
Failures at drop/create/copy/index/receipt roll back DDL, bytes, triggers, marker
and receipts together. Retain source, target and evidence; use a new evidence
directory for CLI replay (exclusive-create outputs).

T04 cannot continue against either finalized target. Current runtime, initialization
and all three direct workers still reject every nonzero phase before business
access; no runtime selector or public switch is added. The next **W4a collection
command writer** consumes these final scope declarations. This does not connect
roster-import, 113/receipt or readers, nor complete T05/W4/#706. Real history,
public cutover and production remain UNRUN; three baseline HTTP FAILs and
#705/B409 are unchanged.
