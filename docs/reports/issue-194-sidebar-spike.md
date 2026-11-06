# #194：侧栏属性透传与键盘行为调查

> 历史状态补注（#580）：下文保留 2026-10-22 固定基线的调查原文，历史 PASS/FAIL、工具失败、受控 cookie 观察与未运行范围均属 inherited 历史证据。后续[修复提交 `1591f08d357c5bd175243c34126239da7c31980f`](https://github.com/MangMax/ningbo-specialized-sme-platform/commit/1591f08d357c5bd175243c34126239da7c31980f) 是本次静态核对基线 `42e75f8cc165810d2fea9d55a501a2eccc313156` 的祖先；该基线的 `components/ui/sidebar/SidebarMenuButton.vue:38–40` 仍以 `v-if="state === 'collapsed' && !isMobile"` 仅在桌面折叠状态挂载 TooltipContent。`tests/sidebar-menu-button.test.ts:35–68` 存在首次 Escape 关闭移动 Sheet（`closes the mobile Sheet on the first Escape after its menu receives focus`）及桌面折叠提示、展开移除提示（`shows help for a focused collapsed desktop menu and removes it when expanded`）两项测试；这两个文件与该修复提交中的版本相同。
>
> 此补注仅提供后续代码定位与 fresh 静态核对，不表示本轮测试或浏览器通过，也不关闭受控 cookie 观察或其他未覆盖范围；本轮运行验证为 UNRUN。固定链接对应提交已通过已认证 GitHub API 核实可读取（匿名网页请求为 404），不等于完整远端归档已验证；旧 `/tmp/ningbo-spec190-handoff/issue-194/` 外部工件恢复能力仍为 UNKNOWN，原报告继续保留。

