/**
 * 日志配置页新增折叠面板的图标登记表（#180 accordion UI）。
 *
 * 只覆盖本次改版用到的图标；不把全站图标迁到 Nuxt Icon。
 * 所有图标都通过 `<Icon :name="...">` 渲染，名称来自 Iconify 本地集合
 * （lucide / logos / simple-icons）或项目自有 custom collection（project:tus、
 * project:pinia-colada）。`nuxt.config.ts` 把 `LOG_ICON_IDS` 显式交给
 * `icon.clientBundle.icons`，因此不依赖运行时 api.iconify.design。
 */
export const LOG_ICONS = {
  sections: {
    technical: 'lucide:workflow',
    business: 'lucide:braces',
    retention: 'lucide:hard-drive',
  },
  groups: {
    'technical-node': 'lucide:server',
    'technical-browser': 'lucide:monitor-smartphone',
    'technical-other': 'lucide:server',
    'business-shared': 'lucide:code',
    'business-node': 'lucide:network',
    'business-browser': 'lucide:radio',
  },
  integrations: {
    'nuxt-nitro': 'logos:nuxt-icon',
    'mcp-toolkit': 'simple-icons:modelcontextprotocol',
    tus: 'project:tus',
    application: 'lucide:code',
    browser: 'lucide:monitor',
    vue: 'logos:vue',
    'tus-client': 'project:tus',
    drizzle: 'logos:drizzle-icon',
    embedpdf: 'lucide:file-text',
    'pinia-colada': 'project:pinia-colada',
    'vue-router': 'lucide:route',
  },
  sources: {
    http: 'lucide:globe',
    mcp: 'simple-icons:modelcontextprotocol',
    task: 'lucide:list-checks',
    worker: 'lucide:cog',
    platform: 'lucide:network',
    file: 'lucide:folder-open',
    ocr: 'lucide:scan-text',
    import: 'lucide:download',
    export: 'lucide:upload',
    system: 'lucide:cpu',
    client: 'lucide:radio',
  },
  actions: {
    expand: 'lucide:chevron-right',
    jump: 'lucide:arrow-up-right',
    warning: 'lucide:triangle-alert',
    saving: 'lucide:loader-circle',
    saved: 'lucide:check',
  },
} as const

const FALLBACK_ICON = 'lucide:circle-alert'

/** integration 目录键 → 图标；未知键退回语义图标，不猜品牌。 */
export function iconForIntegration(key: string): string {
  return (LOG_ICONS.integrations as Record<string, string>)[key] ?? FALLBACK_ICON
}

/** source 目录键 → 图标；未知键退回语义图标。 */
export function iconForSource(key: string): string {
  return (LOG_ICONS.sources as Record<string, string>)[key] ?? FALLBACK_ICON
}

/** section/group 键 → 图标。 */
export function iconForSection(key: keyof typeof LOG_ICONS.sections): string {
  return LOG_ICONS.sections[key]
}
export function iconForGroup(key: string): string {
  return (LOG_ICONS.groups as Record<string, string>)[key] ?? FALLBACK_ICON
}

/** 交给 @nuxt/icon clientBundle 的完整名单；新增图标必须同时登记在这里。 */
export const LOG_ICON_IDS: string[] = [
  ...new Set([
    ...Object.values(LOG_ICONS.sections),
    ...Object.values(LOG_ICONS.groups),
    ...Object.values(LOG_ICONS.integrations),
    ...Object.values(LOG_ICONS.sources),
    ...Object.values(LOG_ICONS.actions),
    FALLBACK_ICON,
  ]),
]

/**
 * 供交接文档使用的来源/许可清单。ID 与 assets/project-icons.json 保持一一对应。
 * 文件许可不等于商标许可；品牌标志仅用于识别对应集成。
 */
export const LOG_ICON_MANIFEST = [
  { slot: 'i:nuxt-nitro', id: 'logos:nuxt-icon', source: 'Iconify logos (gilbarbara/logos)', license: 'CC0-1.0', note: 'Nuxt / Nitro 行共用；Nitro 备选 unjs:nitro' },
  { slot: 'i:mcp-toolkit / s:mcp', id: 'simple-icons:modelcontextprotocol', source: 'Simple Icons via Iconify', license: 'CC0-1.0', note: '单色 currentColor，暗色可读；彩色 logos 版已否决' },
  { slot: 'i:tus / i:tus-client', id: 'project:tus', source: 'tus.io 官方 glyph (tus/tus.io)', license: 'MIT (repo)', note: 'Iconify 无 tus；本地 custom collection' },
  { slot: 'i:drizzle', id: 'logos:drizzle-icon', source: 'Iconify logos (gilbarbara/logos)', license: 'CC0-1.0', note: '图标版；词标已否决' },
  { slot: 'i:vue', id: 'logos:vue', source: 'Iconify logos (gilbarbara/logos)', license: 'CC0-1.0', note: null },
  { slot: 'i:pinia-colada', id: 'project:pinia-colada', source: 'Pinia Colada 官方 docs/public/logo.svg', license: 'MIT (repo)', note: '鸡尾酒杯；不冒用 Pinia 菠萝' },
  { slot: 'i:vue-router', id: 'lucide:route', source: 'Iconify lucide', license: 'ISC', note: '官方 docs logo 实为 Vue V，按用户要求不用 Vue 代替' },
  { slot: 'i:embedpdf', id: 'lucide:file-text', source: 'Iconify lucide', license: 'ISC', note: '官方品牌资产保留所有权利，未获许可前用语义图标' },
  { slot: 'i:browser', id: 'lucide:monitor', source: 'Iconify lucide', license: 'ISC', note: '无单一浏览器品牌' },
  { slot: 'i:application', id: 'lucide:code', source: 'Iconify lucide', license: 'ISC', note: null },
  { slot: 's:http', id: 'lucide:globe', source: 'Iconify lucide', license: 'ISC', note: '抽象来源' },
  { slot: 's:task', id: 'lucide:list-checks', source: 'Iconify lucide', license: 'ISC', note: null },
  { slot: 's:worker', id: 'lucide:cog', source: 'Iconify lucide', license: 'ISC', note: null },
  { slot: 's:platform', id: 'lucide:network', source: 'Iconify lucide', license: 'ISC', note: null },
  { slot: 's:file', id: 'lucide:folder-open', source: 'Iconify lucide', license: 'ISC', note: '字段跟随 tus 采集器' },
  { slot: 's:ocr', id: 'lucide:scan-text', source: 'Iconify lucide', license: 'ISC', note: null },
  { slot: 's:import', id: 'lucide:download', source: 'Iconify lucide', license: 'ISC', note: null },
  { slot: 's:export', id: 'lucide:upload', source: 'Iconify lucide', license: 'ISC', note: null },
  { slot: 's:system', id: 'lucide:cpu', source: 'Iconify lucide', license: 'ISC', note: null },
  { slot: 's:client', id: 'lucide:radio', source: 'Iconify lucide', license: 'ISC', note: null },
  { slot: 'action.expand', id: 'lucide:chevron-right', source: 'Iconify lucide', license: 'ISC', note: '固定朝右；展开后不旋转' },
  { slot: 'action.jump', id: 'lucide:arrow-up-right', source: 'Iconify lucide', license: 'ISC', note: '跳到同时生效的另一侧' },
  { slot: 'l1/l2/action', id: 'lucide:*', source: 'Iconify lucide', license: 'ISC', note: '其余语义图标' },
] as const
