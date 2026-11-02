/**
 * 列插入/删除（v4）。纯结构操作，涉及三类联动：
 * 1. 所有受影响格的 c 偏移（含表头行与数据行）
 * 2. ColumnWidth 列表插入/删除对应项（保护区）
 * 3. 跨插入点的合并列（cs）→ 信息性告警，需人工在设计器确认
 *
 * 新格不带样式引用（<C c r> 无 s 属性），格式由用户在设计器里刷。
 * 保存时走 allow-protected（op 元数据 touchesProtected: true，调用方据此传入）。
 */
import type { CptDocument } from "../core/CptDocument.ts";
import type { OpResult } from "../core/types.ts";
import type { Operation } from "./types.ts";

const CELL_RE = /<C c="(\d+)" r="(\d+)"([^>]*)>([\s\S]*?)<\/C>/g;

export interface ColInsertInput {
  /** 插入位置（0-based；新列占据 c = at .. at+count-1） */
  at: number;
  count?: number;
  /** 表头文字（仅表头行 r=0 填入），多列逗号分隔 */
  header?: string;
  /** 新列列宽（EMU，默认 2743200） */
  width?: number;
}

export interface ColRemoveInput {
  at: number;
  count?: number;
}

function spliceColumnWidth(xml: string, at: number, count: number, width: number): string {
  const m = /<ColumnWidth defaultValue="(\d+)">\s*<!\[CDATA\[([^\]]*)\]\]><\/ColumnWidth>/.exec(xml);
  if (!m) return xml;
  const defaultW = m[1] ?? "2743200";
  const listRaw = m[2] ?? "";
  const list = listRaw.trim() === "" ? [] : listRaw.split(",").map((s) => s.trim());
  if (count > 0) list.splice(at, 0, ...Array.from({ length: count }, () => String(width)));
  else list.splice(at, -count);
  const replacement = `<ColumnWidth defaultValue="${defaultW}">\n<![CDATA[${list.join(",")}]]></ColumnWidth>`;
  const full = m[0] ?? "";
  return xml.slice(0, m.index) + replacement + xml.slice(m.index + full.length);
}

