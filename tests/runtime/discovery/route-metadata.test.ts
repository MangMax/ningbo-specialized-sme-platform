import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'
import { expect, it } from 'vitest'

it('declares literal discovery metadata for every public method route', () => {
  const roots = ['../../../server/api', '../../../layers/core/server/api'].map(path => join(import.meta.dirname, path))
  // Existing file UI handlers predate agent discovery; keep the debt explicit.
  const exempt = new Set(['files/[id]/segments/commit.post.ts', 'files/[id]/segments/preflight.post.ts', 'files/[id]/segments.get.ts', 'files/[id].get.ts'])
  function files(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)])
  }
  const missing = roots.flatMap(root => files(root).filter(path => /\.(get|post|patch|put|delete)\.ts$/.test(path)).filter(path => {
    if (exempt.has(relative(root, path))) return false
    const ast = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
    return !ast.statements.some(node => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) && node.expression.expression.getText(ast) === 'defineRouteMeta' && node.expression.arguments.length === 1 && ts.isObjectLiteralExpression(node.expression.arguments[0]!))
  }).map(path => relative(root, path)))
  expect(missing).toEqual([])
})
