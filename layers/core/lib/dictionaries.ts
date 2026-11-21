export type DictionaryEntry = {
  code: string
  name: string
  detail?: string
  level?: number
  parentCode?: string | null
}

export const editableDictionaryKinds = ['list-sources', 'list-types'] as const
export type EditableDictionaryKind = typeof editableDictionaryKinds[number]
export const coreDictionaryKinds = [...editableDictionaryKinds, 'regions', 'industries'] as const
