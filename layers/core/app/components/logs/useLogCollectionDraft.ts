import { computed, ref, type Ref } from 'vue'
import type { LogCollection, LogCollectionRule } from '#core/lib/logging/contract'
import { sourceLabel } from './logPresentation'
import type { CollectionRow, IntegrationEntry, PolicyView, RuleChange } from './logPolicy'

export type IntegrationRow = CollectionRow & {
  category: IntegrationEntry['category']
  runtimes: IntegrationEntry['runtimes']
}
function cloneRules(
  rules?: Partial<Record<string, LogCollectionRule>>
): Record<string, LogCollectionRule> {
  const out: Record<string, LogCollectionRule> = {}
  for (const [key, rule] of Object.entries(rules ?? {}))
    if (rule) out[key] = { enabled: rule.enabled, minLevel: rule.minLevel }
  return out
}
const sameRule = (a: LogCollectionRule, b: LogCollectionRule) =>
  a.enabled === b.enabled && a.minLevel === b.minLevel

export function useLogCollectionDraft(data: Readonly<Ref<PolicyView | null>>) {
  const sourceDraft = ref<Record<string, LogCollectionRule>>({})
  const integrationDraft = ref<Record<string, LogCollectionRule>>({})

  function reset(collection?: LogCollection) {
    sourceDraft.value = cloneRules(collection?.sources)
    integrationDraft.value = cloneRules(collection?.integrations)
  }

  /** 只有新旧后端都给出 collection + catalog 时才渲染采集规则，不从常量补一套伪目录。 */
  const supportsCollection = computed(
    () => !!data.value?.collection && !!data.value?.catalog?.integrations.length
  )
  const sourceRows = computed<CollectionRow[]>(() =>
    Object.entries(sourceDraft.value).map(([key, rule]) => ({
      key,
      label: sourceLabel(key),
      rule,
      prefix: 'source' as const
    }))
  )
  const configuredIntegrations = computed(() =>
    (data.value?.catalog?.integrations ?? []).filter(
      (meta) =>
        meta.state === 'supported' &&
        meta.configurable &&
        !!integrationDraft.value[meta.key]
    )
  )
  const unwiredIntegrations = computed(() =>
    (data.value?.catalog?.integrations ?? []).filter(
      (meta) => !configuredIntegrations.value.some((supported) => supported.key === meta.key)
    )
  )
  const integrationRows = computed<IntegrationRow[]>(() =>
    configuredIntegrations.value.map((meta) => ({
      key: meta.key,
      label: meta.label,
      rule: integrationDraft.value[meta.key]!,
      prefix: 'integration' as const,
      category: meta.category,
      runtimes: meta.runtimes
    }))
  )
  /** 索引行需要的已保存规则；旧响应没有 collection 时返回 undefined。 */
  function savedRuleFor(row: CollectionRow): LogCollectionRule | undefined {
    const collection = data.value?.collection as
      | {
          sources?: Record<string, LogCollectionRule>
          integrations?: Record<string, LogCollectionRule>
        }
      | undefined
    return row.prefix === 'source'
      ? collection?.sources?.[row.key]
      : collection?.integrations?.[row.key]
  }

  function rowRuleChanged(row: CollectionRow) {
    const saved = savedRuleFor(row)
    return !!saved && !sameRule(saved, row.rule)
  }

  const changedSources = computed<RuleChange[]>(() => {
    const base = data.value?.collection?.sources as
      | Record<string, LogCollectionRule>
      | undefined
    if (!base) return []
    return Object.entries(sourceDraft.value).flatMap(([key, rule]) => {
      const before = base[key]
      return before && !sameRule(before, rule)
        ? [
            {
              dimension: '来源采集' as const,
              key,
              label: sourceLabel(key),
              from: { ...before },
              to: { ...rule }
            }
          ]
        : []
    })
  })
  const changedIntegrations = computed<RuleChange[]>(() => {
    const base = data.value?.collection?.integrations as
      | Record<string, LogCollectionRule>
      | undefined
    if (!base) return []
    return integrationRows.value.flatMap(({ key, label, rule, category }) => {
      const before = base[key]
      return before && !sameRule(before, rule)
        ? [
            {
              dimension: (category === 'business' ? '业务埋点' : '技术集成') as RuleChange['dimension'],
              key,
              label,
              from: { ...before },
              to: { ...rule }
            }
          ]
        : []
    })
  })

  return {
    reset,
    supportsCollection,
    sourceRows,
    configuredIntegrations,
    unwiredIntegrations,
    integrationRows,
    sourceRuleFor: (key: string) => sourceDraft.value[key],
    integrationRuleFor: (key: string) => integrationDraft.value[key],
    savedRuleFor,
    rowRuleChanged,
    changedSources,
    changedIntegrations
  }
}
