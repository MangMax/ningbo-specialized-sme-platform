# 分段物理页码范围维护（#669）

本契约扩展既有解析维护公共 HTTP/MCP；鉴权、幂等、整批原子性与历史点读沿用
[解析维护](maintenance-105.md)。不写正式事件、出处、OCR 或源文件；不包含分段页面或同步命令。

1. `GET /api/files/{id}/parse-result` / `get_file_parse_result` 读取 `version`、
   `parts` 和独立 `declarations`。派生展示行不是声明身份。旧记录没有范围、没有声明身份时不回填。
2. `POST /api/files/{id}/parse-result/preflight` / `preflight_file_parse_result` 提交
   `{kind:"file", verifyPhysicalPages:true}`。不需要 OCR 的描述维护必须使用 `kind:file,pages:[]`。
   服务端用 PDFium 打开实际 PDF 数页，不信清单/OCR页数。Office、不可读 PDF 返回409及定位限制。
   返回 `expectedVersion` 与 `inputRef`，后者新增 `physicalSource:{pageCount,contentVersion}`。
   `contentVersion` 是实际源文件的设备、inode、权限、字节数、纳秒mtime/ctime组成的不透明epoch；
   不应解析或猜造。读取前后核实epoch、锁根与登记SHA；不渲染页图、不修改源文件。
3. `POST /api/files/{id}/parse-result/commit` / `commit_file_parse_result` 传原 `inputRef`、
   `expectedVersion`、`idempotencyKey/actor/reason` 及全部可编辑声明 `parts`。
   每段仍为一个称号/事件/可空年份/可空批次/附件组合，额外接受：
   - `declarationId`：首次新增省略；后续从 `declarations` 取稳定UUID，修改年月坐标必须携带它。
     不接受跨文件、已撤回或派生展示行ID。相同ID在同批重复拒绝。
   - `pageRanges:[{start:1,end:2},{start:4,end:4}]`：1起物理页闭区间，最多1000范围/段，最多1000段。
     逆序、非整数、非正数、越界整批拒绝；重叠按并集归一。未知不默认全文件。
   - 省略 `pageRanges` 保留旧范围及其来源epoch；显式 `[]` 清空。没有范围历史时省略读为null。
     省略ID的旧调用只能按原坐标延续同一活动声明；坐标改变又省略ID视为撤回旧声明并新增。
   - 显式传 `parseState` 保留读到的状态；省略仍遵循旧解析契约置parsed。

新范围的非空写入必须经物理页预检和冻结commit；兼容PUT/MCP save不接受物理页冻结输入，
不能绕过验证。旧客户端仍可按原契约使用旧字段和历史unknown结果；已绑定输入结果仍遵循
既有禁止降级保护。仅状态维护不改变声明和依据。

`declarations` 每项包含 `declarationId,fileId,revision,active,sha256,contentVersion,part,pageRanges`。
稳定身份与可变坐标独立，修订在替换时单调增加，撤回不复用身份。范围绑定文件ID、SHA与
物理内容epoch；源内容改变后不能通过省略范围把旧范围冒充新来源，须重新核实并显式提供或清空。
旧范围仍可在历史回执中读取，不能据它证明历史OCR采用了哪些页或每家企业已核实。

范围编辑、撤回及同内容描述ABA均改变输出version；物理文件内容ABA通过epoch使旧物理页预检失效。
提交重新打开实际PDF核实页数，并在事务内再次核对实际源身份、输出版本和声明归属。
这是读取一致性保护，不提供外部文件写入者的跨进程文件锁；最后检查之后的外部替换沿用#311边界。

新增迁移0045只建声明表和索引，不更新旧声明、文件、正式事实或历史回执。
回执before/after保存当次声明与范围，`history?receiptId=...` / `get_file_parse_history`可点读；
撤回后原回执仍可恢复。同键同载荷在检查磁盘漂移前返回原回执，不重复审计，随后应GET当前状态。
不确定响应只用原载荷原键重试；改草稿使用新键，冲突须重新预检。
