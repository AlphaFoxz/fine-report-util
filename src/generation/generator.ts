/**
 * 全新 cpt 生成器（v3）。**高危能力**：仅用于"全新模板首版"，
 * 对已有文件重跑会清零用户格式（格式保护铁律）。CLI 层要求 --confirm。
 *
 * 输入是列定义（JSON）：表头数组 + 每列绑定规格 + 数据集定义。
 * 布局约定（与实战台账一致）：
 * - r=0 表头行；r=1 数据行
 * - master 列做主扩展格（dir="0"）；group 列 MonoGrouper + 跨数据集过滤（左父格=主格）
 * - 普通列 FunctionGrouper 跟随；blank 列留空
 */
import { colLetter, assertCdataSafe } from "../core/surgery.ts";
import { dsColumn, formula, text, expand, tableData, parseSpec } from "../serializers/index.ts";

export interface GenColumn {
  /** 表头文字 */
  header: string;
  /** 绑定 spec（ds:/master:/group:数据集:字段:NM|XS/formula:/text:）；缺省 = 空白列 */
  spec?: string;
  /** 列宽 EMU，默认 2743200 */
  width?: number;
  /**
   * group 列的过滤键列名。NM 键缺省用主格列名；
   * XS 键必须显式给出（如 XS_CODE），指向主数据集里的配对键列。
   */
  filterColumn?: string;
  /** group 列在本数据集侧的关联列，默认 "CONTRACT_CODE" */
  groupJoinColumn?: string;
}

export interface GenDataset {
  name: string;
  sql: string;
}

export interface GenSpec {
  /** 输出文件路径 */
  output: string;
  /** FR 数据连接名（非凭据，仅名称） */
  connection: string;
  /** 报表标题（r=0 上方的标题行留空则不生成） */
  title?: string;
  datasets: GenDataset[];
  columns: GenColumn[];
}

function colAddr(col: number, row0: number): string {
  let n = col + 1;
  let s = "";
  while (n > 0) {
    n--;
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26);
  }
  return s + (row0 + 1);
}

