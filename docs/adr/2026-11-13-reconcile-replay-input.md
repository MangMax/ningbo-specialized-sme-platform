# reconcile 原断言与旧比较 projection 分离

状态：#770 A docs-only 候选，pending 父级独立 Standards、Spec 和 LOCAL 接受。补充[四槽捕获 ADR](2026-11-13-reconcile-slot-capture.md)和[契约](../platform-retirement/reconcile-slot-capture.md)的 replay 输入归属，不授权 B 或 #768 carry。

固定基线 `c261f2cf4c95d36898277d52d1394dc08bbd7ee7`，tree `ecd7087bb6bd2025ecfafd425ce3982357baec83`。父级已直接检验“旧 fallback 比较行等于原 rawFields”这一前提，NULL 和空对象正常请求在原 writer 失败。原比较器收到原值可接受。非空普通对象对照和主 B1 正常链成功是不同的继承证据，不能覆盖该失败。

选择保留独立 comparison projection、完整 exact original snapshot 和 outgoing assertion 三种输入。复用已有 reference 语义表达修正分区。reference 明确发送原坐标、`reuseExisting:true` 和全部原 sequence，省略 metadata、key/raw、源列及可变归属断言。writer 从持久化原 owner 认证它们；缺档、source drift、缺 projection 或非法原输入继续失败。该省略仅适用于 service 从已认证原件生成的请求，不改写外部显式冲突。

全量发送原 nullable assertion 虽能解决 NULL/空对象，却不能在现有 status 输入类型中发送历史 BLOB，新增原来 omitted 的列还会改变成功请求。统一换成 reference 也会改变 committed requestHash。因此整条 query 先作完整旧编码兼容判断：原断言全部成立的旧成功分区返回原 builder 对象，保留 values、own keys、顺序、普通补齐及原 receipt；失真分区才选固定 reference 形状。它不是逐字段删断言或失败后自动重试。

[详细补充](../platform-retirement/reconcile-replay-input.md)规定全部 producer/source owners、内部 union/API、literal 请求、snapshot/custody、BLOB/源列/冲突/同版本观察、原成功和失败 ledger、B ≤M 接受矩阵。原 capture 已认证完整性；target runtime admission 只消费结构化结果，selected originals 在选中后恢复，原 writer 的 capture/fingerprint 核验保持。没有 comparator/public schema/validator/hash/serializer/capture/DDL/T04/71613/key 政策变化。

若旧 committed 请求必须改变编码，或 target ordinary bootstrap 与 native 原值不能同时满足原契约，则提交准确 owner、literal 请求和 receipt 反例 NOTREADY。不能换 key、改 ledger、造新 Buffer transport 或扩大资格语义。本 A 只有静态文档证据，所有 application runtime、DB、fixtures、tests、types 和 target carry UNRUN。#769 保持，#768/#763/#706 NOTREADY，global guards CLOSED。
