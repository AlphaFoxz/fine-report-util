/**
 * 库入口：维护 cpt 的一切从这里开始。
 *
 * ```ts
 * import { CptDocument } from "fine-report-util";
 * const doc = await CptDocument.load("台账.cpt");
 * doc.model.masterAddress;   // "C2" 主扩展格
 * doc.model.dataRow;         // 1    数据行
 * // ...走 ops 修改，save 时自动守卫格式保护区
 * ```
 */
export { CptDocument } from "./core/CptDocument.ts";
export { parseSpec, dsColumn, formula, text, expand, tableData } from "./serializers/index.ts";
export type { ParsedSpec } from "./serializers/index.ts";
export { buildModel, parseCells, parseDatasets, parseParams, parsePageAttr } from "./model/index.ts";
export type {
  CptModel,
  CellInfo,
  DatasetInfo,
  ParamAudit,
  PageAttrInfo,
  SaveResult,
  CellSpec,
  OpResult,
} from "./core/types.ts";
export { generateCpt, parseXlsx } from "./generation/index.ts";
export type { GenSpec, GenColumn, GenDataset, XlsxGrid, ConnectionInfo } from "./generation/index.ts";
