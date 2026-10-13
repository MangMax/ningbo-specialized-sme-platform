<script setup lang="ts">
import type { HoverCardTriggerProps } from "reka-ui"
import { HoverCardTrigger } from "reka-ui"

/**
 * 相对官方默认加了一句 tabindex。
 *
 * 台账表里「事件」列的内联 chip 超出上限时会折叠成 +N,完整清单放在 hover card 里。
 * reka 的 HoverCardTrigger 已经绑了 onFocus / onBlur,但它渲染的是 <a>,没有 href,
 * 键盘进不去 —— 于是纯键盘用户拿不到那份清单。给一个可聚焦的 tabindex 就能靠
 * 聚焦打开,触屏则走点击。
 */
const props = defineProps<HoverCardTriggerProps>()
</script>

<template>
  <HoverCardTrigger
    data-slot="hover-card-trigger"
    tabindex="0"
    class="focus-visible:ring-ring rounded-sm outline-none focus-visible:ring-3"
    v-bind="props"
  >
    <slot />
  </HoverCardTrigger>
</template>