export const colInsert = {
  name: "col-insert",
  touchesProtected: true,
  description:
    "在第 at 列前插入新列（0-based）：后续格右移、ColumnWidth 插入宽度、每个已存在行补空格、" +
    "表头行(r=0)填 header。触碰保护区，保存须 allow-protected。新格不带样式，格式由用户设计器刷。",
  inputSchema: {
    type: "object",
    properties: {
      at: { type: "integer", description: "插入位置（0-based）" },
      count: { type: "integer", description: "插入列数，默认 1" },
      header: { type: "string", description: "表头文字，多列逗号分隔" },
      width: { type: "integer", description: "列宽 EMU，默认 2743200" },
    },
    required: ["at"],
  },
  examples: [`col insert 台账.cpt --at 5 --header "新备注列" --write --allow-protected`],
  apply(doc: CptDocument, input: ColInsertInput): OpResult {
    const at = input.at;
    const count = input.count ?? 1;
    const width = input.width ?? 2743200;
    if (count < 1) throw Object.assign(new Error("count must be >= 1"), { code: "USAGE" });
    const raw = doc.raw;

    const cells = [...raw.matchAll(CELL_RE)].map((m) => ({
      col: Number(m[1]),
      row: Number(m[2]),
      attrs: m[3] ?? "",
      body: m[4] ?? "",
      start: m.index,
      end: m.index + m[0].length,
    }));

    // 1. 变换：从后往前替换（避免位置失效）
    //    - col >= at：右移 count
    //    - 每行补 count 个新空格（新格集合单独收集）
    let out = raw;
    const newCells: { row: number; col: number; text: string }[] = [];
    const rowsPresent = [...new Set(cells.map((c) => c.row))].sort((a, b) => a - b);
    for (const cell of cells.slice().sort((a, b) => b.start - a.start)) {
      if (cell.col >= at) {
        const shifted =
          `<C c="${cell.col + count}" r="${cell.row}"${cell.attrs}>${cell.body}</C>`;
        out = out.slice(0, cell.start) + shifted + out.slice(cell.end);
      }
    }
    const headers = (input.header ?? "").split(",").map((s) => s.trim());
    for (const r of rowsPresent) {
      for (let i = 0; i < count; i++) {
        const c = at + i;
        if (r === 0 && headers[i]) {
          newCells.push({
            row: r,
            col: c,
            text: `<C c="${c}" r="${r}">\n<O>\n<![CDATA[${headers[i]}]]></O>\n<PrivilegeControl/>\n<Expand/>\n</C>`,
          });
        } else {
          newCells.push({
            row: r,
            col: c,
            text: `<C c="${c}" r="${r}">\n<PrivilegeControl/>\n<Expand/>\n</C>`,
          });
        }
      }
    }

    // 2. 插入新格：跟在该行右移后 c=at+count-1.. 的首个格之前；
    //    锚定不到（at=0 或行内无更右格）→ 统一放 CellElementList 开头
    const listStart = out.indexOf("<CellElementList>") + "<CellElementList>".length;
    const anchors: { pos: number; texts: string[] }[] = [];
    for (const r of rowsPresent) {
      const first = [...out.matchAll(/<C c="(\d+)" r="(\d+)"/g)]
        .filter((m) => Number(m[2]) === r && Number(m[1]) >= at)
        .sort((a, b) => Number(a[1]) - Number(b[1]))[0];
      const texts = newCells.filter((n) => n.row === r).sort((a, b) => a.col - b.col).map((n) => n.text);
      if (first) anchors.push({ pos: first.index, texts });
    }
    const orphanTexts = newCells
      .filter((n) => !rowsPresent.includes(n.row))
      .sort((a, b) => a.row - b.row || a.col - b.col)
      .map((n) => n.text);
    // 行锚点从后往前插
    for (const a of anchors.sort((x, y) => y.pos - x.pos)) {
      out = out.slice(0, a.pos) + a.texts.map((t) => t + "\n").join("") + out.slice(a.pos);
    }
    if (orphanTexts.length > 0) {
      out = out.slice(0, listStart) + "\n" + orphanTexts.map((t) => t + "\n").join("") + out.slice(listStart);
    }

    // 3. ColumnWidth 插入
    out = spliceColumnWidth(out, at, count, width);

    // 4. 跨插入点的合并列告警
    const spanWarnings: string[] = [];
    for (const m of out.matchAll(/<C c="(\d+)" r="\d+"[^>]*\bcs="(\d+)"/g)) {
      const c = Number(m[1]);
      const cs = Number(m[2]);
      if (c < at && c + cs > at) {
        spanWarnings.push(`cell c=${c} has cs=${cs} spanning insert point at=${at} — 需在设计器人工调整`);
      }
    }

    doc.applySpanEdit({
      start: 0,
      end: raw.length,
      replacement: out,
      description: `insert ${count} column(s) at ${at}`,
    });
    return {
      ok: true,
      op: this.name,
      summary: `inserted ${count} column(s) at ${at}; ${spanWarnings.length} span warning(s); ${newCells.length} new cell(s)`,
      detail: { spanWarnings },
      next: "保存走 allow-protected；在设计器里刷新列格式、核对表头",
    };
  },
} satisfies Operation<ColInsertInput>;

export const colRemove = {
  name: "col-remove",
  touchesProtected: true,
  description:
    "删除第 at 列起 count 列（0-based）：区间内格删除、后续格左移、ColumnWidth 移除对应项。触碰保护区。",
  inputSchema: {
    type: "object",
    properties: {
      at: { type: "integer", description: "删除起始列（0-based）" },
      count: { type: "integer", description: "删除列数，默认 1" },
    },
    required: ["at"],
  },
  examples: [`col remove 台账.cpt --at 5 --write --allow-protected`],
  apply(doc: CptDocument, input: ColRemoveInput): OpResult {
    const at = input.at;
    const count = input.count ?? 1;
    const raw = doc.raw;

    const cells = [...raw.matchAll(CELL_RE)].map((m) => ({
      col: Number(m[1]),
      start: m.index,
      end: m.index + m[0].length,
      block: m[0],
    }));

    let out = raw;
    let removedCount = 0;
    for (const cell of cells.sort((a, b) => b.start - a.start)) {
      if (cell.col >= at && cell.col < at + count) {
        removedCount++;
        out = out.slice(0, cell.start) + out.slice(cell.end);
      } else if (cell.col >= at + count) {
        out =
          out.slice(0, cell.start) +
          cell.block.replace(/^<C c="\d+"/, `<C c="${cell.col - count}"`) +
          out.slice(cell.end);
      }
    }

    out = spliceColumnWidth(out, at, -count, 2743200);

    doc.applySpanEdit({
      start: 0,
      end: raw.length,
      replacement: out,
      description: `remove ${count} column(s) at ${at}`,
    });
    return {
      ok: true,
      op: this.name,
      summary: `removed ${count} column(s) at ${at}; ${removedCount} cell(s) deleted`,
      next: "保存走 allow-protected；确认没有左父格/过滤引用指向被删列",
    };
  },
} satisfies Operation<ColRemoveInput>;
