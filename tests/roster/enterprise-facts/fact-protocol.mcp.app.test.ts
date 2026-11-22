/** Real toolkit /mcp transport acceptance. Opt in only against an owned synthetic
 * service; this file never starts/builds an app or reads an active business DB.
 * See skill examples/README.md for the exact isolated invocation. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import * as schema from '../fixtures/postgres-tables'
import { prepareFactCommand, commitPreparedFact, confirmedFactReferences, saveReferencedDecision } from '../../../.agents/skills/roster-ingestion-pipeline/examples/enterprise-facts.mjs'

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { nativeAppAdapter } from '../../support/native-app'
let base: string
let directory: string
let app: ReturnType<typeof nativeAppAdapter>
const token = 'synthetic-fact-protocol'
const client = new Client({ name: 'synthetic-fact-protocol-307', version: '1' })
let db: typeof app.db, ids: number[], tools: Awaited<ReturnType<Client['listTools']>>
const observations: unknown[] = []
const actor = { type: 'agent', id: 'synthetic-fact-protocol-307' }
const basis = '合成通知逐条核实，不代表真实业务判断'
const key = () => `skill-facts-307-${randomUUID()}`
const fact = { kind: 'moved_out', source: { reference: 'synthetic:notice:307', statement: '明确迁出，目的地未知' }, observed: { precision: 'day', value: '2026-11-05' }, effective: { precision: 'year', value: '2024' }, city: null }
async function call(name: string, args: Record<string, unknown>): Promise<any> {
  const result = await client.callTool({ name, arguments: args })
  if (result.isError) throw new Error(JSON.stringify(result.content))
  const decoded = result.structuredContent ?? JSON.parse((result.content as Array<{ text?: string }>).find(c => c.text)?.text ?? 'null')
  if (decoded?.isError) throw new Error(JSON.stringify(decoded.content))
  observations.push({ name, args, result: decoded })
  return decoded
}
async function http(path: string, body?: unknown) {
  const response = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, ...(body ? { body: JSON.stringify(body) } : {}) })
  return { status: response.status, body: await response.json() }
}
async function prepare(enterpriseId: number, change: object) {
  return prepareFactCommand(call, { enterpriseId, ...change, idempotencyKey: key(), actor, basis })
}
async function mutate(enterpriseId: number, change: object) {
  return commitPreparedFact(call, await prepare(enterpriseId, change))
}
async function assertConfirmed(enterpriseId: number, kind: string) {
  const first = await mutate(enterpriseId, { action: 'assert', fact: { ...fact, kind } })
  const confirmed = await mutate(enterpriseId, { action: 'confirm', factId: first.receipt.factId })
  return confirmedFactReferences(confirmed.readback, [first.receipt.factId])[0]
}

describe('skill consumer through real toolkit transport', () => {
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'fact-protocol-'))
    app = nativeAppAdapter({ dir: directory, token, launch: ({ cwd, port }) => ({ args: [join(cwd, '.output/server/index.mjs')], env: { HOST: '127.0.0.1', PORT: String(port), NUXT_MCP_TOKEN: token } }) })
    await app.prepare()
    db = app.db
    ids = []
    for (let index = 0; index < 3; index++) {
      const name = `合成MCP事实协议-${randomUUID()}`
      ids.push((await db.insert(schema.enterprise).values({ name, nameNorm: name }).returning())[0]!.id)
    }
    await app.start()
    base = app.url('')
    const url = new URL(base)
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', url), { requestInit: { headers: { authorization: `Bearer ${token}` } } }))
    tools = await client.listTools()
  }, 60000)
  afterAll(async () => {
    try { await client.close(); await app?.close() }
    finally { if (directory) await rm(directory, { recursive: true, force: true }) }
  })

  it('discovers schemas and performs explicit sourced assert confirm correct withdraw with immutable audit and original replay', async () => {
    const names = tools.tools.map(t => t.name)
    for (const name of ['get_enterprise_facts', 'preflight_enterprise_fact', 'commit_enterprise_fact', 'get_current_difference_decision', 'save_difference_decision', 'get_difference_decision']) expect(names).toContain(name)
    const commitSchema = tools.tools.find(t => t.name === 'commit_enterprise_fact')!.inputSchema
    expect(JSON.stringify(commitSchema)).toContain('planHash')
    expect(JSON.stringify(commitSchema)).toContain('expectedVersion')
    expect(JSON.stringify(tools.tools.find(t => t.name === 'save_difference_decision')!.inputSchema)).toContain('factReferences')
    const id = ids[0]!
    const prepared = await prepare(id, { action: 'assert', fact })
    const asserted = await commitPreparedFact(call, prepared)
    expect(asserted.readback.facts).toMatchObject([{ factId: asserted.receipt.factId, revision: 1, status: 'pending', fact }])
    expect(() => confirmedFactReferences(asserted.readback, [asserted.receipt.factId])).toThrow('currently confirmed')
    const confirmed = await mutate(id, { action: 'confirm', factId: asserted.receipt.factId })
    expect(confirmed.readback.facts).toMatchObject([{ revision: 2, status: 'confirmed', fact }])
    const corrected = await mutate(id, { action: 'replace', factId: asserted.receipt.factId, fact: { ...fact, kind: 'registration_status', effective: { precision: 'unknown', value: null } } })
    expect(corrected.receipt.factId).not.toBe(asserted.receipt.factId)
    expect(corrected.readback.facts).toMatchObject([{ status: 'replaced', fact }, { status: 'pending', replaces: asserted.receipt.factId, fact: { kind: 'registration_status', city: null, effective: { precision: 'unknown', value: null } } }])
    await mutate(id, { action: 'confirm', factId: corrected.receipt.factId })
    const withdrawn = await mutate(id, { action: 'withdraw', factId: corrected.receipt.factId })
    expect(withdrawn.readback.facts.map((r: any) => r.status)).toEqual(['replaced', 'withdrawn'])
    expect(withdrawn.readback.history.map((r: any) => r.action)).toEqual(['assert', 'confirm', 'replace', 'replace', 'confirm', 'withdraw'])
    expect(withdrawn.readback.history.every((r: any) => r.basis === basis && JSON.stringify(r.actor) === JSON.stringify(actor))).toBe(true)
    const replay = await commitPreparedFact(call, prepared)
    expect(replay.receipt).toEqual(asserted.receipt)
    expect(replay.currentVersionMatchesReceipt).toBe(false)
    expect(replay.readback).toEqual(withdrawn.readback)
    expect((await http(`/api/roster/enterprises/${id}/facts`)).body).toEqual(replay.readback)
    await expect(prepare(id, { action: 'confirm', factId: asserted.receipt.factId })).rejects.toThrow('Fact is missing or terminal')
    await expect(prepare(id, { action: 'confirm', factId: corrected.receipt.factId })).rejects.toThrow('Fact is missing or terminal')
  })

  it('binds the complete preflight request and enterprise and rejects stale version or changed idempotent payload without writes', async () => {
    const id = ids[1]!, prepared = await prepare(id, { action: 'assert', fact })
    const before = await call('get_enterprise_facts', { enterpriseId: id })
    await expect(commitPreparedFact(call, { ...prepared, request: { ...prepared.request, basis: 'different command' } })).rejects.toThrow('Preflight does not match request')
    await expect(commitPreparedFact(call, { ...prepared, enterpriseId: ids[2] })).rejects.toThrow('Read current enterprise facts again')
    expect(await call('get_enterprise_facts', { enterpriseId: id })).toEqual(before)
    expect((await call('get_enterprise_facts', { enterpriseId: ids[2] })).facts).toEqual([])
    const alternate = await prepare(id, { action: 'assert', fact: { ...fact, kind: 'cancelled' } })
    const saved = await commitPreparedFact(call, prepared)
    await expect(commitPreparedFact(call, alternate)).rejects.toThrow('Read current enterprise facts again')
    await expect(call('preflight_enterprise_fact', { enterpriseId: id, request: { ...prepared.request, basis: 'same key changed' } })).rejects.toThrow('Key already used for another fact command')
    expect(await call('get_enterprise_facts', { enterpriseId: id })).toEqual(saved.readback)
  })

  it('pins two confirmed facts through first decision and replacement while later fact corrections and withdrawal preserve old pins', async () => {
    const id = ids[2]!, scope = { enterpriseId: id, titleCode: 'specialized_sme', direction: 'missing_in_miit' }
    const refs = [await assertConfirmed(id, 'moved_out'), await assertConfirmed(id, 'cancelled')]
    const head = await call('get_current_difference_decision', scope)
    expect(head.versionId).toBeNull()
    const command = { ...scope, action: 'replace', expectedCurrentId: head.versionId, idempotencyKey: key(), actor, basis, ruleVersion: 'synthetic-307', effectiveAt: '2026-11-05T00:00:00Z', decision: { status: 'confirmed_reason', reasonCode: 'platform_stale', measureCode: 'none', verificationStatus: 'confirmed', factReferences: refs } }
    const first = await saveReferencedDecision(call, command)
    expect(first.version.factReferences).toEqual(refs)
    expect(await saveReferencedDecision(call, command)).toEqual(first)
    const secondCommand = { ...command, expectedCurrentId: first.receipt.versionId, idempotencyKey: key(), basis: '合成追加更正原因，事实保留', decision: { ...command.decision, reasonCode: 'other' } }
    const second = await saveReferencedDecision(call, secondCommand)
    expect(second.receipt.versionId).not.toBe(first.receipt.versionId)
    expect(second.version.factReferences).toEqual(refs)
    const before = await call('get_enterprise_facts', { enterpriseId: id })
    expect(before.facts.map((r: any) => r.status)).toEqual(['confirmed', 'confirmed'])
    for (const invalid of [{ ...refs[0], enterpriseId: ids[0] }, { ...refs[0], revision: 1 }, { ...refs[0], kind: 'moved_in' }]) {
      await expect(saveReferencedDecision(call, { ...secondCommand, expectedCurrentId: second.receipt.versionId, idempotencyKey: key(), decision: { ...secondCommand.decision, factReferences: [invalid] } })).rejects.toThrow('fact_reference_mismatch')
    }
    expect((await call('get_current_difference_decision', scope)).versionId).toBe(second.receipt.versionId)
    await mutate(id, { action: 'replace', factId: refs[0].factId, fact: { ...fact, kind: 'moved_in' } })
    await mutate(id, { action: 'withdraw', factId: refs[1].factId })
    for (const versionId of [first.receipt.versionId, second.receipt.versionId]) {
      expect((await call('get_difference_decision', { id: versionId })).factReferences).toEqual(refs)
      expect((await http(`/api/roster/decision-lifecycle/${versionId}`)).body.factReferences).toEqual(refs)
    }
    await expect(saveReferencedDecision(call, { ...secondCommand, expectedCurrentId: second.receipt.versionId, idempotencyKey: key() })).rejects.toThrow('fact_reference_mismatch')
    // Replay returns the old receipt even after pins become terminal, never repins.
    expect((await saveReferencedDecision(call, command)).receipt).toEqual(first.receipt)
  })
})
