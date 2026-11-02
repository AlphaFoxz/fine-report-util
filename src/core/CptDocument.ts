/**
 * CptDocument：cpt 维护库的入口。
 *
 * 核心不变量（测试锁死）：
 * 1. load → 不做操作 → save 输出与原文 byte-identical
 * 2. 任何操作后，diff 仅包含操作声明的目标区间
 * 3. save(guard:"strict") 时，格式保护区（StyleList/行高列宽/页面/单元格开标签）零改动
 */
import { readFile, writeFile, copyFile } from "node:fs/promises";
import path from "node:path";
import { XMLValidator } from "fast-xml-parser";
import { diffLines } from "diff";
import type { ProtectedViolation, SaveResult, SpanEdit, XmlValidation } from "./types.ts";
import { protectedViolations } from "./protected-regions.ts";
import { buildModel, parseCells } from "../model/index.ts";
import type { CptModel } from "../core/types.ts";

export interface SaveOptions {
  /** 写盘前自动备份原文为 <name>-bak-<时间戳>.cpt（默认 true） */
  backup?: boolean;
  /** strict=触及保护区即拒绝（默认）；allow-protected=放行但记录违规 */
  guard?: "strict" | "allow-protected";
}

export class CptDocument {
  private constructor(
    public readonly path: string,
    private readonly original: string,
    private working: string,
    private readonly edits: SpanEdit[],
  ) {}

  /** 加载 cpt（UTF-8，容忍并剥离 BOM，保存时不回写 BOM） */
  static async load(filePath: string): Promise<CptDocument> {
    const buf = await readFile(filePath);
    let off = 0;
    if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) off = 3;
    const text = buf.subarray(off).toString("utf8");
    return new CptDocument(path.resolve(filePath), text, text, []);
  }

  /** 当前工作文本（所有已应用编辑后） */
  get raw(): string {
    return this.working;
  }

  /** 只读模型（基于当前工作文本） */
  get model(): CptModel {
    return buildModel(this.working);
  }

  /** 已应用的编辑记录 */
  get appliedEdits(): readonly SpanEdit[] {
    return this.edits;
  }

  /** 是否有任何编辑 */
  get dirty(): boolean {
    return this.working !== this.original;
  }

  /**
   * 应用一个文本手术。仅供内部 ops 与测试使用——
   * 业务代码请走 ops（cellBind / sqlSet），它们负责构造正确的片段。
   */
  applySpanEdit(edit: SpanEdit): void {
    if (edit.end < edit.start || edit.start < 0 || edit.end > this.working.length) {
      throw new Error(`invalid span [${edit.start}, ${edit.end})`);
    }
    this.working =
      this.working.slice(0, edit.start) + edit.replacement + this.working.slice(edit.end);
    this.edits.push(edit);
  }

  /** XML 合法性（fast-xml-parser 的校验器） */
  validate(): XmlValidation {
    const r = XMLValidator.validate(this.working, { allowBooleanAttributes: true });
    if (r === true) return { ok: true };
    const e = r.err;
    return {
      ok: false,
      err: { message: e?.msg ?? "unknown xml error", startLine: e?.line, startCol: e?.col },
    };
  }

  /** 相对原文的统一 diff */
  diff(): { text: string; added: number; removed: number } {
    const parts = diffLines(this.original, this.working);
    let added = 0;
    let removed = 0;
    let text = "";
    for (const p of parts) {
      const lines = p.value.replace(/\n$/, "").split("\n");
      if (p.added) {
        added += lines.length;
        text += lines.map((l) => `+${l}`).join("\n") + "\n";
      } else if (p.removed) {
        removed += lines.length;
        text += lines.map((l) => `-${l}`).join("\n") + "\n";
      }
    }
    return { text: text.trimEnd(), added, removed };
  }

  /** 保护区违规检查（空数组 = 格式资产完好） */
  checkProtected(): ProtectedViolation[] {
    return protectedViolations(this.original, this.working);
  }

  /**
   * 保存。默认 backup=true、guard=strict。
   * 写盘前做：XML 校验 + 保护区守卫；写盘后返回机器可读结果。
   */
  async save(opts: SaveOptions = {}): Promise<SaveResult> {
    const { backup = true, guard = "strict" } = opts;

    const xml = this.validate();
    if (!xml.ok) {
      throw new Error(
        `refuse to save: XML invalid after edits — ${xml.err?.message}${xml.err?.startLine ? ` (line ${xml.err.startLine})` : ""}`,
      );
    }

    const violations = this.checkProtected();
    if (guard === "strict" && violations.length > 0) {
      const detail = violations
        .slice(0, 5)
        .map((v) => `  - [${v.region}] ${v.detail}`)
        .join("\n");
      throw new Error(
        `refuse to save: ${violations.length} protected region violation(s):\n${detail}\n` +
          `格式保护区被触碰。确认必要请 save({ guard: "allow-protected" })。`,
      );
    }

    const d = this.diff();
    let backupPath: string | undefined;
    if (backup) {
      const ts = new Date()
        .toISOString()
        .replace(/[-:T]/g, "")
        .replace(/\..+/, "")
        .replace(/(\d{8})(\d{6})/, "$1-$2");
      const parsed = path.parse(this.path);
      backupPath = path.join(parsed.dir, `${parsed.name}-bak-${ts}${parsed.ext}`);
      await copyFile(this.path, backupPath);
    }
    await writeFile(this.path, this.working, "utf8");

    return {
      path: this.path,
      backupPath,
      xmlValid: true,
      diffText: d.text,
      diffStat: { added: d.added, removed: d.removed },
      protectedViolations: violations,
    };
  }
}

/** 便捷重导出（模型直读） */
export { parseCells, buildModel };
