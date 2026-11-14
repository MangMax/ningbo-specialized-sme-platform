// Diagnostic-only alias resolution; no production configuration changes.
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolve as pathResolve } from 'node:path'
const root = fileURLToPath(new URL('../../', import.meta.url))
export async function resolve(specifier, context, next) {
  let target = specifier === '@db' ? pathToFileURL(pathResolve(root, 'db/index.ts')).href
    : specifier.startsWith('~~/') || specifier.startsWith('~/') ? pathToFileURL(pathResolve(root, specifier.replace(/^~~?\//, ''))).href : specifier
  if (/^(\.|\/|file:)/.test(target) && context.parentURL) {
    for (const suffix of ['', '.ts', '/index.ts', '.mjs', '.js']) {
      const url = new URL(target + suffix, context.parentURL)
      if (existsSync(fileURLToPath(url)) && /\.[cm]?[jt]s$/.test(url.pathname)) return next(url.href, context)
    }
  }
  return next(target, context)
}
