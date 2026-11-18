import type Database from 'better-sqlite3'
import {
  createRosterImportClient, type RosterAnnouncementStagedResponse, type RosterImportClientOptions,
  type RosterImportRequest, type SupplementAnnouncementRequest,
} from '../../../../layers/sme-roster/lib/roster-import-client'
import { normalizeName, normalizeUscc } from '../../../../layers/sme-roster/lib/domain'

type Subject = { id: number; revision: number }
type FixtureDb = { $client: Database.Database }
type Intake = Pick<RosterAnnouncementStagedResponse, 'intakeId' | 'sourceDigest'>

/** Synthetic test identities only. Scenarios own the original rows and their expected readback. */
export function reviewFixtureRows(db: FixtureDb, sourceDigest: string, request: RosterImportRequest): SupplementAnnouncementRequest {
  const previous = new Map<string, number>()
  const byUscc = db.$client.prepare(`SELECT e.id, coalesce(d.revision,1) AS revision FROM enterprise e
    LEFT JOIN enterprise_directory d ON d.enterprise_id=e.id
    LEFT JOIN enterprise_merge m ON m.from_enterprise_id=e.id
    WHERE m.from_enterprise_id IS NULL AND e.uscc_norm=?`)
  const byName = db.$client.prepare(`SELECT e.id, coalesce(d.revision,1) AS revision FROM enterprise e
    LEFT JOIN enterprise_directory d ON d.enterprise_id=e.id
    LEFT JOIN enterprise_merge m ON m.from_enterprise_id=e.id
    WHERE m.from_enterprise_id IS NULL AND e.name_norm=?`)
  const rows = request.payload.announcement!.records.map(({ enterprise }, row): SupplementAnnouncementRequest['rows'][number] => {
    const name = normalizeName(enterprise.name)
    const uscc = enterprise.uscc ? normalizeUscc(enterprise.uscc) : null
    const key = uscc ? `uscc:${uscc}` : `name:${name}`
    const earlier = previous.get(key)
    if (earlier !== undefined) return { action: 'same_subject', row: earlier }
    previous.set(key, row)
    const matches = (uscc ? byUscc.all(uscc) : byName.all(name)) as Subject[]
    if (matches.length > 1) throw new Error(`Synthetic fixture needs an explicit subject for row ${row}`)
    const match = matches[0]
    return match ? { action: 'attach', enterpriseId: match.id, expectedRevision: match.revision }
      : { action: 'create', fields: { name: enterprise.name, ...(uscc ? { uscc } : {}) } }
  })
  return { sourceDigest, basis: 'Reviewed synthetic fixture identities', rows }
}

export function createReviewedFixtureImportClient(options: RosterImportClientOptions, db: FixtureDb) {
  const client = createRosterImportClient(options)

  return {
    preflight: client.preflight.bind(client),
    replay: client.replay.bind(client),
    stage: client.commit.bind(client),
    supplement: client.supplement.bind(client),
    async commit(request: RosterImportRequest, reviewedRows?: SupplementAnnouncementRequest['rows']) {
      const result = await client.commit(request)
      if (result.status !== 'staged') return result
      const supplemented = await finishFixtureAnnouncement(options.baseUrl, options.token, db, request, result, reviewedRows)
      if (supplemented.status === 'failed') return supplemented
      const { intakeId, sourceIds, owners, ...receipt } = supplemented
      // These consumers also read import_batch, whose durable terminal state is committed.
      return { ...receipt, status: 'committed' as const }
    },
  }
}

/** Complete a staged HTTP response using the same authenticated transport. */
export async function finishFixtureAnnouncement(baseUrl: string, token: string, db: FixtureDb, request: RosterImportRequest, intake: Intake, rows?: SupplementAnnouncementRequest['rows']) {
  const client = createRosterImportClient({ baseUrl, token })
  const state = await client.readIntake(intake.intakeId)
  const review = rows ? { sourceDigest: intake.sourceDigest, rows, basis: 'Reviewed synthetic fixture identities' }
    : state.review ?? reviewFixtureRows(db, intake.sourceDigest, request)
  return client.supplement(intake.intakeId, review)
}

/** The receiving scenario supplies already-reviewed decisions for its new rows. */
export async function submitNewFixtureAnnouncement(baseUrl: string, token: string, request: RosterImportRequest) {
  const client = createRosterImportClient({ baseUrl, token })
  const staged = await client.commit(request)
  if (staged.status !== 'staged') return staged
  return client.supplement(staged.intakeId, {
    sourceDigest: staged.sourceDigest,
    basis: 'Synthetic fixture uses new identities',
    rows: request.payload.announcement!.records.map(({ enterprise }) => ({
      action: 'create',
      fields: { name: enterprise.name, ...(enterprise.uscc === undefined ? {} : { uscc: enterprise.uscc }) },
    })),
  })
}
