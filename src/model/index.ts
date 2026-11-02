/**
 * 只读模型层：把 cpt 解析成导航友好的索引。
 * 这里允许用正则近似解析——因为它只读，不影响保真性。
 */
import type { CellInfo, CptModel, DatasetInfo, ParamAudit, PageAttrInfo } from "../core/types.ts";
import { colLetter, detectMasterAddress, countMasterExpands } from "../core/surgery.ts";

const CELL_RE = /<C c="(\d+)" r="(\d+)"([^>]*)(?=[ />])[^>]*>([\s\S]*?)<\/C>/g;
const O_RE = /<O(?:\s[^>]*)?>([\s\S]*?)<\/O>|<O(?:\s[^>]*)?\/>/;
const EXPAND_RE = /<Expand([^>]*?)(?:\/>|>([\s\S]*?)<\/Expand>)/;
const ATTR = (s: string, name: string): string =>
  new RegExp(`${name}="([^"]+)"`).exec(s)?.[1] ?? "";
const CDATA = (s: string) => /<!\[CDATA\[([\s\S]*?)\]\]/.exec(s)?.[1] ?? "";

export function parseCells(raw: string): CellInfo[] {
  const out: CellInfo[] = [];
  for (const m of raw.matchAll(CELL_RE)) {
    const col = Number(m[1]);
    const row = Number(m[2]);
    const attrs = m[3] ?? "";
    const body = m[4] ?? "";

    const styleRef = ATTR(attrs, "s");
    const rowSpan = ATTR(attrs, "rs");
    const colSpan = ATTR(attrs, "cs");

    let binding: CellInfo["binding"] = { kind: "empty" };
    const om = O_RE.exec(body);
    if (om) {
      const oOpen = om[0].slice(0, om[0].indexOf(">") + 1);
      const oInner = om[1] ?? "";
      if (oOpen.includes(`t="DSColumn"`)) {
        const ds = ATTR(oInner, `dsName`) ?? "";
        const column = ATTR(oInner, `columnName`) ?? "";
        const grouper = oInner.includes("MonoGrouper")
          ? "mono"
          : oInner.includes("SummaryGrouper")
            ? "summary"
            : oInner.includes("FunctionGrouper")
              ? "function"
              : "unknown";
        const fc = /SimpleDSColumn\s+dsName="([^"]+)"\s+columnName="([^"]+)"/.exec(oInner);
        binding = {
          kind: "ds",
          ds,
          column,
          grouper,
          filterRef: fc ? { ds: fc[1] ?? "", column: fc[2] ?? "" } : undefined,
        };
      } else if (oOpen.includes(`t="XMLable"`)) {
        binding = { kind: "formula", expression: CDATA(oInner) };
      } else {
        binding = { kind: "text", text: CDATA(oInner) };
      }
    }

    let dir: string | undefined;
    let leftParent: string | undefined;
    const em = EXPAND_RE.exec(body);
    if (em) {
      const openAttrs = em[1] ?? "";
      dir = ATTR(openAttrs, "dir");
      if (openAttrs.includes("leftParentDefault")) leftParent = ATTR(openAttrs, "left");
    }

    out.push({
      col,
      row,
      styleRef,
      rowSpan,
      colSpan,
      binding,
      hasConditionAttr: body.includes("<ConditionAttrList>"),
      expand: { dir, leftParent },
    });
  }
  return out;
}

export function parseDatasets(raw: string): DatasetInfo[] {
  const out: DatasetInfo[] = [];
  for (const m of raw.matchAll(/<TableData name="([^"]+)" class="([^"]+)">([\s\S]*?)<\/TableData>/g)) {
    const name = m[1] ?? "";
    const cls = m[2] ?? "";
    const body = m[3] ?? "";
    const conn = /<DatabaseName>\s*<!\[CDATA\[([\s\S]*?)\]\]>/.exec(body)?.[1];
    const qm = /<Query>\s*<!\[CDATA\[([\s\S]*?)\]\]><\/Query>/.exec(body);
    out.push({
      name,
      kind: cls.split(".").pop() ?? cls,
      hasQuery: qm !== null,
      queryText: qm?.[1],
      connection: conn,
    });
  }
  return out;
}

