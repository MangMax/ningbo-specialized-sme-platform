import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { basename, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { parse } from 'vue/compiler-sfc'
import { tablesInSql } from './module-boundary-sql.mjs'
import { indexTableOwnership } from './module-boundary-table-owners.mjs'

const root = resolve(process.argv[2] ?? fileURLToPath(new URL('..', import.meta.url)))
const layersDir = resolve(root, 'layers')
const layerDirs = readdirSync(layersDir, { withFileTypes: true })
  .filter(entry => entry.isDirectory())
  .map(entry => resolve(layersDir, entry.name))
  .sort()

const sourceExtension = /\.(?:[cm]?[jt]s|[jt]sx|vue)$/
function layerFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = resolve(dir, entry.name)
    if (entry.isDirectory()) return entry.name.startsWith('.') || entry.name === 'node_modules' ? [] : layerFiles(path)
    return sourceExtension.test(entry.name) ? [path] : []
  }).sort()
}

function layerOf(path) {
  const parts = relative(layersDir, path).split(sep)
  return parts.length > 1 && parts[0] !== '..' ? parts[0] : undefined
}

const paths = {
  '~/*': ['*'], '~~/*': ['*'], '@/*': ['*'], '@@/*': ['*'],
  '@db': ['db/index'], '@db/*': ['db/*'],
  '#layers/*': ['layers/*'],
  '#core/*': ['layers/core/*'],
  '#sme-roster/*': ['layers/sme-roster/*'],
  '#shared/*': ['shared/*'],
  '#server/*': ['server/*'],
}
const options = { baseUrl: root, paths, moduleResolution: ts.ModuleResolutionKind.Bundler, allowJs: true }
const resolutionCache = ts.createModuleResolutionCache(root, path => path, options)

function resolveImport(specifier, from) {
  const target = ts.resolveModuleName(specifier, from, options, ts.sys, resolutionCache).resolvedModule?.resolvedFileName
  if (target && !relative(root, target).startsWith('..') && !target.split(sep).includes('node_modules')) return target

  // TypeScript cannot resolve Vue SFCs without a plugin.
  const [alias, tail] = Object.entries(paths).find(([key]) => key.endsWith('/*') && specifier.startsWith(key.slice(0, -1))) ?? []
  const vuePath = alias
    ? resolve(root, tail[0].replace('*', specifier.slice(alias.length - 1)))
    : resolve(from, '..', specifier)
  if ((alias || specifier.startsWith('.')) && vuePath.endsWith('.vue') && existsSync(vuePath)) return vuePath
}

function readSource(path) {
  const source = readFileSync(path, 'utf8')
  if (!path.endsWith('.vue')) return ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true)

  const { descriptor } = parse(source, { filename: path, ignoreEmpty: false })
  // Keep the original offsets for diagnostics across both script blocks.
  const scripts = source.replace(/[^\r\n]/g, ' ').split('')
  for (const block of [descriptor.script, descriptor.scriptSetup]) {
    if (!block) continue
    const offset = block.loc.start.offset
    for (let i = 0; i < block.content.length; i++) scripts[offset + i] = block.content[i]
  }
  return ts.createSourceFile(path, scripts.join(''), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
}

function walk(node, visit) {
  visit(node)
  ts.forEachChild(node, child => walk(child, visit))
}

function importSpecifier(node) {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return node.moduleSpecifier
  if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) return node.moduleReference.expression
  if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) return node.argument.literal
  if (ts.isCallExpression(node) && (
    node.expression.kind === ts.SyntaxKind.ImportKeyword ||
    ts.isIdentifier(node.expression) && node.expression.text === 'require'
  )) return node.arguments[0]
  if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'URL' &&
      node.arguments?.[1]?.getText() === 'import.meta.url') return node.arguments[0]
}

const violations = []
function report(source, node, reason) {
  const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source))
  violations.push(`${relative(root, source.fileName)}:${line + 1}:${character + 1}: ${reason}:\n  ${node.getText(source)}`)
}

const files = layerDirs.flatMap(layerFiles)
// Only repository modules participate in symbol resolution. External packages
// cannot own a layer's tables, and type diagnostics belong to typecheck.
const sharedSchema = resolve(root, 'db/schema.ts')
const programOptions = { ...options, allowNonTsExtensions: true, noLib: true, types: [] }
const host = ts.createCompilerHost(programOptions)
host.getSourceFile = path => existsSync(path) ? readSource(path) : undefined
host.resolveModuleNames = (names, from) => names.map(name => {
  const target = resolveImport(name, from)
  return target ? { resolvedFileName: target, extension: target.endsWith('.vue') ? ts.Extension.Tsx : undefined } : undefined
})
const program = ts.createProgram(
  existsSync(sharedSchema) ? [...files, sharedSchema] : files,
  programOptions,
  host,
)
const checker = program.getTypeChecker()
const { tableOwners, importedTables } = indexTableOwnership({
  root, program, files, layerOf, layers: new Set(layerDirs.map(dir => basename(dir))), walk, report, violations,
})

function checkTableReferences(source, node, layer, tables, action) {
  for (const table of tables) {
    const owner = tableOwners.get(table)
    if (owner && owner !== 'core' && owner !== layer) {
      report(source, node, `${layer} cannot ${action(table, owner)}`)
    }
  }
}

for (const dir of layerDirs) {
  const layer = basename(dir)
  const reachable = new Set(files.filter(path => layerOf(path) === layer))
  // Follow app-root bridges with the importing layer's rules. Each layer checks
  // its own internal graph, so crossing a legal public entry ends this traversal.
  for (const path of reachable) {
    const source = program.getSourceFile(path) ?? readSource(path)
    const inLayer = layerOf(path) === layer
    walk(source, node => {
      const specifier = importSpecifier(node)
      if (!specifier || !ts.isStringLiteralLike(specifier)) {
        if (inLayer && layer !== 'core' && tableOwners.size) {
          checkTableReferences(source, node, layer, tablesInSql(node, checker), (table, owner) => `reference table ${table} owned by ${owner} in SQL`)
        }
        return
      }
      const target = resolveImport(specifier.text, path)
      if (!target) return
      const owner = layerOf(target)
      if (!owner && sourceExtension.test(target)) reachable.add(target)
      if (owner && owner !== layer && owner !== 'core') {
        if (layer === 'core') {
          report(source, node, `core cannot depend on ${owner}`)
          return
        }
        if (target !== resolve(layersDir, owner, 'public.ts')) {
          report(source, node, `${layer} must use ${owner}/public.ts`)
          return
        }
      }
      if (inLayer && layer !== 'core' && tableOwners.size) {
        checkTableReferences(source, node, layer, importedTables(node, target), (table, owner) => `import table ${table} owned by ${owner}`)
      }
    })
  }
}

if (violations.length) {
  console.error(violations.join('\n'))
  process.exitCode = 1
} else {
  console.log(`Module boundaries: ${files.length} layer source files checked`)
}
