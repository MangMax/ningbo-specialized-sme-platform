import { defineEventHandler, getRouterParam } from 'h3'
import { createCoreRouteHandler } from './core-route'
import { credentialContext } from './credential-resolution'
import { postgresCredentialStorage } from './credential-state-postgres'
import { handleCredentialsRequest } from './credentials-http'
export function createCredentialsHandler() {
  return createCoreRouteHandler((request, ctx) => handleCredentialsRequest('state', request, ctx, postgresCredentialStorage()), credentialContext)
}

export const credentialRevealHandler = defineEventHandler(event => createCoreRouteHandler(
  (request, ctx) => handleCredentialsRequest('reveal', request, ctx, postgresCredentialStorage(), getRouterParam(event, 'key')),
  credentialContext,
)(event))
