<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Button } from '#core/app/components/ui/button'
import { Checkbox } from '#core/app/components/ui/checkbox'
import { Field, FieldGroup, FieldLabel, FieldLegend, FieldSet } from '#core/app/components/ui/field'
import { Switch } from '#core/app/components/ui/switch'
import { Tabs, TabsList, TabsTrigger } from '#core/app/components/ui/tabs'

/**
 * 单个采集器（HTTP / TUS）的“记录内容”编辑器。
 *
 * - 默认一份选择同步到全部事件级别；已保存级别不一致时显示 mixed，并明确说明
 *   改动会把该字段同步到全部级别。切到高级只改 UI 状态，不写任何字段。
 * - 高级模式按事件级别编辑，保留复制到其他级别、恢复本级别默认、撤销。
 * - `controls` 是父级 fieldDraft 里的这一份草稿；本组件只改草稿，不提交。
 *   父级用同一份响应式对象计算差异，因此每次改动仍走全局“核对 → PATCH”。
 */
type Field = { readonly key: string; readonly label: string; readonly description: string }
type Profile = {
  readonly key: string
  readonly label: string
  readonly levels: readonly string[]
  readonly fields: readonly Field[]
}

const props = defineProps<{
  profile: Profile
  controls: Record<string, Record<string, boolean>>
  disabled?: boolean
  effectiveMin?: string
}>()

const LEVEL_LABELS: Record<string, string> = {
  debug: '调试',
  info: '信息',
  warn: '警告',
  error: '错误'
}
const levelLabel = (level: string) => LEVEL_LABELS[level] ?? level

/** 本面板独立的 UI 状态；多个采集器面板同时打开时互不影响。 */
const advanced = ref(false)
const level = ref(props.profile.levels.includes('info') ? 'info' : (props.profile.levels[0] ?? 'info'))
const copyOpen = ref(false)
const copyTargets = ref<string[]>([])
type Notice = { text: string; restore?: Record<string, Record<string, boolean>> }
const notice = ref<Notice | null>(null)

const valuesAt = (value: string) => props.controls?.[value]
const currentLevel = computed(() =>
  props.profile.levels.includes(level.value) ? level.value : (props.profile.levels[0] ?? 'info')
)
const currentValues = computed(() => valuesAt(currentLevel.value))

type FieldState = 'on' | 'off' | 'mixed'
function fieldState(field: string): FieldState {
  let on = 0
  for (const value of props.profile.levels) if (valuesAt(value)?.[field] === true) on++
  return on === props.profile.levels.length ? 'on' : on === 0 ? 'off' : 'mixed'
}
const mixedCount = computed(
  () => props.profile.fields.filter((field) => fieldState(field.key) === 'mixed').length
)
const allRetained = computed(
  () => props.profile.fields.every((field) => fieldState(field.key) === 'on')
)
const retainedCount = computed(
  () => props.profile.fields.filter((field) => fieldState(field.key) === 'on').length
)
const summary = computed(() =>
  mixedCount.value
    ? `详情 ${retainedCount.value}/${props.profile.fields.length} 项 · ${mixedCount.value} 项各级别不一致`
    : `详情 ${retainedCount.value}/${props.profile.fields.length} 项`
)

function setAll(field: string, next: boolean) {
  for (const value of props.profile.levels) {
    const fields = valuesAt(value)
    if (fields) fields[field] = next
  }
  notice.value = null
}
function toggleAll(field: string) {
  setAll(field, fieldState(field) !== 'on')
}
function setAt(value: string, field: string, next: boolean) {
  const fields = valuesAt(value)
  if (!fields || fields[field] === next) return
  fields[field] = next
  notice.value = null
}
function setLevel(value: string) {
  if (value === currentLevel.value) return
  level.value = value
  clearTransient()
}
function clearTransient() {
  copyOpen.value = false
  copyTargets.value = []
  notice.value = null
}
const UNIT_HINTS = ['毫秒', '字节'] as const
const unit = (description: string) => UNIT_HINTS.find((hint) => description.includes(hint))
const fieldAllId = (field: string) => `log-field-${props.profile.key}-all-${field}`
const fieldLevelId = (value: string, field: string) =>
  `log-field-${props.profile.key}-${value}-${field}`

