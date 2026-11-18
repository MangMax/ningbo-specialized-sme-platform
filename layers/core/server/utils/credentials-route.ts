import { defineEventHandler, getRouterParam } from 'h3'
import { createCoreRouteHandler } from './core-route'
import { credentialContext } from './credential-state'
import { handleCredentialsRequest } from './credentials-http'
export function createCredentialsHandler() {
  return createCoreRouteHandler((request, ctx) => handleCredentialsRequest('state', request, ctx), credentialContext)
}

export const credentialRevealHandler = defineEventHandler(event => createCoreRouteHandler(
  (request, ctx) => handleCredentialsRequest('reveal', request, ctx, getRouterParam(event, 'key')),
  credentialContext,
)(event))
