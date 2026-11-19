/** Stored inside the existing OCR raw JSON; never infer a legacy raw's owner
 * from the mutable row's channel/model. Original payloads remain intact. */
export interface OcrProvenance {
  format: 'ocr-provenance-v1'
  captures: Array<{
    raw: unknown
    source: { channel: string; engine: string; model: string | null; createdAt: string | null } | null
    markdown: string | null
    input?: { taskId: string | null; sourceSha256: string | null; imageSha256: string; variant: string; jobId: string; createdAt: string | null }
  }>
  revisions: Array<{
    markdown: string
    channel: string
    engine: string
    model: string | null
    createdAt: string
    capture: number | null
  }>
}

export function isOcrProvenance(raw: unknown): raw is OcrProvenance {
  return !!raw && typeof raw === 'object' && (raw as OcrProvenance).format === 'ocr-provenance-v1'
    && Array.isArray((raw as OcrProvenance).captures) && Array.isArray((raw as OcrProvenance).revisions)
}

export function reviseOcrProvenance(
  previous: { raw: unknown; markdown: string; channel: string; engine: string; model: string | null; createdAt: string } | undefined,
  next: { raw?: unknown; markdown: string; channel: string; engine: string; model: string | null; createdAt: string; capture?: OcrProvenance['captures'][number]['input'] },
): OcrProvenance {
  const history: OcrProvenance = previous && isOcrProvenance(previous.raw)
    ? structuredClone(previous.raw)
    : {
        format: 'ocr-provenance-v1',
        captures: previous?.raw == null ? [] : [{ raw: previous.raw, source: null, markdown: null }],
        revisions: previous ? [{ markdown: previous.markdown, channel: previous.channel, engine: previous.engine, model: previous.model, createdAt: previous.createdAt, capture: null }] : [],
      }
  const hasRaw = next.raw !== undefined && next.raw !== null
  if (hasRaw) history.captures.push({ raw: next.raw, markdown: next.markdown, source: { channel: next.channel, engine: next.engine, model: next.model, createdAt: next.capture ? next.capture.createdAt : next.createdAt }, ...(next.capture ? { input: next.capture } : {}) })
  // Text-only revisions refer to the retained capture; they do not acquire its
  // source. A legacy capture stays explicitly unknown even after more edits.
  history.revisions.push({ markdown: next.markdown, channel: next.channel, engine: next.engine, model: next.model, createdAt: next.createdAt, capture: history.captures.length ? history.captures.length - 1 : null })
  return history
}
