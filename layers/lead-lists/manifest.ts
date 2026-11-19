import { ListChecks } from '@lucide/vue'
import { defineAppModule } from '../core/lib/core/module-registry'
import { leadListFileCategory } from './lib/file-category'

export default defineAppModule({
  id: 'lead-lists',
  name: '线索名单',
  home: '/lead-lists',
  routes: ['/api/lead-lists'],
  clientPages: [{ page: 'lead-lists', paths: ['/lead-lists'] }],
  nav: [{ title: '线索名单', url: '/lead-lists', icon: ListChecks }],
  dashboard: [{ id: 'lead-lists-entry', title: '名单版本' }],
  fileCategories: leadListFileCategory,
})
