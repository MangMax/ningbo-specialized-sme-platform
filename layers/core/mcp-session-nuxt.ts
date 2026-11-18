import { createHash } from 'node:crypto'
import { realpathSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { defineEventHandler } from 'h3'
import type { Nuxt } from 'nuxt/schema'
import { installSessionFrontend, type SessionFrontendBinding, type SessionEntryProfile, type SessionMount } from './server/utils/mcp-session-runtime'

// Source frontend is a separate, trusted assembly axis. No header/IPC claims.
const sessionSourceProfiles = new WeakMap<object, SessionEntryProfile>()
function sessionRoutingPins() {
  try {
    const h3 = realpathSync(fileURLToPath(import.meta.resolve('h3')))
    const fromH3 = createRequire(h3)
    const pins = [
      { path: h3, sha: "bc1b89b0627a9b32f8c78479fcf943adb105afdd89daaa269c08d1a467cd4369" },
      { path: realpathSync(resolve(dirname(fromH3.resolve('ufo')), 'index.mjs')), sha: "893199faf3aafc1b2a03018de7c87738bcd78ed5153e7c2767d62e09b323b042" },
      { path: realpathSync(resolve(dirname(fromH3.resolve('radix3')), 'index.mjs')), sha: "7cde2a5cd932b73a56485f73e455d52bae375934c54300c4edbdded0cd878e42" },
    ]
    return pins.every(pin => createHash('sha256').update(readFileSync(pin.path)).digest('hex') === pin.sha)
  } catch { return false }
}
function sessionFrontendPins() {
  try {
    const require = createRequire(import.meta.resolve('nuxt/package.json'))
    const cli = dirname(dirname(realpathSync(require.resolve('@nuxt/cli/cli'))))
    const builder = realpathSync(require.resolve('@nuxt/nitro-server'))
    const core = realpathSync(fileURLToPath(import.meta.resolve('nitropack')))
    if (!sessionRoutingPins() || createHash('sha256').update(readFileSync(builder)).digest('hex') !== '5d4bea601b06d31e7a0e7cd5f0f26b373702ba0c1308ef4315b4279c7527f395' || createHash('sha256').update(readFileSync(core)).digest('hex') !== 'b6b0bd3e12f18e2830016dc37cb6c6ad4c939d14a60458634fd329b23653993a') return false
    const pins = [
      {"path": "dist/dev/index.mjs", "sha": "2403949150bbd4fdcfb69407ca88e512ff4a864139add7fe1eae7bfeb30ea969", "text": "await this.#currentNuxt.hooks.callHook(\"listen\", this.listener.server, this.listener);", "count": 1},
      {"path": "dist/dev/index.mjs", "sha": "2403949150bbd4fdcfb69407ca88e512ff4a864139add7fe1eae7bfeb30ea969", "text": "await Promise.all([typesPromise, kit.buildNuxt(this.#currentNuxt)]);", "count": 1},
      {"path": "dist/listen-BjyzPJ2X.mjs", "sha": "bddb50c7107c769c9b197d391eb61ebc88a55a5bc34679c6a1b82f5a60212894", "text": "const server = certificate ? createSecureServer(certificate, handler) : createServer(handler);", "count": 1},
    ]
    for (const pin of pins) {
      const file = realpathSync(resolve(cli, pin.path))
      if (!file.startsWith(cli + '/')) return false
      const bytes = readFileSync(file), code = bytes.toString('utf8')
      if (createHash('sha256').update(bytes).digest('hex') !== pin.sha || code.split(pin.text).length - 1 !== pin.count) return false
    }
    return JSON.parse(readFileSync(resolve(cli, 'package.json'), 'utf8')).version === '4.0.1'
  } catch { return false }
}
export function actualSessionEntryProfile(nitro: any): SessionEntryProfile {
  return nitro.options.dev
    ? sessionSourceProfiles.get(nitro) ?? { kind: 'nuxt-source', mount: { baseURL: nitro.options.runtimeConfig?.app?.baseURL ?? '/', route: '/mcp-session' }, frontendReady: () => false }
    : { kind: 'direct-node', mount: { baseURL: nitro.options.runtimeConfig?.app?.baseURL ?? '/', route: '/mcp-session' } }
}

/** Preserve original toolkit factories. Unknown template shapes leave new entry closed. */
export function configureSessionVirtuals(nitro: any) {
  const helper = fileURLToPath(new URL('./server/utils/mcp-session-runtime.ts', import.meta.url))
  nitro.options.externals ||= {}
  nitro.options.externals.inline = [...(nitro.options.externals.inline ?? []), '@modelcontextprotocol/sdk', '@nuxtjs/mcp-toolkit']
  const virtual = nitro.options.virtual
  const transportKey = '#nuxt-mcp-toolkit/transport.mjs'
  const configKey = '#nuxt-mcp-toolkit/config.mjs'
  const originalTransport = virtual[transportKey], originalConfig = virtual[configKey]
  virtual['#mcp-session-toolkit'] = 'export default () => new Response(null,{status:503})'
  nitro.options.experimental ||= {}; nitro.options.experimental.asyncContext = true
  nitro.options.storage ||= {}
  for (const mount of ['mcp:sessions', 'mcp:sessions-meta']) {
    if (nitro.options.storage[mount] && nitro.options.storage[mount].driver !== 'memory') return
    nitro.options.storage[mount] = { driver: 'memory' }
  }
  if (typeof originalTransport !== 'function' || typeof originalConfig !== 'function') return
  let toolkit: string, provider: string
  try { toolkit = dirname(fileURLToPath(import.meta.resolve('@nuxtjs/mcp-toolkit'))); provider = realpathSync(resolve(toolkit, 'runtime/server/mcp/providers/node.js')) } catch { return }
  virtual[configKey] = (...args: any[]) => {
    const source = originalConfig(...args)
    if (typeof source !== 'string' || !source.startsWith('export default ')) return source
    let base: any
    try { base = JSON.parse(source.slice('export default '.length).replace(/;\s*$/, '')) } catch { return source }
    return `import {useEvent} from 'nitropack/runtime'; import {isSessionEvent,markSessionBinding} from ${JSON.stringify(helper)}; markSessionBinding('config');
const base=${JSON.stringify(base)}; export default new Proxy(base,{get(target,key,receiver){if(key==='sessions'){let active=false;try{active=isSessionEvent(useEvent())}catch{};return active?{...target.sessions,enabled:true,maxSessions:64}:target.sessions}return Reflect.get(target,key,receiver)}});`
  }
  virtual[transportKey] = (...args: any[]) => {
    const source = originalTransport(...args)
    if (typeof source !== 'string') return source
    const match = /^export\s*\{\s*default\s*\}\s*from\s*['"]([^'"]+)['"];?\s*$/.exec(source)
    if (!match || match[1]!.replace(/\.js$/, '') !== provider.replace(/\.js$/, '')) return source
    return `import native from ${JSON.stringify(provider)}; import {dispatchSessionTransport,markSessionBinding} from ${JSON.stringify(helper)}; markSessionBinding('provider'); export default (factory,event)=>dispatchSessionTransport(factory,event,native);`
  }
  virtual['#mcp-session-toolkit'] = `export {default} from ${JSON.stringify(resolve(toolkit, 'runtime/server/mcp/handler.js'))}`
}

/** Same locked overlay used by the app AND the owned SDK fixture. */
export function installSessionOverlay(nitro: any, config: any, audit: ((value: unknown) => void) | undefined, profile: SessionEntryProfile) {
        // #445: exact dependency overlays; failure disables ONLY the new route.
        // The original toolkit config/provider and legacy stateless route stay intact.
        const sessionHelper = fileURLToPath(new URL('./server/utils/mcp-session-runtime.ts', import.meta.url))
        nitro.options.externals ||= {}
        nitro.options.externals.inline = [...(nitro.options.externals.inline ?? []), '@modelcontextprotocol/sdk', '@nuxtjs/mcp-toolkit']
        const sessionPins: Array<{ path: string; sha: string; before: string; after: string; count: number; kind: string }> = []
        try {
          const sdk = dirname(fileURLToPath(import.meta.resolve('@modelcontextprotocol/sdk/client/index.js')))
          const nitroCore = dirname(fileURLToPath(import.meta.resolve('nitropack')))
          sessionPins.push({
            path: realpathSync(resolve(sdk, '../shared/protocol.js')),
            sha: '7ea9524fcde13f9bcb7ce4d1867fd28c7844b6311b43e3a816bb019a3b61e445',
            before: '            const parsed = parseWithCompat(requestSchema, request);\n            return Promise.resolve(handler(parsed, extra));',
            after: '            return observeRegisteredRequest(this, request, extra, () => {\n                const parsed = parseWithCompat(requestSchema, request);\n                return Promise.resolve(handler(parsed, extra));\n            });',
            count: 1, kind: 'protocol',
          }, {
            path: realpathSync(resolve(nitroCore, nitro.options.dev ? '../presets/_nitro/runtime/nitro-dev.mjs' : '../presets/node/runtime/node-server.mjs')),
            sha: nitro.options.dev ? '7369466a832ac75e8d98cb573e373abab751f7d6535613cadb1efda25cdc1c3d' : 'de34cd965af3b45c8a108cef1dcb0aa70fa864f44dbd5b5e92625c1e44d66d7c',
            before: 'toNodeListener(nitroApp.h3App)', after: nitro.options.dev || profile.kind === 'component' ? 'ownAllRequests(toNodeListener(nitroApp.h3App))' : `ownAllRequests(toNodeListener(nitroApp.h3App), ${JSON.stringify(profile.mount)}, ${sessionRoutingPins()})`,
            count: nitro.options.dev ? 1 : 2, kind: 'entry',
          }, {
            path: realpathSync(resolve(dirname(fileURLToPath(import.meta.resolve('@nuxtjs/mcp-toolkit'))), 'runtime/server/mcp/utils.js')),
            sha: 'f99d0e3fc85b947a68272c71af1b38c82effd2bc4e0c67722d4c0fbae08efc67',
            before: 'const onToolCalled = event ? (call) => callMcpHook("mcp:tool:called", { ...call, event }) : void 0;',
            after: 'const onToolCalled = event ? (call) => callMcpHook("mcp:tool:called", { ...call, event: isSessionEvent(event) ? sessionCurrentEvent() : event }) : void 0;',
            count: 1, kind: 'factory',
          })
        } catch { /* No dependency repair or fallback. New endpoint stays closed. */ }
        let sessionInvalid = sessionPins.length !== 3
        const sessionSeen = new Map<string, number>()
        config.plugins = [config.plugins, {
          name: 'mcp-session-locked-runtime',
          buildStart() { sessionSeen.clear(); sessionInvalid = sessionPins.length !== 3 },
          transform: { order: 'pre' as const, handler(code: string, id: string) {
            const pin = sessionPins.find(candidate => candidate.path === id)
            if (!pin) return
            const seen = (sessionSeen.get(pin.kind) ?? 0) + 1
            sessionSeen.set(pin.kind, seen)
            if (seen !== 1 || createHash('sha256').update(code).digest('hex') !== pin.sha || code.split(pin.before).length - 1 !== pin.count) {
              sessionInvalid = true; return
            }
            const imports = pin.kind === 'entry'
              ? `import { ownAllRequests, markSessionBinding, markSessionGraph, markSessionEntryProfile, captureSessionCredential } from ${JSON.stringify(sessionHelper)};\nimport {useRuntimeConfig as sessionStartupConfig} from 'nitropack/runtime'; captureSessionCredential(sessionStartupConfig().mcpToken);\nmarkSessionBinding('entry'); markSessionEntryProfile(${JSON.stringify(profile.kind)}); markSessionGraph('__MCP_SESSION_GRAPH_V1__');\n`
              : pin.kind === 'factory' ? `import {useEvent as sessionCurrentEvent} from 'nitropack/runtime'; import {isSessionEvent,markSessionBinding} from ${JSON.stringify(sessionHelper)}; markSessionBinding('factory');\n`
              : `import { observeRegisteredRequest, markSessionBinding } from ${JSON.stringify(sessionHelper)};\nmarkSessionBinding('protocol');\n`
            const transformed = imports + code.split(pin.before).join(pin.after)
            audit?.({ kind: pin.kind, path: id, source: code, transformed, count: pin.count })
            return { code: transformed, map: null }
          } },
          generateBundle(_options: unknown, bundle: any) {
            audit?.({ graph: Object.values(bundle).filter((chunk: any) => chunk.type === 'chunk').map((chunk: any) => ({ fileName: chunk.fileName, modules: Object.keys(chunk.modules), sha256: createHash('sha256').update(chunk.code).digest('hex') })) })
          },
          renderChunk(code: string) {
            if (!code.includes('__MCP_SESSION_GRAPH_V1__')) return
            const ready = (profile.kind !== 'nuxt-source' || profile.frontendReady()) && !sessionInvalid && sessionSeen.get('protocol') === 1 && sessionSeen.get('entry') === 1 && sessionSeen.get('factory') === 1
            return { code: code.replaceAll('__MCP_SESSION_GRAPH_V1__', ready ? 'ready' : 'invalid'), map: null }
          },
        }]
}

export function registerSessionFrontend(nuxt: Nuxt) {
  // Hooks close over THIS public Nuxt instance, never a user header/global "current".
  const mount: SessionMount = { baseURL: nuxt.options.app.baseURL, route: '/mcp-session' }
  let frontend: SessionFrontendBinding | undefined
  nuxt.hooks.hook('listen', server => {
    const helper = fileURLToPath(new URL('./server/utils/mcp-session-runtime.ts', import.meta.url))
    const version = createHash('sha256').update(readFileSync(helper)).digest('hex')
    frontend = installSessionFrontend(server, mount, version, sessionFrontendPins())
  })
  nuxt.hooks.hook('nitro:build:before', nitro => {
    // Actual H3 app exists now. CLI publishes its handler only AFTER build;
    // the scoped first layer executes only when that app is really dispatched.
    if (!nuxt.options.dev) return
    const server = nuxt.server
    const appInstalled = !!frontend?.installed && !!server && !('handler' in server) && !('fetch' in server) && 'app' in server && frontend.bindApp(server.app, defineEventHandler)
    sessionSourceProfiles.set(nitro, { kind: 'nuxt-source', mount, frontendReady: () => appInstalled && frontend?.ready() === true })
  })
}
