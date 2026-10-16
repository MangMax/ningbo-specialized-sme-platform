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
   `有限责任公司` / `公司`). `宁波上航测绘有限公司` → `上航测绘`. Use the complete published name
   where you can; the keyword is only a search device. A name that yields nothing (only a prefix or
   suffix) yields no candidates — do not fall back to the whole name.
2. **Search the library** for that keyword across **current names *and* confirmed aliases**. The
   alias table *is* part of the matching dictionary: once a name has been confirmed as an alias,
   later searches match it. `pending` aliases do not participate. This makes the flow
   self-strengthening — each round can match more than the last, and a name confirmed earlier in
   the *same* round is already searchable.
3. **An agent judges which candidates could be the same company** (name + locality) and takes its
   code. This is a *candidate* step only — nothing is merged or written here.
4. **Verify that code against the platform by code** (`businessList` `rdjb=1/2/3` **and**
   `queryList`; query both — `queryList` returned 7 rows where `businessList` returned 4 for the
   same code). The verification runs over the **stored** `platform_query` / `platform_relation` rows
   recorded under that code.
5. **Only a platform record can decide identity.** If a returned relation's `qymc` is
   **byte-equal** to the published name, the platform itself recorded "this code is named this" —
   that is independent original evidence ⇒ write the code and record the alias
   (`payload.merges`, contract §8.4/§5.2). If **two or more** different codes both claim the name,
   that is two subjects ⇒ conflict, do not guess. If no code can be evidenced ⇒ manual review.
   Never pick the "most similar" candidate.
6. **Fallback when the library has nothing:** query `queryList?qymc=<published name>` (substring).
   A returned row whose `qymc` is byte-equal to the published name *is* that enterprise; its
   `tyshxydm` is the code to write. Then fetch the full relations with
   `businessList?rdjb=1/2/3&tyshxydm=<code>` as above.
7. **Public-source findings** (the remainder): each code must carry a reviewable source URL, the
   date checked, and the basis for the name/locality correspondence. Write them through the same
   API as `payload.usccBackfills` (contract §8.10). Same-name multiple subjects, a locality that
   does not match, an invalid code (GB 32100-2015 length/charset/check digit), or missing evidence
   ⇒ **leave it empty and flag it**, do not write a guess.

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

133 enterprises (143 enterprise × title × direction differences) have no code; 31 are closed by
platform evidence with in-library candidates, 7 have candidates without evidence (manual review),
95 have no in-library candidate and need the `queryList?qymc=` fallback or a public source.
