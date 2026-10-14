# 11 — 代理只从「已上传文件」解析(不再扫数据根)

**What to build:** pipeline 的**输入源**从「数据根目录扫描」改为「app 的文件库 + `stored_file` 表」。

**Blocked by:** 09

**Status:** ready

## 现状与要改什么

- 现在:`src/inputs.ts · readInputs(root, filesDir)` 用 `discoverAnnouncements(root, subdir)` **扫数据根**(`经信局名单/**`、`工信部名单/**`)。
- 改成:从 **`app/files/`**(+ `stored_file` 表给的元数据)枚举,`.docx/.doc` 走 parser,`.xlsx` 走 miit parser。
- **`--root` 扫描降级为「离线校验用」**(`check:jxj` 仍可用),**导入路径不再依赖数据根**。

## 关键设计点

- **分类从表里读,不从路径猜**:`source/kind/year/batch/title_code` 取 `stored_file`;**未分类的(`unset`)跳过并报出**,不猜(交票 12)。
- pipeline **要读 app 的库** —— 这加深了耦合。已在 `src/db.ts` 复用 app 的库结构;此处再读 `stored_file` 表即可,**不新增第二个连接**。
- `.doc` 仍依赖本机 LibreOffice(既有约束),找不到时**逐文件报错、不整批失败**。

## 测试

- [ ] fixture:文件库里放两份文件(一份已分类、一份 `unset`)→ 只解析已分类的,`unset` 出现在「跳过」清单。
- [ ] 元数据里的年份/批次进 `record_event`,不靠文件名推理。

## 验收

- [ ] 把一份新 PDF 放进 `files/` 并在 `stored_file` 标好分类 → 跑导入 → **库里有新记录**。
- [ ] 数据根目录**不参与**导入(可故意改名数据根验证仍能导入)。
- [ ] pipeline `vp check && vp test` 全绿。

**分支**:`feat/agent-reads-uploads`。
