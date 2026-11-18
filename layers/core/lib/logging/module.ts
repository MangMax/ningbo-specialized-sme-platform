import { getAppModules } from '../../../../lib/app-modules'
import type { McpLogContext } from './contract'

const manifests = getAppModules()
const ids = new Set(manifests.map(({ id }) => id))
const routes = manifests
  .flatMap(({ id, routes }) => (routes ?? []).map(prefix => ({ id, prefix })))
  .sort((a, b) => b.prefix.length - a.prefix.length)
const tools = new Map(manifests.flatMap(({ id, mcpTools }) => (mcpTools ?? []).map(tool => [tool, id] as const)))
const jobs = new Map(manifests.flatMap(({ id, jobKinds }) => (jobKinds ?? []).map(({ kind }) => [kind, id] as const)))

export function registeredLogModule(value: unknown): string | null {
  return typeof value === 'string' && ids.has(value) ? value : null
}

/** Accept the server's matched template or a fixed middleware prefix. */
export function httpLogModule(route: string): string | null {
  return routes.find(({ prefix }) => route === prefix || route.startsWith(prefix + '/'))?.id ?? null
}

export function mcpToolLogModule(tool: string | undefined): string | null {
  return tool === undefined ? null : tools.get(tool) ?? null
}

export function mcpLogModule(context?: McpLogContext): string | null {
  if (context?.tool) return mcpToolLogModule(context.tool)
  const method = context?.rpcMethod
  return method && !['tools/call', 'batch', 'unknown'].includes(method) ? 'core' : null
}

export function jobLogModule(kind: string): string | null {
  return jobs.get(kind) ?? null
}
