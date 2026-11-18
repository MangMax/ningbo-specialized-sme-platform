import type { FileCategory } from '../core/file-categories'
import { CATEGORY_STATES, CATEGORY_STATE_ORDER, PARSE_STATES, PARSE_STATE_ORDER, SOURCES, SOURCE_ORDER } from '../labels'
import { scopeOf } from './file-store-scope'

export const rosterFileCategory = {
  admission: scopeOf,
  columns: [
    { label: '来源', width: 81 },
    { label: '类别', width: 80 },
    { label: '文件发布', width: 92, tooltip: '文件发布年份 / 批次；内容年份和批次在分段中维护' },
    { label: '内容年份', width: 132, tooltip: '文件内容里各段的年份(可多个);复核段记的是被复核的原认定年份' },
    { label: '内容批次', width: 84, tooltip: '文件内容里各段的批次(可多个)' },
    { label: '分类状态', width: 76 },
    { label: '解析状态', width: 76 },
    { label: '被引用', width: 56, align: 'right' },
  ],
  cells: 'roster-file-cells',
  expandedPanel: 'roster-file-segments',
  detailPanel: 'roster-file-details',
  uploadDialog: 'roster-file-upload',
  filters: [
    { key: 'source', label: '来源', placeholder: '全部来源', width: 'w-28', options: SOURCE_ORDER.map(value => ({ value, label: SOURCES[value] ?? value })) },
    { key: 'categoryState', label: '分类', placeholder: '全部分类状态', width: 'w-32', options: CATEGORY_STATE_ORDER.map(value => ({ value, label: CATEGORY_STATES[value] ?? value })) },
    { key: 'parseState', label: '解析', placeholder: '全部解析状态', width: 'w-32', options: PARSE_STATE_ORDER.map(value => ({ value, label: PARSE_STATES[value] ?? value })) },
  ],
} satisfies FileCategory
