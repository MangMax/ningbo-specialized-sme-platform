import { computed } from 'vue'
import { LOG_LEVELS, type LogCollectionRule } from '#core/lib/logging/contract'
import { iconForGroup, iconForIntegration, iconForSection, iconForSource } from './logIcons'
import { isClientLogSource, sourceLabel } from './logPresentation'
import { LEVEL_LABELS, type CollectionRow, type FieldProfile, type LevelKey } from './logPolicy'
import type { IntegrationRow, useLogCollectionDraft } from './useLogCollectionDraft'
import type { useLogFieldDraft } from './useLogFieldDraft'

type RowGroup = {
  key: string
  testid: string
  title: string
  note?: string
  icon: string
  rows: CollectionRow[]
}
type CollectionSection = {
  key: string
  testid: string
  headingId: string
  title: string
  description: string
  icon: string
  groups: RowGroup[]
}
type Counterpart = {
  label: string
  role: '来源' | '采集器'
}
/**
 * profile 与主采集器的展示映射。目录里没有“父级集成”字段，所以先看同名集成
 * （tus 等服务端 hook 就是这种），再补已知的独立采集器（HTTP 完成事件由
 * Nuxt / Nitro 集成产生）。未来目录新增 profile 时，两者都不匹配就不臆造父级。
 */
const PROFILE_COLLECTOR_INTEGRATIONS: Record<string, readonly string[]> = {
  http: ['nuxt-nitro']
}

