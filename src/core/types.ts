/**
 * 共享类型定义
 */

/** 一次文本手术：把 [start, end) 区间替换为 replacement */
export interface SpanEdit {
  readonly start: number;
  readonly end: number;
  readonly replacement: string;
  /** 人读 + agent 可读的变更说明 */
  readonly description: string;
}

/** 单元格绑定的逻辑规格（与物理 XML 解耦） */
export type CellSpec =
  | { type: "ds"; ds: string; column: string }
  | { type: "master"; ds: string; column: string }
  | { type: "group"; ds: string; column: string; key: "NM" | "XS" }
  | { type: "formula"; expression: string }
  | { type: "text"; text: string }
  | { type: "blank" };

/** 模型层：一个单元格的只读快照 */
export interface CellInfo {
  col: number;
  row: number;
  /** 样式引用（格式资产，模型只读） */
  styleRef?: string;
  /** 合并行/列属性（合并单元格） */
  rowSpan?: string;
  colSpan?: string;
  binding:
    | { kind: "text"; text: string }
    | { kind: "formula"; expression: string }
    | {
        kind: "ds";
        ds: string;
        column: string;
        grouper: "function" | "mono" | "summary" | "unknown";
        filterRef?: { ds: string; column: string };
      }
    | { kind: "empty" };
  /** 该格内含条件属性列表（<ConditionAttrList>，只读展示，格式未验证不做写操作） */
  hasConditionAttr?: boolean;
  expand: {
    /** "0"=纵向 "1"=横向 undefined=跟随 */
    dir?: string;
    leftParent?: string;
  };
}

/** 模型层：数据集只读快照 */
export interface DatasetInfo {
  name: string;
  kind: string;
  hasQuery: boolean;
  connection?: string;
  /** Query 的 SQL 文本（内部体检用，heuristic） */
  queryText?: string;
}

/** 参数引用审计（SQL 里的 ${param} vs 各来源注册表） */
export interface ParamAudit {
  /** SQL 中引用的参数名 */
  referencedInSql: string[];
  /** 来源1：经典 <ReportParameter name=...>（FR10 风格，FR11 样本罕见） */
  registered: string[];
  /** 来源2：数据集 <Parameters><Parameter> 绑定（格式已从真实样本验证） */
  datasetBound: string[];
  /** 来源3：参数面板表单控件名（ParameterUI 内的 WidgetName） */
  formWidgetNames: string[];
  /** 引用了但三种来源都没有 → FR 预览时渲染为空 */
  missing: string[];
}

/** ReportPageAttr 只读快照（冻结/重复行列） */
export interface PageAttrInfo {
  raw: string;
  /** 各区块内部文本；空标签为 undefined */
  hr?: string;
  fr?: string;
  hc?: string;
  fc?: string;
}

/** 只读模型总览 */
export interface CptModel {
  cells: CellInfo[];
  datasets: DatasetInfo[];
  params: ParamAudit;
  /** ReportPageAttr 只读快照（冻结/重复标题行列） */
  pageAttr?: PageAttrInfo;
  /** 含条件属性的格数量 */
  conditionAttrCount: number;
  /** 主扩展格（第一个 dir="0" 的格）sheet 地址，如 "C2" */
  masterAddress?: string;
  /** 主扩展格所在行（即数据行号，XML 的 r 值） */
  dataRow?: number;
  /** 存疑项（不阻断使用，但 agent 应该知道） */
  warnings: string[];
}

/** 保护区违规 */
export interface ProtectedViolation {
  region: string;
  detail: string;
}

/** XML 校验结果 */
export interface XmlValidation {
  ok: boolean;
  err?: { message: string; startLine?: number; startCol?: number };
}

/** 保存结果 */
export interface SaveResult {
  path: string;
  backupPath?: string;
  xmlValid: boolean;
  /** 统一 diff 文本（可能截断） */
  diffText: string;
  /** 变更统计 */
  diffStat: { added: number; removed: number };
  protectedViolations: ProtectedViolation[];
}

/** Op 的机器可读结果 */
export interface OpResult<T = unknown> {
  ok: boolean;
  op: string;
  summary: string;
  /** 改动详情（dry-run 也有） */
  detail?: T;
  /** 下一步建议（给 agent 的 hint） */
  next?: string;
}
