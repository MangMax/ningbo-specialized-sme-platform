<script setup lang="ts">
import { computed } from 'vue'
import { Moon, Sun } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { useAppColorMode } from '@/composables/useAppColorMode'

const colorMode = useAppColorMode()
const isDark = computed(() => colorMode.value === 'dark')

function toggle(event: MouseEvent) {
  const next = isDark.value ? 'light' : 'dark'
  const reduceMotion =
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches

  // 退化:不支持 View Transitions 或用户偏好减少动效时瞬时切换。
  if (typeof document === 'undefined' || !document.startViewTransition || reduceMotion) {
    colorMode.value = next
    return
  }

  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  const x = rect.left + rect.width / 2
  const y = rect.top + rect.height / 2
  const radius = Math.hypot(
    Math.max(x, window.innerWidth - x),
    Math.max(y, window.innerHeight - y),
  )

  const root = document.documentElement
  root.style.setProperty('--theme-reveal-x', `${x}px`)
  root.style.setProperty('--theme-reveal-y', `${y}px`)
  root.style.setProperty('--theme-reveal-r', `${radius}px`)
  root.classList.add('theme-transition')

  const transition = document.startViewTransition(async () => {
    colorMode.value = next
    await nextTick()
  })

  transition.finished.finally(() => {
    root.classList.remove('theme-transition')
    root.style.removeProperty('--theme-reveal-x')
    root.style.removeProperty('--theme-reveal-y')
    root.style.removeProperty('--theme-reveal-r')
  })
}
</script>

<template>
  <Button
    variant="ghost"
    size="icon"
    :aria-label="isDark ? '切换到浅色模式' : '切换到深色模式'"
    :title="isDark ? '切换到浅色模式' : '切换到深色模式'"
    @click="toggle"
  >
    <Sun v-if="isDark" />
    <Moon v-else />
  </Button>
</template>
