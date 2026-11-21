import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { parse } from 'vue/compiler-sfc'

const root = fileURLToPath(new URL('..', import.meta.url))
const baselinePath = resolve(root, 'scripts/sql-guard-baseline.tsv')
const sourceFile = /\.(?:[cm]?[jt]s|[jt]sx|vue)$/
const driver = /^(?:pg|pg-native|postgres|better-sqlite3|sqlite3|node:sqlite|@neondatabase\/serverless)(?:\/|$)/
const sqlStatement = /^(?:(?:select|with)\s+.+|(?:insert\s+(?:or\s+\w+\s+)?into|update\s+(?:or\s+\w+\s+)?[\w`"[?]|delete\s+from|create\s+(?:(?:temp(?:orary)?|unique)\s+)?(?:table|index|trigger|schema|view|extension|function)|alter\s+|drop\s+(?:table|index|trigger|schema|view)|pragma\s+|truncate\s+|copy\s+|listen\s+|unlisten\s+|notify\s+|explain\s+|savepoint\s+|release\s+savepoint\b|set\s+(?:local|transaction|role|search_path)\b|vacuum(?:\s|$))|(?:begin(?:\s+(?:transaction|immediate|deferred|exclusive|isolation))?|commit|rollback)(?:\s|;|$))/is
const signature = text => createHash('sha256').update(text).digest('base64url')
const rules = new Map([
  ['C', '驱动调用'],
  ['D', '驱动导入'],
  ['E', '直接执行'],
  ['F', '独立 SQL 文件'],
  ['I', '驱动实例'],
  ['L', 'SQL 语句字面量'],
  ['P', '驱动客户端'],
  ['R', 'Drizzle SQL 构造'],
  ['T', 'Drizzle SQL 模板'],
])
const ruleCodes = new Map([...rules].map(([code, rule]) => [rule, code]))

function area(path) {
  if (path.startsWith('tests/')) return '测试'
  if (path.startsWith('db/migrations/') || path === 'db/runtime-schema.generated.ts') return '迁移'
  if (path.startsWith('upgrade/') || /^scripts\/(?:initialize-native-db|upgrade-)/.test(path)) return '离线'
  return '运行时'
}

function runtimeEngine(path, source) {
  const postgres = path.startsWith('db/postgresql/') || /\/(?:postgres(?:ql)?[-.]|[^/]+-postgres\.)/.test(path)
    || /['"](?:pg|drizzle-orm\/node-postgres)['"]|\/db\/postgresql\/|\/postgres(?:ql)?-\w+['"]/.test(source)
  const sqlite = /^db\/(?:runtime-schema\.generated|schema|schema-phase|create-runtime|enterprise-kernel-schema|title-cycle-disposition|import-receipt-bodies)\.ts$/.test(path)
    || /\/(?:sqlite[-.]|[^/]+-sqlite\.)/.test(path)
    || /['"](?:better-sqlite3|drizzle-orm\/(?:better-sqlite3|sqlite-core))['"]|\$client|\.pragma\(|\bsqlite_schema\b/.test(source)
  if (postgres && sqlite) return '共享模块，需核对 PG 分支'
  if (postgres) return 'PG 运行实现'
  if (sqlite) return 'SQLite 兼容实现'
  return '共享或未识别，需核对调用者'
}

function accessPath(path, engine, row) {
  if (row.area === '测试') return '测试与夹具'
  if (row.area === '迁移') return '迁移与生成的建库 SQL'
  if (row.area === '离线') return path.startsWith('upgrade/postgresql/') ? 'PG 离线迁移/恢复' : '离线工具与历史快照'
  if (/\b(?:sqlite_schema|sqlite_master|pragma_(?:table|index)|pragma\b)|better-sqlite3|COLLATE\s+(?:BINARY|NOCASE)\b/i.test(row.snippet)) return 'SQLite 运行调用'
  if (/\b(?:pg_(?:(?:try_)?advisory_\w+|catalog|input_is_valid|get_serial_sequence))\b|::(?:jsonb|bytea)\b|COLLATE\s+"C"|WITH\s+ORDINALITY/i.test(row.snippet)) return 'PG 运行调用'
  return engine
}

function* sourceParts(path, text) {
  if (!path.endsWith('.vue')) {
    yield [text, 0, ts.getScriptKindFromFileName(path)]
    return
  }
  const { descriptor } = parse(text, { filename: path, ignoreEmpty: false })
  for (const block of [descriptor.script, descriptor.scriptSetup]) {
    if (block) yield [block.content, block.loc.start.offset, ts.getScriptKindFromFileName('script.' + (block.lang ?? 'js'))]
  }
}

function visit(node, callback) {
  callback(node)
  ts.forEachChild(node, child => visit(child, callback))
}

function access(node) {
  if (ts.isPropertyAccessExpression(node)) return node.name.text
  if (ts.isElementAccessExpression(node) && node.argumentExpression && ts.isStringLiteralLike(node.argumentExpression)) return node.argumentExpression.text
}

function stringParts(node) {
  if (ts.isStringLiteralLike(node)) return node.text
  if (ts.isTemplateExpression(node)) return node.head.text + node.templateSpans.map(span => '? ' + span.literal.text).join('')
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = stringParts(node.left)
    const right = stringParts(node.right)
    if (left !== undefined || right !== undefined) return (left ?? '? ') + (right ?? '? ')
  }
}

function tagText(template) {
  return ts.isNoSubstitutionTemplateLiteral(template)
    ? template.text
    : template.head.text + template.templateSpans.map(span => span.literal.text).join('')
}

function isStatement(text) {
  const candidate = text.trimStart().replace(/^(?:(?:--[^\r\n]*(?:\r?\n|$)|\/\*[\s\S]*?\*\/)\s*)+/, '')
  if (/^select\s/i.test(candidate)) return /\bfrom\b|^select\s+(?:[?*'"$()0-9+-]|(?:null|true|false)\b|[a-z_][\w.]*\s*\()/i.test(candidate)
  if (/^with\s/i.test(candidate)) return /\bas\s*(?:(?:not\s+)?materialized\s*)?\(/i.test(candidate)
  if (/^update\s/i.test(candidate)) return /\bset\b/i.test(candidate)
  return sqlStatement.test(candidate)
}

function typeOnlyImport(node) {
  const clause = node.importClause
  return clause?.isTypeOnly || (clause && !clause.name && clause.namedBindings && ts.isNamedImports(clause.namedBindings)
    && clause.namedBindings.elements.length > 0 && clause.namedBindings.elements.every(element => element.isTypeOnly))
}

function* scanAst(source, offset) {
  const sqlNames = new Set()
  const sqlClasses = new Set()
  const namespaces = new Set()
  const driverBindings = new Set()
  const driverNamespaces = new Set()
  for (const node of source.statements) {
    if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier) || typeOnlyImport(node)) continue
    const bindings = node.importClause?.namedBindings
    if (driver.test(node.moduleSpecifier.text)) {
      if (node.importClause?.name) {
        driverBindings.add(node.importClause.name.text)
        driverNamespaces.add(node.importClause.name.text)
      }
      if (bindings && ts.isNamespaceImport(bindings)) driverNamespaces.add(bindings.name.text)
      if (bindings && ts.isNamedImports(bindings)) {
        for (const specifier of bindings.elements) {
          if (!specifier.isTypeOnly) driverBindings.add(specifier.name.text)
        }
      }
    }
    if (!/^drizzle-orm(?:\/sql(?:\/sql)?)?$/.test(node.moduleSpecifier.text)) continue
    if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text)
    if (bindings && ts.isNamedImports(bindings)) {
      for (const specifier of bindings.elements) {
        const imported = (specifier.propertyName ?? specifier.name).text
        if (!specifier.isTypeOnly && imported === 'sql') sqlNames.add(specifier.name.text)
        if (!specifier.isTypeOnly && imported === 'SQL') sqlClasses.add(specifier.name.text)
      }
    }
  }

  const isDrizzle = (node, names, member) => ts.isIdentifier(node) ? names.has(node.text)
    : access(node) === member && ts.isIdentifier(node.expression) && namespaces.has(node.expression.text)
  const isSql = node => isDrizzle(node, sqlNames, 'sql')
  visit(source, node => {
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isIdentifier(node.name) && isSql(node.initializer)) {
      sqlNames.add(node.name.text)
    }
  })
  const pending = []
  visit(source, node => {
    const add = (rule, snippet = node.getText(source)) => pending.push({
      rule, snippet, offset: offset + node.getStart(source),
    })
    if ((ts.isImportDeclaration(node) && !typeOnlyImport(node) || ts.isExportDeclaration(node) && !node.isTypeOnly)
      && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier) && driver.test(node.moduleSpecifier.text)) {
      add('驱动导入')
    }
    if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && access(node) === '$client'
      || ts.isBindingElement(node) && (node.propertyName ?? node.name).getText(source).replace(/^['"]|['"]$/g, '') === '$client') {
      add('驱动客户端')
    }
    if (ts.isTaggedTemplateExpression(node) && isSql(node.tag)) {
      // Passing through a typed expression adds no literal SQL text.
      if (tagText(node.template).trim()) add('Drizzle SQL 模板')
      return
    }
    if (ts.isNewExpression(node)) {
      const target = node.expression
      if (isDrizzle(target, sqlClasses, 'SQL')) add('Drizzle SQL 构造')
      if (ts.isIdentifier(target) ? driverBindings.has(target.text)
        : access(target) && ts.isIdentifier(target.expression) && driverNamespaces.has(target.expression.text)) add('驱动实例')
    }
    if (ts.isCallExpression(node)) {
      const name = access(node.expression)
      const first = node.arguments[0]
      if (first && ts.isStringLiteralLike(first) && driver.test(first.text)
        && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === 'require')) {
        add('驱动导入')
      }
      if (name && ['raw', 'fromList'].includes(name) && isSql(node.expression.expression)) add('Drizzle SQL 构造')
      if (ts.isIdentifier(node.expression) && driverBindings.has(node.expression.text)) add('驱动实例')
      const argument = first && stringParts(first)
      const receiver = name && node.expression.expression.getText(source)
      const connection = receiver && /(?:^|\.)(?:db|tx|sqlite|client|connection|pool|scratch|oracle|native|\$client)$/i.test(receiver)
      if (['query', 'unsafe', 'pragma'].includes(name)
        || name === 'prepare' && first && (connection || argument && isStatement(argument))) add('驱动调用')
      if (first && ['execute', 'exec', 'run', 'get', 'all', 'values'].includes(name)) {
        const alreadyScanned = argument && isStatement(argument) || ts.isTaggedTemplateExpression(first) && isSql(first.tag)
        if (!alreadyScanned && ['execute', 'exec'].includes(name) && connection) add('直接执行')
      }
    }
    const value = stringParts(node)
    const bareTransaction = value !== undefined && /^(?:begin|commit|rollback)$/i.test(value)
    const method = bareTransaction && ts.isCallExpression(node.parent) && access(node.parent.expression)
    if (value !== undefined && isStatement(value) && (!bareTransaction || ['query', 'exec', 'execute', 'run'].includes(method)) && !(ts.isTaggedTemplateExpression(node.parent) && isSql(node.parent.tag))
      && !ts.isTemplateSpan(node.parent) && !ts.isBinaryExpression(node.parent)) {
      add('SQL 语句字面量')
    }
  })
  yield* pending
}

function git(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
}

export function inventory(ref, includeTests = true) {
  const listing = ref ? git(['ls-tree', '-r', '--name-only', '-z', ref]) : git(['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
  const paths = [...new Set(listing.split('\0').filter(path => sourceFile.test(path) || path.endsWith('.sql')))].sort()
  const results = []
  for (const path of paths) {
    if ((!includeTests && area(path) === '测试') || path.startsWith('.agents/') || /\.d\.[cm]?ts$/.test(path)) continue
    const filePath = resolve(root, path)
    if (!ref && !existsSync(filePath)) continue
    const text = ref ? git(['show', ref + ':' + path]) : readFileSync(filePath, 'utf8')
    const engine = includeTests ? runtimeEngine(path, text) : undefined
    const emit = ({ rule, snippet, offset }) => {
      const line = text.slice(0, offset).split('\n').length
      const row = { path, line, area: area(path), rule, signature: signature(snippet), snippet }
      if (includeTests) row.accessPath = accessPath(path, engine, row)
      results.push(row)
    }
    if (path.endsWith('.sql')) {
      emit({ rule: '独立 SQL 文件', offset: 0, snippet: text })
      continue
    }
    for (const [content, offset, kind] of sourceParts(path, text)) {
      const source = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true, kind)
      for (const entry of scanAst(source, offset)) emit(entry)
    }
  }
  return results
}

function key(entry) {
  return [entry.path, entry.rule, entry.signature].join('\t')
}

function decodeEntry(path, token, reason) {
  const [, code, signature, count] = /^([A-Z])([A-Za-z0-9_-]{43})(?::([1-9][0-9]*))?$/.exec(token) ?? []
  const rule = rules.get(code)
  if (!path || !rule || reason === '') throw new Error('Invalid SQL baseline entry: ' + path + ' ' + token)
  return { path, rule, signature, count: Number(count ?? 1), reason }
}

export function readBaseline() {
  return readFileSync(baselinePath, 'utf8').trimEnd().split('\n').filter(line => !line.startsWith('#')).flatMap(line => {
    const [path, tokens, reason] = line.split('\t')
    if (!tokens) throw new Error('Invalid SQL baseline line: ' + line)
    return tokens.split(',').map(token => decodeEntry(path, token, reason))
  })
}

export function baselineText(entries) {
  const legacyByPath = new Map()
  const approved = []
  const sorted = [...entries].sort((a, b) => key(a).localeCompare(key(b), 'en'))
  for (const entry of sorted) {
    const token = ruleCodes.get(entry.rule) + entry.signature + (entry.count === 1 ? '' : ':' + entry.count)
    if (entry.reason) approved.push([entry.path, token, entry.reason].join('\t'))
    else {
      const tokens = legacyByPath.get(entry.path) ?? []
      tokens.push(token)
      legacyByPath.set(entry.path, tokens)
    }
  }
  const legacy = [...legacyByPath].map(([path, tokens]) => path + '\t' + tokens.join(','))
  return ['# Legacy: file, then rule + base64url SHA256 + optional count. Use --prune to remove retired entries. Do not add legacy entries.',
    ...legacy, '# Justified exceptions: the optional third column records the reviewed reason.',
    ...approved, ''].join('\n')
}

export function counts(rows) {
  const grouped = new Map()
  for (const row of rows) {
    if (row.area === '测试') continue
    const token = key(row)
    const entry = grouped.get(token)
    if (entry) entry.count++
    else grouped.set(token, { ...row, count: 1 })
  }
  return grouped
}

function main() {
  const mode = process.argv[2]
  const rows = inventory(undefined, mode === '--inventory')
  const baseline = readBaseline()
  const allowed = new Map(baseline.map(entry => [key(entry), entry]))
  if (allowed.size !== baseline.length) throw new Error('Duplicate SQL baseline entry')
  if (mode === '--inventory') {
    const clean = value => value.replace(/\s+/g, ' ').trim()
    console.log('区域\t分类\t文件\t行\t检测类型\tSHA256-base64url\t依据\t片段\t调用区域')
    const observed = new Map()
    for (const row of rows) {
      const token = key(row)
      const occurrence = (observed.get(token) ?? 0) + 1
      observed.set(token, occurrence)
      const approval = allowed.get(token)
      const entry = occurrence <= (approval?.count ?? 0) ? approval : undefined
      const status = row.area === '测试' ? '测试或夹具' : entry?.reason ? '已核实必要' : entry ? '遗留' : '新增待审'
      console.log([row.area, status, row.path, row.line, row.rule, row.signature, entry?.reason ?? '', clean(row.snippet).slice(0, 350), row.accessPath].join('\t'))
    }
    return
  }
  if (mode && mode !== '--prune') throw new Error('Use sql-guard.mjs [--prune | --inventory]')
  const current = counts(rows)
  const violations = []
  for (const entry of current.values()) {
    if (entry.count > (allowed.get(key(entry))?.count ?? 0)) {
      violations.push(`${entry.path}:${entry.line}: ${entry.rule} [${entry.signature}]\n  ${entry.snippet.replace(/\s+/g, ' ').slice(0, 180)}`)
    }
  }
  if (violations.length) {
    console.error(violations.join('\n'))
    process.exitCode = 1
    return
  }
  const pruned = baseline.flatMap(entry => {
    const found = current.get(key(entry))
    return found ? [{ ...entry, count: found.count }] : []
  })
  if (mode === '--prune') writeFileSync(baselinePath, baselineText(pruned))
  else if (pruned.length !== baseline.length || pruned.some((entry, index) => entry.count !== baseline[index].count)) {
    console.error('SQL baseline has stale entries. Run node scripts/sql-guard.mjs --prune and include the shrinkage.')
    process.exitCode = 1
    return
  }
  const approved = pruned.filter(entry => entry.reason).reduce((sum, entry) => sum + entry.count, 0)
  const total = [...current.values()].reduce((sum, entry) => sum + entry.count, 0)
  console.log(`SQL guard: ${total - approved} legacy and ${approved} justified findings. No uncatalogued SQL or driver calls.`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
