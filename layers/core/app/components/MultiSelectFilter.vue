<script setup lang="ts">
import { computed } from 'vue'
import { ChevronDown } from '@lucide/vue'
import { Button } from '#core/app/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '#core/app/components/ui/dropdown-menu'
import { cn } from '#core/lib/utils'

/**
 * 多选筛选(称号 / 来源 / 事件 / 年份)。
 *
 * 用官方的 DropdownMenu + DropdownMenuCheckboxItem,不用 Button 堆成列表:
 * 后者没有菜单语义、没有键盘导航,勾选态也只能靠肉眼。勾选后菜单不关闭
 * (@select.prevent),方便连着勾几项。
 *
 * 触发按钮自己说明状态:没选时是灰的占位文案,选了就换成「称号 ·3」并加粗描边,
 * 所以不用打开下拉也知道当前开着哪些筛选。
 */
const props = withDefaults(
  defineProps<{
    modelValue: string[]
    options: { value: string; label: string; short?: string }[]
    /** 未选择任何项时按钮上的文案,如「全部称号」。 */
    placeholder: string
    /** 已选多于两项时的前缀,如「称号」。 */
    summaryPrefix?: string
    class?: string
  }>(),
  { summaryPrefix: '' },
)

const emit = defineEmits<{ 'update:modelValue': [value: string[]] }>()

const optionOf = (value: string) => props.options.find((o) => o.value === value)
/** 按钮上放不下全称时用短名(如「专精特新"小巨人"」→「小巨人」);下拉里始终写全称。 */
const labelOf = (value: string) => optionOf(value)?.label ?? value
const shortOf = (value: string) => optionOf(value)?.short ?? labelOf(value)
const isChecked = (value: string) => props.modelValue.includes(value)

const active = computed(() => props.modelValue.length > 0)

const summary = computed(() => {
  const picked = props.modelValue
  if (!picked.length) return props.placeholder
  if (picked.length === 1) return shortOf(picked[0]!)
  if (picked.length === 2) return picked.map(shortOf).join('、')
  return `${props.summaryPrefix ? props.summaryPrefix + ' ' : ''}${picked.length} 项`
})

/** reka 的菜单项在 select 事件未被 preventDefault 时关闭菜单;这里保持打开。 */
const keepOpen = () => {}

function setChecked(value: string, checked: boolean) {
  emit(
    'update:modelValue',
    checked ? [...props.modelValue, value] : props.modelValue.filter((v) => v !== value),
  )
}
</script>

<template>
  <DropdownMenu>
    <DropdownMenuTrigger as-child>
      <Button
        variant="outline"
        size="sm"
        :data-active="active"
        :class="
          cn(
            'justify-between gap-1.5 font-normal transition-colors',
            'data-[active=true]:border-primary/45 data-[active=true]:bg-accent data-[active=true]:text-accent-foreground data-[active=true]:font-medium',
            props.class,
          )
        "
      >
        <span class="truncate">{{ summary }}</span>
        <ChevronDown class="size-3.5 shrink-0 opacity-50" />
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="start" class="w-52 shadow-none">
      <DropdownMenuLabel class="text-muted-foreground text-xs font-normal">
        {{ placeholder.replace('全部', '按') }}
      </DropdownMenuLabel>
      <DropdownMenuCheckboxItem
        v-for="opt in options"
        :key="opt.value"
        :model-value="isChecked(opt.value)"
        @select.prevent="keepOpen"
        @update:model-value="(v) => setChecked(opt.value, !!v)"
      >
        {{ opt.label }}
      </DropdownMenuCheckboxItem>
      <template v-if="active">
        <DropdownMenuSeparator />
        <DropdownMenuItem
          class="text-muted-foreground justify-center text-xs"
          @select.prevent="emit('update:modelValue', [])"
        >
          清除
        </DropdownMenuItem>
      </template>
    </DropdownMenuContent>
  </DropdownMenu>
</template>
