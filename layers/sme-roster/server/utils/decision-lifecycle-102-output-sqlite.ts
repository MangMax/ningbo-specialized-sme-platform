import { cookieRedactor } from '../../lib/platform/client'
import { credentialContext, resolveFromState } from '../../../core/server/utils/credential-resolution'
import { readRosterFixtureCredentials } from './roster-fixture-credentials'
import type { DecisionDb } from './decision-lifecycle-102'
import { projectDecisionOutput } from './decision-lifecycle-102-output'

/** Resolve redactors before a write so output preparation cannot fail after commit. */
export function decisionOutput102(db: DecisionDb) {
  const runtime = useRuntimeConfig()
  const credentials = credentialContext()
  const saved = readRosterFixtureCredentials(db)
  const values = [runtime.apiToken, runtime.mcpToken, resolveFromState('sme-roster.miitCookie', credentials, saved).value, resolveFromState('core.ocrToken', credentials, saved).value]
  const redactors = [...new Set(values.filter((v): v is string => typeof v === 'string' && !!v))].map(cookieRedactor)
  return projectDecisionOutput(redactors)
}
