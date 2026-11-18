import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { nativeAppAdapter } from '../../support/native-app'

it('returns raw values only for registered credential keys over compiled HTTP', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'settings-compiled-'))
  const app = nativeAppAdapter({ dir, token: 'synthetic-settings-api' })
  const route = '/api/settings/credentials'
  const request = (method: string, path: string, body: object) => fetch(app.url(path), {
    method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  try {
    await app.start()
    const saved = await request('PATCH', route, { 'core.ocrToken': 'synthetic-settings-ocr' })
    expect(saved.status).toBe(200)
    expect(JSON.stringify(await saved.json())).not.toContain('synthetic-settings-ocr')
    const raw = await request('POST', `${route}/core.ocrToken/reveal`, {})
    expect(raw.status).toBe(200)
    expect(raw.headers.get('cache-control')).toBe('no-store')
    expect(await raw.json()).toEqual({ value: 'synthetic-settings-ocr' })
    const denied = await request('POST', `${route}/core.unregistered/reveal`, { key: 'core.ocrToken' })
    expect(denied.status).toBe(404)
    expect(denied.headers.get('cache-control')).toBe('no-store')
    expect(JSON.stringify(await denied.json())).not.toContain('synthetic-settings-ocr')
  } finally {
    try { await app.close() } finally { await rm(dir, { recursive: true, force: true }) }
  }
}, 60_000)
