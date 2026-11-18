<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { Badge } from '#core/app/components/ui/badge'
import { Button } from '#core/app/components/ui/button'
import { Field, FieldGroup, FieldLabel } from '#core/app/components/ui/field'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '#core/app/components/ui/select'
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger
} from '#core/app/components/ui/sheet'
import { Switch } from '#core/app/components/ui/switch'
import { cn } from '#core/lib/utils'
import LogFieldEditor from './LogFieldEditor.vue'

/**
 * 模块索引行 + 共享 shadcn-vue Sheet（B 方向）。
 *
 * 主列表只有图标、名称、开启/关闭、未保存、摘要和朝右入口；开关、门槛和字段
 * 都在 Sheet 里。Sheet 使用共享 SheetContent 的默认焦点陷阱、Escape、遮罩
 * 和焦点归还；触发器就是这一行按钮，所以关闭后焦点回到入口。
 *
 * 抽屉只改父级的同一份全局草稿：没有局部保存/PATCH；“完成编辑”只关闭。
 */
type Rule = { enabled: boolean; minLevel: string }
type Row = {
  key: string
  label: string
  rule: Rule
  prefix: 'source' | 'integration'
}
type Profile = {
  readonly key: string
  readonly label: string
  readonly source: string
  readonly levels: readonly string[]
  readonly fields: readonly {
    readonly key: string
    readonly label: string
    readonly description: string
  }[]
}
type Counterpart = { label: string; role: '来源' | '采集器' }

const props = withDefaults(
  defineProps<{
    row: Row
    savedRule?: Rule
    icon: string
    summary: string
    dirty?: boolean
    profile?: Profile
    sourceFollowLabel?: string
    controls?: Record<string, Record<string, boolean>>
    supportsFields?: boolean
    effectiveMin?: string
    offReasons?: string[]
    counterpart?: Counterpart | null
    disabled?: boolean
    open?: boolean
  }>(),
  {
    savedRule: undefined,
    dirty: false,
    profile: undefined,
    sourceFollowLabel: undefined,
    controls: undefined,
    supportsFields: false,
    effectiveMin: undefined,
    offReasons: () => [],
    counterpart: null,
    disabled: false,
    open: false
  }
)

const emit = defineEmits<{ 'update:open': [open: boolean] }>()
const rowRef = ref<HTMLButtonElement | null>(null)
let focusTimer: ReturnType<typeof setTimeout> | undefined
function onCloseAutoFocus(event: Event) {
  event.preventDefault()
  rowRef.value?.focus()
}
function onOpenChange(next: boolean) {
  emit('update:open', next)
  if (next) {
    if (focusTimer) clearTimeout(focusTimer)
    focusTimer = undefined
    return
  }
  if (focusTimer) clearTimeout(focusTimer)
  focusTimer = setTimeout(() => {
    focusTimer = undefined
    rowRef.value?.focus()
  }, 0)
}
onBeforeUnmount(() => {
  if (focusTimer) clearTimeout(focusTimer)
})

const LEVEL_LABELS: Record<string, string> = {
  debug: '调试',
  info: '信息',
  warn: '警告',
  error: '错误'
}
const levelLabel = (level: string) => LEVEL_LABELS[level] ?? level
const enabledId = computed(
  () => 'log-' + props.row.prefix + '-' + props.row.key + '-enabled'
)
const levelId = computed(
  () => 'log-' + props.row.prefix + '-' + props.row.key + '-min-level'
)
const rowTestId = computed(
  () => 'log-module-row-' + props.row.prefix + '-' + props.row.key
)
const sheetTestId = computed(
  () => 'log-module-sheet-' + props.row.prefix + '-' + props.row.key
)
const savedLabel = computed(() => {
  const rule = props.savedRule
  return rule
    ? (rule.enabled ? '开启' : '关闭') + ' · 最低' + levelLabel(rule.minLevel)
    : null
})
const draftLabel = computed(
  () =>
    (props.row.rule.enabled ? '开启' : '关闭') +
    ' · 最低' +
    levelLabel(props.row.rule.minLevel)
)
const sourceFollow = computed(() => props.sourceFollowLabel ?? '')
</script>

