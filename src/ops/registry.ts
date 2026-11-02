/** Operation 注册表：CLI、编程 API 与 MCP 共用 */
import type { Operation } from "./types.ts";
import { cellBind } from "./cell-bind.ts";
import { sqlSet } from "./sql-set.ts";
import { paramList, paramSetDefault, paramRemove } from "./params.ts";
import { colInsert, colRemove } from "./columns.ts";

const OPS: Record<string, Operation<never>> = {};

export function register<I>(op: Operation<I>): void {
  OPS[op.name] = op as unknown as Operation<never>;
}

register(cellBind);
register(sqlSet);
register(paramList);
register(paramSetDefault);
register(paramRemove);
register(colInsert);
register(colRemove);

export function getOp(name: string): Operation<never> | undefined {
  return OPS[name];
}

export function allOps(): Operation<never>[] {
  return Object.values(OPS);
}
