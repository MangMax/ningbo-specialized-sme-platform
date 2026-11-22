import { createServer } from 'node:http'
import * as h3 from 'h3'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { vi } from 'vitest'
import { createRosterImportClient, type RosterImportClientOptions, type RosterImportRequest } from '../../../../layers/sme-roster/lib/roster-import-client'
import { reviewPostgresFixtureRows } from '../../imports/fixtures/reviewed-announcement-postgres'

/** Mount the same import and enterprise research routes used by Nitro. */
export async function startPostgresImportHttp(dir: string, token: string) {
  const { createError, defineEventHandler, getQuery, getRouterParam, readBody, setHeader, setResponseStatus } = h3
  for (const [name, fn] of Object.entries({ createError, defineEventHandler, getQuery, getRouterParam, readBody, setHeader, setResponseStatus })) {
    vi.stubGlobal(name, fn)
  }
  vi.stubGlobal('useRuntimeConfig', () => ({ filesDir: dir, apiToken: token }))
  const preflight = (await import('../../../../layers/sme-roster/server/api/roster/import/preflight.post')).default
  const duplicate = (await import('../../../../layers/sme-roster/server/api/roster/import/duplicate-candidates.get')).default
  const commit = (await import('../../../../layers/sme-roster/server/api/roster/import/commit.post')).default
  const intake = (await import('../../../../layers/sme-roster/server/api/roster/import/intake/[id].get')).default
  const supplement = (await import('../../../../layers/sme-roster/server/api/roster/import/intake/[id]/supplement.post')).default
  const researchGet = (await import('../../../../layers/sme-roster/server/api/roster/uscc-research.get')).default
  const researchPost = (await import('../../../../layers/sme-roster/server/api/roster/uscc-research.post')).default
  const router = h3.createRouter()
   .post('/api/roster/import/commit', commit)
   .post('/api/roster/import/preflight', preflight)
   .get('/api/roster/import/duplicate-candidates', duplicate)
   .get('/api/roster/import/intake/:id', intake)
   .post('/api/roster/import/intake/:id/supplement', supplement)
   .get('/api/roster/uscc-research', researchGet)
   .post('/api/roster/uscc-research', researchPost)
  const server = createServer(h3.toNodeListener(h3.createApp().use(router)))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return {
    baseUrl: 'http://127.0.0.1:' + (server.address() as { port: number }).port,
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  }
}

export function createReviewedPostgresImportClient(options: RosterImportClientOptions, db: NodePgDatabase) {
  const client = createRosterImportClient(options)
  return {
    async commit(request: RosterImportRequest) {
      const staged = await client.commit(request)
      if (staged.status !== 'staged') return staged
      const state = await client.readIntake(staged.intakeId)
      const review = state.review ?? await reviewPostgresFixtureRows(db, staged.sourceDigest, request)
      const preflight = state.status === 'staged' && state.officialEvidencePreflightRequired ? await client.preflightSupplement(staged.intakeId, review) : null
      const result = await client.supplement(staged.intakeId, preflight?.officialEvidencePlanHash
        ? { ...review, officialEvidencePlanHash: preflight.officialEvidencePlanHash } : review)
      if (result.status === 'failed') return result
      const { intakeId, sourceIds, owners, ...receipt } = result
      return { ...receipt, status: 'committed' as const }
    },
  }
}
