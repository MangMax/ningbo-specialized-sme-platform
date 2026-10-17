# Business rules for roster cleanup

## Source authority

- The published announcement body and its attachments establish the designation, title, event type, year and batch. A notice file name or current platform state does not establish those facts.
- The three MIIT exports are comparison snapshots for their stated collection period. They do not replace official roster history.
- Every row in an in-scope official roster remains in the import, including rows unmatched to exports or missing an identity code. Comparison is a review aid, not an inclusion filter.
- Keep repeated designation events. Deduplicate enterprises across titles, but retain each award and review event with its own source.

## Event and lifecycle rules

- The earliest formal award for an enterprise and title is its first recognition. A review is not a new first recognition. Reapproval after a failed review does not reset first recognition.
- Review due dates follow the user-confirmed three-year rule from the latest effective award or passed review. A failed review leaves the active cohort; later reapproval changes the next due year, not the first-recognition history.
- Platform application and maintenance fields are not formal announcement events. In particular, `sqsj`, `whpc`, `whpcyear`, and maintenance labels must not be converted into an official award year or batch. Interpret a field in the context of its interface; see [`uscc-recovery.md`](./uscc-recovery.md).
- RL-07 does not use automatic incremental rechecks. For a requested year, use the existing query API to review that year; do not create a separate review interface.
- An enterprise absent from an export may still be a valid official roster row. A platform-only row may be current, stale or moved; do not infer its cause without evidence.

## Identity and evidence

- Names, aliases, locality and search results produce candidates. They do not confirm identity or authorize a merge by themselves. A confirmed alias needs its source evidence and explicit confirmation under the current contract.
- Keep a missing code empty when sources do not close the identity chain. Invalid codes, multiple plausible subjects, partial searches and unresolved conflicts stay pending.
- Separate page evidence, event metadata and enterprise identity. An OCR correction changes the transcription only when the source page supports it; it does not establish a new enterprise identity.
- Use [`uscc-recovery.md`](./uscc-recovery.md) for candidate discovery, current interface limits and the exact `cross_source` boundary.

## File handling

- File-store membership follows the one executable rule in `lib/file-store-scope.ts`, with its prose counterpart in `files/README.md`. Evidence file paths must resolve inside the file store.
- Keep credentials in runtime secret storage. Keep business databases, source documents and uploaded files outside Git.