/** SQL 里引用的 ${param} 与三种来源（经典注册/数据集绑定/表单控件名）的对照 */
export function parseParams(raw: string): ParamAudit {
  const referenced = new Set<string>();
  for (const m of raw.matchAll(/\$\{([^}]+)\}/g)) referenced.add((m[1] ?? "").trim());

  // 来源1：经典 <ReportParameter name="X">（FR10 风格）
  const registered = new Set<string>();
  for (const m of raw.matchAll(/<ReportParameter name="([^"]+)"/g)) registered.add(m[1] ?? "");

  // 来源2：数据集 <Parameters><Parameter><Attributes name="X"/>（格式已从真实样本验证）
  const datasetBound = new Set<string>();
  for (const m of raw.matchAll(/<Parameter>\s*<Attributes name="([^"]+)"/g)) datasetBound.add(m[1] ?? "");

  // 来源3：参数面板表单控件名（ParameterUI 区块内的 WidgetName）
  const formWidgetNames = new Set<string>();
  const ui = /<ParameterUI[\s\S]*?<\/ParameterUI>/.exec(raw);
  if (ui) {
    for (const m of ui[0].matchAll(/<WidgetName name="([^"]+)"/g)) formWidgetNames.add(m[1] ?? "");
  }

  const missing = [...referenced].filter(
    (p) => !registered.has(p) && !datasetBound.has(p) && !formWidgetNames.has(p),
  );
  return {
    referencedInSql: [...referenced].sort(),
    registered: [...registered].sort(),
    datasetBound: [...datasetBound].sort(),
    formWidgetNames: [...formWidgetNames].sort(),
    missing,
  };
}

/** ReportPageAttr 只读快照 */
export function parsePageAttr(raw: string): PageAttrInfo | undefined {
  const m = /<ReportPageAttr>([\s\S]*?)<\/ReportPageAttr>/.exec(raw);
  if (!m) return undefined;
  const body = m[1] ?? "";
  const inner = (tag: string): string | undefined => {
    const t = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>|<${tag}\\s*/>`).exec(body);
    const g = t?.[1];
    return g !== undefined && g.trim() !== "" ? g : undefined;
  };
  return { raw: m[0] ?? "", hr: inner("HR"), fr: inner("FR"), hc: inner("HC"), fc: inner("FC") };
}

export function buildModel(raw: string): CptModel {
  const cells = parseCells(raw);
  const masterAddress = detectMasterAddress(raw);
  const master = masterAddress
    ? cells.find((c) => colLetter(c.col) + (c.row + 1) === masterAddress && c.expand.dir === "0")
    : undefined;

  const warnings: string[] = [];
  if (!masterAddress) warnings.push("no master expand cell (dir=\"0\") found — 报表可能无法纵向展开");
  const masterCount = countMasterExpands(raw);
  if (masterCount > 1) {
    warnings.push(`multiple master expand cells (dir="0" without leftParentDefault): ${masterCount} — 双主格会导致行数膨胀`);
  }
  // 悬空左父格 / 左父格指向自身（FR 死循环）
  const addresses = new Set(cells.map((c) => colLetter(c.col) + (c.row + 1)));
  for (const c of cells) {
    const addr = colLetter(c.col) + (c.row + 1);
    if (c.expand.leftParent && !addresses.has(c.expand.leftParent)) {
      warnings.push(`dangling left parent: cell ${addr} references ${c.expand.leftParent} which has no cell`);
    }
    if (c.expand.leftParent === addr) {
      warnings.push(`self-referencing left parent: cell ${addr} — FR 会报单元格计算死循环`);
    }
  }
  // 行不等组格但过滤器指向不存在的数据集；或被引数据集 SQL 里找不到过滤键列
  const datasets = parseDatasets(raw);
  const dsNames = new Set(datasets.map((d) => d.name));
  for (const c of cells) {
    if (c.binding.kind !== "ds") continue;
    if (!dsNames.has(c.binding.ds)) {
      warnings.push(`cell ${colLetter(c.col)}${c.row + 1} binds missing dataset "${c.binding.ds}"`);
      continue;
    }
    const filterRef = c.binding.filterRef;
    if (filterRef) {
      const target = datasets.find((d) => d.name === filterRef.ds);
      if (target && target.queryText && !target.queryText.toUpperCase().includes(filterRef.column.toUpperCase())) {
        warnings.push(
          `cell ${colLetter(c.col)}${c.row + 1} filter references column "${filterRef.column}" not found in dataset "${filterRef.ds}" SQL — 过滤将不生效`,
        );
      }
    }
  }
  // 空查询数据集（无 Query 或 CDATA 为空）
  for (const d of datasets) {
    if (!d.hasQuery || !d.queryText || d.queryText.trim() === "") {
      warnings.push(`dataset "${d.name}" has no <Query> — 预览会报错或为空`);
    }
  }
  // SQL 引用了 ${param} 但三种来源都没有 → FR 渲染为空（实战踩过的坑）
  const params = parseParams(raw);
  if (params.missing.length > 0) {
    warnings.push(
      `params referenced in SQL but not provided by any source (report param / dataset binding / form widget): ${params.missing.join(", ")} — 预览时这些参数将为空`,
    );
  }

  return {
    cells,
    datasets: parseDatasets(raw),
    params,
    pageAttr: parsePageAttr(raw),
    conditionAttrCount: (raw.match(/<ConditionAttrList>/g) ?? []).length,
    masterAddress,
    dataRow: master?.row,
    warnings,
  };
}
