import { defineAsyncComponent } from 'vue'
import type { FileCategoryUi } from '../../layers/core/lib/core/file-category-ui'
import manifest from './manifest'

export const rosterFileCategoryUi = {
  id: manifest.id,
  name: manifest.name,
  ...manifest.fileCategories,
  cells: defineAsyncComponent(() => import('../../components/sme-roster/RosterFileCells.vue')),
  expandedPanel: defineAsyncComponent(() => import('../../components/sme-roster/RosterFileSegmentsEditor.vue')),
  detailPanel: defineAsyncComponent(() => import('../../components/sme-roster/RosterFileDetailPanel.vue')),
  uploadDialog: defineAsyncComponent(() => import('../../components/sme-roster/RosterFileUploadDialog.vue')),
  appliesTo: file => 'categoryState' in file,
} satisfies FileCategoryUi
