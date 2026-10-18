# 专精特新 · SVG 标识

当前版本采用四块精密切面围合的抽象图形，品牌名称为“专精特新”。公共资源位于 `public/brand/`，应用侧栏、浏览器 favicon 和项目 README 复用同一套资源。

## 方向与取舍

北极星：用向心的精密结构表达专注，用向外错位的块面表达突破。

四块几何体保留相同切角，围出菱形负空间；右上块向外移出原网格。三块稳定、一块突破，建立集中与变化的关系。名称与图形均不再使用宁波首字母 N；平台仍服务宁波企业数据，业务地域描述不受品牌简称影响。

这是一种抽象联想，不声称陌生用户一定能无提示读出四个词。保留深蓝、等比块面、平面单色语言；不加齿轮、奖章、星星、文字缩写或渐变。未进行商标相似性检索。

文字标用 Noto Sans SC SemiBold 转路径。图形和文字主版统一 `#14417E`；单色 `#172B45`；深底反白。

## 资产

| 形态 | 主版 | 单色 | 反白 |
| --- | --- | --- | --- |
| 图形 | symbol.svg | symbol-mono.svg | symbol-white.svg |
| 文字 | wordmark.svg | wordmark-mono.svg | wordmark-white.svg |
| 组合 | lockup.svg | lockup-mono.svg | lockup-white.svg |
| 16px 图形 | symbol-compact.svg | symbol-compact-mono.svg | symbol-compact-white.svg |

全部透明背景、路径化，无字体/位图/外链依赖。标准图形使用 64×64 viewBox，建议 24px 及以上；16px 使用像素对齐的 compact 版。文字标最小宽度 112px，组合建议至少 176px；比例不得拉伸。

## 复现

```sh
uv run design/brand/2026-10-18-logo/generate.py --publish
```

生成器用 PEP 723 固定 `fonttools==4.60.1`；随附 `source-font.ttf` 为字重 600 的所需汉字子集。源字体为 Google Fonts Noto Sans SC，许可保存在 `FONT-LICENSE.txt`；使用 SVG 不需要安装字体或 Python。

字体来源：https://github.com/google/fonts/tree/main/ofl/notosanssc

## 展示、验证与评审

`preview.html` 是自包含展示稿。当前截图为本地 `abstract-preview-728.png`、`abstract-preview-390.png`，不入 Git。应用验收记录见 `integration.md`，公共资源用法见 `public/brand/README.md`。

静态品牌资产不添加动效；应用接入沿用现有侧栏和主题切换。文字标仅四个字，没有英文副标或口号。展示页的“专注于内，突破于外”仅为设计说明，不进入应用。

旧 N 标识的一轮评审记录保留在 `review-round-1.md`，不适用于当前图形。新抽象方向继续交由 Magpie / DeepSeek OpenDesign 独立评审，当前状态见 `review.md`。
