/**
 * row-append：在最后一个已存在行之后追加静态文本行（如台账底部备注行）。
 *
 * 设计约束：
 * - 新行 r = max(现有 r) + 1，只追加不移动任何现有格——静态行位于数据扩展带
 *   下方，FR 会随数据展开整体下移，无需特殊处理。
 * - 不触碰 RowHeight/ColumnWidth/StyleList（保护区零改动）：新行行号超出
 *   RowHeight CDATA 条目数时 FR 自动使用 defaultValue 行高，因此无需编辑该列表。
 * - 新格不带样式引用（s 属性缺省），格式由用户在设计器里刷。
 */
import { assertCdataSafe } from "../core/surgery.ts";
import type { CptDocument } from "../core/CptDocument.ts";
import type { OpResult } from "../core/types.ts";
import type { Operation } from "./types.ts";
import { readFile } from "node:fs/promises";

export interface RowCellInput {
  /** 0-based 列号 */
  c: number;
  /** 文本内容（CDATA 安全自动断言） */
  text: string;
}

export interface RowAppendInput {
  /** 格数组；与 cellsFile 二选一（推荐文件传中文，UTF-8） */
  cells?: RowCellInput[];
  /** JSON 文件路径（内容为 RowCellInput[]） */
  cellsFile?: string;
}

export const rowAppend: Operation<RowAppendInput> = {
  name: "row-append",
  description:
    "在最后一个已存在行之后追加一行静态文本格（如底部备注行）。" +
    "只追加不移动现有格；不触碰 RowHeight（超出条目数自动用默认行高）与样式表。",
  inputSchema: {
    type: "object",
    properties: {
      cells: {
        type: "array",
        description: "格数组 [{c:列号, text:文字}]",
        items: {
          type: "object",
          properties: { c: { type: "integer" }, text: { type: "string" } },
          required: ["c", "text"],
        },
      },
      cellsFile: { type: "string", description: "JSON 文件路径（UTF-8，内容同 cells）" },
    },
  },
  examples: [
    `row append 台账.cpt --file remark.json --write`,
    `row append 台账.cpt --cells '[{"c":0,"text":"备注"},{"c":41,"text":"结算单金额-实际付款总额"}]' --write`,
  ],
  async apply(doc: CptDocument, input: RowAppendInput): Promise<OpResult> {
    let items = input.cells;
    if (!items && input.cellsFile) {
      const raw = (await readFile(input.cellsFile, "utf8")).replace(/\uFEFF/g, "");
      items = JSON.parse(raw) as RowCellInput[];
    }
    if (!items || items.length === 0) {
      throw Object.assign(new Error("empty cells"), { code: "EMPTY_CELLS", hint: "传 cells 或 cellsFile" });
    }
    for (const it of items) {
      if (!Number.isInteger(it.c) || it.c < 0) {
        throw Object.assign(new Error(`bad column: ${JSON.stringify(it)}`), { code: "USAGE" });
      }
      assertCdataSafe(it.text ?? "", `row-append c=${it.c}`);
    }

    const raw = doc.raw;
    let maxR = -1;
    for (const m of raw.matchAll(/<C c="\d+" r="(\d+)"/g)) {
      const r = Number(m[1]);
      if (r > maxR) maxR = r;
    }
    const newR = maxR + 1;
    const xml = items
      .slice()
      .sort((a, b) => a.c - b.c)
      .map(
        ({ c, text }) =>
          `<C c="${c}" r="${newR}">\n<O>\n<![CDATA[${text}]]></O>\n<PrivilegeControl/>\n<Expand/>\n</C>`,
      )
      .join("\n") + "\n";

    const closeIdx = raw.lastIndexOf("</CellElementList>");
    if (closeIdx < 0) throw Object.assign(new Error("CellElementList not found"), { code: "MALFORMED" });

    doc.applySpanEdit({
      start: closeIdx,
      end: closeIdx,
      replacement: xml,
      description: `append row ${newR} with ${items.length} static cell(s)`,
    });

    return {
      ok: true,
      op: this.name,
      summary:
        `appended ${items.length} static cell(s) at r=${newR}（表行 ${newR + 1}，数据行 max=${maxR}）；` +
        `RowHeight/样式未触碰——新行用默认行高，样式请在设计器里刷`,
      next: "save 后在设计器里核对备注行位置（会随数据展开整体下移）与字体",
    };
  },
} satisfies Operation<RowAppendInput>;
