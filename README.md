# fine-report-util

维护 FineReport `.cpt` 模板的 TypeScript 库 + CLI（Bun）。
定位：**更好地维护一个 cpt** —— 手术式增量编辑、格式保真、AI agent 友好。与具体业务解耦。

## 设计要点

- **手术式编辑**：从不整体解析再序列化。所有修改都是原文上的精确文本替换，
  未触碰区域保证逐字节不变（round-trip 测试锁死）。
- **格式保护区**：StyleList / 行高列宽 / 页面设置 / 单元格样式引用与合并属性被列为保护区，
  `save` 默认 strict 守卫，误触即拒绝。
- **安全写入**：默认 dry-run；`--write` 自动备份 + XML 校验 + diff 报告。
- **敏感信息零内置**：库只处理 XML 文本，不包含任何数据库连接；
  数据连接名由调用方在生成场景显式传入。
- **agent 友好**：全命令 `--json` 结构化输出（`--ascii` 转义防控制台乱码）、
  错误带 `code + hint`、`cpt ops` 能力自描述、`cpt audit` 状态体检优先。

## 使用

```bash
bun cpt audit 台账.cpt --json --ascii     # 体检
bun cpt list  台账.cpt --row 2 --json     # 逐格绑定
bun cpt cell set 台账.cpt --c 27 --r 2 --spec "group:付款发票:INVOICE_NO:NM" --write
bun cpt sql set  台账.cpt --ds 台账 --file new.sql --write
bun cpt ops                               # 能力自描述
```

### 远程模板拉取（remote）

把远程服务器（设计器「远程连接」的那个）上的模板批量同步到本地目录，同名覆盖：

```bash
bun cpt remote envs                                     # 列出设计器里保存的远程连接
bun cpt remote pull --target D:/backup/reportlets       # 全量拉取（默认 reportlets 根、*.cpt）
bun cpt remote pull --target D:/dir --prefix reportlets/TRRPZJ0002 --ext cpt,fvs
bun cpt remote pull --target D:/dir --prefix reportlets/TRRPZJ0002 --strip 1 --prune
#                        --strip N：剥掉 N 级目录再落地；--prune：镜像同步（删除服务器没有的本地文件，慎用）
```

原理：调用 `java/FrPull.java` 的预编译产物（`java/precompiled/FrPull.class`，Java 8 字节码），
复用设计器自带的远程工作空间 RPC 通道（`FineWorkspaceConnector` → `WorkResource.list/readFully`），
密码用设计器配置里的加密态密文，由 FR 自己的 `SecurityToolbox.defaultDecrypt` 解密，本库不接触明文。
环境配置从 `%USERPROFILE%/.FineReport*/FineReportEnv.xml` 读取（设计器需勾选记住密码）。
依赖：**FineReport 安装目录**（`--fr-home`，默认 `FINE_REPORT_HOME` 环境变量或 `D:\FineReport_11.0`，
运行时直接用其自带的 `jre/`，无需独立 JDK）；只有当 `FrPull.java` 源码更新且预编译 class 过期时
才需要 javac 重新编译（自动探测 `JAVA_HOME`，`--release 8` 输出到 `java/precompiled/`）。

编程 API：

```ts
import { pullTemplates } from "./src/index.ts";
const r = await pullTemplates({ target: "D:/backup/reportlets", prefix: "reportlets", quiet: true });
r.files; r.bytes; r.errors;
```

编程 API：

```ts
import { CptDocument } from "./src/index.ts";
const doc = await CptDocument.load("台账.cpt");
doc.model.masterAddress; // 主扩展格，如 "C2"
doc.model.dataRow;       // 数据行
// 走 ops 修改 → await doc.save({ backup: true })
```

详细工作流与坑清单见 [AGENTS.md](./AGENTS.md)。

## 开发

```bash
bun install
bun test        # 21 个测试：保真不变量/模型/操作/守卫/CLI
bun x tsc --noEmit
```

## Roadmap

见 [ROADMAP.md](./ROADMAP.md)——v1（核心底座）已完成，v2 参数体系、v3 生成链路、v4 Operation 扩展与 MCP 化的规划与勾选状态都在那里。
