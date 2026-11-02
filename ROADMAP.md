# Roadmap

> 状态：`[x]` 已实现 / `[ ]` 未实现。每个版本附验收口径。
> 原则（任何版本都不得违背）：
> 1. **手术式编辑**——未触碰区域 byte-identical，round-trip 测试永远先行
> 2. **格式资产只读是默认**——保护区守卫 strict，写入是显式例外
> 3. **敏感信息零内置**——数据连接等信息永远由调用方注入，库内只有类型定义
> 4. **agent 友好**——结构化输出、错误带 `code + hint`、能力自描述（`cpt ops`）

---

## v1 —— 核心底座：手术式编辑 + cell/sql 两个 Operation（✅ 2026-11-02 完成）

验收：对真实台账（设计器保存版）做一次改绑，diff 仅目标块变化，格式区零触碰。

### core
- [x] `CptDocument.load/save`：load → 无操作 → save 与原文 **byte-identical**（round-trip 测试锁死）
- [x] 手术式编辑（surgery）：块定位 + span 替换，`<C>`/`<TableData>` 不嵌套假设已验证
- [x] XML 校验（fast-xml-parser validator），改坏即拒绝保存
- [x] 自动备份 `<name>-bak-<时间戳>.cpt`
- [x] 格式保护区守卫：StyleList / RowHeight / ColumnWidth / ReportPageAttr / PaperSetting / `<C>` 开标签（样式引用 s= 与合并属性 rs/cs）；`strict` 默认，`allow-protected` 显式越权并记录违规
- [x] diff 报告（统一 diff 文本 + 增删行统计）

### model（只读索引）
- [x] 逐格解析：文本 / 公式 / 数据列（分组 function｜列表 mono｜汇总 summary）/ 跨数据集过滤引用 / 扩展方向 / 左父格 / 样式引用与合并属性
- [x] 数据集清单（连接名、Query 有无）
- [x] 主扩展格探测（`cpt audit` 给出 masterAddress 与 dataRow）
- [x] 告警：悬空左父格 / 绑定了不存在的数据集 / SQL 引用未注册的 `${param}`

### ops（一切功能皆 Operation）
- [x] `cell-bind`：`ds` / `master` / `group`（MonoGrouper + CommonCondition 过滤，NM→NM_CODE、XS→XS_CODE）/ `formula` / `text` / `blank`
- [x] cell-bind 防呆：换绑保留样式引用、左父格引用与原扩展方向（改字段不改结构）；group 左父格缺省自动探测主格
- [x] `sql-set`：只替换 `<Query>` CDATA（PowerShell BOM 兜底、CDATA `]]>` 断言）
- [x] Operation 注册表：CLI 与编程 API 共用，`cpt ops` / `cpt explain` 能力自描述（JSON Schema + 示例）

### CLI（agent 友好）
- [x] `audit` / `list`（--row 过滤）/ `cell set` / `sql set` / `ops` / `explain`
- [x] `--json` 结构化输出、`--ascii` 非 ASCII 转义（防 GBK 控制台乱码）
- [x] 错误输出 `{ ok:false, code, message, hint }`，hint 指向下一步（如 CELL_NOT_FOUND → 去 audit/list 定位）
- [x] 默认 dry-run，`--write` 显式落盘并返回 `{ backupPath, diffStat, diffText }`

### 质量与文档
- [x] bun test 22 个测试：保真不变量 / 只读模型 / 两个操作 / 守卫与备份 / CLI 全链路
- [x] `tsc --noEmit` 零错误（strict + noUncheckedIndexedAccess）
- [x] AGENTS.md（agent 标准工作流 + Windows 中文传参坑）/ README.md
- [x] 真实台账集成验证：识别漂移结构（主格 D3、数据行 2）、写回 diff 仅 1 增 1 删、dir/样式原样保留

---

## v2 —— 参数体系 + 体检扩充（✅ 2026-11-02 完成）

- [x] 采集真实参数序列化格式：**数据集级** `<Parameter><Attributes name/><O>CDATA` 已从 FR11 真实模板验证并做成 fixture；**经典** `<ReportParameter>` 全库样本均为表单式 UI 无实例 → 写操作按"不猜测"原则挂起（读取侧已支持）
- [x] `param-list`：按数据集列出绑定 + SQL `${param}` 引用与三种满足来源（经典注册/数据集绑定/表单控件名）对照
- [x] `param-set-default` / `param-remove`：数据集级参数绑定增删改（`<Parameters/>` 自闭合自动展开/收回），只动该数据集的 `<Parameters>` 区
- [x] 体检规则扩充：空 Query（无 Query 或 CDATA 为空）/ 组格过滤键列在被引数据集 SQL 中缺失 / 多个主扩展格 / 左父格自引用（死循环）
- [x] `cpt diff <a> <b>`：两文件统一 diff（行数统计 + 全文）
- [x] `cpt batch`：单文件多 op 事务式执行（JSON ops 文件，任一失败整体不落盘；touchesProtected 的 op 自动走 allow-protected）

## v3 —— 生成链路（✅ 2026-11-02 完成，全新模板首版专用）

- [x] `parseXlsx`：fflate 解压 + 正则直解 sharedStrings/sheet（命名空间免疫），支持 sheet 选择/合并区/inlineStr
- [x] `generateCpt`：列定义 → 完整 cpt（表头行/数据行/主格 dir=0/组列 MonoGrouper+过滤/公式列左父格/空白列），XS 组列强制显式 `filterColumn`
- [x] 生成产物自动过 audit（写回即回显 masterAddress/warnings）；`--confirm` 二次确认，默认 dry-run
- [x] `datasource/`：`ConnectionInfo` 类型与 `SqlPreviewer` 接口预留，零敏感信息

## v4 —— 按真实需求增长的 Operation（✅ 2026-11-02 完成，两项写操作因格式无样本挂起）

- [x] **MCP server**（`src/mcp/server.ts`，stdio）：全部注册 Operation 自动映射为 tool（JSON Schema 直传），握手与 tools/list 已测；写操作语义与 CLI 一致（默认 dry-run）
- [x] `col-insert` / `col-remove`：列结构变更（格偏移 + ColumnWidth 联动 + 跨插点合并列告警），声明 `touchesProtected` 自动走 allow-protected
- [x] 只读体检扩展：ReportPageAttr 快照（HR/FR/HC/FC）入 audit、`hasConditionAttr` 逐格标记、`conditionAttrCount` 汇总
- [ ] 条件属性（ConditionAttr）**写**操作 —— 挂起：全库无单元格级序列化样本（现有样本均为图表属性），遵守不猜测原则；有真实 fixture 后补充
- [ ] 冻结/重复标题行（ReportPageAttr）**写**操作 —— 挂起：同因（只读快照已交付）
- [ ] 超链接/控件类操作 —— 挂起：同因

---

> 维护约定：勾选前必须有对应测试；v1 的「保真不变量」测试是所有后续功能的底线，任何改动先跑它。
