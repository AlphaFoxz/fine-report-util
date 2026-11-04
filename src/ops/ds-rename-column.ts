/**
 * ds-rename-column：数据集输出列改名（中文化别名）。
 *
 * 联动四处，一次完成：
 * 1. 该数据集 Query 的输出别名（`AS OLD` → `AS "NEW"`；裸列无别名时在
 *    select list 首个出现处补 ` AS "NEW"`——输出列必须带别名，中文名用双引号包裹）
 * 2. 该数据集自身绑定格的 `<Attributes columnName>`
 * 3. 其他格引用该列做过滤键的 `<SimpleDSColumn columnName>`
 * 4. 绑定该数据集的组格 `<CNAME>`（过滤的"自家列"）
 *
 * 手术式：仅上述 span 被替换，保护区与其余内容 byte 级不动。
 * 不支持改名 where/order by 等内部引用——输出别名与内部列名是两个名字空间，
 * 数据库会分别解析（ORDER BY 旧列名在改名后依然指向源表列，语义不变）。
 */
import { findDatasetBlock, assertCdataSafe } from "../core/surgery.ts";
import type { CptDocument } from "../core/CptDocument.ts";
import type { OpResult } from "../core/types.ts";
import type { Operation } from "./types.ts";

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface DsRenameColumnInput {
  dataset: string;
  /** 输出列现名（SQL 别名） */
  from: string;
  /** 新列名（将输出为 `AS "NEW"`） */
  to: string;
}

const CELL_RE = /<C c="\d+" r="\d+"[^>]*>([\s\S]*?)<\/C>/g;

