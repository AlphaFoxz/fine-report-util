/**
 * 序列化器：高层 DSL → FineReport .cpt 的 XML 片段。
 * 输出格式与设计器兼容（经真实模板验证），这里是 FR 绑定格式的知识沉淀点。
 * 全部为纯函数；含 CDATA 的入口自动做安全断言。
 */
import { assertCdataSafe } from "../core/surgery.ts";

/** 数据列分组语义 */
export type Grouper = "function" | "mono" | "summary";

const GROUPER_CLASS: Record<Grouper, string> = {
  function: "com.fr.report.cell.cellattr.core.group.FunctionGrouper",
  mono: "com.fr.report.cell.cellattr.core.group.MonoGrouper",
  summary: "com.fr.report.cell.cellattr.core.group.SummaryGrouper",
};

/** 数据列过滤：与另一数据集当前行值比较（跨数据集关联的标准做法） */
export interface DsFilter {
  /** 本格数据集中作为比较的列（通常是 CONTRACT_CODE 这类外键） */
  ownColumn: string;
  /** 被引用数据集 */
  refDs: string;
  /** 被引用数据集的列（通常是主扩展格的键） */
  refColumn: string;
}

export interface DsColumnOptions {
  ds: string;
  column: string;
  grouper?: Grouper;
  filter?: DsFilter;
}

/** 生成 <O t="DSColumn"> 绑定。mono=逐行明细（列表），function=分组（默认） */
export function dsColumn(opts: DsColumnOptions): string {
  const grouper = opts.grouper ?? "function";
  const condition = opts.filter
    ? `<Condition class="com.fr.data.condition.CommonCondition">\n` +
      `<CNUMBER>\n<![CDATA[0]]></CNUMBER>\n` +
      `<CNAME>\n<![CDATA[${opts.filter.ownColumn}]]></CNAME>\n` +
      `<Compare op="0">\n` +
      `<SimpleDSColumn dsName="${opts.filter.refDs}" columnName="${opts.filter.refColumn}"/>\n` +
      `</Compare>\n</Condition>`
    : `<Condition class="com.fr.data.condition.ListCondition"/>`;
  return (
    `<O t="DSColumn">\n` +
    `<Attributes dsName="${opts.ds}" columnName="${opts.column}"/>\n` +
    `${condition}\n<Complex/>\n` +
    `<RG class="${GROUPER_CLASS[grouper]}"/>\n<Parameters/>\n</O>`
  );
}

/** 公式格 */
export function formula(expression: string): string {
  assertCdataSafe(expression, "formula");
  return `<O t="XMLable" class="com.fr.base.Formula">\n<Attributes>\n<![CDATA[${expression}]]></Attributes>\n</O>`;
}

/** 文本格（表头/标题） */
export function text(t: string): string {
  assertCdataSafe(t, "text");
  return `<O>\n<![CDATA[${t}]]></O>`;
}

export interface ExpandOptions {
  /** "0" 纵向扩展（主扩展格用） */
  dir?: string;
  /** 手动左父格地址，如 "C2"；带此值即 leftParentDefault="false" */
  left?: string;
}

/** 生成 <Expand>（扩展方向 + 手动左父格） */
export function expand(opts: ExpandOptions = {}): string {
  const attrs: string[] = [];
  if (opts.dir !== undefined) attrs.push(`dir="${opts.dir}"`);
  if (opts.left !== undefined) attrs.push(`leftParentDefault="false" left="${opts.left}"`);
  return attrs.length ? `<Expand ${attrs.join(" ")}/>` : `<Expand/>`;
}

/** 完整数据集块（首版全量生成用；编辑已有模板请走 sqlSet 只换 Query） */
export function tableData(name: string, sql: string, connection: string): string {
  assertCdataSafe(sql, `dataset ${name}`);
  return (
    `<TableData name="${name}" class="com.fr.data.impl.DBTableData">\n` +
    `<Desensitizations desensitizeOpen="false"/>\n<Parameters/>\n` +
    `<Attributes maxMemRowCount="-1"/>\n` +
    `<Connection class="com.fr.data.impl.NameDatabaseConnection">\n` +
    `<DatabaseName>\n<![CDATA[${connection}]]></DatabaseName>\n</Connection>\n` +
    `<Query>\n<![CDATA[${sql}]]></Query>\n` +
    `<PageQuery>\n<![CDATA[]]></PageQuery>\n</TableData>`
  );
}

