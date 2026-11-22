export class LegacyProvenanceError extends Error {
  constructor(public code: string, message: string) { super(message) }
}
export function rejectLegacyProvenance(code: string, message: string): never { throw new LegacyProvenanceError(code, message) }
