import { expect, it } from 'vitest'
import { resolvePreviewKind } from '../../../layers/core/lib/preview'

it('dispatches explicit Markdown and common code extensions without admitting config or binary files', () => {
  expect(resolvePreviewKind('名单.MD?x=1')).toMatchObject({ kind: 'markdown', language: 'markdown' })
  for (const [extension, language] of Object.entries({ txt: 'text', json: 'json', jsonl: 'jsonl', js: 'javascript', ts: 'typescript', py: 'python', sql: 'sql', yaml: 'yaml', html: 'html' })) {
    expect(resolvePreviewKind(`source.${extension}`)).toMatchObject({ kind: 'text', language })
  }
  for (const path of ['.env', '.env.local', '.secret.json', 'package-lock', 'a.exe', 'a.zip', 'a.unknown']) expect(resolvePreviewKind(path)).toBeNull()
})

it('keeps generated OCR page PNG paths readable while rejecting hidden source and OCR cache files', () => {
  for (const path of ['jxj/.名单.pdf.pages/p001.png', '.workbench-97.pdf.pages/p097.png?v=1', 'jxj/%2E名单.pdf.pages/p1000.png']) {
    expect(resolvePreviewKind(path)).toMatchObject({ kind: 'image' })
  }
  for (const path of ['.secret.json', '.private/a.md', '.private/page.png', '.a.pdf.pages/.ocr-cache/result.json', '.a.pdf.pages/notes.md', '.a.pdf.pages/secret.png', '.a.pdf.pages/p000.png', '.a.pdf.pages/p1.png', '.private/.a.pdf.pages/p001.png']) {
    expect(resolvePreviewKind(path)).toBeNull()
  }
})
