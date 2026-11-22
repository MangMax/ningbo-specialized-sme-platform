import { createHash } from 'node:crypto'

export const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

export class ProofSourceError extends Error {
  constructor(readonly code: 'source_missing' | 'insufficient_evidence' | 'source_mismatch', message: string) { super(message) }
  get status() { return this.code === 'source_missing' ? 404 : 422 }
}
