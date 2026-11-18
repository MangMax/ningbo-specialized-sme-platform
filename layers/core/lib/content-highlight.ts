import { createHighlighterCore, type HighlighterCore } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'

// Explicit imports keep the web build bounded; never import shiki's full/web language bundle.
const languages = {
  markdown: () => import('shiki/langs/markdown.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  typescript: () => import('shiki/langs/typescript.mjs'),
  jsx: () => import('shiki/langs/jsx.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  jsonl: () => import('shiki/langs/jsonl.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  sql: () => import('shiki/langs/sql.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  css: () => import('shiki/langs/css.mjs'),
}
const aliases: Record<string, string> = { md: 'markdown', js: 'javascript', ts: 'typescript', py: 'python', yml: 'yaml', htm: 'html', txt: 'text', plaintext: 'text' }
let highlighter: Promise<HighlighterCore> | undefined
const loaded = new Map<string, Promise<void>>()
const themes = { light: () => import('shiki/themes/github-light.mjs'), dark: () => import('shiki/themes/github-dark.mjs') }

export const HIGHLIGHT_LIMIT = 100_000
export async function highlightContent(source: string, language: string, theme: 'light' | 'dark'): Promise<string | null> {
  const lang = aliases[language.toLowerCase()] ?? language.toLowerCase()
  if (!Object.hasOwn(languages, lang) || source.length > HIGHLIGHT_LIMIT) return null
  if (!highlighter) highlighter = createHighlighterCore({ langs: [], themes: [], engine: createJavaScriptRegexEngine() }).catch(error => { highlighter = undefined; throw error })
  const instance = await highlighter
  const load = (key: string, action: () => Promise<void>) => {
    if (!loaded.has(key)) loaded.set(key, action().catch(error => { loaded.delete(key); throw error }))
    return loaded.get(key)!
  }
  await Promise.all([
    load(`lang:${lang}`, async () => { await instance.loadLanguage(await languages[lang as keyof typeof languages]()) }),
    load(`theme:${theme}`, async () => { await instance.loadTheme(await themes[theme]()) }),
  ])
  return instance.codeToHtml(source, { lang, theme: `github-${theme}` })
}
