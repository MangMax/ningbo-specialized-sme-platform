import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, relative, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

// Parse syntax rather than guessing dependencies from import text. Unresolved
// local aliases or computed imports make source changes conservatively relevant.
export function upgradeDependencies() {
 const seen=new Set()
 let uncertain=false
 function visit(file) {
  file=resolve(file); if(seen.has(file)||!existsSync(file)) return
  seen.add(file)
  if(!/\.(ts|mjs|js)$/.test(file)) return
  const ast=ts.createSourceFile(file,readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true)
  function dependency(spec) {
   const alias=spec.match(/^(~~|~|@db|@)(?:\/|$)/)
   if(!spec.startsWith('.')&&!alias) {
    if(spec.startsWith('#')) uncertain=true
    return
   }
   const base=alias?resolve(alias[1]==='@db'?'db':'.',spec.slice(alias[0].length)):resolve(dirname(file),spec)
   const target=[base,base+'.ts',base+'.mjs',base+'.js',base.replace(/\.js$/,'.ts'),base+'/index.ts'].find(p=>existsSync(p)&&statSync(p).isFile())
   if(target) visit(target)
   else uncertain=true
  }
  function walk(node) {
   if((ts.isImportDeclaration(node)||ts.isExportDeclaration(node))&&node.moduleSpecifier&&ts.isStringLiteral(node.moduleSpecifier)) dependency(node.moduleSpecifier.text)
   if(ts.isCallExpression(node)&&(node.expression.kind===ts.SyntaxKind.ImportKeyword||node.expression.getText(ast)==='require')) {
    const arg=node.arguments[0]
    if(arg&&(ts.isStringLiteral(arg)||ts.isNoSubstitutionTemplateLiteral(arg))) dependency(arg.text)
    else uncertain=true
   }
   ts.forEachChild(node,walk)
  }
  walk(ast)
 }
 function walk(dir) {for(const e of readdirSync(dir,{withFileTypes:true})) {const p=`${dir}/${e.name}`;if(e.isDirectory())walk(p);else if(dir.startsWith('upgrade')||p.endsWith('.upgrade.test.ts'))visit(p)}}
 walk('upgrade');walk('tests')
 const dependencies=new Set([...seen].map(p=>relative(process.cwd(),p)))
 dependencies.uncertain=uncertain
 return dependencies
}
export function selectUpgrade(paths) {
 const deps=upgradeDependencies()
 return paths.some(p=>!existsSync(p)||deps.has(p)||(deps.uncertain&&/^(server|lib)\/.*\.(ts|js|mjs)$/.test(p))||(p.startsWith('tests/')&&!p.endsWith('.test.ts'))||/^(db\/|upgrade\/|docs\/adr\/)/.test(p)||! /^(server\/|lib\/|tests\/|app\/|components\/|pages\/|assets\/|public\/|docs\/|README[^/]*$)/.test(p))
}
if(process.argv[1]===fileURLToPath(import.meta.url)) console.log(selectUpgrade(readFileSync(process.argv[2],'utf8').split('\n').filter(Boolean)))
