# #681 文件登记契约（供 #682）

V2设计优先。服务端基础票；本票没有修改页面、正式事件、资格规则或源文件。

## 读取

- `GET /api/files` 的 `rows[].registeredSummary` 与 `list_files` 同形：`{count: number, declarations: Declaration[]}`。一次分组查询取得本页声明，不逐文件查询声明。
- `GET /api/files/{id}/parse-result`、`get_file_parse_result` 返回 `declarations` 及同源 `registeredSummary`。浏览器 `GET /api/files/{id}/segments` 使用 `state` 包装此对象。
- `Declaration`：`declarationId: string`（UUID）、`fileId: number`、`displaySequence: number`、`revision: number`、`active: boolean`、`sha256: string`、`contentVersion: string|null`、`part: {titleCode:string,eventKind:string,year:number|null,batch:number|null,attachment:string|null,rowCount:number}`、`pageRanges: {start:number,end:number}[]|null`。只返回active声明，按displaySequence升序，ID作为相同序号的确定性后备排序。正常写入由服务端分配正序号。
- `ingestionStatistics: {parts: FilePart[], rowCount:number}` 在解析读取中单独表达正式出处聚合统计。它不是登记声明。`parts` 原兼容读模型保留，不能当登记摘要；列表 `referenceCount` 仍为出处引用数。
- 没有登记时返回`{count:0,declarations:[]}`，即使有489个正式事件。读取错误仍抛出错误；消费者不能把失败转换为空数组。
- 年份1900..2100、批次正整数，各自可以未知，不推断另一项。

## 保存与身份

继续用现有整集合parse-result PUT或预检/commit以及segments适配器，不新增删除接口。传`parts[]`，每项将`declaration.part`展开并携`declarationId`，需要改范围时传`pageRanges`。省略某个ID代表撤回；不是删除企业记录。未知/别文件/已撤回ID返回409，不作为新增。

`displaySequence`是只读服务端字段，**不要发送**。原ID修改保留序号；新声明在IMMEDIATE事务内按包含已撤回行的最大序号追加；删除不压缩序号。请求数组顺序不重排既有声明。省略范围保留已有范围；显式`[]`清空。非空范围必须物理页预检。所有其他声明必须完整保留其ID及part；页面不得按可变年月反查ID。

旧调用不带ID时仅允许按完全相同的旧坐标复用身份（原兼容语义）；坐标变化会被视作撤回+新增。因此新编辑器必须传ID。旧调用省略顺序与范围不会清空它们。现代CAS封套、inputRef与原幂等键规则不变；序号进入版本hash，迁移前计划会拒绝。重放先于CAS，返回原历史回执，不改写旧hash或快照。旧save_parse_result返回形状保持原样，不增加摘要。

## 增加式迁移与运行风险

0046只增加display_sequence和索引，并补建缺少稳定身份的agent/legacy描述声明；不改stored_file_part或历史回执。已有声明按文件内SQLite rowid确定性编号（包括已撤回行），旧描述按原stored_file_part.id随后追加。补建UUID为`68100000-0000-4000-8000-`加12位十六进制旧行ID；不使用年月作身份。相同坐标已有声明（包括撤回）不复活；derived永不转换成声明。旧行原值与行数保留，范围依据未知为null，不伪造物理依据。

须在受控副本先显式初始化迁移再开新版本；运行时拒绝未迁移库。没有生产回填。回滚需恢复迁移前备份，不能在有新写入后直接删除新表列。旧UI留作基线，本票不承诺其消费新摘要。

HTTP列表及MCP list_files不再隐式扫盘/写回；rescan兼容参数不再触发维护。需要扫盘时使用已有明确维护命令，不以GET代替。其他历史MCP工具的懒初始化不在此次列表投影范围。

## 验收入口

`tests/declaration-681-migration.test.ts`验证旧schema真实SQLite升级后公共HTTP稳定读取及零读写副作用。
`tests/file-segments-668-http.test.ts`的`#681 persists display order...`验证ID编辑、反序旧载荷、删除追加、CAS、原回执重放；已有范围测试验证保留/清空及越界原子拒绝。
`tests/parse-maintenance-105-http.test.ts`的`#681 list and expanded registered summaries...`验证489事件零登记、HTTP列表/展开一致及OpenAPI/MCP发现；同文件其他测试验证legacy精确回包、输入血缘与历史回放。
