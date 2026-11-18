/** Announcement facts persisted in record_event.formal_validity. */
export interface FormalValidity {
  evidenceId: number
  sourceSha256: string
  statementPages: number[]
  publishedOn?: string
  originAwardEventId?: number
  interval?: { validFrom: string; validThrough: string }
  continuation?: 'until_next_review_results' | 'until_this_review_results'
}
