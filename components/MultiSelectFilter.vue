<script setup lang="ts">
import { computed } from 'vue'
import { ChevronDown } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Separator } from '@/components/ui/separator'
import { cn } from '@/lib/utils'

interface Option {
  value: string
  label: string
}

const props = withDefaults(
  defineProps<{
    modelValue: string[]
    options: Option[]
    /** 未选择任何项时按钮上的文案,如「全部称号」。 */
    placeholder: string
    /** 已选且多于两项时的前缀,如「称号」。 */
    summaryPrefix?: string
    class?: string
  }>(),
  { summaryPrefix: '' },
)

const emit = defineEmits<{ 'update:modelValue': [value: string[]] }>()

const labelOf = (value: string) => props.options.find((o) => o.value === value)?.label ?? value

const summary = computed(() => {
  const picked = props.modelValue
  if (!picked.length) return props.placeholder
  if (picked.length === 1) return labelOf(picked[0]!)
  if (picked.length === 2) return picked.map(labelOf).join('、')
  const prefix = props.summaryPrefix ? `${props.summaryPrefix} ` : ''
  return `${prefix}已选 ${picked.length} 项`
})

const isChecked = (value: string) => props.modelValue.includes(value)

function toggle(value: string) {
  const next = isChecked(value)
    ? props.modelValue.filter((v) => v !== value)
    : [...props.modelValue, value]
  emit('update:modelValue', next)
}

function clear() {
  emit('update:modelValue', [])
}
</script>

<template>
  <Popover>
    <PopoverTrigger as-child>
      <Button
        variant="outline"
        size="sm"
        :class="cn('justify-between gap-1 font-normal', modelValue.length && 'border-primary/60', props.class)"
      >
        <span class="truncate">{{ summary }}</span>
        <ChevronDown class="size-4 shrink-0 opacity-50" />
      </Button>
    </PopoverTrigger>
    <PopoverContent align="start" class="w-56 p-1.5">
      <div class="flex max-h-72 flex-col gap-0.5 overflow-auto">
        <Button
          v-for="opt in options"
          :key="opt.value"
          type="button"
          variant="ghost"
          class="w-full justify-start gap-2 px-2 font-normal"
          @click="toggle(opt.value)"
        >
          <Checkbox
            :model-value="isChecked(opt.value)"
            tabindex="-1"
            aria-hidden="true"
            class="pointer-events-none"
          />
          <span class="truncate">{{ opt.label }}</span>
        </Button>
      </div>
      <template v-if="modelValue.length">
        <Separator class="my-1" />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          class="text-muted-foreground w-full justify-start font-normal"
          @click="clear"
        >
          清除
        </Button>
      </template>
    </PopoverContent>
  </Popover>
</template>
