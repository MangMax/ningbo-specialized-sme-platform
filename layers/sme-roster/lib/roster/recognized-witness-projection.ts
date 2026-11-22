import { normalizeUscc } from '../domain'
import type { RecognizedWitnessReader, RecognizedWitnessResult } from './recognized-witness-reader'
import type { RecognizedWitnessRow } from './recognized-witness-postgres'

class TargetRecognizedWitnessGap extends Error {
  constructor(relationId: number | null, reason: string) {
    super(`Recognized witness gap ${relationId ?? 'catalog'}: ${reason}`)
  }
}

function witnessPropertyKey(hex: string): string {
  if (hex.length % 4 !== 0 || /[^0-9a-f]/.test(hex)) throw new TargetRecognizedWitnessGap(null, 'invalid_property_key')
  return Buffer.from(hex, 'hex').toString('utf16le')
}

function sourceError(name: string | null, message: string | null): Error {
  const text = message ?? 'Witness source error'
  if (name === 'TypeError') return new TypeError(text)
  if (name === 'RangeError') return new RangeError(text)
  if (name === 'SqliteError') return Object.assign(new Error(text), { name, code: 'SQLITE_ERROR' })
  const error = new Error(text)
  error.name = name ?? 'Error'
  return error
}

type WitnessInput = Parameters<RecognizedWitnessReader['readMany']>[0]
type Unavailable = Extract<RecognizedWitnessResult, { kind: 'unavailable' }>

function unavailable(reason: Unavailable['reason']): Unavailable {
  return { kind: 'unavailable', reason }
}

export function projectRecognizedWitness(input: WitnessInput, row: RecognizedWitnessRow | undefined): RecognizedWitnessResult {
  if (!row) return unavailable('missing')
  const { relationId, scope, position } = row
  if (row.assignmentId === null) throw new TargetRecognizedWitnessGap(relationId, 'assignment_missing')
  const ownerMatches = row.enterpriseId === input.enterpriseId ||
    (row.enterpriseId === null && input.uscc !== null && (normalizeUscc(row.uscc) || null) === input.uscc)
  if (!ownerMatches) return unavailable('owner')
  if (row.verification !== 'confirmed') return unavailable('unconfirmed')
  if (row.interface !== 'recognized_list' || row.status !== 'success') return unavailable('not_applicable')
  if (!scope) throw new TargetRecognizedWitnessGap(relationId, 'unsupported_capture_rule')
  if (scope.state === 'gap') throw new TargetRecognizedWitnessGap(relationId, scope.reason)
  if (scope.state === 'error') throw sourceError(scope.name, scope.message)
  if (scope.state === 'uncaptured') return unavailable('evidence_uncaptured')
  if (scope.state !== 'captured') return unavailable('not_applicable')
  if (row.identity !== 'resolved' || row.content !== 'verified' || row.recordInterface !== 'recognized_list' || row.projectionId === null) {
    return unavailable('unverified')
  }
  if (row.yearAbsent === null) return unavailable('fidelity_uncaptured')
  if (!position) throw new TargetRecognizedWitnessGap(relationId, 'position_binding')
  if (position.state === 'gap') throw new TargetRecognizedWitnessGap(relationId, position.reason)
  if (position.state === 'error') throw sourceError(position.name, position.message)
  if (position.state === 'rejected') return unavailable('position_rejected')
  if (!scope.conditions) throw new TargetRecognizedWitnessGap(relationId, 'condition_capture')
  const rdjbKey = position.state === 'matched' && position.rdjbKey !== null ? witnessPropertyKey(position.rdjbKey) : null
  return { kind: 'available', source: {
    queryId: row.queryId, titleCode: row.titleCode, rdjb: row.rdjb, rdjbKey,
    conditionValidYear: scope.conditions.validYear, conditionMaintenanceYear: scope.conditions.maintenanceYear,
    rawValid: row.rawValid, maintenanceYearAbsent: Boolean(row.yearAbsent), rawMaintenanceBatch: row.rawMaintenanceBatch,
  } }
}
