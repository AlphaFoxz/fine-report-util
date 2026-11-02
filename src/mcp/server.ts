#!/usr/bin/env bun
/**
 * MCP server（v4）：把 fine-report-util 的 Operation 暴露为 MCP tools。
 *
 *   bun run src/mcp/server.ts            （stdio transport）
 *
 * 设计：低层 Server API + 原生 JSON Schema（直接复用 op.inputSchema，
 * 不引入 zod 依赖）。工具列表自动随注册表增长。
 * 安全语义与 CLI 一致：写操作默认 dry-run，input.write=true 才落盘（自动备份）。
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { CptDocument } from "../core/CptDocument.ts";
import { allOps, getOp } from "../ops/registry.ts";

const server = new Server(
  { name: "fine-report-util", version: "0.4.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "cpt_audit",
      description:
        "cpt 模板体检：主扩展格地址、数据行、数据集清单、参数缺失告警、格式问题。" +
        "任何修改前先调用它定位真实结构（行号会漂移）。",
      inputSchema: {
        type: "object",
        properties: { file: { type: "string", description: "cpt 文件绝对路径" } },
        required: ["file"],
      },
    },
    {
      name: "cpt_list",
      description: "逐格绑定清单（可按行过滤）。",
      inputSchema: {
        type: "object",
        properties: {
          file: { type: "string" },
          row: { type: "integer", description: "只看该行" },
        },
        required: ["file"],
      },
    },
    ...allOps().map((op) => ({
      name: "cpt_" + op.name.replace(/-/g, "_"),
      description:
        op.description +
        ` 默认 dry-run；input.write=true 落盘（自动备份）。示例: ${op.examples[0] ?? ""}`,
      inputSchema: {
        type: "object" as const,
        properties: {
          ...(op.inputSchema.properties ?? {}),
          file: { type: "string", description: "cpt 文件绝对路径" },
          write: { type: "boolean", description: "true=落盘（自动备份）；缺省 dry-run" },
        },
        required: [...(op.inputSchema.required ?? []), "file"],
      },
    })),
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params.name;
  const args = (request.params.arguments ?? {}) as Record<string, unknown>;

  try {
    // 内置只读工具
    if (name === "cpt_audit" || name === "cpt_list") {
      const doc = await CptDocument.load(String(args.file));
      if (name === "cpt_audit") {
        const m = doc.model;
        return textResult({
          masterAddress: m.masterAddress,
          dataRow: m.dataRow,
          datasets: m.datasets,
          params: m.params,
          pageAttr: m.pageAttr ? { hr: m.pageAttr.hr, fr: m.pageAttr.fr, hc: m.pageAttr.hc, fc: m.pageAttr.fc } : null,
          conditionAttrCount: m.conditionAttrCount,
          warnings: m.warnings,
        });
      }
      const row = args.row !== undefined ? Number(args.row) : undefined;
      return textResult(
        doc.model.cells
          .filter((c) => row === undefined || c.row === row)
          .map((c) => ({ address: `${c.col},${c.row}`, binding: c.binding, expand: c.expand, style: c.styleRef })),
      );
    }

    // 注册表 Operation
    const opName = name.replace(/^cpt_/, "").replace(/_/g, "-");
    const op = getOp(opName);
    if (!op) {
      return textError(`unknown tool: ${name}`);
    }
    const { file, write, ...rest } = args;
    const doc = await CptDocument.load(String(file));
    const result = await op.apply(doc, rest as never);
    let saved: unknown;
    if (write === true && doc.dirty) {
      const r = await doc.save({ backup: true, guard: "strict" });
      saved = {
        path: r.path,
        backupPath: r.backupPath,
        diffStat: r.diffStat,
        protectedViolations: r.protectedViolations,
      };
    }
    return textResult({ ...result, saved });
  } catch (err) {
    const e = err as Error & { code?: string; hint?: string };
    return textError(e.message, e.code, e.hint);
  }
});

function textResult(value: unknown) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
}

function textError(message: string, code?: string, hint?: string) {
  return {
    content: [{ type: "text", text: JSON.stringify({ ok: false, code: code ?? "ERROR", message, hint }) }],
    isError: true,
  };
}

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("fine-report-util MCP server ready (stdio)");
