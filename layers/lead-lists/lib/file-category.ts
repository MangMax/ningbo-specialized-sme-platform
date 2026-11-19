import type { FileCategory } from '../../core/lib/core/file-categories'

export const leadListFileCategory = {
  admission: () => ({ inScope: true, reason: 'in-scope', detail: '' }),
  filters: [{
    key: 'leadListUsage', label: '线索名单', placeholder: '线索名单用途', width: 'w-40',
    options: [{ value: 'source', label: '线索名单原件' }],
  }],
} satisfies FileCategory
