import pg from 'pg'
import { and, eq, inArray } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { namespaces, relations, triggers } from '../../../../db/postgresql/system-catalog'
import { useJobsDb } from './postgres-jobs'

const channel = 'task_center_changed'

type Subscriber = (event: 'ready' | 'changed' | 'close') => void
type Listener = { client: pg.Client; subscribers: Set<Subscriber>; ready: boolean }

let listener: Listener | undefined
let closing: Promise<void> | undefined

function closeListener(current: Listener) {
  if (listener !== current) return
  listener = undefined
  const pending = current.client.end().catch(() => {})
  closing = Promise.all([closing, pending]).then(() => {})
  for (const subscriber of current.subscribers) subscriber('close')
  current.subscribers.clear()
  return closing
}

export async function closeTaskCenterEvents() {
  if (listener) closeListener(listener)
  await closing
}

async function listen(current: Listener) {
  try {
    await closing
    if (listener !== current) return
    await current.client.connect()
    const [installation] = await drizzle(current.client).select({ name: triggers.name })
      .from(triggers)
      .innerJoin(relations, eq(relations.oid, triggers.relation))
      .innerJoin(namespaces, eq(namespaces.oid, relations.namespace))
      .where(and(eq(namespaces.name, 'business'), eq(relations.name, 'job'),
        eq(triggers.name, channel), inArray(triggers.enabled, ['O', 'A'])))
      .limit(1)
    if (!installation) throw new Error('Task center notification trigger is unavailable')
    // LISTEN must run on the same persistent connection that receives notifications.
    await current.client.query(`LISTEN ${channel}`)
    if (listener !== current) return
    current.ready = true
    for (const subscriber of current.subscribers) subscriber('ready')
  } catch {
    await closeListener(current)
  }
}

export function subscribeTaskCenterEvents(subscriber: Subscriber) {
  if (!listener) {
    useJobsDb()
    const url = new URL(process.env.NUXT_POSTGRES_DIRECTORY_URL!)
    url.searchParams.delete('options')
    url.searchParams.set('application_name', 'task-center-events')
    const client = new pg.Client({
      connectionString: url.href,
      connectionTimeoutMillis: 5000,
      query_timeout: 5000,
      keepAlive: true,
      keepAliveInitialDelayMillis: 10_000,
    })
    const current: Listener = { client, subscribers: new Set(), ready: false }
    listener = current
    client.on('error', () => void closeListener(current))
    client.on('end', () => void closeListener(current))
    client.on('notification', notice => {
      if (!current.ready || notice.channel !== channel) return
      for (const receive of current.subscribers) receive('changed')
    })
    void listen(current)
  }
  const current = listener
  current.subscribers.add(subscriber)
  if (current.ready) queueMicrotask(() => {
    if (current.subscribers.has(subscriber)) subscriber('ready')
  })
  return () => {
    current.subscribers.delete(subscriber)
    if (!current.subscribers.size) void closeListener(current)
  }
}
