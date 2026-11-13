# Collection capture writes and replay (#766)

This B2 implementation uses the accepted capture variant at completed 71613. It
does not install that variant or connect the normal reconcile service. The global
database and worker guards remain closed.

`writeNewCollectionTarget` saves the original archives, query alias, all
observations and their source projections before `captureNewReconcileSlot`.
Capture runs inside the collection savepoint and the caller's import transaction.
The existing import coordinator commits the final receipt with the business
writes.

The sealed `legacyRowSnapshot` owns the actual legacy insert materialization.
The capture input uses its native cells, public aliases and original raw archive
bytes. Variant apply and process observation projections use those same stored
cells for the seven stored/source comparisons. The original command, fingerprint
basis, typed JSON and content hash retain their existing serializers.

`reconcile-slot-write.ts` authenticates only the selected original collection.
It checks sealed same-owner archives, observation aliases and coordinates,
materialized source comparisons, and the accepted capture result and digest.
It uses the accepted capture function and original validator. It does not select
business members or derive facts from version, display or history DTOs.

Full and reference replay retain the existing payload, source and row-set
conflicts before capture authentication. They do not upgrade a captured miss,
capture an incomplete collection, replace archives, allocate aliases or advance
the original `queriedAt`. The existing fresh-result reuse owner can still advance
`lastCollectedAt`; that field does not participate in the capture input digest.

Independent apply and process writers can populate an uncaptured collection.
They cannot append to a captured row set, including a captured miss. Recognized
collections retain `uncaptured/not_legacy_slot`. Old targets with no capture
variant keep their original writer and replay path. Partial variant columns,
missing completion, missing required barriers or a missing archive FK fail
closed. Runtime code performs no DDL, migration repair or receipt rebinding.

`tests/reconcile-slot-write-766.test.ts` uses independent writable copies of the
verified B1 source and completed target. It compares real schema0 imports and the
schema0 service with target writes and literal expectations. The independent
digest oracle reads the actual schema0 native cells in the contract's specified
order. Source execution and the migration chain are inherited B1 evidence.

The historical completion test performs real new collection writes, including
their revision1 assignments, a provenance supplement, a nonempty difference
decision and committed receipts. It compares every table before and after replay
of the original completion. A separate controlled revision2 probes assignment
isolation; it is not evidence of a new reassignment command. Such correction
commands remain with their existing owners.

Verification commands, exact test names, source hashes, original failures and
archive cleanup receipts are kept under the private acceptance directory
`reconcile-slot-capture/write766`. Whole configured type checks and the controlled
transitive graph have inherited failures. Their baseline and candidate results
must be reported separately. This implementation does not sign off B3, #763,
#706, the full application, CI or production.
