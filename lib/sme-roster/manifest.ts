import { ChartColumn, Gauge, LayoutList, Search } from '@lucide/vue'
import { defineAppModule } from '../core/module-registry'
import { ENTERPRISE_LIST_TITLE } from '../labels'
import { ROSTER_LEDGER_PATH } from './routes'

const platform = { id: 'platform', label: '工信部平台' }
const rosterExport = { id: 'export', label: '导出' }

export default defineAppModule({
  id: 'sme-roster',
  name: '优质中小企业',
  description: '查询企业称号、历年认定记录与有效资格。',
  home: ROSTER_LEDGER_PATH,
  dashboard: [
    {
      id: 'roster-stats',
      title: '名录统计',
    },
  ],
  credentials: [{
    key: 'miitCookie',
    name: '平台 Cookie',
    description: '保存后供新查询和核查任务使用，不会自动登录、刷新会话或发起核查。优先级为显式覆盖、页面保存值、MIIT_COOKIE。',
    purpose: '工信部平台查询与核查',
    environment: ['MIIT_COOKIE'],
    singleLine: true,
  }],
  nav: [
    { title: ENTERPRISE_LIST_TITLE, url: ROSTER_LEDGER_PATH, icon: LayoutList },
    { title: '优质中小企业查询', url: '/current-enterprises', icon: Search },
    {
      title: '工信部查询', icon: Search,
      items: [
        { title: '申报记录', url: '/platform-declarations' },
        { title: '关联办理', url: '/platform-business-processes' },
        { title: '平台认定目录', url: '/platform-recognized-directory' },
      ],
    },
    { title: '统计', url: '/stats', icon: ChartColumn },
    { title: '数据质量', url: '/quality', icon: Gauge },
  ],
  jobKinds: [
    { kind: 'difference-snapshot', label: '平台业务采集入库', group: platform, spec: 'differenceSnapshotSpec' },
    { kind: 'platform-query-batch', label: '平台批量查询', group: platform, spec: 'batchSpec' },
    { kind: 'reconcile', label: '平台核查', group: platform, spec: 'reconcileSpec' },
    { kind: 'event-archive-candidates', label: '公布事件候选发现', group: platform, spec: 'candidateDiscoverySpec' },
    { kind: 'event-annual-correspondence', label: '年度过程对应', group: platform, spec: 'annualSpec' },
    { kind: 'current-roster-export', label: '当前名录导出', group: rosterExport, spec: 'currentRosterExportSpec' },
  ],
})