const levelTabs = computed(() =>
  props.profile.levels.map((value) => {
    const fields = valuesAt(value)
    const count = props.profile.fields.filter((field) => fields?.[field.key] === false).length
    const below = !!props.effectiveMin &&
      props.profile.levels.indexOf(value) < props.profile.levels.indexOf(props.effectiveMin)
    const parts = [levelLabel(value)]
    if (below) parts.push('不会写入')
    if (count) parts.push(`已调整 ${count} 项`)
    return { key: value, label: levelLabel(value), count, below, ariaLabel: parts.join('，') }
  })
)
const belowCurrent = computed(() =>
  !!props.effectiveMin &&
  props.profile.levels.indexOf(currentLevel.value) <
    props.profile.levels.indexOf(props.effectiveMin)
)
const sameLevel = (left: Record<string, boolean> | undefined, right: Record<string, boolean> | undefined) =>
  props.profile.fields.every((field) => left?.[field.key] === right?.[field.key])
const copyLevels = computed(() =>
  props.profile.levels
    .filter((value) => value !== currentLevel.value)
    .map((value) => ({
      key: value,
      label: levelLabel(value),
      same: sameLevel(currentValues.value, valuesAt(value))
    }))
)
const copyAvailable = computed(() => copyLevels.value.filter((entry) => !entry.same))
function toggleCopyTarget(value: string, next: boolean) {
  copyTargets.value = next
    ? [...new Set([...copyTargets.value, value])]
    : copyTargets.value.filter((entry) => entry !== value)
}
const snapshot = () =>
  JSON.parse(JSON.stringify(props.controls)) as Record<string, Record<string, boolean>>
function openCopy() {
  notice.value = null
  copyTargets.value = []
  copyOpen.value = true
}
function copyLevel() {
  const source = currentValues.value
  const targets = copyTargets.value.filter((value) =>
    copyAvailable.value.some((entry) => entry.key === value)
  )
  if (!source || !targets.length) return
  const restore = snapshot()
  for (const value of targets) {
    const fields = valuesAt(value)
    if (!fields) continue
    for (const field of props.profile.fields) fields[field.key] = source[field.key] === true
  }
  copyOpen.value = false
  copyTargets.value = []
  notice.value = {
    text: `已复制到${targets.map((value) => levelLabel(value)).join('、')}。`,
    restore
  }
}
function restoreLevel() {
  const restore = snapshot()
  const fields = currentValues.value
  if (fields) for (const field of props.profile.fields) fields[field.key] = true
  notice.value = { text: '已恢复本级别的默认选择。', restore }
}
function undo() {
  if (!notice.value?.restore) return
  const restore = notice.value.restore
  for (const value of props.profile.levels) {
    const fields = valuesAt(value)
    const saved = restore[value]
    if (fields && saved) for (const field of props.profile.fields) fields[field.key] = saved[field.key] === true
  }
  notice.value = { text: '已撤销，恢复到操作前的选择。' }
}
// 保存成功会替换整份 fieldDraft；此时清掉只在旧草稿上成立的临时状态。
watch(
  () => props.controls,
  () => clearTransient()
)
</script>

