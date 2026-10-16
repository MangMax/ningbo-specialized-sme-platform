# Recovering missing unified social credit codes (缺统一社会信用代码企业)

A published roster row can be a valid designation while the enterprise has **no** unified social
credit code (统一社会信用代码). Platform queries take a code (`businessList` **only** accepts
`rdjb` + `tyshxydm`; `queryList` accepts `tyshxydm` **or** `qymc`), so without a code the enterprise
can never be compared against the export snapshots — it sits at `not_queried` forever and the
difference can't be explained.

**Where this step goes in the pipeline: after the import of a roster file, before the annual
refresh.** Import first (the published rows are the authoritative history), then recover codes for
the rows the exports couldn't match, then run the platform comparison. Recovering a code changes
which enterprises the comparison sees, so doing it before an annual refresh keeps that refresh from
re-reporting the same unresolved rows.

Run it with:

```bash
# checklist + in-library plan (read-only)
curl -s "$BASE/api/roster/uscc-research" | jq '.checklist.counts, .plan.counts'
# same, plus public-source findings, then commit the plan
NUXT_API_TOKEN=<runtime secret> node scripts/roster-uscc-research.mjs --base-url "$BASE" --claims claims.json
```

## The order matters: in-library first, platform second

| order | means | when | measured coverage |
|---|---|---|---|
| **primary** | search **our own database** for a core keyword → take the candidate's code → verify that code against the platform by code | when the library has a same-or-near-name enterprise | core-word hit **38/133** (with confirmed aliases in the dictionary; 15/133 on current names alone) |
| **fallback** | platform `queryList?qymc=<name>` substring reverse lookup | when the library search finds nothing | exact-name hit 0/133 — this is the main means for the rest |

Why in-library first: library candidates come from the export tables and carry a definite subject
(name + code). A platform name query is a **substring** match and can explode (`qymc=宁波市` returns
1069 rows), so it must be narrowed by "unique candidate + byte-equal `qymc`". Use the library
candidates whenever they exist.

## The procedure

1. **Core keyword.** From the published name, strip **one** district prefix (`宁波` / `宁波市` /
   `浙江` / `浙江省`) and **one** organizational-form suffix (`有限公司` / `股份有限公司` /
   `有限责任公司` / `公司` / `厂`). `宁波上航测绘有限公司` → `上航测绘`. Use the complete published name
   where you can; the keyword is only a search device. A name that yields nothing (only a prefix or
   suffix) yields no candidates — do not fall back to the whole name.
2. **Search the library** for that keyword across **current names *and* confirmed aliases**. The
   alias table *is* part of the matching dictionary: once a name has been confirmed as an alias,
   later searches match it. `pending` aliases do not participate. This makes the flow
   self-strengthening — each round can match more than the last, and a name confirmed earlier in
   the *same* round is already searchable.
3. **An agent judges which candidates could be the same company** and takes its code. This is a
   *candidate* step only — nothing is merged or written here.
4. **Verify that code against the platform by code.** Query **all `rdjb` levels (1/2/3)** on
   `businessList` *and* `queryList`, then merge the answers. **Never default to `rdjb=3`**: measured
   on real batch 1, `businessList rdjb=3` returned 0 rows for **26 of its 29** candidate codes while
   `rdjb=1` returned rows for **29 of 29** — that batch was all `innovative_sme`, whose relations
   hang off `rdjb=1`. A `rdjb=3`-only check makes a whole batch look like "the platform has no
   record". Also query **both** interfaces: for the same code `queryList` returned 7 rows where
   `businessList` returned 4.
5. **Only a platform record can decide identity.** If a returned relation's `qymc` is
   **byte-equal** to the published name, the platform itself recorded "this code is named this" —
   that is independent original evidence. Then:
   - **fill** when no other enterprise row holds that code (`payload.usccBackfills`, §8.10);
   - **merge** when another row already holds it (`payload.merges`, §5.2/§8.4) — the code is under
     a UNIQUE index (`enterprise_uscc_norm_uq`), so writing it directly throws. This is the
     **main** path, not a corner case: batches 1–5 reported 11 + 12 + 12 candidate codes already
     held by another row. Decide per row by **looking at the current database**, not by trusting a
     field in a handover file.
   If **two or more** different codes both claim the name, that is two subjects ⇒ conflict, do not
   guess. If no code can be evidenced ⇒ manual review. Never pick the "most similar" candidate.
6. **Fallback when the library has nothing:** query `queryList?qymc=<published name>` (substring).
   **Enumerate punctuation variants** — the endpoint is sensitive to full-width vs half-width
   brackets. Measured on batch 2: `qymc=爱芯元智半导体(宁波)有限公司` (half-width) returned
   `maxCount=0`, while `qymc=爱芯元智半导体（宁波）有限公司` (full-width) returned 2 rows for the same
   company. Try both spellings (and treat whitespace/zero-width similarly), otherwise "the platform
   has a record" gets mis-read as "not found". Keep the query string close to the source's own
   spelling; only the **matching** rule normalizes.
   A returned row whose `qymc` is byte-equal to the published name *is* that enterprise; its
   `tyshxydm` is the code to write. Then fetch the full relations with
   `businessList?rdjb=1/2/3&tyshxydm=<code>` as above.
