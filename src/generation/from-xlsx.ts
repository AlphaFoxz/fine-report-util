/**
 * xlsx 样表解析（v3）：从业务给的样表提取表头与合并信息，产出列定义。
 * 移植自实战验证过的 DumpXlsx.ps1 逻辑：
 * - 用正则直解 sharedStrings.xml / sheet XML（不要用通用 XML→对象适配器，
 *   命名空间会让所有 t="s" 单元格解析成同一个值）
 * - 只支持单 sheet 样表场景（台账样表的典型形态），多 sheet 取第一个可见表
 */
import { readFileSync } from "node:fs";
import { unzipSync, strFromU8 } from "fflate";
import { colNumber } from "../core/surgery.ts";

export interface XlsxCell {
  col: number;
  row: number;
  text: string;
}

export interface XlsxGrid {
  /** 解析的 sheet 名 */
  sheetName: string;
  cells: XlsxCell[];
  /** 合并区域列表，如 "A2:A3" */
  merges: string[];
  /** 取第 headerRow 行（1-based）为表头，按列顺序给出 { 列号, 表头文字 } */
  headers(headerRow?: number): { col: number; text: string }[];
}

function unescape(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

export function parseXlsx(filePath: string, opts: { sheet?: string } = {}): XlsxGrid {
  const zip = unzipSync(new Uint8Array(readFileSync(filePath)));
  const must = (u8: Uint8Array | undefined, name: string): Uint8Array => {
    if (!u8) throw new Error(`missing entry in xlsx: ${name}`);
    return u8;
  };

  // ---- workbook.xml：sheet 名 → rId → 文件名 ----
  const wb = strFromU8(must(zip["xl/workbook.xml"], "xl/workbook.xml"));
  const sheetEntries = [...wb.matchAll(/<sheet name="([^"]+)"[^>]*r:id="(rId\d+)"/g)].map((m) => ({
    name: unescape(m[1] ?? ""),
    rId: m[2] ?? "",
  }));
  const rels = strFromU8(must(zip["xl/_rels/workbook.xml.rels"], "xl/_rels/workbook.xml.rels"));
  const ridToFile = new Map<string, string>();
  for (const m of rels.matchAll(/<Relationship Id="(rId\d+)"[^>]*Target="([^"]+)"/g)) {
    ridToFile.set(m[1] ?? "", (m[2] ?? "").replace(/^\//, ""));
  }
  const chosen =
    (opts.sheet ? sheetEntries.find((s) => s.name === opts.sheet) : undefined) ??
    sheetEntries.find((s) => !/state="hidden"/.test(wb.slice(wb.indexOf(`name="${s.name}"`), wb.indexOf(`name="${s.name}"`) + 200))) ??
    sheetEntries[0];
  if (!chosen) throw new Error("no sheet found in workbook");
  const sheetPath = "xl/" + (ridToFile.get(chosen.rId) ?? `worksheets/sheet1.xml`);

  // ---- sharedStrings（正则直解，避免 XML 适配器命名空间问题）----
  const ssRaw = strFromU8(must(zip["xl/sharedStrings.xml"], "xl/sharedStrings.xml"));
  const strings: string[] = [];
  for (const m of ssRaw.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    const ts = [...(m[1] ?? "").matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => unescape(t[1] ?? ""));
    strings.push(ts.join(""));
  }

  // ---- sheet cells ----
  const shRaw = strFromU8(must(zip[sheetPath], sheetPath));
  const cells: XlsxCell[] = [];
  for (const rm of shRaw.matchAll(/<row r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
    const row = Number(rm[1]);
    for (const cm of (rm[2] ?? "").matchAll(/<c r="([A-Z]+)(\d+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const colLetters = cm[1] ?? "";
      const attrs = cm[3] ?? "";
      const inner = cm[4] ?? "";
      const tAttr = /t="([^"]+)"/.exec(attrs)?.[1] ?? "";
      let v = "";
      const vm = /<v[^>]*>([\s\S]*?)<\/v>/.exec(inner);
      if (tAttr === "s" && vm) v = strings[Number(vm[1] ?? "0")] ?? "";
      else if (tAttr === "inlineStr") {
        v = [...inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => unescape(t[1] ?? "")).join("");
      } else if (vm) v = unescape(vm[1] ?? "");
      if (v !== "") cells.push({ col: colNumber(colLetters), row, text: v });
    }
  }

  // ---- merges ----
  const merges = [...shRaw.matchAll(/<mergeCell ref="([A-Z]+\d+:[A-Z]+\d+)"/g)].map((m) => m[1] ?? "");

  return {
    sheetName: chosen.name,
    cells,
    merges,
    headers(headerRow = 1) {
      return cells
        .filter((c) => c.row === headerRow)
        .sort((a, b) => a.col - b.col)
        .map((c) => ({ col: c.col, text: c.text }));
    },
  };
}