export function generateCpt(spec: GenSpec): string {
  if (spec.columns.length === 0) throw new Error("no columns defined");
  const masterCol = spec.columns.findIndex((c) => c.spec?.startsWith("master:"));
  if (masterCol < 0) throw new Error("no master column (spec 'master:数据集:字段') — 报表无法扩展");
  const masterAddr = colAddr(masterCol, 1);
  const masterSpecParts = spec.columns[masterCol]!.spec!.split(":");
  const masterDs = masterSpecParts[1]!;
  const masterColumn = masterSpecParts[2]!;

  const sb: string[] = [];
  sb.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  sb.push(`<WorkBook xmlVersion="20211223" releaseVersion="11.5.0">`);
  sb.push(`<TableDataMap>`);
  for (const d of spec.datasets) sb.push(tableData(d.name, d.sql, spec.connection));
  sb.push(`</TableDataMap>`);
  sb.push(
    `<ElementCaseMobileAttr>\n<ElementCaseMobileAttrProvider horizontal="1" vertical="1" zoom="true" refresh="false" isUseHTML="false" isMobileCanvasSize="false" appearRefresh="false" allowFullScreen="false" allowDoubleClickOrZoom="true" functionalWhenUnactivated="false"/>\n</ElementCaseMobileAttr>`,
  );
  sb.push(`<Report class="com.fr.report.worksheet.WorkSheet" name="sheet1">`);
  sb.push(`<ReportPageAttr>\n<HR/>\n<FR/>\n<HC/>\n<FC/>\n<USE REPEAT="false" PAGE="false" WRITE="false"/>\n</ReportPageAttr>`);
  sb.push(`<ColumnPrivilegeControl/>\n<RowPrivilegeControl/>`);
  const heights = spec.title ? "1143000,1432560,723900" : "1432560,723900";
  sb.push(`<RowHeight defaultValue="723900">\n<![CDATA[${heights}]]></RowHeight>`);
  const widths = spec.columns.map((c) => String(c.width ?? 2743200)).join(",");
  sb.push(`<ColumnWidth defaultValue="2743200">\n<![CDATA[${widths}]]></ColumnWidth>`);
  sb.push(`<CellElementList>`);

  let r = 0;
  if (spec.title) {
    sb.push(
      `<C c="0" r="${r}" s="0" cs="${spec.columns.length}">\n` +
        `<O>\n<![CDATA[${spec.title}]]></O>\n<PrivilegeControl/>\n<Expand/>\n</C>`,
    );
    r++;
  }

  // 表头行
  for (let c = 0; c < spec.columns.length; c++) {
    const h = spec.columns[c]!.header;
    assertCdataSafe(h, `header ${c}`);
    sb.push(`<C c="${c}" r="${r}" s="0">\n<O>\n<![CDATA[${h}]]></O>\n<PrivilegeControl/>\n<Expand/>\n</C>`);
  }
  r++;

  // 数据行
  for (let c = 0; c < spec.columns.length; c++) {
    const col = spec.columns[c]!;
    const openTag = `<C c="${c}" r="${r}"`;
    if (!col.spec) {
      sb.push(`${openTag}>\n<PrivilegeControl/>\n<Expand/>\n</C>`);
      continue;
    }
    // 解析 spec（复用统一语法）
    const parsed = parseSpec(col.spec);
    let o: string | null;
    let exp: string;
    if (parsed.type === "master") {
      o = dsColumn({ ds: parsed.ds, column: parsed.column, grouper: "function" });
      exp = expand({ dir: "0" });
    } else if (parsed.type === "group") {
      if (parsed.key === "XS" && !col.filterColumn) {
        throw new Error(
          `column "${col.header}": group spec with key XS needs filterColumn (主数据集中的配对键列，如 XS_CODE)`,
        );
      }
      o = dsColumn({
        ds: parsed.ds,
        column: parsed.column,
        grouper: "mono",
        filter: {
          ownColumn: col.groupJoinColumn ?? "CONTRACT_CODE",
          refDs: masterDs,
          refColumn: parsed.key === "NM" ? masterColumn : col.filterColumn!,
        },
      });
      exp = expand({ dir: "0", left: masterAddr });
    } else if (parsed.type === "ds") {
      o = dsColumn({ ds: parsed.ds, column: parsed.column, grouper: "function" });
      exp = expand();
    } else if (parsed.type === "formula") {
      o = formula(parsed.expression);
      // 主格左侧的公式（如序号 =&C2）需要左父格指向主格
      exp = c < masterCol ? expand({ left: masterAddr }) : expand();
    } else if (parsed.type === "text") {
      o = text(parsed.text);
      exp = expand();
    } else {
      // blank
      sb.push(`${openTag}>\n<PrivilegeControl/>\n<Expand/>\n</C>`);
      continue;
    }
    sb.push(`${openTag}>\n${o}\n<PrivilegeControl/>\n${exp}\n</C>`);
  }

  sb.push(`</CellElementList>`);
  sb.push(
    `<ReportAttrSet>\n<ReportSettings headerHeight="0" footerHeight="0">\n` +
      `<PaperSetting orientation="1">\n<PaperSize width="30240000" height="216000000"/>\n` +
      `<Margin top="986400" left="2743200" bottom="986400" right="2743200"/>\n</PaperSetting>\n` +
      `<FollowingTheme background="true"/>\n<Background name="ColorBackground">\n<color>\n<FineColor color="-1" hor="-1" ver="-1"/>\n</color>\n</Background>\n` +
      `</ReportSettings>\n<Header reportPageType="0">\n<Background name="NullBackground"/>\n<LeftList/>\n<CenterList/>\n<RightList/>\n</Header>\n</ReportAttrSet>`,
  );
  sb.push(`<PrivilegeControl/>\n</Report>`);
  sb.push(
    `<ReportParameterAttr>\n<Attributes showWindow="true" delayPlaying="true" windowPosition="1" align="0" useParamsTemplate="true" currentIndex="0"/>\n<PWTitle>\n<![CDATA[参数]]></PWTitle>\n</ReportParameterAttr>`,
  );
  sb.push(
    `<StyleList>\n<Style style_name="默认" full="true" border_source="-1" imageLayout="1">\n<FRFont name="simhei" style="0" size="72"/>\n<Background name="NullBackground"/>\n<Border/>\n</Style>\n</StyleList>`,
  );
  sb.push(`<DesensitizationList/>\n<DesignerVersion DesignerVersion="LAA"/>\n<PreviewType PreviewType="1"/>`);
  sb.push(`</WorkBook>`);
  return sb.join("\n");
}
