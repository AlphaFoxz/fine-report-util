/**
 * Operation 扩展点：库的一切功能都是 Operation。
 * 新功能 = 新增一个 op 文件并在 registry 注册；CLI 与编程 API 共用同一注册表。
 */
import type { CptDocument } from "../core/CptDocument.ts";
import type { OpResult } from "../core/types.ts";

/** JSON Schema（agent 通过 `cpt ops` 自描述发现） */
export interface JsonSchema {
  type: string;
  properties?: Record<string, unknown>;
  required?: string[];
}

export interface Operation<I = unknown> {
  name: string;
  /** 给 agent 看的能力描述 */
  description: string;
  inputSchema: JsonSchema;
  /** 使用示例（agent few-shot 用） */
  examples: string[];
  /** 声明本操作会触碰格式保护区（保存时自动走 allow-protected 并记录违规） */
  touchesProtected?: boolean;
  apply(doc: CptDocument, input: I): Promise<OpResult> | OpResult;
}
