import ts from 'typescript'

// Match table positions, ignoring comments and value literals. Keep quoted
// identifier tokens intact so a column named "from invoice" is not SQL syntax.
const sqlTokens = /--[^\r\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|[a-z_][\w$]*|[^\s]/gi
const identifier = /^(?:[a-z_][\w$]*|(["'\x60]).*\1|\[.*\])$/is
const tableKeywords = new Set(['from', 'join', 'into', 'update', 'references', 'table'])
const fromEnd = new Set(['where', 'group', 'having', 'order', 'limit', 'window', 'returning', 'union', 'intersect', 'except', ';'])
const tableModifiers = new Set(['or', 'rollback', 'abort', 'replace', 'fail', 'ignore', 'if', 'not', 'exists'])

function sqlTableReferences(sql) {
  if (!/\b(?:from|join|into|update|references|table)\b/i.test(sql)) return []
  const tokens = (sql.match(sqlTokens) ?? [])
    .filter(token => !token.startsWith('--') && !token.startsWith('/*'))
    .map(token => token.toLowerCase())
  const tables = new Set()
  const fromClauses = new Set()
  let depth = 0
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token === '(') {
      depth++
    } else if (token === ')') {
      fromClauses.delete(depth--)
    } else if (fromEnd.has(token)) {
      fromClauses.delete(depth)
    } else if (tableKeywords.has(token) || token === ',' && fromClauses.has(depth)) {
      if (token === 'from') {
        if (tokens[i - 1] === 'distinct') continue
        fromClauses.add(depth)
      }
      let j = i + 1
      while (tableModifiers.has(tokens[j])) j++
      if (tokens[j + 1] === '.') j += 2
      if (identifier.test(tokens[j] ?? '')) {
        const name = tokens[j].replace(/^["'`\[]|["'`\]]$/g, '')
        tables.add(name)
        i = j
      }
    }
  }
  return tables
}

function staticSql(node) {
  if (ts.isStringLiteralLike(node)) return node.text
  if (ts.isTemplateExpression(node)) {
    return node.head.text + node.templateSpans.map(span => (staticSql(span.expression) ?? ' ? ') + span.literal.text).join('')
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticSql(node.left)
    const right = staticSql(node.right)
    if (left !== undefined && right !== undefined) return left + right
  }
}

export function tablesInSql(node) {
  const sql = staticSql(node)
  if (sql === undefined) return []
  // Report the complete statement once when several literals form it.
  if (ts.isBinaryExpression(node.parent) && staticSql(node.parent) !== undefined) return []
  return sqlTableReferences(sql)
}
