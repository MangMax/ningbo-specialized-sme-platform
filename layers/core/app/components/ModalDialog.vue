<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import { computed } from 'vue'
import { X } from '@lucide/vue'
import { cn } from '#core/lib/utils'
import { Button } from './ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from './ui/dialog'

/**
 * 业务模态弹窗的统一结构（与 DetailDrawer 对称）：
 * 固定头部（标题与关闭按钮垂直居中，不贴底边线）+ 独立滚动主体 + 可选固定底栏。
 *
 * 宽度统一走 `size` 档位（sm 448 / md 512 / lg 672 / xl 768），
 * `preventClose` 统一屏蔽 Esc、点遮罩与关闭按钮。
 * 若业务需要 `<form>` 同时包裹滚动区与底栏，传 `bareBody` 后在默认插槽内渲染表单。
 */
const props = withDefaults(
  defineProps<{
    open: boolean
    title: string
    description?: string
    /** 标题只作读屏名称时隐藏可见说明。 */
    hideDescription?: boolean
    size?: 'sm' | 'md' | 'lg' | 'xl'
    preventClose?: boolean
    bareBody?: boolean
    stopEscapePropagation?: boolean
    contentTestId?: string
    contentClass?: HTMLAttributes['class']
    bodyClass?: HTMLAttributes['class']
    footerClass?: HTMLAttributes['class']
  }>(),
  {
    size: 'md',
    hideDescription: false,
    preventClose: false,
    bareBody: false,
    stopEscapePropagation: false,
  },
)

const emit = defineEmits<{
  'update:open': [value: boolean]
  closeAutoFocus: [event: Event]
}>()

const sizeClass = computed(() => {
  switch (props.size) {
    case 'sm':
      return 'sm:max-w-md'
    case 'lg':
      return 'sm:max-w-2xl'
    case 'xl':
      return 'sm:max-w-3xl'
    default:
      return 'sm:max-w-lg'
  }
})

function onEscapeKeyDown(event: Event) {
  if (props.stopEscapePropagation) event.stopPropagation()
  if (props.preventClose) event.preventDefault()
}

function blockClose(event: Event) {
  if (props.preventClose) event.preventDefault()
}

function close() {
  if (!props.preventClose) emit('update:open', false)
}
</script>

<template>
  <Dialog
    :open="props.open"
    @update:open="(value: boolean) => { if (value || !props.preventClose) emit('update:open', value) }"
  >
    <DialogContent
      :show-close-button="false"
      :data-testid="props.contentTestId"
      :class="cn(
        'flex max-h-[min(85dvh,calc(100dvh-2rem))] min-w-0 flex-col gap-0 overflow-hidden rounded-xl p-0 shadow-(--shadow-drawer)',
        sizeClass,
        props.contentClass,
      )"
      @escape-key-down="onEscapeKeyDown"
      @pointer-down-outside="blockClose"
      @interact-outside="blockClose"
      @close-auto-focus="emit('closeAutoFocus', $event)"
    >
      <header class="flex shrink-0 flex-col gap-1.5 border-b px-5 py-3.5 sm:px-6">
        <div class="flex items-center justify-between gap-3">
          <DialogTitle class="min-w-0 flex-1 text-base leading-snug font-semibold wrap-anywhere">
            {{ props.title }}
          </DialogTitle>
          <Button
            v-if="!props.preventClose"
            type="button"
            variant="ghost"
            size="icon-sm"
            class="text-muted-foreground hover:text-foreground -mr-1.5 size-8 shrink-0"
            aria-label="关闭"
            @click="close"
          >
            <X class="size-4" aria-hidden="true" />
          </Button>
        </div>
        <!-- 没有可见说明时仍给读屏一个描述节点，避免 Dialog 无描述告警。 -->
        <DialogDescription
          :class="props.hideDescription || (!props.description && !$slots.description)
            ? 'sr-only'
            : 'text-muted-foreground text-sm leading-relaxed wrap-anywhere'"
        >
          <slot name="description">{{ props.description ?? props.title }}</slot>
        </DialogDescription>
        <slot name="header-extra" />
      </header>

      <slot v-if="props.bareBody" />
      <div
        v-else-if="$slots.default"
        :class="cn(
          'min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4 sm:px-6',
          props.bodyClass,
        )"
      >
        <slot />
      </div>

      <footer
        v-if="!props.bareBody && $slots.footer"
        :class="cn(
          'bg-surface-sunken/40 flex shrink-0 flex-col-reverse gap-2 border-t px-5 py-3 sm:flex-row sm:items-center sm:justify-end sm:px-6',
          props.footerClass,
        )"
      >
        <slot name="footer" />
      </footer>
    </DialogContent>
  </Dialog>
</template>
