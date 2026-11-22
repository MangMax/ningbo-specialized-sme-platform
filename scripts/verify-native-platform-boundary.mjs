import { createRequire } from 'node:module'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, extname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ts = createRequire(root + '/package.json')('typescript')
const walk = path => existsSync(path) ? readdirSync(path, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(path + '/' + entry.name) : [path + '/' + entry.name]) : []
const moduleFile = path => /\.(?:ts|vue|mjs)$/.test(path) && !path.endsWith('.d.ts')
const sqliteModule = /^(?:better-sqlite3|drizzle-orm\/(?:better-sqlite3|sqlite-core)|node:sqlite)(?:\/|$)/
if (process.argv.includes('--built')) {
  const output = root + '/.output/server'
  const manifest = JSON.parse(readFileSync(output + '/package.json', 'utf8'))
  const files = [...walk(output + '/chunks'), ...readdirSync(output, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.mjs')).map(entry => output + '/' + entry.name)]
  const imports = /(?:from\s+|import\s*(?:\(\s*)?|require\s*\(\s*)['"]([^'"]+)['"]/g
  const violations = Object.keys(manifest.dependencies ?? {}).filter(name => sqliteModule.test(name))
  for (const file of files.filter(moduleFile)) {
    if ([...readFileSync(file, 'utf8').matchAll(imports)].some(match => sqliteModule.test(match[1]))) violations.push(relative(root, file))
  }
  if (violations.length) {
    console.error('SQLite dependencies in Nitro build: ' + violations.join(', '))
    process.exit(1)
  }
  console.log('Nitro build contains no SQLite dependency or import')
  process.exit(0)
}
const serverEntryDirs = ['api', 'mcp', 'plugins', 'middleware', 'routes']
const appEntryDirs = ['plugins', 'pages', 'components', 'composables', 'layouts']
const layers = ['layers/core', 'layers/sme-roster', 'layers/lead-lists']
const entryDirs = [
  ...serverEntryDirs.flatMap(dir => [`server/${dir}`, ...layers.map(layer => `${layer}/server/${dir}`)]),
  ...appEntryDirs.flatMap(dir => [dir, ...layers.map(layer => `${layer}/app/${dir}`)]),
]
const entries = entryDirs.flatMap(path => walk(root + '/' + path)).filter(moduleFile)
entries.push(...[
  'server/install-application.ts',
  'nuxt.config.ts',
  ...layers.map(layer => `${layer}/nuxt.config.ts`).filter(path => existsSync(root + '/' + path)),
  'layers/core/app/app.vue',
  'layers/sme-roster/public.ts',
  ...['enterprise-read', 'current-export'].map(worker => `layers/sme-roster/lib/roster/${worker}-worker.ts`),
].map(path => root + '/' + path))
const retired = ['platform_query', 'platform_relation', 'platform_query_legacy_provenance', 'platform_relation_body_ref', 'platform_query_body_ref', 'platform_version_body_ref', 'platform_body_part', 'platform_body_root', 'platform_body_leaf']
const retiredSql = new RegExp('\\b(?:from|join|into|update|table)\\s+["`]?(' + retired.join('|') + ')\\b', 'i')
const removedSelectors = /\b(?:ROSTER_COMPARISON_TYPED_READ|ROSTER_ENTERPRISE_DETAIL_TYPED_READ|ROSTER_RECOGNIZED_FILTER_SOURCE|ENTERPRISE_FACT_CONSUMER_SOURCE|LEGACY_LEDGER_PRESENTATION_SOURCE|PLATFORM_DETAIL_TYPED_READ)\b/
const violations = [], seen = new Set(), queue = [...entries]
function modulePath(spec, from) {
  let base
  if (spec.startsWith('.')) base = resolve(dirname(from), spec)
  else if (spec.startsWith('#core/')) base = root + '/layers/core/' + spec.slice(6)
  else if (/^#(?:layers\/)?sme-roster\//.test(spec)) base = root + '/layers/sme-roster/' + spec.replace(/^#(?:layers\/)?sme-roster\//, '')
  else if (spec === '@db') base = root + '/db/index'
  else if (spec.startsWith('@db/')) base = root + '/db/' + spec.slice(4)
  else if (/^(?:~~|~|@)\//.test(spec)) base = root + '/' + spec.replace(/^(?:~~|~|@)\//, '')
  else return
  return [base, base + '.ts', base + '.vue', base + '.mjs', base + '/index.ts'].find(path => existsSync(path) && extname(path))
}
const importers = new Map()
function importPath(path) {
  const chain = [relative(root, path)]
  while (importers.has(path)) {
    path = importers.get(path)
    chain.unshift(relative(root, path))
  }
  return chain.join(' → ')
}
for (let index = 0; index < queue.length; index++) {
  const path = queue[index]
  if (seen.has(path)) continue
  seen.add(path)
  let source = readFileSync(path, 'utf8')
  if (retiredSql.test(source)) violations.push(relative(root, path) + ': retired table SQL')
  if (removedSelectors.test(source)) violations.push(relative(root, path) + ': removed runtime selector')
  if (path.endsWith('.vue')) source = [...source.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(match => match[1]).join('\n')
  const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const imports = []
  const typeImports = []
  for (const node of ast.statements) {
    if (ts.isImportDeclaration(node)) {
      const bindings = node.importClause?.namedBindings
      if (node.importClause?.isTypeOnly || (!node.importClause?.name && bindings && ts.isNamedImports(bindings) && bindings.elements.every(binding => binding.isTypeOnly))) {
        typeImports.push(node.moduleSpecifier.text)
        continue
      }
      imports.push(node.moduleSpecifier.text)
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier) (node.isTypeOnly ? typeImports : imports).push(node.moduleSpecifier.text)
  }
  function visit(node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'sqliteTable' && node.arguments[0] && ts.isStringLiteral(node.arguments[0]) && retired.includes(node.arguments[0].text)) violations.push(relative(root, path) + ': retired schema declaration')
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'URL' && node.arguments?.[0] && ts.isStringLiteral(node.arguments[0]) && moduleFile(node.arguments[0].text)) imports.push(node.arguments[0].text)
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) imports.push(node.arguments[0].text)
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) typeImports.push(node.argument.literal.text)
    ts.forEachChild(node, visit)
  }
  visit(ast)
  if (path.startsWith(root + '/layers/core/')) {
    for (const spec of [...imports, ...typeImports]) {
      if (modulePath(spec, path)?.startsWith(root + '/layers/sme-roster/')) {
        violations.push(relative(root, path) + ': roster dependency bypasses application composition: ' + spec)
      }
    }
  }
  for (const spec of imports) {
    const target = modulePath(spec, path)
    if (sqliteModule.test(spec)) violations.push(importPath(path) + ': SQLite driver or schema import ' + spec)
    if (target && /^db\/(?:schema|index|client|create-runtime)\.ts$/.test(relative(root, target))) {
      violations.push(importPath(path) + ': SQLite runtime value import ' + spec)
      continue
    }
    if (target?.startsWith(root + '/upgrade/')) violations.push(relative(root, path) + ': offline import ' + spec)
    if (target && moduleFile(target)) {
      if (!seen.has(target) && !importers.has(target) && !entries.includes(target)) importers.set(target, path)
      queue.push(target)
    }
    else if (!target && /^(?:\.|@db|#core\/|#(?:layers\/)?sme-roster\/|~~\/|~\/|@\/)/.test(spec)) violations.push(relative(root, path) + ': missing module ' + spec)
  }
}
if (violations.length) {
  console.error(violations.join('\n'))
  process.exitCode = 1
} else console.log(`Native platform boundary: ${entries.length} entries, ${seen.size} reachable modules; no retired SQL, removed selectors, missing modules, SQLite imports, offline value imports or direct core-to-roster dependencies`)
