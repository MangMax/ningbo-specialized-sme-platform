<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import { cn } from '@/lib/utils'
const props = defineProps<{ class?: HTMLAttributes['class'] }>()
</script>
<template>
  <div data-slot="field" role="group" :class="cn('group/field flex min-w-0 flex-col gap-2 data-[disabled=true]:opacity-50 data-[invalid=true]:text-destructive', props.class)"><slot /></div>
</template>