/** 解析简写 spec 字符串（CLI / agent 便捷入口） */
export type ParsedSpec =
  | { type: "ds"; ds: string; column: string }
  | { type: "master"; ds: string; column: string }
  | { type: "group"; ds: string; column: string; key: "NM" | "XS" }
  | { type: "formula"; expression: string }
  | { type: "text"; text: string }
  | { type: "blank" };

/**
 * spec 语法:
 *   ds:数据集:字段            普通合同级/跟随格（分组语义）
 *   master:数据集:字段        主扩展格（纵向扩展）
 *   group:数据集:字段:NM|XS   行不等明细组（列表语义+跨数据集过滤，NM/XS=过滤键约定）
 *   formula:=表达式
 *   text:文字
 *   blank
 */
export function parseSpec(spec: string): ParsedSpec {
  if (spec === "blank") return { type: "blank" };
  const i = spec.indexOf(":");
  const kind = i < 0 ? "" : spec.slice(0, i);
  const rest = spec.slice(i + 1);
  switch (kind) {
    case "ds":
    case "master": {
      const [ds, column] = rest.split(":");
      if (!ds || !column) throw new Error(`bad spec "${spec}": expect ${kind}:数据集:字段`);
      return kind === "ds" ? { type: "ds", ds, column } : { type: "master", ds, column };
    }
    case "group": {
      const [ds, column, key] = rest.split(":");
      if (!ds || !column || (key !== "NM" && key !== "XS")) {
        throw new Error(`bad spec "${spec}": expect group:数据集:字段:NM|XS`);
      }
      return { type: "group", ds, column, key };
    }
    case "formula":
      if (!rest) throw new Error(`bad spec "${spec}": formula:表达式`);
      return { type: "formula", expression: rest };
    case "text":
      if (!rest) throw new Error(`bad spec "${spec}": text:文字`);
      return { type: "text", text: rest };
    default:
      throw new Error(`bad spec "${spec}": 未知类型 "${kind}"，可用 ds/master/group/formula/text/blank`);
  }
}

/** spec → <O> 片段；group 的过滤键按约定 NM→NM_CODE、XS→XS_CODE。
 *  列名已中文化（ds-rename-column 改过名）的模板可用 overrides 覆盖约定值。 */
export function specToO(
  spec: ParsedSpec,
  overrides?: { filterColumn?: string; refDs?: string; refColumn?: string },
): string | null {
  switch (spec.type) {
    case "ds":
      return dsColumn({ ds: spec.ds, column: spec.column, grouper: "function" });
    case "master":
      return dsColumn({ ds: spec.ds, column: spec.column, grouper: "function" });
    case "group":
      return dsColumn({
        ds: spec.ds,
        column: spec.column,
        grouper: "mono",
        filter: {
          ownColumn: overrides?.filterColumn ?? "CONTRACT_CODE",
          refDs: overrides?.refDs ?? "台账",
          refColumn:
            overrides?.refColumn ?? (spec.key === "NM" ? "NM_CODE" : "XS_CODE"),
        },
      });
    case "formula":
      return formula(spec.expression);
    case "text":
      return text(spec.text);
    case "blank":
      return null;
  }
}

/** spec → <Expand> 片段。oldDir：原格的扩展方向——「改绑字段不改扩展结构」，普通改绑保留。 */
export function specToExpand(spec: ParsedSpec, left?: string, oldDir?: string): string {
  if (spec.type === "master") return expand({ dir: "0" });
  if (spec.type === "group") {
    if (!left) throw new Error("group cell needs a left parent address (master cell), got none");
    return expand({ dir: "0", left });
  }
  if (spec.type === "blank") return expand();
  return expand({
    ...(oldDir !== undefined ? { dir: oldDir } : {}),
    ...(left ? { left } : {}),
  });
}
