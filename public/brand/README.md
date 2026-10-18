# 专精特新品牌资源

三种形态均为透明背景、文字转路径的 SVG，无运行时字体或网络依赖。

| 形态 | 主版 | 单色 | 深底反白 |
| --- | --- | --- | --- |
| 图形 | symbol.svg | symbol-mono.svg | symbol-white.svg |
| 文字 | wordmark.svg | wordmark-mono.svg | wordmark-white.svg |
| 组合 | lockup.svg | lockup-mono.svg | lockup-white.svg |
| 16px 图形 | symbol-compact.svg | symbol-compact-mono.svg | symbol-compact-white.svg |

图形由四块切面围出聚焦的负形，右上块向外错位，表达专注、精度和突破。名称为“专精特新”。

主版图形和文字统一为 `#14417E`；单色为 `#172B45`；深底用白色。标准图形用于 24px 及以上；16px 使用 compact 版。文字标最小宽度 112px，图文组合建议至少 176px，等比缩放。

应用侧栏：32px 图形标；浅色主题用蓝底白标，深色主题用浅蓝底墨标；文字标随应用主题切换为蓝/白。保留完整的品牌链接无障碍名称。

浏览器图标：`/favicon.svg` 由四块切面的 compact 版派生，用系统 `prefers-color-scheme` 选择深蓝或白色，独立于页面内主题切换。

README：使用图文组合，并提供深色模式反白版。

复现并同步公共资源：

```sh
uv run design/brand/2026-10-18-logo/generate.py --publish
```

源字形子集、字体许可和设计/评审记录位于 [design/brand/2026-10-18-logo](../../design/brand/2026-10-18-logo/README.md)。`generate.py` 通过 PEP 723 固定 fonttools 版本；`--publish` 同步 12 个品牌 SVG 和 favicon。修改时更新生成器后重新生成，避免仅修改公共副本。
