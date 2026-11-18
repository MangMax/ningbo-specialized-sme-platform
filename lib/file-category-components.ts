import { defineAsyncComponent, type Component } from 'vue'

// The file page resolves the component keys declared in the shared manifests.
const components = new Map<string, Component>([
  ['roster-file-cells', defineAsyncComponent(() => import('../components/sme-roster/RosterFileCells.vue'))],
  ['roster-file-segments', defineAsyncComponent(() => import('../components/sme-roster/RosterFileSegmentsEditor.vue'))],
  ['roster-file-details', defineAsyncComponent(() => import('../components/sme-roster/RosterFileDetailPanel.vue'))],
  ['roster-file-upload', defineAsyncComponent(() => import('../components/sme-roster/RosterFileUploadDialog.vue'))],
])

export function getFileCategoryComponent(id: string): Component {
  const component = components.get(id)
  if (!component) throw new Error(`未登记文件扩展组件「${id}」`)
  return component
}
