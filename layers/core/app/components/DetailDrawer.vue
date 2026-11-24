<script setup lang="ts">
import { X } from '@lucide/vue'
import { Button } from './ui/button'
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from './ui/sheet'

/**
 * 业务侧抽屉的统一结构：固定头部 + 独立滚动主体 + 可选固定底栏。
 *
 * 宽度沿用 SheetContent 的 floatingSize（compact 360 / standard 448 /
 * detail 560），业务页面只选档位，不再各自写宽度类。
 * `preventClose` 用于提交中等不可中断的状态：屏蔽 Esc、点遮罩和关闭按钮。
 */
const props = withDefaults(
  defineProps<{
    open: boolean
    title: string
    description?: string
    /** 标题只作读屏名称时隐藏可见说明。 */
    hideDescription?: boolean
    floatingSize?: 'compact' | 'standard' | 'detail'
    preventClose?: boolean
  }>(),
  { floatingSize: 'standard' },
)

const emit = defineEmits<{
  'update:open': [value: boolean]
  closeAutoFocus: [event: Event]
}>()

function blockClose(event: Event) {
  if (props.preventClose) event.preventDefault()
}
</script>

<template>
  <Sheet :open="props.open" @update:open="(value: boolean) => { if (value || !props.preventClose) emit('update:open', value) }">
    <SheetContent
      :floating-size="props.floatingSize"
      :show-close-button="false"
      class="gap-0 overflow-hidden p-0"
      @escape-key-down="blockClose"
      @pointer-down-outside="blockClose"
      @interact-outside="blockClose"
      @close-auto-focus="emit('closeAutoFocus', $event)"
    >
      <header class="flex shrink-0 items-center justify-between gap-3 border-b px-5 py-4 sm:px-6">
        <div class="flex min-w-0 flex-1 flex-col gap-1">
          <SheetTitle class="wrap-anywhere text-base leading-tight">
            {{ props.title }}
          </SheetTitle>
          <!-- 没有可见说明时仍给读屏一个描述节点，避免 Dialog 的无描述告警。 -->
          <SheetDescription
            :class="props.hideDescription || !props.description ? 'sr-only' : 'text-sm'"
          >
            {{ props.description ?? props.title }}
          </SheetDescription>
        </div>
        <SheetClose v-if="!props.preventClose" as-child>
          <Button
            variant="ghost"
            size="icon-sm"
            class="text-muted-foreground hover:text-foreground shrink-0"
            aria-label="关闭"
          >
            <X class="size-4" aria-hidden="true" />
          </Button>
        </SheetClose>
      </header>

      <div
        class="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4 pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:px-6"
      >
        <slot />
      </div>

      <footer v-if="$slots.footer" class="shrink-0 border-t px-5 py-3 sm:px-6">
        <slot name="footer" />
      </footer>
    </SheetContent>
  </Sheet>
</template>
