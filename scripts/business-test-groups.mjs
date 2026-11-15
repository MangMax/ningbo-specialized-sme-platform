// One explicit business owner per directory. Unknown owners fail selection.
import { readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const owners = {
  "名录导入与证据": [
    "roster/imports",
    "roster/official-evidence",
    "roster/event-correction",
    "roster/source-completeness",
    "roster/curation"
  ],
  "后台任务": [
    "tasks/candidates",
    "tasks/center",
    "tasks/context",
    "tasks/details",
    "tasks/jobs"
  ],
  "称号统计": [
    "statistics/annual",
    "statistics/districts",
    "statistics/movements",
    "statistics/published",
    "statistics/retired-models"
  ],
  "日志与审计": [
    "logging/client",
    "logging/context",
    "logging/core",
    "logging/database",
    "logging/enterprise",
    "logging/exports",
    "logging/files",
    "logging/imports",
    "logging/integration",
    "logging/jobs",
    "logging/platform",
    "logging/policy",
    "logging/reliability",
    "logging/viewer"
  ],
  "运行环境与界面": [
    "runtime/credentials",
    "runtime/database",
    "runtime/development",
    "runtime/discovery",
    "runtime/http-contract",
    "runtime/mcp",
    "runtime/native-boundary",
    "runtime/read-scheduling",
    "runtime/test-services",
    "ui/disclosure",
    "ui/navigation",
    "ui/scroll",
    "ui/settings",
    "ui/tables"
  ],
  "平台申报与办理": [
    "platform/declarations",
    "platform/business-processes",
    "platform/filters",
    "platform/identity",
    "platform/record-list",
    "platform/summary",
    "platform/export"
  ],
  "平台认定目录": [
    "platform/recognized-directory"
  ],
  "平台采集与查询回放": [
    "platform/collections",
    "platform/queries",
    "platform/transport",
    "platform/retained-query",
    "platform/comparison"
  ],
  "平台归档与引用迁移": [
    "platform/evidence",
    "platform/correspondence",
    "platform/differences",
    "platform/provenance",
    "platform/projections",
    "platform/runtime-boundary",
    "platform/snapshots"
  ],
  "平台观察、指纹与补录": [
    "platform/fingerprints",
    "platform/observations",
    "platform/reconciliation"
  ],
  "名录资格与认定读取": [
    "roster/current-qualification",
    "roster/current-candidates",
    "roster/little-giant",
    "roster/qualification-readback",
    "roster/recognition-read"
  ],
  "名录工作簿导出": [
    "roster/current-export",
    "roster/legacy-export",
    "roster/status-workbook"
  ],
  "名录企业台账与年度流程": [
    "roster/annual-process",
    "roster/aliases",
    "roster/enterprise-detail",
    "roster/enterprise-facts",
    "roster/enterprise-read",
    "roster/evidence-navigation",
    "roster/identity",
    "roster/labels",
    "roster/ledger",
    "roster/lifecycle",
  ],
  "名录对应与差异决定": [
    "roster/comparison",
    "roster/correspondence",
    "roster/event-correspondence",
    "roster/annual-correspondence",
    "roster/decisions",
    "roster/enterprise-differences"
  ],
  "文件存储、OCR识别、解析与预览": [
    "files/ocr",
    "files/parsing",
    "files/pdf-reader",
    "files/excel",
    "files/content",
    "files/metadata",
    "files/preview",
    "files/segments",
    "files/storage",
    "files/upload"
  ]
}
const watcher = 'tests/runtime/development/nuxt-runtime-watch.http.app.test.ts'
export function inventory() {
  function walk(dir) { return readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(`${dir}/${e.name}`):[`${dir}/${e.name}`]) }
  return walk('tests').filter(f=>f.endsWith('.test.ts')).sort().map(file=>{
    const directory=file.split('/').slice(1,3).join('/')
    const matches=Object.entries(owners).filter(([,dirs])=>dirs.includes(directory))
    if(matches.length!==1) throw new Error(`Expected exactly one business owner: ${file} (${matches.length})`)
    const project=file===watcher?'deep':file.endsWith('.app.test.ts')?'app':file.endsWith('.upgrade.test.ts')?'upgrade':'runtime'
    return {file,project,business:matches[0][0],group:`${matches[0][0]} · ${project}`}
  })
}
export function matrices(includeUpgrade=true) {
  const rows=inventory().filter(r=>r.project!=='deep'&&(includeUpgrade||r.project!=='upgrade'))
  const unique=[...new Map(rows.map(r=>[`${r.business}:${r.project==='app'?'app':'native'}`,r])).values()].map(r=>{
    const project=r.project==='app'?'app':'native'
    const upgrade=project==='native'&&rows.some(row=>row.business===r.business&&row.project==='upgrade')
    const group=`${r.business} · ${project==='app'?'应用进程':upgrade?'逻辑及升级':'逻辑'}`
    return {group,business:r.business,project,upgrade}
  })
  return {native:unique.filter(r=>r.project==='native'),app:unique.filter(r=>r.project==='app')}
}
if(process.argv[1]===fileURLToPath(import.meta.url)) {
 const [command,arg,...extra]=process.argv.slice(2)
 if(command==='matrix') console.log(JSON.stringify(matrices(arg!=='false')))
 else if(command==='inventory') console.log(JSON.stringify(inventory(),null,2))
 else if(command==='run'||command==='list') {
   const group=[...matrices(true).native,...matrices(true).app,...matrices(false).native].find(r=>r.group===arg)
   const rows=group?inventory().filter(r=>r.business===group.business && (group.project==='app'?r.project==='app':r.project==='runtime'||(group.upgrade&&r.project==='upgrade'))):[]
   if(!rows.length) throw new Error(`Unknown/empty test group: ${arg}`)
   const result=spawnSync('pnpm',[...(command==='list'?['exec','vitest','list','--filesOnly','--json']:['test']),...[...new Set(rows.map(r=>r.project))].map(p=>`--project=${p}`),...rows.map(r=>r.file),'--maxWorkers=1','--no-file-parallelism',...extra],{stdio:'inherit'})
   process.exit(result.status??1)
 } else throw new Error('Use inventory, matrix [false], or run GROUP [vitest options]')
}