<template>
  <Sheet :open="open" @update:open="onOpenChange">
    <SheetTrigger as-child>
      <button
        ref="rowRef"
        type="button"
        :data-testid="rowTestId"
        :aria-label="row.label + '配置'"
        class="group flex w-full min-w-0 items-center gap-2.5 rounded-md px-2 py-2 text-left transition-colors hover:bg-accent hover:no-underline focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <span
          :class="
            cn(
              'inline-flex size-[18px] shrink-0 items-center justify-center',
              profile ? 'text-primary' : 'text-muted-foreground'
            )
          "
        >
          <Icon :name="icon" class="size-[18px]" aria-hidden="true" />
        </span>
        <span class="flex min-w-0 flex-1 flex-col gap-0.5">
          <span class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span class="min-w-0 truncate text-table leading-5 font-medium">{{
              row.label
            }}</span>
            <span
              class="inline-flex shrink-0 items-center gap-1 text-[12px] leading-4"
              :class="row.rule.enabled ? 'text-primary' : 'text-muted-foreground'"
            >
              <span
                aria-hidden="true"
                class="inline-block size-1.5 rounded-full"
                :class="row.rule.enabled ? 'bg-primary' : 'bg-muted-foreground/50'"
              />
              {{ row.rule.enabled ? '开启' : '关闭' }}
            </span>
            <Badge v-if="dirty" variant="quiet" class="shrink-0 font-normal"
              >未保存</Badge
            >
          </span>
          <span class="text-muted-foreground min-w-0 truncate text-[12px] leading-4">{{
            summary
          }}</span>
        </span>
        <span
          class="text-muted-foreground pointer-events-none inline-flex size-4 shrink-0 items-center justify-center"
          aria-hidden="true"
          data-testid="log-module-chevron"
        >
          <Icon name="lucide:chevron-right" class="size-4" />
        </span>
      </button>
    </SheetTrigger>

    <SheetContent
      floating-size="standard" class="min-w-0 gap-0"
      :data-testid="sheetTestId"
      @close-auto-focus="onCloseAutoFocus"
    >
      <SheetHeader class="shrink-0 border-b px-5 py-4 pr-12">
        <SheetTitle class="flex min-w-0 items-center gap-2 text-[15px]">
          <span
            :class="
              cn(
                'inline-flex size-[18px] shrink-0 items-center justify-center',
                profile ? 'text-primary' : 'text-muted-foreground'
              )
            "
          >
            <Icon :name="icon" class="size-[18px]" aria-hidden="true" />
          </span>
          <span class="min-w-0 wrap-anywhere">{{ row.label }}</span>
        </SheetTitle>
        <SheetDescription class="text-table leading-5" data-testid="log-module-sheet-summary">
          {{ summary }}
        </SheetDescription>
      </SheetHeader>

      <div
        class="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4"
        data-testid="log-module-sheet-body"
      >
        <div class="flex min-w-0 flex-col gap-4">
          <FieldGroup class="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
            <Field
              orientation="horizontal"
              :data-disabled="disabled"
              class="min-w-0 items-center justify-between gap-3"
            >
              <FieldLabel
                :for="enabledId"
                class="text-table leading-5 font-normal"
                >采集开关</FieldLabel
              >
              <Switch
                :id="enabledId"
                v-model="row.rule.enabled"
                :disabled="disabled"
              />
            </Field>
            <Field
              orientation="horizontal"
              :data-disabled="disabled || !row.rule.enabled"
              class="min-w-0 items-center justify-between gap-3"
            >
              <FieldLabel
                :for="levelId"
                class="text-table leading-5 font-normal"
                >采集门槛</FieldLabel
              >
              <Select v-model="row.rule.minLevel">
                <SelectTrigger
                  :id="levelId"
                  size="sm"
                  class="bg-card w-32 shrink-0 shadow-none"
                  :aria-label="row.label + '的最低日志级别'"
                  :disabled="disabled || !row.rule.enabled"
                >
                  <SelectValue>{{ LEVEL_LABELS[row.rule.minLevel] }}</SelectValue>
                </SelectTrigger>
                <SelectContent><SelectGroup>
                  <SelectItem
                    v-for="level in ['debug', 'info', 'warn', 'error']"
                    :key="level"
                    :value="level"
                  >
                    {{ LEVEL_LABELS[level] }}（{{ level }}）
                  </SelectItem>
                </SelectGroup></SelectContent>
              </Select>
            </Field>
          </FieldGroup>
          <p class="text-muted-foreground text-[12px] leading-4">
            低于门槛的事件不写入；技术集成与来源须同时开启时，最低级别取更严格的一处。
          </p>

          <div class="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1 text-[12px] leading-4">
            <span class="text-muted-foreground">已保存</span>
            <span class="text-foreground">{{ savedLabel ?? '—' }}</span>
            <span v-if="dirty" class="text-primary">草稿：{{ draftLabel }}</span>
          </div>

          <div
            v-if="offReasons.length"
            role="status"
            class="flex min-w-0 flex-col gap-1"
          >
            <p class="flex flex-wrap items-center gap-x-2 gap-y-1 text-table leading-5">
              <Badge variant="quiet" class="font-normal">当前不采集</Badge>
              <span class="text-muted-foreground">
                {{ offReasons.join('、') }}；选择会保留，重新开启后按这里的设置记录。
              </span>
            </p>
          </div>

          <LogFieldEditor
            v-if="profile && supportsFields && controls"
            :profile="profile"
            :controls="controls"
            :disabled="disabled"
            :effective-min="effectiveMin"
          />
          <p
            v-else-if="profile"
            class="text-muted-foreground text-[12px] leading-4"
          >
            字段目录来自服务端；当前响应不完整，暂不显示字段开关。
          </p>
          <p
            v-else-if="sourceFollow"
            class="text-muted-foreground text-[12px] leading-4"
          >
            此来源暂无独立的字段采集选项：记录内容跟随「{{ sourceFollow }}」，在主采集器里配置一次。
          </p>
          <p v-else class="text-muted-foreground text-[12px] leading-4">
            暂无字段采集选项。此模块只控制是否采集与最低级别。
          </p>

          <div
            v-if="counterpart"
            class="flex min-w-0 flex-col gap-1 border-t pt-3"
          >
            <span class="text-[12px] leading-4 font-medium">同时生效</span>
            <p class="text-muted-foreground text-table leading-5">
              与「{{ counterpart.label }}」{{ counterpart.role }}同时生效；当前有效门槛：<strong class="text-foreground">{{ levelLabel(effectiveMin ?? 'debug') }}</strong>。
            </p>
          </div>

          <p class="text-muted-foreground text-[12px] leading-4">
            改动只留在全局草稿；关闭抽屉不会丢失，使用页面底部「核对日志配置修改」统一提交。
          </p>
        </div>
      </div>

      <SheetFooter class="shrink-0 border-t px-5 py-3">
        <SheetClose as-child>
          <Button
            variant="outline"
            class="w-full sm:w-auto"
            data-testid="log-module-sheet-done"
            >完成编辑</Button
          >
        </SheetClose>
      </SheetFooter>
    </SheetContent>
  </Sheet>
</template>