关联：[#190](https://github.com/MangMax/ningbo-specialized-sme-platform/issues/190)、[#194](https://github.com/MangMax/ningbo-specialized-sme-platform/issues/194)。2026-10-22，45 分钟上限内完成；仅交付调查文档，无生产代码修复。

## 结论

**属性／点击重复假设被当前组合反证；另有可复现的移动侧栏 Escape 问题，应另票处理。** 不建议为消除静态提示而修改 `SidebarProvider` 的 attrs 继承。

- `class`、`id` 各只有一个 DOM 落点；更新后旧 id 消失，新 class/id/style 生效。
- 一次普通点击或触发器点击，Provider 的监听各调用一次。桌面 Enter、Space 各产生一次原生点击；Ctrl+B、Meta+B 各切换一次，不产生 click。
- 390px 下，带 tooltip 的菜单自动获得焦点后，**第一次 Escape 只关闭不可见 Tooltip，第二次才关闭 Sheet**。这不是重复监听，也不能报告为键盘验收全绿。

## 对象与隔离

- 初始源码／安装基线：`c22aab2f4788eb7b1c287f89dd41f0ad27731fbd`，确认为本分支祖先；从干净独立 worktree 建立 `t3/issue-194-sidebar-spike`。
- 调查期间合入本地集成分支 `t3/implement-spec-190` 的 `678bba97e5e217ef1bafdea760a2eeb328b8a809`。侧栏、Sheet、Tooltip、`lib/utils.ts`、应用 CSS 与初始基线无差异；锁文件中的 Vue `3.5.43`、Reka UI `2.11.0` 与实测安装一致。最终交付 SHA 见提交记录。
- `/tmp/ningbo-spec190-handoff/issue-194/harness/` 是独立 Vite 页面，直接导入仓库真实 `SidebarProvider`、`Sidebar`、`SidebarTrigger`、`SidebarMenuButton`、Sheet、Tooltip 和 CSS；无 stub，不运行 Nuxt 应用服务或业务路由。
- 采用应用实际使用的 `collapsible="icon"`；桌面 1440×900、窄屏 390×900。每场景独立 `*.issue194.localhost:4194` 合成源；状态探针只读取注入的 sidebar context，操作使用浏览器原生点击／按键。没有访问业务库、应用 API、凭据或生产环境。

## 行为证据

| 范围 | 新鲜结果与证据 |
| --- | --- |
| 桌面：无 cookie 默认、`defaultOpen=false`、受控 true、受控 false | `round-02.log` 中四个 `PASS 1440-*`；`browser-evidence.json` 的对应记录证明唯一属性落点、点击次数、Ctrl+B／Meta+B、Enter／Space 和每次一次 `update:open`。展开 256px、图标折叠 48px。 |
| 390px：同上四种状态 | `browser-evidence-round05.json` 的四组 `390-*`；打开宽度 288px，初始 `openMobile=false`；触发器、Ctrl+B／Meta+B、Enter 操作不改桌面 open、不发桌面 `update:open`。属性仍各一处，触发器点击仍一次。 |
| 合成 cookie 默认 | `desktop-cookie-false`／`desktop-cookie-true`：刷新后分别折叠／展开，见 `browser-evidence-round05.json`。 |
| 移动 Escape 反例 | 四种状态均复现，第一次 Escape 后 `openMobile=true`，第二次关闭；`escape-evidence.json` 捕获可信键盘事件与隐藏 Tooltip 层消失、Sheet 保留的顺序。 |
| Tooltip 有／无对照、遮罩关闭 | `control-evidence.json`：仅省略合成菜单的 tooltip 参数，第一次 Escape 即关闭；带 tooltip 需两次。两组点击遮罩均关闭。真实组件实现不变。 |
| 可视检查 | 已查看 `desktop-initial.png`、`failure.png`、`control-on-open.png`；尺寸与交互结论以 DOM／事件记录为依据，不以截图替代。 |

移动菜单由 Portal 移至 wrapper DOM 外；点击其中菜单不会冒泡到 Provider 的 DOM 监听。这次也测得零次，属于当前 DOM 冒泡边界，不是两次调用或监听丢失的证明。

## 组件库依据与最小建议

`components/ui/sidebar/SidebarProvider.vue:4,69–81` 直接使用 **Reka** TooltipProvider，未使用仓库的同名包装组件。`class` 已声明为 prop，经 `cn` 放到 wrapper；其余 attrs 显式放在该 div 上。

安装包 `reka-ui/dist/Tooltip/TooltipProvider.js:9,71–73` 明确 `inheritAttrs:false`，只渲染 slot；对应源码为 `reka-ui/src/Tooltip/TooltipProvider.vue:67–69,107–109`。因此 Provider 根上的自动继承不会形成第二次 DOM 透传。Vue `renderComponentRoot` 也只在 `inheritAttrs !== false` 时应用 fallthrough。安装源码及相关仓库文件的 SHA-256 保存在 `provenance.json`。本结论仅适用于已锁定组件版本与此组合。

Escape 反例链路：

1. `SidebarMenuButton.vue:37–40` 用 `hidden` 隐藏移动端 TooltipContent，未阻止其挂载。
2. 打开 Sheet 后菜单获得焦点，Tooltip 打开；DOM 同时存在可见 dialog 和 `hidden=true/display:none` 的 `data-dismissable-layer` Tooltip。
3. Reka `TooltipContentImpl.vue` 为 Tooltip 挂载 DismissableLayer；`DismissableLayer.vue:146–158` 只让最高层处理 Escape。第一次移除隐藏 Tooltip，Sheet 留下；第二次才关闭 Sheet。等待入场动画完成后仍复现，无 tooltip 对照不复现。

后续票可只验证 `SidebarMenuButton.vue` 的 TooltipContent 在 `state === 'collapsed' && !isMobile` 时才挂载（例如条件渲染替代 `hidden`），并回归桌面折叠提示、移动首次 Escape、遮罩、快捷键与焦点返回。本票未实施该方案，也未证明该方案所有交互均通过。单独给 SidebarProvider 加 `inheritAttrs:false` 没有解决此反例的证据。

附带观察：两种桌面受控初态的点击记录中，open 已切换而 `sidebar_state` cookie 仍是旧值，见 `1440-controlled-*-trigger`。这里只保留观察，不将其归因于 attrs、不扩展为 cookie 修复；受控状态持久化不在本报告的通过声明内。

## 命令、失败与未运行范围

实际命令（原始文件均在外部证据目录）：

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm exec nuxt prepare
node /tmp/ningbo-spec190-handoff/issue-194/server.mjs
# 独立终端；依次执行，未并发运行套件
# round-01 建立本次浏览器空间；后续脚本使用其返回的 spaceId
 ego-browser nodejs < /tmp/ningbo-spec190-handoff/issue-194/round-01.mjs
 ego-browser nodejs < /tmp/ningbo-spec190-handoff/issue-194/round-02.mjs
 ego-browser nodejs < /tmp/ningbo-spec190-handoff/issue-194/round-04.mjs
 ego-browser nodejs < /tmp/ningbo-spec190-handoff/issue-194/round-05.mjs
 ego-browser nodejs < /tmp/ningbo-spec190-handoff/issue-194/round-06.mjs
```

- **新鲜／成功**：安装与 prepare 退出 0；四个桌面场景完成；round-05 退出 0，46 条观察，确认移动 attrs／快捷键与 Escape 反例；round-04、round-06 对照退出 0。
- **新鲜／失败，保留**：round-02 退出 1，第一次 Escape 关闭 Sheet 的预期超时，见 `browser-result-original-fail.txt`。后续脚本确认该反例，未把它改称修复通过。初始 server 因缺 `.nuxt/tsconfig.json` 失败，prepare 后重启恢复；初始 CSS 未扫描组件，补齐外部 harness 的 `@source` 后才计入尺寸证据。
- **工具失败／不计入结论**：T3 snapshot 多次返回 `Preview automation snapshot timed out after 15000ms.`，改用 ego-browser。T3 后续窄屏交叉检查设置 390、实际 `innerWidth=1440`，保存在 `t3-escape-evidence.json`，不作为 390px 证据。
- **继承**：集成分支合入的 #191 接入改动；本报告未重新执行其诊断或验证。相关 UI 源码与依赖版本相等，只支持复用本票局部证据，不证明整个合并树。
- **未运行**：完整业务页面、全套 Vitest、typecheck、应用 build、prod-openapi、CI、真实移动设备、生产与容量验收；未遍历其他 sidebar variant 或全部断点。本票仅文档交付，没有公开契约修改。

完整 harness、脚本、日志、JSON、截图在 `/tmp/ningbo-spec190-handoff/issue-194/`，不入 Git。没有 push、PR、GitHub 评论／状态修改、生产操作或委派。
