import { ChartColumn, Gauge, LayoutList, Search } from '@lucide/vue'
import { defineAppModule } from '../core/module-registry'
import { ENTERPRISE_LIST_TITLE } from '../labels'
import { ROSTER_LEDGER_PATH } from './routes'

export default defineAppModule({
  id: 'sme-roster',
  name: '优质中小企业',
  description: '查询企业称号、历年认定记录与有效资格。',
  home: ROSTER_LEDGER_PATH,
  dashboard: [
    {
      id: 'roster-stats',
      title: '名录统计',
      loadComponent: () => import('../../components/RosterDashboardStats.vue').then(module => module.default),
    },
  ],
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
})