<template>
  <div
    class="bg-secondary/60 flex min-w-0 flex-col gap-2 rounded-md px-3 py-2.5"
    :data-testid="`log-field-controls-${profile.key}`"
    :data-profile="profile.key"
  >
    <div class="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
      <h4 class="text-table leading-5 font-medium">记录内容</h4>
      <span class="text-muted-foreground text-[12px] leading-4"
        >只决定每条日志留哪些字段，不决定哪些日志会被采集。</span
      >
    </div>

    <template v-if="!advanced">
      <p class="text-muted-foreground text-[12px] leading-4">
        一份选择适用于全部事件级别（调试 / 信息 / 警告 / 错误）。
      </p>
      <p
        v-if="mixedCount"
        class="text-muted-foreground text-[12px] leading-4"
        :data-testid="`log-field-mixed-${profile.key}`"
      >
        已保存的各事件级别不一致：改动某个字段会把该字段同步到全部级别。
      </p>
      <FieldSet class="min-w-0 gap-2">
        <FieldGroup class="grid min-w-0 grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
          <Field
            v-for="field in profile.fields"
            :key="field.key"
            orientation="horizontal"
            :data-disabled="disabled"
            class="min-w-0 items-start justify-between gap-3"
          >
            <div class="flex min-w-0 flex-col gap-0.5">
              <FieldLabel
                :for="fieldAllId(field.key)"
                class="min-w-0 text-table leading-5 font-normal"
                >{{ field.label
                }}<span v-if="unit(field.description)" class="text-muted-foreground"
                  >（{{ unit(field.description) }}）</span
                ></FieldLabel
              >
              <span
                v-if="fieldState(field.key) === 'mixed'"
                class="text-muted-foreground text-[12px] leading-4"
                >各级别不一致</span
              >
            </div>
            <Switch
              :id="fieldAllId(field.key)"
              :model-value="fieldState(field.key) === 'on'"
              :class="
                fieldState(field.key) === 'mixed' ? 'data-[state=unchecked]:bg-primary/40' : ''
              "
              :aria-label="
                `记录${field.label}${fieldState(field.key) === 'mixed' ? '，各级别不一致' : ''}`
              "
              :disabled="disabled"
              :data-mixed="fieldState(field.key) === 'mixed' ? 'true' : undefined"
              @update:model-value="(value) => toggleAll(field.key)"
            />
          </Field>
        </FieldGroup>
      </FieldSet>
      <p
        class="text-muted-foreground text-[12px] leading-4"
        :data-testid="`log-field-status-${profile.key}`"
      >
        <template v-if="allRetained">各级别均保留全部字段。</template>
        <template v-else>{{ summary }}</template>
      </p>
    </template>

    <template v-else>
      <p class="text-muted-foreground text-[12px] leading-4">
        事件级别是每条日志自己的严重程度（由产生它的代码决定），不是采集门槛。
      </p>
      <Tabs
        :model-value="currentLevel"
        class="gap-0"
        @update:model-value="(value) => setLevel(String(value))"
      >
        <TabsList class="w-full justify-start sm:w-fit" :aria-label="`${profile.label}字段级别`">
          <TabsTrigger
            v-for="tab in levelTabs"
            :key="tab.key"
            :value="tab.key"
            class="min-w-0 flex-1 gap-1 px-2 text-table sm:flex-none sm:px-3"
            :aria-label="tab.ariaLabel"
          >
            {{ tab.label }}
            <span
              v-if="tab.count"
              aria-hidden="true"
              class="bg-foreground inline-block size-1.5 rounded-full"
            />
          </TabsTrigger>
        </TabsList>
      </Tabs>
      <p
        v-if="belowCurrent"
        class="text-muted-foreground text-[12px] leading-4"
        :data-testid="`log-field-level-below-${profile.key}`"
      >
        「{{ levelLabel(currentLevel) }}」低于采集门槛「{{ levelLabel(effectiveMin ?? 'debug') }}」，当前不产生这个级别的日志；选择会保留。
      </p>
      <FieldSet v-if="currentValues" class="min-w-0 gap-2">
        <FieldGroup class="grid min-w-0 grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
          <Field
            v-for="field in profile.fields"
            :key="field.key"
            orientation="horizontal"
            :data-disabled="disabled"
            class="min-w-0 items-start justify-between gap-3"
          >
            <FieldLabel
              :for="fieldLevelId(currentLevel, field.key)"
              class="min-w-0 text-table leading-5 font-normal"
              >{{ field.label
              }}<span v-if="unit(field.description)" class="text-muted-foreground"
                >（{{ unit(field.description) }}）</span
              ></FieldLabel
            >
            <Switch
              :id="fieldLevelId(currentLevel, field.key)"
              :model-value="currentValues[field.key] ?? true"
              :aria-label="`记录${field.label}`"
              :disabled="disabled"
              @update:model-value="(value) => setAt(currentLevel, field.key, value === true)"
            />
          </Field>
        </FieldGroup>
      </FieldSet>
      <div class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
        <Button
          variant="ghost"
          size="sm"
          :data-testid="`log-field-copy-${profile.key}`"
          :aria-expanded="copyOpen ? 'true' : 'false'"
          :disabled="disabled"
          @click="copyOpen ? (copyOpen = false) : openCopy()"
          >复制到其他级别</Button
        >
        <Button
          v-if="currentValues && Object.values(currentValues).some((value) => !value)"
          variant="ghost"
          size="sm"
          :data-testid="`log-field-restore-${profile.key}`"
          :disabled="disabled"
          @click="restoreLevel"
          >恢复本级别默认</Button
        >
      </div>
      <div
        v-if="copyOpen"
        class="flex min-w-0 flex-col gap-2"
        :data-testid="`log-field-copy-panel-${profile.key}`"
      >
        <FieldSet class="min-w-0 gap-2">
          <FieldLegend variant="label" class="mb-1 text-table"
            >把这 {{ profile.fields.length }} 项选择复制到其他级别</FieldLegend
          >
          <div class="flex min-w-0 flex-col gap-1.5">
            <Field
              v-for="target in copyLevels"
              :key="target.key"
              orientation="horizontal"
              class="min-w-0 items-center gap-2.5"
            >
              <Checkbox
                :id="`log-field-copy-${profile.key}-${target.key}`"
                :model-value="copyTargets.includes(target.key)"
                :disabled="disabled || target.same"
                :aria-label="`复制到${target.label}`"
                @update:model-value="(value) => toggleCopyTarget(target.key, value === true)"
              />
              <FieldLabel
                :for="`log-field-copy-${profile.key}-${target.key}`"
                class="min-w-0 text-table leading-5 font-normal"
                >{{ target.label }}</FieldLabel
              >
              <span v-if="target.same" class="text-muted-foreground text-table leading-5"
                >已相同</span
              >
            </Field>
          </div>
        </FieldSet>
        <p
          v-if="!copyAvailable.length"
          class="text-muted-foreground text-[12px] leading-4"
          :data-testid="`log-field-copy-empty-${profile.key}`"
          >其他级别已经和这里相同。</p
        >
        <div class="flex flex-wrap items-center gap-2">
          <Button variant="ghost" size="sm" :disabled="disabled" @click="copyOpen = false"
            >取消</Button
          >
          <Button
            variant="outline"
            size="sm"
            :data-testid="`log-field-copy-apply-${profile.key}`"
            :disabled="disabled || !copyTargets.length"
            @click="copyLevel"
            >复制</Button
          >
        </div>
      </div>
      <p
        v-if="notice"
        role="status"
        aria-live="polite"
        class="flex flex-wrap items-center gap-x-2 gap-y-1 text-table leading-5"
      >
        <span>{{ notice.text }}</span>
        <Button
          v-if="notice.restore"
          variant="link"
          size="sm"
          class="h-auto p-0"
          :data-testid="`log-field-undo-${profile.key}`"
          @click="undo"
          >撤销</Button
        >
      </p>
    </template>

    <div class="flex min-w-0 flex-col gap-1">
      <Button
        variant="link"
        size="sm"
        class="h-auto justify-start p-0 text-table"
        :data-testid="`log-field-advanced-${profile.key}`"
        :aria-expanded="advanced ? 'true' : 'false'"
        @click="advanced = !advanced"
      >
        <span class="inline-flex size-4 shrink-0 items-center justify-center" aria-hidden="true">
          <Icon name="lucide:chevron-right" class="size-4" />
        </span>
        {{ advanced ? '收起按事件级别设置（高级）' : '按事件级别分别设置（高级）' }}
      </Button>
    </div>
    <p class="text-muted-foreground text-[12px] leading-4">
      当前固定记录以上 {{ profile.fields.length }} 项。<template v-if="profile.key === 'http'"
        >请求参数、响应内容、原始报文尚未采集。</template
      ><template v-else>上传请求头、响应内容、原始报文尚未采集。</template>
    </p>
    <p
      v-if="profile.key === 'http'"
      class="text-muted-foreground text-[12px] leading-4"
      :data-testid="`log-field-http-note-${profile.key}`"
    >
      HTTP 完成事件只有 信息 / 警告 / 错误，没有调试档。
    </p>
  </div>
</template>
