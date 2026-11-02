/**
 * 数据源连接信息（v3 预检接口）。
 *
 * ★ 本库不内置任何连接串/账密——全部由调用方构造并注入（CLI 用 --env-file，API 用参数）。
 * ★ v3 只做类型定义与占位；达梦直连无成熟 Node 驱动，取数预检建议通过
 *   子进程调用现有 Java 探测类（见使用方工程），或在具备 ODBC 环境时扩展实现。
 */
export interface ConnectionInfo {
  /** JDBC/ODBC URL，如 jdbc:dm://host:5236?schema=PSCS */
  url: string;
  user: string;
  password: string;
  /** 可选驱动标识（如 "dm"），仅作提示 */
  driver?: string;
}

/** 取数预检结果（预留） */
export interface SqlPreviewResult {
  columns: string[];
  rowCount: number;
  sampleRows?: unknown[][];
}

export interface SqlPreviewer {
  preview(connection: ConnectionInfo, sql: string, maxRows?: number): Promise<SqlPreviewResult>;
}
