<script lang="ts" setup>
import type { ToasterProps } from "vue-sonner"
import { CircleCheckIcon, InfoIcon, Loader2Icon, OctagonXIcon, TriangleAlertIcon, XIcon } from "@lucide/vue"
import { cn } from "@/lib/utils"
import { Toaster as Sonner } from "vue-sonner"

const props = defineProps<ToasterProps>()
</script>

<template>
  <Sonner
    :class="cn('toaster group', props.class)"
    :style="{
      '--normal-bg': 'var(--popover)',
      '--normal-text': 'var(--popover-foreground)',
      '--normal-border': 'var(--border)',
      '--success-bg': 'var(--popover)',
      '--success-text': 'var(--popover-foreground)',
      '--success-border': 'var(--border)',
      '--info-bg': 'var(--popover)',
      '--info-text': 'var(--popover-foreground)',
      '--info-border': 'var(--border)',
      '--warning-bg': 'var(--popover)',
      '--warning-text': 'var(--popover-foreground)',
      '--warning-border': 'var(--border)',
      '--error-bg': 'var(--popover)',
      '--error-text': 'var(--popover-foreground)',
      '--error-border': 'var(--border)',
      '--border-radius': 'var(--radius)',
    }"
    v-bind="props"
  >
    <template #success-icon>
      <CircleCheckIcon class="text-success size-4" />
    </template>
    <template #info-icon>
      <InfoIcon class="text-info size-4" />
    </template>
    <template #warning-icon>
      <TriangleAlertIcon class="text-warning size-4" />
    </template>
    <template #error-icon>
      <OctagonXIcon class="text-destructive size-4" />
    </template>
    <template #loading-icon>
      <div>
        <Loader2Icon class="text-primary size-4 animate-spin motion-reduce:animate-none" />
      </div>
    </template>
    <template #close-icon>
      <XIcon class="size-4" />
    </template>
  </Sonner>
</template>

<style>
/* Keep Sonner's positioning/interaction CSS; this wrapper owns its theme. */
.toaster[data-sonner-toaster] {
  font-family: inherit;
}

.toaster[data-sonner-toaster] [data-sonner-toast][data-styled='true'] [data-description] {
  color: var(--muted-foreground);
}

.toaster[data-sonner-toaster] [data-sonner-toast][data-styled='true'] [data-button] {
  color: var(--primary-foreground);
  background: var(--primary);
  border-radius: calc(var(--radius) - 2px);
}

.toaster[data-sonner-toaster] [data-sonner-toast][data-styled='true'] [data-cancel] {
  color: var(--secondary-foreground);
  background: var(--secondary);
}

.toaster[data-sonner-toaster] [data-sonner-toast][data-styled='true'] [data-close-button] {
  color: var(--muted-foreground);
  background: var(--popover);
  border-color: var(--border);
}

.toaster[data-sonner-toaster] [data-sonner-toast][data-styled='true'] [data-close-button]:hover {
  color: var(--accent-foreground);
  background: var(--accent);
  border-color: var(--input);
}

.toaster[data-sonner-toaster] [data-sonner-toast][data-styled='true'] :is([data-button], [data-close-button]):focus-visible {
  box-shadow: 0 0 0 2px var(--ring);
}

/*
 * 全站惯例(prefers-reduced-motion):不写新动画。sonner 自带的进出场/位移/翻转
 * 只服务观感,没有信息;减少动效时全部停掉,toast 仍然原地出现、可交互、可关闭。
 */
@media (prefers-reduced-motion: reduce) {
  .toaster[data-sonner-toaster] [data-sonner-toast],
  .toaster[data-sonner-toaster] [data-sonner-toast] * {
    animation: none !important;
    transition: none !important;
  }
}
</style>
