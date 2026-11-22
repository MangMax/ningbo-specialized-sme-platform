import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import ts from 'typescript'

export function indexTableOwnership({ root, program, files, layerOf, layers, walk, report, violations }) {
  const checker = program.getTypeChecker()
  const schemaDirectory = resolve(root, 'db/postgresql')
  const ownershipPath = resolve(root, 'scripts/shared-schema-table-owners.json')
  const sharedOwners = new Map()
  const tableOwners = new Map()
  const declarations = new Map()
  const sharedDeclarations = new Set()
  if (existsSync(ownershipPath)) {
    const inventory = JSON.parse(readFileSync(ownershipPath, 'utf8'))
    for (const [owner, tables] of Object.entries(inventory)) {
      if (!layers.has(owner)) violations.push(`${relative(root, ownershipPath)}: unknown layer ${owner}`)
      for (const table of tables) {
        if (sharedOwners.has(table)) violations.push(`${relative(root, ownershipPath)}: duplicate owner for ${table}`)
        sharedOwners.set(table, owner)
      }
    }
  }

  function canonicalSymbol(symbol) {
    return symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol
  }

  function indexTables(source) {
    const layer = layerOf(source.fileName)
    walk(source, node => {
      if (!ts.isCallExpression(node)) return
      const callee = ts.isPropertyAccessExpression(node.expression) ? node.expression.name : node.expression
      const symbol = checker.getSymbolAtLocation(callee)
      const importName = symbol?.declarations?.find(ts.isImportSpecifier)
      const constructor = (importName?.propertyName ?? callee).getText(source)
      const schema = ts.isPropertyAccessExpression(node.expression) && node.expression.expression.getText(source)
      if (constructor !== 'pgTable' && !(constructor === 'table' && /^(?:businessSchema|logSchema|runtimeLogSchema)$/.test(schema || ''))) return
      const name = node.arguments[0]
      if (!name || !ts.isStringLiteralLike(name)) {
        report(source, node, 'PostgreSQL table declarations need a static name for ownership checking')
        return
      }
      const table = name.text.toLowerCase()
      if (!layer) sharedDeclarations.add(table)
      const owner = layer ?? sharedOwners.get(table)
      if (!owner) {
        report(source, node, `no owner declared for table ${table}`)
        return
      }
      const previousOwner = tableOwners.get(table)
      if (previousOwner && previousOwner !== owner) {
        report(source, node, `conflicting owners for table ${table}: ${previousOwner} and ${owner}`)
        return
      }
      tableOwners.set(table, owner)
      declarations.set(node, table)
    })
  }

  function tablesForExport(symbol, seen, tables) {
    symbol = canonicalSymbol(symbol)
    if (!symbol || seen.has(symbol)) return
    seen.add(symbol)
    for (const decl of symbol.declarations ?? []) {
      if (ts.isSourceFile(decl)) {
        for (const member of checker.getExportsOfModule(symbol)) tablesForExport(member, seen, tables)
      } else if (ts.isVariableDeclaration(decl) || ts.isExportAssignment(decl)) {
        const value = ts.isVariableDeclaration(decl) ? decl.initializer : decl.expression
        if (!value) continue
        const table = declarations.get(value)
        if (table) tables.add(table)
        else if (ts.isCallExpression(value)) tablesForExport(checker.getSymbolAtLocation(value.expression), seen, tables)
        else if (ts.isIdentifier(value) || ts.isPropertyAccessExpression(value)) {
          tablesForExport(checker.getSymbolAtLocation(ts.isIdentifier(value) ? value : value.name), seen, tables)
        }
      } else if (ts.isFunctionDeclaration(decl) && decl.body) {
        for (const statement of decl.body.statements) {
          if (ts.isReturnStatement(statement) && declarations.has(statement.expression)) {
            tables.add(declarations.get(statement.expression))
          }
        }
      }
    }
  }

  function importedNames(node) {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause
      if (!clause) return []
      if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) return
      return [
        ...(clause.name ? ['default'] : []),
        ...(clause.namedBindings?.elements.map(element => (element.propertyName ?? element.name).text) ?? []),
      ]
    }
    if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
      return node.exportClause.elements.map(element => (element.propertyName ?? element.name).text)
    }
    if (ts.isImportTypeNode(node) && node.qualifier && ts.isIdentifier(node.qualifier)) return [node.qualifier.text]
    if (ts.isNewExpression(node)) return []
  }

  function importedTables(node, target) {
    const targetSource = program.getSourceFile(target)
    const module = targetSource && checker.getSymbolAtLocation(targetSource)
    if (!module) return []
    const names = importedNames(node)
    const tables = new Set()
    const seen = new Set()
    for (const symbol of checker.getExportsOfModule(module)) {
      if (!names || names.includes(symbol.name)) tablesForExport(symbol, seen, tables)
    }
    return tables
  }

  for (const source of program.getSourceFiles()) {
    if (source.fileName.startsWith(schemaDirectory + '/') || layerOf(source.fileName) && files.includes(source.fileName)) indexTables(source)
  }
  const schemaTables = new Set(
    (existsSync(schemaDirectory) ? readdirSync(schemaDirectory) : []).filter(name => name.endsWith('.sql')).flatMap(name =>
      [...readFileSync(resolve(schemaDirectory, name), 'utf8').matchAll(/^CREATE TABLE (?:IF NOT EXISTS )?(?:business\.)?(\w+)/gim)]
        .map(match => match[1].toLowerCase())),
  )
  for (const table of sharedOwners.keys()) {
    if (!schemaTables.has(table) && !sharedDeclarations.has(table)) {
      violations.push(`${relative(root, ownershipPath)}: table ${table} has no PostgreSQL declaration`)
    }
  }
  for (const table of schemaTables) {
    if (!tableOwners.has(table)) {
      const owner = sharedOwners.get(table)
      if (owner) tableOwners.set(table, owner)
      else violations.push(`${relative(root, ownershipPath)}: no owner declared for table ${table}`)
    }
  }

  return { tableOwners, importedTables }
}
