# #744 A2 fixed successor applicability

Accepted A1 is c7d739bd, locally integrated as 0a6cba0d. A1 is catalog proof only; controlled successors below are not C migration acceptance. A2 exceeds one M owner unit, so this candidate is **A2a primary catalog inheritance and the existing read seams**. A2b fingerprint/private staging, A2c writer/replay/candidate, A2d display remain deferred. B correspondence typed/detail mapping and C offline FK transfer remain unimplemented. No runtime/public activation.

| Exact callsite | Current accepted phase/behavior | A2a action / later owner |
|---|---|---|
| process-stored-catalog processStoredInstalled | 71610 complete process schema/receipt; verifier private inherited catalog | 71611 primary handle calls full A1 proof per call; original71610 path unchanged |
| process-stored-catalog processPredecessorSchema | 71610 process source-schema hash | 71611 returns exact preserved process source-schema hash only after full A1 proof, in same read snapshot |
| recognized-witness-catalog witnessCatalogPresent/witnessPredecessorSchema/witnessInstalled | 71609 or authenticated71610 inheritance | primary71611 follows authenticated process chain; complete gate/receipt reads wrapped in one read snapshot |
| recognized-stored-catalog recognizedStoredInstalled | 71609 / witness+process inheritance | primary71611 authenticates full chain in one read snapshot; old phases/errors unchanged |
| process/witness/recognized inherit*Catalog | private verifier empty memory transfer | 71611 explicitly rejects until A2b supports complete fingerprint staging; old71610 inheritance unchanged |
| platform-business-processes-target list/options/facts | gate processStoredInstalled, caller read transaction | inherits authenticated71611 primary gate; compare complete old71610 DTOs/facts including original cells |
| platform-recognized-target list/options | gate recognizedStoredInstalled, caller read transaction | inherits authenticated71611 primary gate; compare old71610 DTOs including stored title/NULL |
| both target detail functions reading correspondence.relationId | current typed relation_id | **B**; 71611 detail remains rejected (missing old column), not mapped or claimed usable |
| fingerprint-capture capturePhase; verifier phase and stored projections; bootstrap; schema-inventory | explicit71610 branches and earlier phases | **A2b UNWIRED**; no71611 capture/verify/bootstrap/inventory acceptance |
| fingerprint-command-facts and inherit*Catalog scratch consumers | process stored selection and source-authenticated private scratch | **A2b UNWIRED**; no bypass or partially populated inherited target |
| collection-target-command / collection-target-replay | exact supported phases +71608 source restriction +71610 process materialization | **A2c UNWIRED** |
| apply-target-writer/process-target-writer/recognized-target-writer/candidate-scope-write | phase-specific stored fields/capture | **A2c UNWIRED**; no new71611 writer support |
| H1a target-evidence-read dependencies / H1b relation-evidence-display-target guard | existing evidence ownership, explicit71610 display guard | **A2d UNWIRED**; no71611 DTO acceptance claim |
| platform-declarations-target gate | exact71608 only | unchanged; do not extend to71610/71611 |
| db runtime /3 source workers | reject all nonzero phases | unchanged; regression exercised via A1 focused matrix |
| recognized-witness-write verifyWitnessCollection/verifyWitnessObservation; recognized-stored verifyRecognizedStored | selected-owner certification calls the catalog gates | transitively sees authenticated71611 primary catalog; full fingerprint/staging certification remains **A2b UNRUN**; capture* implementations are unchanged |
| lib/roster/recognized-witness-target createTargetRecognizedWitnessReader | explicit typed witness source uses witnessInstalled | catalog gate now inherits71611; complete71611 qualification/H3 behavior is **UNRUN**, no qualification rule or public selector changed |
| historical offline upgrade executors | own source/target phase + immutable receipt | unchanged; do not replay old DDL on successor |

A2a uses A1's exact fixed71611 catalog/receipt proof, never only a marker, hash length or phase list. Historical receipt bytes and the fixed predecessor trust root remain unchanged. Calls on71611 execute in one SQLite transaction, including downstream receipt queries. A1's reconstructed71610 validation never enters the71611 branch, so the narrow static module dependency does not recurse on the same target. No success cache is added.

A2a acceptance: populated and empty controlled successors; all catalog primary entrypoints and process/recognized list/options/process-facts; old71610 complete DTO equivalence and literal original cells; standalone process/witness/recognized catalog calls use one snapshot during a second connection's receipt mutation; next request must reject; missing/forged receipt, marker-only, unrelated schema and sqliteX prefix, same-connection mutation refuse without writes; wrong phase retains old errors; declarations and private staging/new writer/capture/display remain closed; detail rejection belongs B. Exact focused/affected/typecheck/catalog/diff and resources are in h1c/a2. C mapping/data migration/rollback/replay are UNRUN.

`readTargetPlatformEvidence` has selected raw/evidence branches without an explicit71610 marker gate already on the accepted base. A2a does not certify or close all such H1a branches; H1b display still explicitly refuses71611. Transitive catalog readiness is not whole-H1a/H2/H3 acceptance. The complete direct-catalog-consumer scan is retained in h1c/a2/direct-catalog-consumers-exact.txt.
