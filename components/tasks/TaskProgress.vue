<script setup lang="ts">
import type { TaskSummary } from '~~/lib/task-center'
defineProps<{ progress: TaskSummary['progress'] }>()
</script>
<template>
  <div class="flex flex-col gap-1 text-sm">
    <span>{{ progress.stage }}</span>
    <span class="text-muted-foreground text-xs tabular-nums">{{ progress.done }}<template v-if="progress.total !== null"> / {{ progress.total }} {{ progress.unit }}</template><template v-else> · 总量未知</template></span>
  </div>
</template>
