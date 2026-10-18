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
2. **queryList — application records.** Use app `query_platform` or `POST /api/platform/query` with `source:"queryList"`, `name` (platform keyword) and/or `uscc` (AND when combined). Search published name variants then candidates/codes; inspect completeness and all requested pages. It is not a name-to-code identity decision.
3. **queryBusList — current recognized enterprises.** Use the same app query with `source:"queryBusList"`; `rdjb` is an array of `"1"|"2"|"3"`, default all three. Name/code AND supported. Keep dates and region blank unless intentionally restricted. Verified filters, formats and unknown date-boundary semantics are in [`platform-query.md`](./platform-query.md). Retain each title/page and all relationships.
4. **businessList — platform relation rows.** Use app `source:"businessList",uscc,rdjb:"all"` or explicit string `"1"|"2"|"3"`. This source rejects name searches and recognized-list filters. All three title levels and all pages are needed for an all-relation search. Ordinary title failure continues other titles; auth stops. No title's valid zero hides another's unfinished range.
5. **Public-source research.** Search exact official names, punctuation variants, progressively shorter distinctive phrases, candidate current names and confirmed codes. Prefer primary public subject or registry pages that state the name/code relationship. A search-results page or a plausible name match is only a lead, not evidence.

Use app APIs/MCP for every routine platform query, including batch submit/status/individual results/retry. Follow [`platform-query.md`](./platform-query.md); the server resolves credentials, so the investigator never reads/reveals Cookie or sends direct platform HTTP requests. Stored history at `GET /api/platform/queries` is not a fresh live query. Its stored enum remains `business_list` / `apply_list`; never label queryBusList as either. Keep unsupported queryBusList persistence pending while retaining its source, full result and check times outside Git.

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
