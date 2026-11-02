/**
 * 数据集参数操作（v2）。
 * 操作对象是数据集级 <Parameters><Parameter> 绑定——格式已从 FR11 真实模板验证：
 *   <Parameters>
 *     <Parameter>
 *     <Attributes name="area"/>
 *     <O>
 *     <![CDATA[华东]]></O>
 *     </Parameter>
 *   </Parameters>
 * 经典模板级 <ReportParameter> 写操作暂不提供（FR11 全库样本均为表单式 UI，
 * 序列化格式未验证；见 ROADMAP v2 挂起项）。
 */
import { findDatasetBlock } from "../core/surgery.ts";
import type { CptDocument } from "../core/CptDocument.ts";
import type { OpResult } from "../core/types.ts";
import type { Operation } from "./types.ts";

const PARAM_RE = /<Parameter>\s*<Attributes name="([^"]+)"\s*\/>\s*<O>\s*<!\[CDATA\[([\s\S]*?)\]\]><\/O>\s*<\/Parameter>/g;

function makeEntry(name: string, value: string): string {
  return `<Parameter>\n<Attributes name="${name}"/>\n<O>\n<![CDATA[${value}]]></O>\n</Parameter>`;
}

/** 在数据集块内定位 <Parameters> 区（含自闭合），返回位置与内容 */
function findParametersSection(block: string):
  | { start: number; end: number; selfClosing: boolean; inner: string }
  | undefined {
  const pair = /<Parameters>([\s\S]*?)<\/Parameters>/.exec(block);
  if (pair) return { start: pair.index, end: pair.index + (pair[0] ?? "").length, selfClosing: false, inner: pair[1] ?? "" };
  const single = /<Parameters\s*\/>/.exec(block);
  if (single) return { start: single.index, end: single.index + (single[0] ?? "").length, selfClosing: true, inner: "" };
  return undefined;
}

function listEntries(block: string): { name: string; value: string }[] {
  const sec = findParametersSection(block);
  if (!sec) return [];
  const out: { name: string; value: string }[] = [];
  for (const m of block.slice(sec.start, sec.end).matchAll(PARAM_RE)) {
    out.push({ name: m[1] ?? "", value: (m[2] ?? "").trim() });
  }
  return out;
}

// ---------------------------------------------------------------- param-list

export interface ParamListInput {
  /** 只看某个数据集；缺省列出全部 */
  dataset?: string;
}

