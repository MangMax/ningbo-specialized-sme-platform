import { createCoreRouteHandler } from './core-route'
import { credentialContext } from './credential-state'
import { handleCredentialsRequest } from './credentials-http'
export function createCredentialsHandler(action: 'state' | 'reveal') {
  return createCoreRouteHandler((request, ctx) => handleCredentialsRequest(action, request, ctx), () => ({ ...credentialContext(), apiToken: useRuntimeConfig().apiToken }))
}
