import { expect, it } from 'vitest'
import { resolvePreviewKind } from '../lib/preview'

it('dispatches explicit Markdown and common code extensions without admitting config or binary files', () => {
  expect(resolvePreviewKind('名单.MD?x=1')).toMatchObject({ kind: 'markdown', language: 'markdown' })
  for (const [extension, language] of Object.entries({ txt: 'text', json: 'json', jsonl: 'jsonl', js: 'javascript', ts: 'typescript', py: 'python', sql: 'sql', yaml: 'yaml', html: 'html' })) {
    expect(resolvePreviewKind(`source.${extension}`)).toMatchObject({ kind: 'text', language })
  }
  for (const path of ['.env', '.env.local', '.secret.json', 'package-lock', 'a.exe', 'a.zip', 'a.unknown']) expect(resolvePreviewKind(path)).toBeNull()
})