export function useLogCollectionPresentation(
  collection: ReturnType<typeof useLogCollectionDraft>,
  fields: ReturnType<typeof useLogFieldDraft>
) {
  const {
    sourceRows, integrationRows, configuredIntegrations, unwiredIntegrations,
    sourceRuleFor, integrationRuleFor, rowRuleChanged, savedRuleFor
  } = collection
  const { fieldProfiles, supportsFieldControls, fieldChanges, retainedFieldCount, profileDirty, controlsFor } = fields

  /** runtimes 只用于页面分组，不是新的策略维度；旧目录缺失时按兼容组展示。 */
  const runsOn = (row: IntegrationRow, runtime: 'node' | 'browser') =>
    (row.runtimes as readonly string[] | undefined)?.includes(runtime) === true
  const technicalGroups = computed<RowGroup[]>(() => {
    const technical = integrationRows.value.filter((row) => row.category === 'technical')
    const groups: RowGroup[] = [
      {
        key: 'technical-node',
        testid: 'log-technical-node',
        title: '服务端',
        icon: iconForGroup('technical-node'),
        rows: technical.filter((row) => runsOn(row, 'node'))
      },
      {
        key: 'technical-browser',
        testid: 'log-technical-browser',
        title: '客户端',
        note: '客户端自报，不代表服务端执行事实。',
        icon: iconForGroup('technical-browser'),
        rows: technical.filter((row) => runsOn(row, 'browser'))
      },
      {
        key: 'technical-other',
        testid: 'log-technical-other',
        title: '未标注运行端',
        note: '旧目录没有运行端元数据，仅作兼容展示；不影响规则保存。',
        icon: iconForGroup('technical-other'),
        rows: integrationRows.value.filter(
          (row) => row.category !== 'technical' && row.category !== 'business'
        )
      }
    ]
    return groups.filter((group) => group.rows.length > 0)
  })
  const businessGroups = computed<RowGroup[]>(() => {
    const groups: RowGroup[] = [
      {
        key: 'business-shared',
        testid: 'log-business-shared',
        title: '跨端共享手动上报',
        note: '服务端与客户端共用这一条规则，并与来源条件同时成立。',
        icon: iconForGroup('business-shared'),
        rows: integrationRows.value.filter((row) => row.category === 'business')
      },
      {
        key: 'business-node',
        testid: 'log-business-node',
        title: '服务端来源',
        icon: iconForGroup('business-node'),
        rows: sourceRows.value.filter((row) => !isClientLogSource(row.key))
      },
      {
        key: 'business-browser',
        testid: 'log-business-browser',
        title: '客户端来源',
        note: '浏览器自报，上下文不可信。',
        icon: iconForGroup('business-browser'),
        rows: sourceRows.value.filter((row) => isClientLogSource(row.key))
      }
    ]
    return groups.filter((group) => group.rows.length > 0)
  })
  const collectionSections = computed<CollectionSection[]>(() => {
    const sections: CollectionSection[] = [
      {
        key: 'technical',
        testid: 'log-collection-integrations',
        headingId: 'log-technical-heading',
        title: '技术集成',
        description: '技术集成与来源须同时开启，最低级别取两者中更严格的一处。',
        icon: iconForSection('technical'),
        groups: technicalGroups.value
      },
      {
        key: 'business',
        testid: 'log-collection-sources',
        headingId: 'log-business-heading',
        title: '业务埋点',
        description: '来源维度独立生效，也可被技术集成条件收窄。',
        icon: iconForSection('business'),
        groups: businessGroups.value
      }
    ]
    return sections.filter((section) =>
      section.key === 'technical'
        ? section.groups.length > 0 || unwiredIntegrations.value.length > 0
        : section.groups.length > 0
    )
  })

  function collectorKeyForProfile(profile: FieldProfile): string | undefined {
    const mapped = PROFILE_COLLECTOR_INTEGRATIONS[String(profile.key)]?.[0]
    if (mapped) return mapped
    return configuredIntegrations.value.some((meta) => meta.key === String(profile.key))
      ? String(profile.key)
      : undefined
  }
  function collectorLabelForProfile(profile: FieldProfile): string {
    const key = collectorKeyForProfile(profile)
    return (
      configuredIntegrations.value.find((meta) => meta.key === key)?.label ??
      key ??
      String(profile.key)
    )
  }
  /** 集成行承载哪个字段 profile；来源行不承载字段（字段跟随主采集器）。 */
  function profileForIntegration(key: string): FieldProfile | undefined {
    return (
      fieldProfiles.value.find((profile) => String(profile.key) === key) ??
      fieldProfiles.value.find((profile) =>
        (PROFILE_COLLECTOR_INTEGRATIONS[String(profile.key)] ?? []).includes(key)
      )
    )
  }
  function sourceProfileForRow(row: CollectionRow): FieldProfile | undefined {
    return row.prefix === 'source'
      ? fieldProfiles.value.find((profile) => String(profile.source) === row.key)
      : undefined
  }

  function collectorProfileForRow(row: CollectionRow): FieldProfile | undefined {
    return row.prefix === 'integration' ? profileForIntegration(row.key) : undefined
  }

  function parentRulesFor(profile: FieldProfile | undefined) {
    if (!profile) return []
    const rules: { label: string; rule: LogCollectionRule }[] = []
    const source = sourceRuleFor(profile.source)
    if (source) rules.push({ label: sourceLabel(String(profile.source)) + '来源', rule: source })
    const candidates = [
      String(profile.key),
      ...(PROFILE_COLLECTOR_INTEGRATIONS[String(profile.key)] ?? [])
    ]
    for (const key of candidates) {
      const rule = integrationRuleFor(key)
      if (!rule) continue
      const label = configuredIntegrations.value.find((meta) => meta.key === key)?.label ?? key
      rules.push({ label: label + '集成', rule })
    }
    return rules
  }
  const offReasonsFor = (profile: FieldProfile | undefined) =>
    parentRulesFor(profile)
      .filter((entry) => !entry.rule.enabled)
      .map((entry) => entry.label + '已关闭')
  /** 核对时按改动涉及的 profile 说明父级；不是只看当前正在编辑的那一类。 */
  const reviewParentReasons = computed(() => {
    const keys = [...new Set(fieldChanges.value.map((change) => change.profile))]
    const reasons = keys.flatMap((key) =>
      offReasonsFor(fieldProfiles.value.find((profile) => profile.key === key))
    )
    return [...new Set(reasons)]
  })
  /** 父级规则同时生效，有效门槛取更严格的一处。 */
  function effectiveMinFor(profile: FieldProfile | undefined): LevelKey | undefined {
    const indexes = parentRulesFor(profile).map((entry) => LOG_LEVELS.indexOf(entry.rule.minLevel))
    if (!indexes.length) return undefined
    return LOG_LEVELS[Math.max(...indexes)]
  }

  function rowDirty(row: CollectionRow, profile = collectorProfileForRow(row)) {
    return rowRuleChanged(row) || (!!profile && supportsFieldControls.value && profileDirty(profile))
  }
  function ruleSummary(rule: LogCollectionRule) {
    return rule.enabled
      ? '最低' + LEVEL_LABELS[rule.minLevel]
      : '关闭 · 级别保留' + LEVEL_LABELS[rule.minLevel]
  }
  /** 索引行的一行摘要：门槛、字段保留数、来源跟随/父级关闭/无字段。 */
  function panelSummary(
    row: CollectionRow,
    profile: FieldProfile | undefined,
    sourceFollowLabel: string | undefined
  ) {
    const parts = [ruleSummary(row.rule)]
    if (profile && supportsFieldControls.value) {
      parts.push('详情 ' + retainedFieldCount(profile) + '/' + profile.fields.length + ' 项')
      if (offReasonsFor(profile).length) parts.push('当前不采集')
      else {
        const sourceKey = String(profile.source)
        if (sourceRuleFor(sourceKey)?.enabled)
          parts.push('需「' + sourceLabel(sourceKey) + '」来源同时开启')
      }
    } else if (profile) {
      parts.push('字段目录暂不可用')
    }
    if (sourceFollowLabel !== undefined) parts.push('字段跟随「' + sourceFollowLabel + '」')
    if (!profile && sourceFollowLabel === undefined) parts.push('暂无字段采集选项')
    return parts.join(' · ')
  }
  function counterpartForRow(row: CollectionRow, profile: FieldProfile | undefined): Counterpart | null {
    if (!profile) return null
    if (row.prefix === 'integration') {
      const sourceKey = String(profile.source)
      if (!sourceRuleFor(sourceKey)) return null
      return {
        label: sourceLabel(sourceKey),
        role: '来源'
      }
    }
    const collectorKey = collectorKeyForProfile(profile)
    const collector = integrationRows.value.find((candidate) => candidate.key === collectorKey)
    if (!collectorKey || !collector) return null
    return { label: collector.label, role: '采集器' }
  }

  function rowView(row: CollectionRow) {
    const collectorProfile = collectorProfileForRow(row)
    const sourceProfile = sourceProfileForRow(row)
    const profile = collectorProfile ?? sourceProfile
    const sourceFollowLabel = sourceProfile ? collectorLabelForProfile(sourceProfile) : undefined
    return {
      row,
      savedRule: savedRuleFor(row),
      icon: row.prefix === 'integration' ? iconForIntegration(row.key) : iconForSource(row.key),
      summary: panelSummary(row, collectorProfile, sourceFollowLabel),
      dirty: rowDirty(row, collectorProfile),
      profile: collectorProfile,
      sourceFollowLabel: sourceFollowLabel ?? '',
      controls: collectorProfile ? controlsFor(collectorProfile) : undefined,
      supportsFields: supportsFieldControls.value,
      effectiveMin: effectiveMinFor(profile),
      offReasons: offReasonsFor(profile),
      counterpart: counterpartForRow(row, profile)
    }
  }

  const sections = computed(() =>
    collectionSections.value.map((section) => ({
      ...section,
      groups: section.groups.map((group) => ({ ...group, rows: group.rows.map(rowView) }))
    }))
  )

  const dirtyCollectionLabels = computed(() => {
    const labels = new Set<string>()
    for (const row of integrationRows.value) if (rowDirty(row)) labels.add(row.label)
    for (const row of sourceRows.value) if (rowRuleChanged(row)) labels.add(row.label)
    return [...labels]
  })

  return { sections, dirtyCollectionLabels, reviewParentReasons }
}

export type LogCollectionSection = ReturnType<typeof useLogCollectionPresentation>['sections']['value'][number]
