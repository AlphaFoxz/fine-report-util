/**
 * 保护区：用户在设计器里积累的格式资产。
 *
 * 「格式保护铁律」的代码化——save(guard: "strict") 时，任何对下列区域的
 * 修改都会被拒绝（显式 allow-protected 才放行）：
 * - <StyleList>            样式表
 * - <RowHeight>/<ColumnWidth>  行高列宽
 * - <ReportPageAttr>       冻结/重复标题行
 * - <PaperSetting>         页面设置
 * - 每个 <C ...> 开标签     样式引用 s="N" 与合并属性 rs/cs
 */

export const PROTECTED_REGIONS = [
  "StyleList",
  "RowHeight",
  "ColumnWidth",
  "ReportPageAttr",
  "PaperSetting",
  "ReportWebAttr",
] as const;

export type ProtectedRegionName = (typeof PROTECTED_REGIONS)[number];

export interface ProtectedSpan {
  name: string;
  text: string;
}

/** 提取原文中所有保护区内容（按出现顺序） */
export function extractProtectedSpans(raw: string): ProtectedSpan[] {
  const spans: ProtectedSpan[] = [];
  for (const name of PROTECTED_REGIONS) {
    const re = new RegExp(`<${name}(?:\\s[^>]*)?>[\\s\\S]*?</${name}>|<${name}(?:\\s[^>]*)?/>`, "g");
    for (const m of raw.matchAll(re)) {
      spans.push({ name, text: m[0] });
    }
  }
  // 所有单元格开标签（样式引用 + 合并属性都在这里）
  for (const m of raw.matchAll(/<C c="\d+" r="\d+"[^>]*>/g)) {
    spans.push({ name: "CellOpenTag", text: m[0] });
  }
  return spans;
}

/** 对比两版的保护区，返回被改动的区域（空数组 = 格式资产完好） */
export function protectedViolations(
  before: string,
  after: string,
): { region: string; detail: string }[] {
  const a = extractProtectedSpans(before);
  const b = extractProtectedSpans(after);
  const out: { region: string; detail: string }[] = [];

  const keyOf = (s: ProtectedSpan) => `${s.name}#${s.text}`;
  const beforeKeys = new Map<string, number>();
  for (const s of a) beforeKeys.set(keyOf(s), (beforeKeys.get(keyOf(s)) ?? 0) + 1);
  const afterKeys = new Map<string, number>();
  for (const s of b) afterKeys.set(keyOf(s), (afterKeys.get(keyOf(s)) ?? 0) + 1);

  // 消失或减少的
  for (const [key, count] of beforeKeys) {
    const region = key.slice(0, key.indexOf("#"));
    const newCount = afterKeys.get(key) ?? 0;
    if (newCount < count) {
      out.push({
        region,
        detail: `protected region content changed/removed (occurrences ${count} -> ${newCount})`,
      });
    }
  }
  // 新增的
  for (const [key, count] of afterKeys) {
    const region = key.slice(0, key.indexOf("#"));
    const oldCount = beforeKeys.get(key) ?? 0;
    if (oldCount < count) {
      out.push({
        region,
        detail: `protected region content added/changed (occurrences ${oldCount} -> ${count})`,
      });
    }
  }
  return out;
}
