import { credentialContext, resolveCredential } from './credential-state'
import { ocrProviderOptions } from './ocr-api'

export function resolveOcrConfig(override: { token?: string } = {}) {
  const token = resolveCredential('core.ocrToken', credentialContext(), override.token).value
  return { ...ocrProviderOptions(), token }
}