export const dsRenameColumn: Operation<DsRenameColumnInput> = {
  name: "ds-rename-column",
  description:
    "数据集列改名：Query 输出别名改为 AS \"新名\"（裸列自动补别名），并联动更新" +
    "绑定格 Attributes、SimpleDSColumn 过滤引用、组格 CNAME。保护区零触碰。",
  inputSchema: {
    type: "object",
    properties: {
      dataset: { type: "string", description: "数据集名" },
      from: { type: "string", description: "现列名（SQL 别名）" },
      to: { type: "string", description: "新列名（建议中文，SQL 中以双引号包裹）" },
    },
    required: ["dataset", "from", "to"],
  },
  examples: [
    `ds rename 台账.cpt --ds 台账 --from NM_CODE --to 采购合同号 --write`,
    `ds rename 台账.cpt --ds 付款发票 --from CONTRACT_CODE --to 合同号 --write`,
  ],
  apply(doc: CptDocument, input: DsRenameColumnInput): OpResult {
    const { dataset, from, to } = input;
    if (!from || !to) throw err("USAGE", "from/to 不能为空");
    assertCdataSafe(to, `rename target ${to}`);
    const found = findDatasetBlock(doc.raw, dataset);
    if (!found) {
      throw err("DATASET_NOT_FOUND", `用 \`cpt audit --json\` 查看数据集清单`, `dataset "${dataset}" 不存在`);
    }
    const qm = /<Query>\s*<!\[CDATA\[([\s\S]*?)\]\]><\/Query>/.exec(found.block);
    if (!qm || qm[1] === undefined) throw err("NO_QUERY", "该数据集没有 <Query> CDATA");
    const sql = qm[1];
    const qAbsStart = found.start + qm.index + (qm[0] ?? "").indexOf(sql);
    const fromRe = escapeRe(from);
    const toRe = escapeRe(to);

    // 引号形态必须严格：带引号要闭合（防"销售合同号"前缀误匹配"销售合同号键"），不带引号须词尾
    const aliasPattern = (name: string) =>
      `\\bAS\\s+(?:"${name}"(?!\\w)|${name}(?![\\w$"]))`;

    if (new RegExp(aliasPattern(toRe)).test(sql)) {
      throw err(
        "DUPLICATE_COLUMN",
        `该数据集已有输出列 "${to}"——同数据集列名必须唯一`,
        "换一个新列名，或先处理同名列",
      );
    }

    const regions: { start: number; end: number; replacement: string }[] = [];
    let sqlAliasMode: "aliased" | "bare" | "missing" = "missing";

    // 1) 已有别名：`AS from`（可有旧引号）→ `AS "to"`（全部出现处）
    const aliasMatches = [...sql.matchAll(new RegExp(aliasPattern(fromRe), "g"))];
    if (aliasMatches.length > 0) {
      const newSql = sql.replace(new RegExp(aliasPattern(fromRe), "g"), `AS "${to}"`);
      regions.push({
        start: qAbsStart,
        end: qAbsStart + sql.length,
        replacement: newSql,
      });
      sqlAliasMode = "aliased";
    } else {
      // 2) 裸列（无别名）：select list 首个完整项（后随逗号/闭括号/FROM）补别名
      const bareRe = new RegExp(`\\b${fromRe}\\b(?=\\s*(?:,|\\)|\\bFROM\\b))`);
      const bm = bareRe.exec(sql);
      if (bm) {
        regions.push({
          start: qAbsStart + bm.index,
          end: qAbsStart + bm.index + bm[0].length,
          replacement: `${from} AS "${to}"`,
        });
        sqlAliasMode = "bare";
      }
    }

    // 3) 引用联动（在整个文件上找，全部基于原 raw 的偏移）
    const raw = doc.raw;
    // 3a. 自身绑定格 <Attributes>
    for (const m of raw.matchAll(
      new RegExp(`(<Attributes dsName="${escapeRe(dataset)}" columnName=")${fromRe}(")`, "g"),
    )) {
      regions.push({ start: m.index, end: m.index + m[0].length, replacement: m[1] + to + m[2] });
    }
    // 3b. 跨数据集过滤引用 <SimpleDSColumn>
    for (const m of raw.matchAll(
      new RegExp(`(<SimpleDSColumn dsName="${escapeRe(dataset)}" columnName=")${fromRe}(")`, "g"),
    )) {
      regions.push({ start: m.index, end: m.index + m[0].length, replacement: m[1] + to + m[2] });
    }
    // 3c. 组格 <CNAME>（绑定了本数据集的格，过滤自家列 = from）
    let cnameCount = 0;
    for (const cm of raw.matchAll(CELL_RE)) {
      const block = cm[0];
      const bindDs = /<Attributes dsName="([^"]+)"/.exec(block)?.[1];
      if (bindDs !== dataset) continue;
      const nm = new RegExp(`(<CNAME>\\s*<!\\[CDATA\\[)${fromRe}(\\]\\]></CNAME>)`).exec(block);
      if (!nm) continue;
      const inner = nm[1] + to + nm[2];
      const absStart = cm.index + block.indexOf(nm[0]);
      regions.push({ start: absStart, end: absStart + nm[0].length, replacement: inner });
      cnameCount++;
    }

    if (regions.length === 0) {
      throw err(
        "COLUMN_NOT_FOUND",
        `数据集 "${dataset}" 中找不到输出列 "${from}"`,
        "用 audit 输出的 queryText 核对别名；裸列需出现在 select list 且无 AS 别名",
      );
    }

    // 从后往前应用（避免偏移失效）
    for (const r of regions.sort((a, b) => b.start - a.start)) {
      doc.applySpanEdit({
        start: r.start,
        end: r.end,
        replacement: r.replacement,
        description: `rename column ${dataset}.${from} -> ${to}`,
      });
    }

    return {
      ok: true,
      op: this.name,
      summary:
        `${dataset}.${from} -> "${to}"（SQL 别名: ${sqlAliasMode === "aliased" ? "已有别名改名" : "裸列补别名"}，` +
        `绑定 ${regions.filter((r) => r.replacement.startsWith("<Attributes")).length} 处，` +
        `过滤引用 ${regions.filter((r) => r.replacement.startsWith("<SimpleDSColumn")).length} 处，` +
        `CNAME ${cnameCount} 处）`,
      next: "save 后用 diff 验证只有上述 span 变化；再在设计器里预览该数据集",
    };
  },
};

function err(code: string, message: string, hint?: string): Error & { code: string; hint?: string } {
  return Object.assign(new Error(message), { code, hint });
}
