<script setup lang="ts">
import { animate, useReducedMotion } from 'motion-v'
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
const props = defineProps<{ value: number }>()
const reducedMotion = useReducedMotion()
const displayed = ref(props.value)
let stop: (() => void) | undefined
onMounted(() => {
  displayed.value = reducedMotion.value ? props.value : 0
  watch([() => props.value, reducedMotion], ([value, reduced]) => {
    stop?.()
    if (reduced) { displayed.value = value; return }
    const playback = animate(displayed.value, value, {
      duration: 0.4, ease: 'easeOut',
      onUpdate: latest => { displayed.value = Math.round(latest) },
      onComplete: () => { displayed.value = value },
    })
    stop = () => playback.stop()
  }, { immediate: true })
})
onBeforeUnmount(() => stop?.())
</script>
<template><span aria-hidden="true">{{ displayed.toLocaleString('zh-CN') }}</span><span class="sr-only">{{ value.toLocaleString('zh-CN') }}</span></template>
