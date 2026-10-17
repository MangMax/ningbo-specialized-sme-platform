import { createCoreRouteHandler } from './core-route'
import { credentialContext, type CredentialKey } from './credential-state'
import { handleCredentialsRequest } from './credentials-http'
export function createCredentialsHandler(action: 'state' | 'reveal', key: CredentialKey = 'ocrToken') {
  return createCoreRouteHandler((request, ctx) => handleCredentialsRequest(action, request, ctx, key), credentialContext)
}
