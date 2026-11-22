import { credentialContext, resolveFromState, type CredentialReadContext } from '../../../core/server/utils/credential-resolution'
import { readRosterFixtureCredentials } from './roster-fixture-credentials'

/** The application reads database overrides; explicit callbacks remain controlled overrides. */
export function resolvePlatformCookie(override?: string | (() => string) | null, ctx?: CredentialReadContext & { db: Parameters<typeof readRosterFixtureCredentials>[0] }): string {
  if (typeof override === 'function') return override().trim()
  if (typeof override === 'string') return override.trim()
  return resolveFromState('sme-roster.miitCookie', ctx ?? credentialContext(), ctx ? readRosterFixtureCredentials(ctx.db) : {}).value
}
