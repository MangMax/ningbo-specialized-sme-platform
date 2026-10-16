# Business rules for roster cleanup

- The published announcement and its roster attachment decide whether and when a company received or reviewed a designation. Use the attachment/body, not a filename or current export, to determine year and batch.
- The three designations form one deduplicated enterprise list with separate designation histories. Keep repeated company events, such as the same credit code appearing in two Little Giant batches.
- A company absent from an export can still be a valid published enterprise. A platform-only enterprise can be an inbound relocation or stale/current record. Use both platform interfaces to explain it; keep all returned relation rows and original title/year/batch when verifiable.
- Matching aids visual review; it never filters away official roster rows. Verify candidate matches and unmatched rows against their cited page before finalizing the file.
- The earliest formal award per enterprise and title is its first recognition. A review is not a new first recognition. Reapproval after a failed review does not reset that marker.
- Review is due three years after the latest effective award or passed review. A failed review leaves the current active review cohort; later reapproval changes the next due year but not first-recognition history.
- For annual refresh, import the newest three export files as a new comparison snapshot. Remove a current-list enterprise only when it was platform-only, has never appeared in an official roster and is absent from the new platform exports. Keep official historical designation events even if the platform later drops them.
- Do not infer an enterprise identity from a name alone when multiple candidates exist. A valid credit code and a documented alias are stronger evidence; unresolved cases remain unresolved.
- Whether a file belongs in the file store is one rule, not a habit: `lib/file-store-scope.ts` (prose in `files/README.md`). A nurture-only list, a `.doc` that duplicates a previewable `.docx`, or a `.docx` that duplicates a `.pdf` does not belong there. Evidence addresses the file store, never the processing directory — an out-of-store pointer breaks preview with no error.
