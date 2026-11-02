# AGENTS.md — AI agent 使用须知

本库用于**维护 FineReport .cpt 模板**。第一铁律：**不破坏用户在设计器里积累的格式**。

## 标准工作流（任何修改都按这个顺序）

```
1. audit   → bun cpt audit <file> --json --ascii
   （拿到主扩展格地址、数据行号、数据集清单、告警 —— 行号会漂移，永远别猜）
2. 定位    → bun cpt list <file> --row <数据行> --json --ascii
3. dry-run → 修改类命令不加 --write 先跑，检查返回 JSON 里的 diff
4. 写回    → 加 --write（自动备份 <name>-bak-<时间戳>.cpt）
5. 验证    → 对比备份与现文件，确认只有目标块变化；XML 校验通过
```

## 保护区（strict 模式下改了就报错）

StyleList、RowHeight、ColumnWidth、ReportPageAttr、PaperSetting、每个 `<C>` 开标签上的
`s="N"` 样式引用与 rs/cs 合并属性。**这些是用户的手工格式资产。**
确实要动：`save({ guard: "allow-protected" })` 显式越权，结果里会记录违规。

## 命令速查

```
bun cpt audit <file> [--json] [--ascii]     # 体检：主格/数据行/数据集/参数三来源/页面属性/告警
bun cpt list  <file> [--row N] [--json]     # 逐格绑定清单（含条件属性标记）
bun cpt diff  <a.cpt> <b.cpt>               # 两文件结构化对比
bun cpt cell set <file> --c N --r N --spec SPEC [--left ADDR] [--write]
bun cpt sql set  <file> --ds NAME (--sql S | --file F) [--write]
bun cpt param list <file> [--ds NAME] [--json]
bun cpt param set-default <file> --ds NAME --name P --value V [--write]
bun cpt param remove <file> --ds NAME --name P [--write]
bun cpt col insert <file> --at N [--count N] [--header 文字] [--width N] [--write]
bun cpt col remove <file> --at N [--count N] [--write]
bun cpt batch <file> --file ops.json [--write]   # 多 op 事务式
bun cpt gen --from spec.json [--confirm]         # 全新模板首版（高危）
bun cpt ops / explain <op>                       # 能力自描述（JSON Schema）
```

MCP：`bun run src/mcp/server.ts`（stdio）——全部 Operation 自动映射为 tool，语义与 CLI 一致。

spec 语法：
- `ds:数据集:字段` —— 普通跟随格（分组语义）
- `master:数据集:字段` —— 主扩展格（纵向扩展）
- `group:数据集:字段:NM|XS` —— 行不等明细组（MonoGrouper + 跨数据集过滤；
  NM→过滤键 NM_CODE，XS→XS_CODE；左父格自动保留/自动探测主格）
- `formula:=表达式` / `text:文字` / `blank`

## Windows 中文坑（agent 必读）

1. **中文路径/参数经控制台传给子进程可能 GBK 乱码**。稳妥做法：
   把文件复制成 ASCII 临时名（`work.cpt`）再操作，完成后复制回原位；
   含中文的参数（数据集名、spec）优先写一个小的 .ts 驱动脚本用库 API（源码 UTF-8 无此问题）。
2. CLI 输出加 `--ascii` 可把 JSON 里非 ASCII 转义成 \uXXXX，控制台不乱码。
3. 控制台显示乱码 ≠ 文件内容坏 —— 以 --ascii JSON 或直接读文件为准。

## 库的保证（tests/ 里有测试锁死）

- load → 不操作 → save：与原文 byte-identical
- 每个操作只改目标 span；保护区守卫 strict 默认开启
- 写回自动 XML 校验 + 自动备份

## 开发与验证

```
bun install
bun test                      # 全量（保真不变量/模型/操作/守卫/CLI/MCP）
bun test tests/ops.test.ts    # 单个测试文件；bun test -t <名称> 过滤单条
bun x tsc --noEmit            # 类型检查（改完必跑）
```

## 扩展

新功能 = 在 `src/ops/` 加一个 Operation（name/description/inputSchema/examples/apply）
并到 `registry.ts` 注册，CLI 自动获得分发。参考 `cell-bind.ts`。
