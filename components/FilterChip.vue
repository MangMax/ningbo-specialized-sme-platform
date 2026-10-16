<script setup lang="ts">
import { X } from '@lucide/vue'
import { Button } from '@/components/ui/button'

/**
 * 已生效的筛选条件。表格上方列出一行,每项可单独撤掉。
 * 光看四个下拉按钮看不出「年份里到底勾了哪几年」,所以把生效的值摊开写出来。
 */
defineProps<{ label: string }>()
defineEmits<{ remove: [] }>()
</script>

<template>
  <!--
    `data-testid` 给浏览器验收脚本一个稳定的抓手:`scripts/verify-ledger-ui.mjs` 要断言
    「地址栏里有这个筛选、页面上也看得见它」。靠 class 或文案去认,改一次样式就假红一次。
  -->
  <span
    data-testid="filter-chip"
    class="bg-accent text-accent-foreground inline-flex h-6 shrink-0 items-center gap-1 rounded-sm pr-0.5 pl-2 text-xs font-medium"
  >
    {{ label }}
    <Button
      variant="ghost"
      size="icon"
      class="hover:bg-primary/20 size-4 shrink-0 rounded-[3px]"
      :aria-label="`移除筛选条件:${label}`"
      @click="$emit('remove')"
    >
      <X class="size-3" />
    </Button>
  </span>
</template>
