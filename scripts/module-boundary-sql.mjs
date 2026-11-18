import ts from 'typescript'

// Match table positions, ignoring comments and value literals. Keep quoted
// identifier tokens intact so a column named "from invoice" is not SQL syntax.
const sqlTokens = /--[^\r\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|[a-z_][\w$]*|[^\s]/gi
const identifier = /^(?:[a-z_][\w$]*|(["'\x60]).*\1|\[.*\])$/is
const tableKeywords = new Set(['from', 'join', 'into', 'update', 'references', 'table'])
const fromEnd = new Set(['where', 'group', 'having', 'order', 'limit', 'window', 'returning', 'union', 'intersect', 'except', ';'])
const tableModifiers = new Set(['or', 'rollback', 'abort', 'replace', 'fail', 'ignore', 'if', 'not', 'exists'])
const queryStart = new Set(['select', 'with', 'values'])

function closingParentheses(tokens) {
  const opens = []
  const closes = new Map()
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === '(') opens.push(i)
    if (tokens[i] === ')' && opens.length) closes.set(opens.pop(), i)
  }
  return closes
}

function tableName(token) {
  return token.replace(/^["'`\[]|["'`\]]$/g, '')
}

function cteNames(tokens, start, closes) {
  const names = new Set()
  let i = tokens[start] === 'recursive' ? start + 1 : start
  while (identifier.test(tokens[i] ?? '')) {
    const name = tableName(tokens[i++])
    if (tokens[i] === '(') i = (closes.get(i) ?? tokens.length) + 1
    if (tokens[i++] !== 'as') break
    if (tokens[i] === 'not' && tokens[i + 1] === 'materialized') i += 2
    else if (tokens[i] === 'materialized') i++
    const end = closes.get(i)
    if (end === undefined) break
    names.add(name)
    i = end + 1
    if (tokens[i++] !== ',') break
  }
  return names
}

function sqlTableReferences(sql) {
  if (!/\b(?:from|join|into|update|references|table)\b/i.test(sql)) return []
  const tokens = (sql.match(sqlTokens) ?? [])
    .filter(token => !token.startsWith('--') && !token.startsWith('/*'))
    .map(token => token.toLowerCase())
  const tables = new Set()
  const fromClauses = new Set()
  const cteScopes = new Map()
  const closes = tokens.includes('with') ? closingParentheses(tokens) : undefined
  let depth = 0
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token === '(') {
      depth++
    } else if (token === ')') {
      cteScopes.delete(depth)
      fromClauses.delete(depth--)
    } else if (token === 'with') {
      const names = cteNames(tokens, i + 1, closes)
      if (names.size) cteScopes.set(depth, names)
    } else if (fromEnd.has(token)) {
      fromClauses.delete(depth)
      if (token === ';') cteScopes.delete(depth)
    } else if (tableKeywords.has(token) || token === ',' && fromClauses.has(depth)) {
      if (token === 'from') {
        if (tokens[i - 1] === 'distinct') continue
        fromClauses.add(depth)
      }
      let j = i + 1
      while (tableModifiers.has(tokens[j])) j++
      const read = token === 'from' || token === 'join' || token === ','
      if (read) {
        // A table group starts a new FROM list. A derived query discovers
        // its own FROM clauses as the main scan enters its parentheses.
        while (tokens[j] === '(' && !queryStart.has(tokens[j + 1])) {
          fromClauses.add(++depth)
          i = j++
        }
      }
      const qualified = tokens[j + 1] === '.'
      if (qualified) j += 2
      if (identifier.test(tokens[j] ?? '')) {
        const name = tableName(tokens[j])
        if (!read || qualified || ![...cteScopes.values()].some(names => names.has(name))) tables.add(name)
        i = j
      }
    }
  }
  return tables
}

function staticSql(node, checker, resolving) {
  if (ts.isStringLiteralLike(node)) return node.text
  if (ts.isTemplateExpression(node)) {
    const seen = resolving ?? new Set()
    return node.head.text + node.templateSpans.map(span => (
      (staticSql(span.expression, checker, seen) ?? ' ? ') + span.literal.text
    )).join('')
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticSql(node.left, checker, resolving)
    const right = staticSql(node.right, checker, resolving)
    if (left !== undefined && right !== undefined) return left + right
  }
  if (!resolving) return
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {
    return staticSql(node.expression, checker, resolving)
  }
  if (ts.isIdentifier(node)) {
    const declaration = checker.getSymbolAtLocation(node)?.valueDeclaration
    if (!declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer ||
        !ts.isVariableDeclarationList(declaration.parent) || !(declaration.parent.flags & ts.NodeFlags.Const) ||
        declaration.getSourceFile() !== node.getSourceFile() || resolving.has(declaration)) return
    resolving.add(declaration)
    const value = staticSql(declaration.initializer, checker, resolving)
    resolving.delete(declaration)
    return value
  }
}

export function tablesInSql(node, checker) {
  const sql = staticSql(node, checker)
  if (sql === undefined) return []
  // Report the complete statement once when several literals form it.
  if (ts.isBinaryExpression(node.parent) && staticSql(node.parent, checker) !== undefined) return []
  return sqlTableReferences(sql)
}
