<script setup lang="ts">
import { inject, nextTick, onBeforeUnmount, shallowRef, watch } from 'vue'
import { pdfPageImagesKey } from '#core/app/composables/usePdfPageImages'
const props = defineProps<{ pageIndex: number; scale: number }>()
const emit = defineEmits<{ load: []; error: [] }>()
const images = inject(pdfPageImagesKey)!
const src = shallowRef<string | null>(null)
let displayed: ReturnType<typeof images.acquire> | null = null
onBeforeUnmount(() => displayed?.release())
// Keep the previous decoded image while a sharper image is prepared at a new zoom.
watch(() => [props.pageIndex, props.scale] as const, ([page, scale], _, cleanup) => {
  let active = true
  const lease = images.acquire(page, scale)
  lease.ready.then(async url => { if (active) { const previous = displayed; displayed = lease; src.value = url; await nextTick(); previous?.release() } }, () => { if (active) emit('error') })
  cleanup(() => { active = false; if (displayed !== lease) lease.release() })
}, { immediate: true })
</script>
<template>
  <img v-if="src" :src="src" class="h-full w-full" alt="" draggable="false" @load="emit('load')" @error="emit('error')" />
</template>
