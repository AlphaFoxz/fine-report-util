/** cell-bind：调整指定单元格的数据绑定（不动该格样式引用与其余任何内容） */
import { findCellBlock, extractLeftParent, extractExpandDir, detectMasterAddress, replaceO, replaceExpand, colLetter } from "../core/surgery.ts";
import { parseSpec, specToO, specToExpand } from "../serializers/index.ts";
import type { CptDocument } from "../core/CptDocument.ts";
import type { OpResult } from "../core/types.ts";
import type { Operation } from "./types.ts";

export interface CellBindInput {
  col: number;
  row: number;
  /** 简写 spec 或结构化对象 */
  spec: string;
  /** group 格手动指定左父格；缺省自动保留原引用或探测主扩展格 */
  left?: string;
}

export const cellBind = {
  name: "cell-bind",
  description:
    "调整指定单元格的数据绑定（ds=普通跟随格 / master=主扩展格 / group=行不等明细组 / formula / text / blank）。" +
    "只替换该格 <C> 块内的 <O> 与 <Expand>，样式引用(s=)与合并属性原样保留。",
  inputSchema: {
    type: "object",
    properties: {
      col: { type: "integer", description: "0-based 列号" },
      row: { type: "integer", description: "XML r 值（0-based 行号）" },
      spec: {
        type: "string",
        description:
          "ds:数据集:字段 | master:数据集:字段 | group:数据集:字段:NM|XS | formula:表达式 | text:文字 | blank",
      },
      left: { type: "string", description: "可选：手动左父格地址（如 C2）" },
    },
    required: ["col", "row", "spec"],
  },
  examples: [
    `cell set 台账.cpt --c 27 --r 2 --spec "group:付款发票:INVOICE_NO:NM"`,
    `cell set 台账.cpt --c 2 --r 2 --spec "master:台账:NM_CODE"`,
  ],
  apply(doc: CptDocument, input: CellBindInput): OpResult {
    const found = findCellBlock(doc.raw, input.col, input.row);
    if (!found) {
      throw Object.assign(
        new Error(`cell not found: c=${input.col} r=${input.row}`),
        {
          code: "CELL_NOT_FOUND",
          hint: "先用 `cpt audit` / `cpt list` 定位真实行列——用户可能插过行，数据行不一定是 r=1",
        },
      );
    }
    const spec = parseSpec(input.spec);
    const oldLeft = extractLeftParent(found.block);
    const oldDir = extractExpandDir(found.block);
    const o = specToO(spec);
    let left: string | undefined;
    if (spec.type === "group") {
      left = input.left ?? oldLeft ?? detectMasterAddress(doc.raw);
    } else if (spec.type !== "master") {
      left = input.left ?? oldLeft;
    }
    const expandXml = specToExpand(spec, left, oldDir);

    let newBlock = replaceO(found.block, o);
    newBlock = replaceExpand(newBlock, expandXml);
    if (newBlock === found.block) {
      return { ok: true, op: this.name, summary: "no change (already bound as specified)", next: "无需写盘" };
    }
    doc.applySpanEdit({
      start: found.start,
      end: found.end,
      replacement: newBlock,
      description: `rebind cell ${colLetter(input.col)}${input.row + 1} -> ${input.spec}`,
    });
    return {
      ok: true,
      op: this.name,
      summary:
        `cell ${colLetter(input.col)}${input.row + 1} rebound to ${input.spec}` +
        (left ? ` (left parent: ${left})` : ""),
      detail: { before: found.block, after: newBlock },
      next: "预览 diff 后 save({ backup: true })；再用 diff 验证只有该格变化",
    };
  },
} satisfies Operation<CellBindInput>;
