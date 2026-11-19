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
      :transition="{ duration: reducedMotion ? 0 : 0.18, ease: 'easeOut' }"
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
