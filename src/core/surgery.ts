/**
 * 手术层：在原始 cpt 文本上定位与替换单元格/数据集块。
 *
 * 原则：
 * - cpt 从不被整体解析再序列化——所有编辑都是原文上的区间替换，
 *   未触碰区域保证 byte-identical。
 * - 块定位依赖 FR .cpt 的结构约定：<C> 不嵌套、<TableData> 不嵌套。
 */

/** 定位一个单元格块 `<C c="X" r="Y" ...>...</C>`，返回 [start, end) */
export function findCellBlock(
  raw: string,
  col: number,
  row: number,
): { start: number; end: number; block: string } | undefined {
  const re = new RegExp(
    `<C c="${col}" r="${row}"(?=[ />])[^>]*>[\\s\\S]*?</C>`,
  );
  const m = re.exec(raw);
  if (!m) return undefined;
  return { start: m.index, end: m.index + m[0].length, block: m[0] };
}

/** 定位某数据集块 `<TableData name="X" ...>...</TableData>` */
export function findDatasetBlock(
  raw: string,
  name: string,
): { start: number; end: number; block: string } | undefined {
  const re = new RegExp(
    `<TableData name="${escapeRe(name)}"[^>]*>[\\s\\S]*?</TableData>`,
  );
  const m = re.exec(raw);
  if (!m) return undefined;
  return { start: m.index, end: m.index + m[0].length, block: m[0] };
}

/** 在单元格块内提取左父格引用（leftParentDefault="false" left="X"） */
export function extractLeftParent(block: string): string | undefined {
  const m = /leftParentDefault="false"\s+left="([^"]+)"/.exec(block);
  return m?.[1];
}

/** 在单元格块内提取扩展方向 dir（"0"=纵向） */
export function extractExpandDir(block: string): string | undefined {
  const m = /<Expand([^>]*)/.exec(block);
  if (!m) return undefined;
  return /dir="([^"]+)"/.exec(m[1] ?? "")?.[1];
}

/**
 * 替换块内的 <O>...</O>（或自闭合），不存在且 replacement 非空时插入到开标签后。
 * 返回新块文本。
 */
export function replaceO(block: string, replacement: string | null): string {
  const re = /<O(?:\s[^>]*)?>[\s\S]*?<\/O>|<O(?:\s[^>]*)?\/>/;
  const m = re.exec(block);
  if (m) {
    return block.slice(0, m.index) + (replacement ?? "") + block.slice(m.index + m[0].length);
  }
  if (replacement == null) return block;
  const gt = block.indexOf(">");
  if (gt < 0) throw new Error("cell block malformed: no '>' in open tag");
  return block.slice(0, gt + 1) + "\n" + replacement + block.slice(gt + 1);
}

/**
 * 替换块内的 <Expand.../> 或 <Expand>...</Expand>；不存在时插到 </C> 前。
 */
export function replaceExpand(block: string, replacement: string): string {
  const re = /<Expand(?:\s[^>]*)?\/>|<Expand(?:\s[^>]*)?>[\s\S]*?<\/Expand>/;
  const m = re.exec(block);
  if (m) {
    return block.slice(0, m.index) + replacement + block.slice(m.index + m[0].length);
  }
  return block.replace(/<\/C>\s*$/, replacement + "\n</C>");
}

/** 替换数据集块内的 <Query> CDATA 内容 */
export function replaceQuery(block: string, sql: string): string {
  const re = /<Query>\s*<!\[CDATA\[[\s\S]*?\]\]><\/Query>/;
  const m = re.exec(block);
  if (!m) throw new Error("dataset block has no <Query> CDATA section");
  return block.slice(0, m.index) + `<Query>\n<![CDATA[${sql}]]></Query>` + block.slice(m.index + m[0].length);
}

/** CDATA 安全断言：内容里不允许出现序列结束符 */
export function assertCdataSafe(text: string, where: string): void {
  if (text.includes("]]>")) {
    throw new Error(`CDATA violation in ${where}: content contains ']]>'`);
  }
}

/** 数字 → FR 列字母（0-based: 0→A, 25→Z, 26→AA） */
export function colLetter(col: number): string {
  let n = col + 1;
  let s = "";
  while (n > 0) {
    n--;
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26);
  }
  return s;
}

/** FR 列字母 → 数字（A→0） */
export function colNumber(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** 探测主扩展格地址（第一个 dir="0" 且非组格的格），如 "C2" */
export function detectMasterAddress(raw: string): string | undefined {
  const re = /<C c="(\d+)" r="(\d+)"[^>]*>(?:(?!<\/C>)[\s\S])*?<Expand dir="0"(?![^/>]*leftParentDefault)/;
  const m = re.exec(raw);
  if (!m) return undefined;
  return colLetter(Number(m[1])) + (Number(m[2]) + 1);
}

/** 统计主扩展格数量（dir="0" 且无 leftParentDefault） */
export function countMasterExpands(raw: string): number {
  return (raw.match(/<Expand dir="0"(?![^/>]*leftParentDefault)/g) ?? []).length;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
