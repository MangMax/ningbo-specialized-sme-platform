# 宁波专精特新 · SVG 标识

本目录保存标识三种形态的设计源文件、复现脚本与评审记录。公共资源位于 `public/brand/`，应用侧栏、浏览器 favicon 和项目 README 已接入；接入说明见 `public/brand/README.md`。

## 方向

北极星：给名录与来源证据工具一个安静、清晰、能在侧栏小尺寸使用的入口。

- 图形：宁波首字母 N，由等宽竖笔、对角带和右上三角折角组成；折角与下方竖笔之间保留切口，区别于字母 i 的圆点。
- 文字：宁波专精特新，使用 Noto Sans SC SemiBold 的轮廓，保留清楚的中文阅读顺序，不添加英文副标或口号。
- 色彩：沿用项目 `assets/css` 中的深蓝 `#14417E`；主版的图形和文字均为 `#14417E`；单色版统一为 `#172B45`，深色背景统一用白色版。
- 比较与取舍：本轮是一个标识组件的单方向设计；保留当前项目书册图标的“名录”语义，改为可独立使用的几何字母，不使用书本图标、勾选徽章、渐变或复杂细线。未做外部品牌相似性检索。

## 资产

| 形态 | 彩色 | 单色 | 反白 |
| --- | --- | --- | --- |
| 图形 | symbol.svg | symbol-mono.svg | symbol-white.svg |
| 文字 | wordmark.svg | wordmark-mono.svg | wordmark-white.svg |
| 组合 | lockup.svg | lockup-mono.svg | lockup-white.svg |

所有文件背景透明；全部为路径，无 `<text>`、外链、位图或脚本。反白版用于深色背景。图形标默认 viewBox 为 64 × 64，三种形态的比例不可拉伸。

建议：侧栏收起使用 24/32px 标准图形标；16px 必须使用 `symbol-compact.svg`（反白为 `symbol-compact-white.svg`，单色为 `symbol-compact-mono.svg`），去掉折角并用整像素竖笔保证小尺寸清晰，不将标准版直接缩到 16px。图文组合建议宽度至少 232px（字面约 28px），低于此尺寸优先只用图形标；文字标建议宽度至少 168px。展示稿不是应用接入验收。

## 复现

```sh
uv run design/brand/2026-10-18-logo/generate.py
```

生成器用 PEP 723 固定 `fonttools==4.60.1`；随附 `source-font.ttf` 是字重 600、仅含本次所需汉字的静态子集，复现无需系统字体。字形来源为 Google Fonts 的 Noto Sans SC；其 SIL Open Font License 保留在 `FONT-LICENSE.txt`。标识 SVG 使用轮廓，因此展示和使用时无需字体文件或 Python。

最初字体来源：
https://github.com/google/fonts/tree/main/ofl/notosanssc

## 验证与范围

- `preview.html` 为自包含展示稿，`preview-728.png`、`preview-390.png` 为实际渲染截图。
- 展示覆盖三形态、反白、单色、16/24/32/48px；检查中文轮廓、比例和窄屏裁切。
- 静态品牌资产不含动效；应用接入保留原侧栏布局与主题切换动效。
- 初稿没有多余副标题、英文缩写或装饰性口号放入标识，未额外删减资产文字。
- 设计阶段未运行产品检查；接入阶段执行 `pnpm typecheck` 并在桌面与 390px 实际检查，详见 `integration.md`。
- 用户指定 Magpie + DeepSeek OpenDesign 独立评审，记录见 `review.md`。

## 评审处理

Magpie / `opendesign/deepseek-v4.1-flash[1m]` 完成一轮独立视觉评审，初版 7/10。完整原文与初版截图保存在 `review-round-1.md`、`review-round-1-*.png`。

修订：方块改为与顶边相齐的三角折角；新增 16px 专用版及浅/深底原尺寸样张；小尺寸行增加 16px 内缩；主版统一全蓝；补充 168px 字标下限样张。修订版已由主 Agent 查看 728/390px 截图并复核生成；未进行第二轮独立评审，不将初版分数当作修订版分数。

保留六字排布、平面语言、右侧断口和三形态。没有增加动效。未采纳把标记扩展成整套界面系统的建议，因为本轮仅设计 logo。