export const paramList = {
  name: "param-list",
  description:
    "列出数据集参数绑定（<Parameters><Parameter>），以及 SQL ${param} 引用与三种满足来源的对照。只读。",
  inputSchema: {
    type: "object",
    properties: { dataset: { type: "string", description: "可选：只看该数据集" } },
  },
  examples: [`param list 台账.cpt`],
  apply(doc: CptDocument, input: ParamListInput): OpResult {
    const raw = doc.raw;
    const perDataset: Record<string, { name: string; value: string }[]> = {};
    const names = input.dataset ? [input.dataset] : [...new Set([...raw.matchAll(/<TableData name="([^"]+)"/g)].map((m) => m[1] ?? ""))];
    for (const name of names) {
      const found = findDatasetBlock(raw, name);
      if (found) perDataset[name] = listEntries(found.block);
    }
    const p = doc.model.params;
    return {
      ok: true,
      op: this.name,
      summary: `${Object.keys(perDataset).length} dataset(s); SQL 引用 ${p.referencedInSql.length} 个参数，缺失 ${p.missing.length} 个`,
      detail: {
        perDataset,
        referencedInSql: p.referencedInSql,
        sources: {
          classicReportParameter: p.registered,
          datasetBound: p.datasetBound,
          formWidgetNames: p.formWidgetNames,
        },
        missing: p.missing,
      },
    };
  },
} satisfies Operation<ParamListInput>;

// -------------------------------------------------------- param-set-default

export interface ParamSetDefaultInput {
  dataset: string;
  param: string;
  value: string;
}

export const paramSetDefault = {
  name: "param-set-default",
  description:
    "为数据集设置/更新一个参数绑定（<Parameter> 条目：${param} → 默认值）。" +
    "用于修复「SQL 引用 ${param} 但无来源，预览为空」的常见问题。只动该数据集的 <Parameters> 区。",
  inputSchema: {
    type: "object",
    properties: {
      dataset: { type: "string" },
      param: { type: "string", description: "参数名（SQL 里的 ${name}）" },
      value: { type: "string", description: "默认值" },
    },
    required: ["dataset", "param", "value"],
  },
  examples: [`param set-default 台账.cpt --ds 台账 --name acctset --value 5236 --write`],
  apply(doc: CptDocument, input: ParamSetDefaultInput): OpResult {
    const found = findDatasetBlock(doc.raw, input.dataset);
    if (!found) {
      throw Object.assign(new Error(`dataset not found: ${input.dataset}`), {
        code: "DATASET_NOT_FOUND",
        hint: "用 `cpt audit --json` 查看数据集清单",
      });
    }
    if (/\$\{[\s\S]*\}/.test(input.value) ) {
      // 值里再嵌 ${} 是合法场景但易出 CDATA/嵌套混乱，v2 先禁止
      throw Object.assign(new Error("nested ${} in value not supported"), { code: "UNSUPPORTED_VALUE" });
    }
    if (!found.block.includes(`<Query>`)) throw new Error("dataset block malformed: no Query");
    const sec = findParametersSection(found.block);

    let newBlock: string;
    let action: string;
    if (!sec) {
      // 数据集连 <Parameters/> 都没有：插在 <Attributes 之前
      const entry = `<Parameters>\n${makeEntry(input.param, input.value)}\n</Parameters>\n`;
      const anchor = /<Attributes maxMemRowCount/.exec(found.block);
      if (!anchor) throw new Error("dataset block malformed: no <Attributes>");
      newBlock = found.block.slice(0, anchor.index) + entry + found.block.slice(anchor.index);
      action = "created <Parameters> section and added entry";
    } else {
      const entries = listEntries(found.block);
      const existing = entries.find((e) => e.name === input.param);
      if (existing && existing.value === input.value) {
        return { ok: true, op: this.name, summary: "no change (same binding already present)" };
      }
      const inner = sec.selfClosing
        ? `\n${makeEntry(input.param, input.value)}\n`
        : replaceEntryInXml(sec.inner, input.param, makeEntry(input.param, input.value));
      newBlock =
        found.block.slice(0, sec.start) +
        (sec.selfClosing ? `<Parameters>${inner}</Parameters>` : `<Parameters>${inner}</Parameters>`) +
        found.block.slice(sec.end);
      action = existing ? "updated existing binding" : "added new binding";
    }

    doc.applySpanEdit({
      start: found.start,
      end: found.end,
      replacement: newBlock,
      description: `param "${input.param}" of dataset "${input.dataset}" -> ${action}`,
    });
    return {
      ok: true,
      op: this.name,
      summary: `dataset "${input.dataset}": ${action} (${input.param} = ${input.value})`,
      detail: { before: found.block, after: newBlock },
      next: "save 后在 FR 设计器预览该数据集参数生效",
    };
  },
} satisfies Operation<ParamSetDefaultInput>;

function replaceEntryInXml(inner: string, name: string, entryXml: string): string {
  const re = new RegExp(
    `<Parameter>\\s*<Attributes name="${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s*/>[\\s\\S]*?</Parameter>`,
  );
  if (re.test(inner)) return inner.replace(re, entryXml);
  return inner.replace(/\s*$/, "") + "\n" + entryXml + "\n";
}

// ----------------------------------------------------------- param-remove

export interface ParamRemoveInput {
  dataset: string;
  param: string;
}

export const paramRemove = {
  name: "param-remove",
  description: "删除数据集的一个参数绑定条目。",
  inputSchema: {
    type: "object",
    properties: { dataset: { type: "string" }, param: { type: "string" } },
    required: ["dataset", "param"],
  },
  examples: [`param remove 台账.cpt --ds 台账 --name area --write`],
  apply(doc: CptDocument, input: ParamRemoveInput): OpResult {
    const found = findDatasetBlock(doc.raw, input.dataset);
    if (!found) {
      throw Object.assign(new Error(`dataset not found: ${input.dataset}`), { code: "DATASET_NOT_FOUND" });
    }
    const sec = findParametersSection(found.block);
    if (!sec || sec.selfClosing) {
      return { ok: true, op: this.name, summary: "no parameters section — nothing to remove" };
    }
    const re = new RegExp(
      `\\s*<Parameter>\\s*<Attributes name="${input.param.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s*/>[\\s\\S]*?</Parameter>`,
    );
    if (!re.test(sec.inner)) {
      return { ok: true, op: this.name, summary: `no binding named "${input.param}" — nothing to remove` };
    }
    const newInner = sec.inner.replace(re, "");
    const newBlock =
      found.block.slice(0, sec.start) +
      (newInner.trim() === "" ? "<Parameters/>" : `<Parameters>${newInner}</Parameters>`) +
      found.block.slice(sec.end);

    doc.applySpanEdit({
      start: found.start,
      end: found.end,
      replacement: newBlock,
      description: `remove param binding "${input.param}" from dataset "${input.dataset}"`,
    });
    return {
      ok: true,
      op: this.name,
      summary: `dataset "${input.dataset}": removed binding "${input.param}"`,
      next: "若 SQL 仍引用该 ${param}，audit 会给出缺失告警",
    };
  },
} satisfies Operation<ParamRemoveInput>;
