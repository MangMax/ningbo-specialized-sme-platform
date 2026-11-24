<script setup lang="ts">
import type { TabsContentProps } from "reka-ui";
import type { HTMLAttributes } from "vue";
import { reactiveOmit } from "@vueuse/core";
import { Motion, useReducedMotion } from "motion-v";
import { Primitive, TabsContent } from "reka-ui";
import { cn } from "#core/lib/utils";

const props = defineProps<
  TabsContentProps & { class?: HTMLAttributes["class"] }
>();

const delegatedProps = reactiveOmit(props, "class");
const reducedMotion = useReducedMotion();

// 与 CSS 的 `--motion-ease-out` / `--ease-snap` 严格一致(cubic-bezier(0.215, 0.61, 0.355, 1)):
// motion-v 的 JS 动效也必须落在同一手感上,面板切换不能因为走的是 JS 而变「软」。
const easeSnap: [number, number, number, number] = [0.215, 0.61, 0.355, 1];
</script>

<template>
  <TabsContent
    data-slot="tabs-content"
    v-bind="delegatedProps"
    as-child
  >
    <Motion
      as-child
      :initial="reducedMotion ? false : { opacity: 0, y: 6 }"
      :animate="{ opacity: 1, y: 0 }"
      :transition="{ duration: reducedMotion ? 0 : 0.18, ease: easeSnap }"
    >
      <Primitive
        :as="props.as || 'div'"
        :as-child="props.asChild"
        :class="cn('flex-1 outline-none', props.class)"
      >
        <slot />
      </Primitive>
    </Motion>
  </TabsContent>
</template>
