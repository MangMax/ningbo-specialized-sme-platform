# Identity research and missing unified social credit codes

A row in a published roster is valid evidence of a designation even when its unified social credit code is missing. Import the complete official roster independently from identity enrichment. Keep an unresolved code empty and pending; never drop its row to make matching easier.

## Search record

For every investigation, keep a record outside Git of:

- the official name and source file/page;
- each exact query string, source/interface, retrieval time and candidate returned;
- filters and title levels; page number, page size, reported total and whether all pages were reached;
- the original source URL or supported platform response reference, plus any failure or incomplete state.

An absent query, failed page, expired session, HTTP 200 login page or incomplete pagination is not a measured zero. Do not put cookies, account details or passwords in the record.

## Candidate discovery

Search across sources without making external research depend on an empty local result. A name or code found by any route is a candidate until independent evidence closes the identity chain.

1. **Local candidates.** Search current enterprise names and confirmed aliases by the complete published name, punctuation/parenthesis variants and progressively shorter distinctive terms. Include any candidate's current name and code in the investigation log. Pending aliases are not confirmed identity evidence.
2. **queryList — application records.** The platform's queryList accepts a unified code or qymc name substring; it is not code-only. Search the published name and variants, then candidate current names or a code. Inspect all pages. The app stores this source as `apply_list`, but its current client issues a single page-1, 50-row code query; that response alone is not an exhaustive name search.
3. **queryBusList — current recognized enterprises.** This is a separate platform list from queryList applications and businessList relations. Issue #33 records Chrome-observed filters: rdjb 1 = innovative SME, 2 = specialized SME, 3 = Little Giant; qymc and tyshxydm are name and code filters. The page labels sqsj as recognition time, but the filter's accepted date format is untested. rddqrq is an effective year; whpcyear and whpc are maintenance year and batch; szq is an administrative-area code. Use all title levels and full pagination. Do not assume untested sort values or a date encoding.
4. **businessList — platform relation rows.** This interface accepts rdjb plus tyshxydm; qymc is not a name filter here. Query rdjb 1, 2 and 3 by code, retain every returned relation, and follow every page. A zero result at one title level is not a zero across all relations. The app client currently requests page 1 with page size 50.
5. **Public-source research.** Search exact official names, punctuation variants, progressively shorter distinctive phrases, candidate current names and confirmed codes. Prefer primary public subject or registry pages that state the name/code relationship. A search-results page or a plausible name match is only a lead, not evidence.

The current app exposes stored query evidence at `GET /api/platform/queries`; it does not provide live queryBusList search through REST or MCP. The current stored interface enum is `business_list` / `apply_list`. Preserve those sources through the unified import when the payload supports them. Never label queryBusList as either interface. If that source must be persisted but the current contract cannot represent it, keep the case pending and track #33 rather than inventing a source type.

## Close the identity chain

- A library hit, shared name, matching locality or search-engine result only proposes a candidate. Do not pick the most similar name or treat a candidate alias as confirmed.
- For a platform-name match, compare the platform's original qymc with the published name using only a rule accepted by the current contract. Keep any normalized or typographic match labeled as such.
- For a renamed subject, require public evidence that links the published old name to the code, then query the platform by that exact code and preserve the platform's current qymc. A different current name is not itself proof of the old-name relationship.
- Keep public-source evidence and platform-by-code evidence as separate provenance. Record the source URL, check time and the basis that connects the published name to the code. The current unified import can save supported public-source backfills and merge lineage; use `usccBackfills` only when no other enterprise row holds the code and `merges` only for an explicit, evidenced merge into the existing holder. Never overwrite a code or merge on name alone.
- If multiple codes or subjects remain plausible, the code is invalid, a required page is missing, or the source does not establish the link, leave identity pending. Continue the official-row import.

## Current cross-source gate and issue #6

The current `cross_source` merge path is narrower than the proposed identity rule. It requires a public source URL/date/basis, a non-empty platform-by-code result with qymc, and `nameQueryRowCount = 0` for the published name. The query must have actually been run and fully paginated. A real count above zero does not satisfy this path; use only a platform-name evidence path accepted by the current contract, or leave the case pending for #6.

There is a known parser hazard: `server/utils/uscc-verdicts.ts` currently converts an omitted `queryListByName.rowCount` to 0. That default is not a platform observation. Always supply the count measured from the actual completed query; never omit it, type a guessed zero, claim a failed/partial search as zero, or bypass the check. Changing this rule belongs to issue #6. If a required query or accepted write path is unavailable, retain the evidence as pending and describe the exact contract gap.

The current gate checks field presence and counts; it does not independently prove that a public page semantically links the published name to the code. The researcher must verify that relationship from the source page. A cross-source result must not be described as a platform name match or as a conclusion derived from name similarity.

## Write and status boundaries

- Preserve every official roster row when the code is unresolved. Identity pending is not roster-import failure.
- Save platform queries and relations only using current supported `business_list` / `apply_list` payload shapes. Save public-source evidence only through a currently supported backfill or merge shape. Refer to [`docs/roster-lifecycle-contract.md`](../../../../docs/roster-lifecycle-contract.md) §§8.3, 8.4 and 8.10.
- Keep query status, pagination completeness, page/OCR status, event metadata and identity status separate. `failed`, `no_record`, `not_queried` and `pending` are not interchangeable.
- The names 海尔施、众鑫、华盛、展慈 are leads supplied in issue #35. They are not verified old names, aliases, current names or identities by virtue of appearing in a task. Only record a lineage after independent public evidence and platform-by-code evidence support it.
