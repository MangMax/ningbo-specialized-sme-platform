# T05a: offline observation identity and current assignment

Scope:M under #706/#713. This unused upgrade-only tool fills existing observation identities/positions/source keys, archives original relation rows, binds relation aliases and captures current assignment revision1. It retains relation_id PK/FK and all original observation identity/content/key source/rule/fingerprint/indexedAt/batch fields. It changes neither runtime writers nor business versions/hashes. Ordinary CRUD uses Drizzle; original SQLite bytes/catalog/PK manifests and independent legacy SQL remain upgrade/test infrastructure exceptions.

T05 is split without weakening its final obligation:

- T05a owns observation mapping, current assignment, observation archives/aliases and atomic source-bound checkpoints.
- T05b owns all three source projections for **every** observation, including verified shared-version and raw-only observations, plus canonical version archive transfer. T05a snapshots are evidence, never a business JSON fallback.
- T05c owns final independent observation PK, required mapping columns, all assignment/projection/T02 FK rebuilds, removal of relation_id and T02 old ownership JOINs. W/R/H/C/Z gates still depend on the complete T05 result.

## Narrow structural prerequisite

Existing schema cannot represent a completely unindexed relation honestly: identity_state/content_state/key_source/projection_rule_version/input_fingerprint/indexed_at are required, with identity/content CHECKs. Unknown indexing state is not missing_key/unverifiable/none; relation.created_at is not indexed_at. This tool reports **every** unindexed relation PK and every inherited FK fault as unresolved, returns state=blocked, and makes no T05a writes. It does not claim coverage of those histories. An explicitly accepted schema expansion for uncaptured indexing facts is required before those inputs can migrate. This candidate does not perform that schema redesign. Real historical coverage and #713 full historical completion remain UNRUN/blocked by this input-specific prerequisite.

## Operation and replay

First run accepted T04 on an isolated target. Then, from the checkout with Node24 and existing dependencies:

```sh
node upgrade/run-observations.mjs FROZEN_SOURCE EXISTING_T04_TARGET NEW_EVIDENCE_DIRECTORY T05A_RUN_ID T04_RUN_ID 100
```

Use the same IDs and fresh evidence directory on restart. Files are exclusive-create. The command requires T04 complete and revalidates its mapped collections/pages/archive bytes. T04 retains copying and migration ownership; T05a does not recopy or migrate a target. Source locking uses T04's single retained SQLite connection and byte fd throughout manifest/hash/transfer/receipt/mapping/stdout. No extra source fd opens/closes, source journal changes or runtime entry imports. Library callbacks are synchronous and trusted, as in T04. An offline consistent rollback-journal source, distinct target inode, absent live sidecars and 8GiB floor remain required. Arbitrary filesystem replacement/reentrant asynchronous callers are outside that contract.

The manifest binds original query, provenance/scope/errors, relation, observation, record/version, assignments, all three projections, enterprise/alias and import-batch domains. Ordered PKs and every original field storage class/hex bytes are recorded, in addition to full source file/schema hashes, target schema and transform version. Target immutable source domains must match; target assignment/mapping/archive/alias sets are replay checked. Each batch maps observations, inserts or validates revision1, archives/seals, binds aliases and advances the chained checkpoint within one immediate transaction. Every source relation PK must have an observation id and alias; assignment cardinality must match. Missing or unsafe PKs refuse completion. Source FK faults remain explicitly reported, never deleted or hidden. A completed receipt covers only the preflight-representable source.

Position comes only from accepted T04 sequence intervals. One verified interval supplies page/pageRow; unavailable intervals remain unknown and overlapping intervals remain conflict. Row titles never fabricate pages. Source relation_key NULL/empty/space remains exact; no raw.id fallback.

## Archive and evidence boundary

rawFields/sourceText retain SQL NULL, TEXT or BLOB and original SQLite CAST bytes, including malformed UTF8. legacyRowSnapshot is a BLOB UTF8 envelope `{"encoding":"t05a-sqlite-cells-v1","fields":[...]}`. Fields follow frozen source PRAGMA column ordinal; each entry has name, storageClass and uppercase hex of CAST(value AS BLOB). Null has empty hex and storageClass=null, distinguishing empty TEXT/BLOB. Integer/real hex bytes are SQLite CAST spellings, not a JS numeric reserialization. REAL cells additionally retain `real64be`, the exact IEEE754 bits in big-endian hex, because SQLite CAST decimal text alone need not round-trip the binary value. No original raw value is decoded or reserialized by transfer. CreatedAt on new archive metadata is NULL, not invented history.

The snapshot can restore original SQLite storage classes and bytes for old DTO/evidence or fingerprint envelope construction. It is not itself an old DTO or a historical fingerprint, and archive SHA256 is not inputFingerprint. Source invalid JSON retains old DTO's malformed-JSON failure. Target public evidence serialization and specific historical hash algorithms remain C3/H2; mutable assignment must be read from the current revision there, never from the historical snapshot. Sealed T02 bindings are validated and reused byte-for-byte; differing bindings refuse, and a partial sealed owner cannot be extended by bypassing its triggers.

Synthetic focused evidence only. No actual history/business DB, production3482/historical3497, full build/suite, Docker, cleanup, push/PR/tracker/integration merge or deployment. Preserve #705/B409 and all firstFAIL logs. Parent owns independent merger acceptance.
