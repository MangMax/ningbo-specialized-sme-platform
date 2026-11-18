import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * 非 ui/button 原生触发器（Badge 簇、链接式摘要等）的统一交互态：
 * hover/focus-visible 焦点环/active 缩放/disabled 手感与 ui/button 一致,
 * 减少动效时停掉过渡与缩放。布局/排版类由各调用点按自身需要叠加。
 */
export const interactiveTriggerState =
  'focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-3 focus-visible:outline-none active:scale-[0.97] disabled:pointer-events-none disabled:opacity-50 motion-reduce:transition-none motion-reduce:active:scale-100 transition-[color,background-color,transform] duration-150 ease-snap'