7. **Public-source findings** (the remainder): each code must carry a reviewable source URL, the
   date checked, and the basis for the name/locality correspondence. Write them through the same
   API as `payload.usccBackfills` (contract §8.10). Same-name multiple subjects, an invalid code
   (GB 32100-2015 length/charset/check digit), or missing evidence ⇒ **leave it empty and flag it**,
   do not write a guess.

## Two traps that were measured the hard way

- **`queryList?qymc=` does not index old names that only appear in `businessList` "更新" rows.**
  Measured on `507 宁波沈鑫电子有限公司`: the company's current name has no record under
  `queryList?qymc=`, yet the code's `businessList rdjb=2` carries an "更新" row whose `qymc` is the
  published name. So the fallback in step 6 — "library search found nothing ⇒ ask `queryList` by
  name" — **systematically fails for renamed companies** and would mis-classify them as
  `not_found` in bulk. The reliable order is: get the candidate **code** first (from the library, or
  from the name query), then query **`businessList` rdjb=1/2/3** by that code. Corollary: a
  `queryList` zero-row answer is **not** evidence that the platform has no record.
- **District-suffix normalisation must only fire at the position immediately following the
  district name at the start of the name.** Applying it anywhere rewrites unrelated short names —
  measured side effect: `宁波市北仑顺兴联合压铸有限公司` becomes `…北仑**区**顺兴…`. Keep the rule
  narrow (delete at most one `县`/`区` that directly follows a known district stem) or it starts
  inventing companies.

## Things that look like criteria and are not

- **Locality is not a criterion.** Four `resolved` rows in batch 4 had a candidate code whose
  embedded administrative division contradicts the published district (e.g. code prefix `330212`
  = 鄞州 vs published district 海曙区) while the platform `qymc` was byte-equal. The judgement is
  **`qymc` byte-equality only**; record a locality mismatch in the reason, never let it veto.
- **A library candidate is only a candidate.** Batch 4 produced three cases where the single
  library "hit" would have filled the **wrong subject**. The sufficient and necessary condition for
  `resolved` is a **platform relation whose `qymc` is byte-equal to the published name** — so put
  that gate in **code**, not in the agent's self-discipline: re-check the relation in the database
  (or write it in the same batch and point the alias at it) and refuse anything the check cannot
  confirm.
- **Do not write a self-referential alias.** The evidence requires `qymc` byte-equal to the
  published name, and a plain fill keeps that name on the row — an alias would repeat the current
  name. Aliases are only meaningful on the **merge** path, where the canonical row carries a
  different (newer) name.
- **Do not write a duplicate alias.** `enterprise_alias`'s unique key includes `source_ref_id`, so
  the *same* name from a *different* relation creates a second row. Before writing an alias, look up
  `(enterprise_id, name_norm)`; if a `confirmed` alias with that name already exists, skip the alias
  (still perform the merge). Batches 1 and 5 both hit this (`335` / `783` / `1448`).

## Red lines

- **No fuzzy inference and no similarity scoring.** Names (and the core keyword) are used **only to
  generate candidates**. Every write must be traced back to a platform relation row
  (`platform_relation.id`) or to a public source with URL + date + basis.
- **Fill only missing values; never overwrite an existing code, never merge identities implicitly.**
  A code that is already held by another enterprise is a **conflict** (`uscc_taken`) — merging is a
  separate, evidence-requiring act (`payload.merges`).
- **Do not re-check enterprises that already have a code.** They leave the checklist automatically.
- The checklist filter is "missing code **and** still in the current roster"; `GET
  /api/roster/uscc-research` returns it together with, per enterprise, the district, titles, the
  **source file and attachment/list number/page**, and the interface-match trace (why it is still
  unresolved) so any row can be traced back to its evidence.

## Load and coverage (measured 2026-10-16 on the real roster)

133 enterprises (143 enterprise × title × direction rows) have no code. The in-library path alone
closes 31 of them from relations already in the database (31 of 38 in-library candidates had
byte-equal evidence; 7 had a candidate but no evidence). The five parallel judgement batches
returned `resolved 117 / conflict 20 / not_found 4 / needs_human 2`; of the 117 resolved, 102 carry
`qymcEqualsAnnouncedName: true` and 15 came from a batch that omitted the field entirely (its
evidence still contains byte-equal `qymc` rows — verify before treating it as resolved).

## Two things a reviewer will ask about

- **The `not_queried` reason text is now stale.** `lib/platform/reconcile.ts` writes
  "平台两接口只认 tyshxydm，不支持按名称查询" for enterprises with no code. Only `businessList` is
  code-only; `queryList` accepts `qymc`. That string is frozen with RL-03's decision logic, so the
  correction lives here and in `decisions.md` rather than in that module.
- **The evidence for a judgement-file-written relation is a transcription, not a raw response.**
  The batch handover carries only field summaries, so the `platform_query` row written from it uses
  the file's `generatedAt` as `queried_at` and leaves `raw_response` empty; both facts are recorded
  in the relation's `source_text`. Ask the batches to carry `queriedAt` and the raw body if exact
  provenance is needed.
