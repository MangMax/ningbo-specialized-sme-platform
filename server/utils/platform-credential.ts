import { resolveCredential, type CredentialContext } from '../../layers/core/server/utils/credential-state'

/** The application reads database overrides; explicit callbacks remain controlled overrides. */
export function resolvePlatformCookie(override?: string | (() => string) | null, ctx?: CredentialContext): string {
  if (typeof override === 'function') return override().trim()
  if (typeof override === 'string') return override.trim()
  return resolveCredential('sme-roster.miitCookie', ctx).value
}
