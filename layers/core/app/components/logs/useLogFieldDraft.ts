import { computed, ref, type Ref } from 'vue'
import type { LogFieldControls } from '#core/lib/logging/contract'
import { levelLabel, type FieldChange, type FieldProfile, type PolicyView } from './logPolicy'

type FieldLevels = Record<string, Record<string, boolean>>
type FieldDraft = Partial<Record<string, FieldLevels>>

const fieldValues = (controls: FieldDraft | undefined, profile: string, level: string) =>
  controls?.[profile]?.[level]

/** 只按目录里真实存在的键重建，响应里多出的 profile/level/field 不进入草稿。 */
function cloneFieldControls(
  controls: LogFieldControls | undefined,
  profiles: readonly FieldProfile[]
): FieldDraft {
  const out: FieldDraft = {}
  for (const profile of profiles) {
    const levels: Record<string, Record<string, boolean>> = {}
    for (const level of profile.levels) {
      const values = fieldValues(controls, profile.key, level)
      const fields: Record<string, boolean> = {}
      for (const field of profile.fields) fields[field.key] = values?.[field.key] === true
      levels[level] = fields
    }
    out[profile.key] = levels
  }
  return out
}

export function useLogFieldDraft(data: Readonly<Ref<PolicyView | null>>) {
  const fieldDraft = ref<FieldDraft>({})

  function reset(policy: PolicyView) {
    fieldDraft.value = cloneFieldControls(policy.fieldControls, policy.catalog?.profiles ?? [])
  }

  /** 字段目录只来自服务端响应；旧后端或不可读的字段规则不渲染入口，也不补默认。 */
  const fieldProfiles = computed<readonly FieldProfile[]>(() => data.value?.catalog?.profiles ?? [])
  const supportsFieldControls = computed(() => {
    const profiles = fieldProfiles.value,
      controls = data.value?.fieldControls
    // 父级条件是真实的来源/集成规则；没有 collection 就无从判断“当前是否采集”，
    // 整个入口隐藏而不是渲染一组看起来可用的孤立开关。
    if (!profiles.length || !controls || !data.value?.collection) return false
    return profiles.every(
      (profile) =>
        profile.fields.length > 0 &&
        profile.levels.length > 0 &&
        profile.levels.every((level) => {
          const values = fieldValues(controls, profile.key, level)
          return (
            !!values && profile.fields.every((field) => typeof values[field.key] === 'boolean')
          )
        })
    )
  })
  function retainedFieldCount(profile: FieldProfile) {
    return profile.fields.filter((field) =>
      profile.levels.every((level) => fieldValues(fieldDraft.value, profile.key, level)?.[field.key] === true)
    ).length
  }

  /** 相对服务端基线的真实差异；恢复 true 也在这里出现，不能只在“关闭项”里找。 */
  const fieldChanges = computed<FieldChange[]>(() => {
    const baseline = data.value?.fieldControls
    if (!baseline || !supportsFieldControls.value) return []
    const changes: FieldChange[] = []
    for (const profile of fieldProfiles.value)
      for (const level of profile.levels)
        for (const field of profile.fields) {
          const from = fieldValues(baseline, profile.key, level)?.[field.key]
          const to = fieldValues(fieldDraft.value, profile.key, level)?.[field.key]
          if (typeof from !== 'boolean' || typeof to !== 'boolean' || from === to) continue
          changes.push({
            profile: profile.key,
            profileLabel: profile.label,
            level,
            levelLabel: levelLabel(level),
            field: field.key,
            fieldLabel: field.label,
            from,
            to
          })
        }
    return changes
  })
  const controlsFor = (profile: FieldProfile) => fieldDraft.value[profile.key]

  function profileDirty(profile: FieldProfile) {
    const baseline = data.value?.fieldControls
    if (!baseline) return false
    return profile.levels.some((level) =>
      profile.fields.some((field) => {
        const from = fieldValues(baseline, profile.key, level)?.[field.key]
        const to = fieldValues(fieldDraft.value, profile.key, level)?.[field.key]
        return typeof from === 'boolean' && from !== to
      })
    )
  }

  return { reset, fieldProfiles, supportsFieldControls, retainedFieldCount, fieldChanges, controlsFor, profileDirty }
}
