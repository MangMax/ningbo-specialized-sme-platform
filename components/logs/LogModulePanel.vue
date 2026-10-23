<script setup lang="ts">
import { computed } from 'vue'
import { Badge } from '@/components/ui/badge'
import DisclosurePanel from '@/components/DisclosurePanel.vue'
import { cn } from '@/lib/utils'

/**
 * 日志配置页的三级模块面板（技术集成 / 业务埋点 / 来源）。
 *
 * 每个实例是独立的 DisclosurePanel：可以同时打开多个，互斥只发生在单个
 * instance 内部。触发器右侧固定 lucide:chevron-right，展开后也不旋转；
 * 开合只通过 aria-expanded 表达。
 */
const props = withDefaults(
  defineProps<{
    label: string
    icon: string
    open?: boolean
    enabled?: boolean
    summary?: string
    dirty?: boolean
    primary?: boolean
    headingLevel?: 2 | 3 | 4
    testid?: string
  }>(),
  {
    open: false,
    enabled: undefined,
    summary: '',
    dirty: false,
    primary: false,
    headingLevel: 4,
    testid: undefined
  }
)

const emit = defineEmits<{ 'update:open': [open: boolean] }>()
const resolvedOpen = computed(() => props.open)
</script>

<template>
  <DisclosurePanel
    :open="resolvedOpen"
    :heading-level="headingLevel"
    compact
    :data-testid="testid"
    @update:open="emit('update:open', $event)"
  >
    <template #trigger>
      <span class="flex min-w-0 flex-1 items-center gap-2.5">
        <span
          :class="
            cn(
              'inline-flex size-[18px] shrink-0 items-center justify-center',
              primary ? 'text-primary' : 'text-muted-foreground'
            )
          "
        >
          <Icon :name="icon" class="size-[18px]" aria-hidden="true" />
        </span>
        <span class="flex min-w-0 flex-1 flex-col gap-0.5 text-left">
          <span class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span class="min-w-0 truncate text-[13px] leading-5 font-medium">{{ label }}</span>
            <span
              v-if="enabled !== undefined"
              class="inline-flex shrink-0 items-center gap-1 text-[12px] leading-4"
              :class="enabled ? 'text-primary' : 'text-muted-foreground'"
            >
              <span
                aria-hidden="true"
                class="inline-block size-1.5 rounded-full"
                :class="enabled ? 'bg-primary' : 'bg-muted-foreground/50'"
              />
              {{ enabled ? '开启' : '关闭' }}
            </span>
            <Badge v-if="dirty" variant="quiet" class="shrink-0 font-normal">未保存</Badge>
          </span>
          <span class="text-muted-foreground min-w-0 truncate text-[12px] leading-4 font-normal">{{
            summary
          }}</span>
        </span>
      </span>
    </template>
    <template #chevron>
      <span
        class="text-muted-foreground pointer-events-none inline-flex size-4 shrink-0 items-center justify-center"
        aria-hidden="true"
        data-testid="log-panel-chevron"
      >
        <Icon name="lucide:chevron-right" class="size-4" />
      </span>
    </template>
    <slot />
  </DisclosurePanel>
</template>
