import { expect, it } from 'vitest'
import { platformBusinessObservation } from '../../../db/postgresql/platform-tables'
import { nativeCorrespondenceFixture } from '../correspondence/fixtures/native-correspondence'
import { listPostgresCorrespondences } from '../../../layers/sme-roster/server/utils/record-correspondence-postgres'
import { handlePostgresCorrespondenceRequest } from '../../../layers/sme-roster/server/utils/record-correspondence-runtime'
import { useIsolatedPostgresCases } from '../../support/isolated-postgres-cases'

const createDb = useIsolatedPostgresCases()

it('discovers native history without mutating observations or creating decisions', async () => {
  const f = await nativeCorrespondenceFixture(createDb())
  const old = await f.add({ status: '终审不通过' })
  const current = await f.add()
  const readObservations = () => f.db.select().from(platformBusinessObservation).orderBy(platformBusinessObservation.id)
  const before = await readObservations()
  const result = await handlePostgresCorrespondenceRequest({ action: 'discover', method: 'POST', body: { eventId: f.event.id } })
  expect(result.status).toBe(200)
  expect(result.body).toMatchObject({ total: 2 })
  const text = JSON.stringify(result.body)
  expect(text).toContain(String(old.id))
  expect(text).toContain(String(current.id))
  expect(text).not.toContain('PRIVATE-COOKIE')
  expect(await readObservations()).toEqual(before)
  expect(await listPostgresCorrespondences(f.db, {})).toEqual([])
})

it('discovery excludes another title while retaining the matching native row', async () => {
  const f = await nativeCorrespondenceFixture(createDb())
  await f.add()
  await f.add({ rdjb: '1', titleCode: 'innovative_sme' })
  const result = await handlePostgresCorrespondenceRequest({ action: 'discover', method: 'POST', body: { eventId: f.event.id } })
  expect(result.status).toBe(200)
  expect(result.body).toMatchObject({ total: 1 })
})
