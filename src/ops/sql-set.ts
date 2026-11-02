/** sql-set：替换指定数据集的查询 SQL（不动连接与其他任何内容） */
import { findDatasetBlock, replaceQuery, assertCdataSafe } from "../core/surgery.ts";
import type { CptDocument } from "../core/CptDocument.ts";
import type { OpResult } from "../core/types.ts";
import type { Operation } from "./types.ts";

export interface SqlSetInput {
  dataset: string;
  /** 新 SQL 文本；与 sqlFile 二选一 */
  sql?: string;
  /** 从 UTF-8 文件读 SQL（推荐长 SQL 用；自动剥离 PowerShell 可能加的 BOM） */
  sqlFile?: string;
}

export const sqlSet: Operation<SqlSetInput> = {
  name: "sql-set",
  description: "替换指定数据集 <TableData> 的 <Query> SQL。连接、参数、其余内容不动。",
  inputSchema: {
    type: "object",
    properties: {
      dataset: { type: "string", description: "数据集名" },
      sql: { type: "string", description: "新 SQL 文本" },
      sqlFile: { type: "string", description: "SQL 文件路径（UTF-8）" },
    },
    required: ["dataset"],
  },
  examples: [`sql set 台账.cpt --ds 台账 --file new-sql.sql --write`],
  async apply(doc: CptDocument, input: SqlSetInput): Promise<OpResult> {
    let sql = input.sql ?? (input.sqlFile ? await readFileText(input.sqlFile) : "");
    if (!sql.trim()) throw Object.assign(new Error("empty sql"), { code: "EMPTY_SQL", hint: "传 sql 或 sqlFile" });
    sql = sql.replace(/\uFEFF/g, "").trim(); // PowerShell Set-Content UTF8 的 BOM 兜底
    assertCdataSafe(sql, `dataset ${input.dataset}`);

    const found = findDatasetBlock(doc.raw, input.dataset);
    if (!found) {
      throw Object.assign(
        new Error(`dataset not found: ${input.dataset}`),
        { code: "DATASET_NOT_FOUND", hint: "用 `cpt audit --json` 查看 datasets 清单确认名称" },
      );
    }
    const newBlock = replaceQuery(found.block, sql);
    if (newBlock === found.block) {
      return { ok: true, op: this.name, summary: "no change (SQL identical)" };
    }
    doc.applySpanEdit({
      start: found.start,
      end: found.end,
      replacement: newBlock,
      description: `update SQL of dataset "${input.dataset}"`,
    });
    return {
      ok: true,
      op: this.name,
      summary: `dataset "${input.dataset}" SQL replaced (${sql.length} chars)`,
      detail: { oldBlock: found.block, newBlock },
      next: "save 后建议在 FR 设计器里预览该数据集",
    };
  },
};

async function readFileText(p: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  return readFile(p, "utf8");
}
