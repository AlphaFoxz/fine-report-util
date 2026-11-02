#!/usr/bin/env bun
/**
 * cpt CLI — fine-report-util 的薄壳。
 * 所有命令支持 --json（机器可读）与 --ascii（JSON 非 ASCII 转义，规避控制台乱码）。
 * 修改类命令默认 dry-run，--write 才落盘（自动备份）。
 * 声明 touchesProtected 的操作保存时自动走 allow-protected 并记录违规。
 */
import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import { diffLines } from "diff";
import { CptDocument } from "../core/CptDocument.ts";
import { allOps, getOp } from "../ops/registry.ts";
import { cellBind, type CellBindInput } from "../ops/cell-bind.ts";
import { sqlSet, type SqlSetInput } from "../ops/sql-set.ts";
import { paramList, paramSetDefault, paramRemove } from "../ops/params.ts";
import { colInsert, colRemove } from "../ops/columns.ts";
import { generateCpt, type GenSpec } from "../generation/generator.ts";

interface GlobalFlags {
  json: boolean;
  ascii: boolean;
  write: boolean;
  left?: string;
}

function esc(v: unknown, flags: GlobalFlags): string {
  let s = JSON.stringify(v, null, 2);
  if (flags.ascii) s = s.replace(/[^\x00-\x7F]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return s;
}

function printOut(value: unknown, flags: GlobalFlags): void {
  console.log(esc(value, flags));
}

function fail(err: unknown): never {
  const e = err as Error & { code?: string; hint?: string };
  console.error(JSON.stringify({ ok: false, code: e.code ?? "ERROR", message: e.message, hint: e.hint }, null, 2));
  process.exit(1);
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      json: { type: "boolean", default: false },
      ascii: { type: "boolean", default: false },
      write: { type: "boolean", default: false },
      row: { type: "string" },
      c: { type: "string" },
      r: { type: "string" },
      spec: { type: "string" },
      left: { type: "string" },
      ds: { type: "string" },
      file: { type: "string" },
      sql: { type: "string" },
      name: { type: "string" },
      value: { type: "string" },
      at: { type: "string" },
      count: { type: "string" },
      header: { type: "string" },
      width: { type: "string" },
      from: { type: "string" },
      confirm: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });

  const flags: GlobalFlags = {
    json: values.json ?? false,
    ascii: values.ascii ?? false,
    write: values.write ?? false,
    left: values.left,
  };

  const [cmd, sub, third] = positionals;
  const file = cmd === "list" || cmd === "audit" || cmd === "batch" ? sub : third;

  if (cmd === "ops") {
    printOut(
      allOps().map((o) => ({
        name: o.name,
        description: o.description,
        touchesProtected: (o as { touchesProtected?: boolean }).touchesProtected === true,
        inputSchema: o.inputSchema,
        examples: o.examples,
      })),
      flags,
    );
    return;
  }

  if (cmd === "explain") {
    const op = getOp(sub ?? "");
    if (!op) throw Object.assign(new Error(`unknown op: ${sub}`), { code: "UNKNOWN_OP" });
    printOut({ name: op.name, description: op.description, inputSchema: op.inputSchema, examples: op.examples }, flags);
    return;
  }

  // ---- cpt diff <a> <b> ----
  if (cmd === "diff") {
    const [a, b] = [sub, third];
    if (!a || !b) throw Object.assign(new Error("usage: cpt diff <a.cpt> <b.cpt>"), { code: "USAGE" });
    const [ta, tb] = await Promise.all([readFile(a, "utf8"), readFile(b, "utf8")]);
    const parts = diffLines(ta, tb);
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
    printOut({ a, b, added, removed, unified: text.trimEnd() }, flags);
    return;
  }

  // ---- cpt batch <file> --file ops.json [--write] ----
  if (cmd === "batch") {
    if (!file || !values.file) {
      throw Object.assign(new Error("usage: cpt batch <file> --file <ops.json> [--write]"), { code: "USAGE" });
    }
    const opsSpec = JSON.parse(await readFile(values.file, "utf8")) as { op: string; input: Record<string, unknown> }[];
    const doc = await CptDocument.load(file);
    const applied: string[] = [];
    for (const { op, input } of opsSpec) {
      const impl = getOp(op);
      if (!impl) throw Object.assign(new Error(`unknown op in batch: ${op}`), { code: "UNKNOWN_OP", hint: "cpt ops 查看可用列表" });
      const r = await impl.apply(doc, input as never);
      applied.push(`${op}: ${r.summary}`);
    }
    let saved: unknown;
    if (flags.write && doc.dirty) {
      const touches = opsSpec.some((s) => (getOp(s.op) as unknown as { touchesProtected?: boolean })?.touchesProtected);
      const r = await doc.save({ backup: true, guard: touches ? "allow-protected" : "strict" });
      saved = { backupPath: r.backupPath, diffStat: r.diffStat, protectedViolations: r.protectedViolations };
    }
    printOut({ ok: true, op: "batch", applied, saved: flags.write ? saved : undefined, next: flags.write ? "核对 diff 与备份" : "dry-run 完成，加 --write 落盘" }, flags);
    return;
  }

  // ---- cpt gen --from spec.json [--confirm] ----
  if (cmd === "gen") {
    if (!values.from) throw Object.assign(new Error("usage: cpt gen --from <spec.json> [--confirm]"), { code: "USAGE" });
    const spec = JSON.parse(await readFile(values.from, "utf8")) as GenSpec;
    const xml = generateCpt(spec);
    if (!values.confirm) {
      printOut(
        {
          ok: true,
          op: "gen",
          summary: `generated ${xml.length} chars (dry-run) for ${spec.output}`,
          previewHead: xml.split("\n").slice(0, 12).join("\n"),
          next: "确认无误后加 --confirm 落盘；随后在设计器里调整格式（生成只做首版）",
        },
        flags,
      );
      return;
    }
    await Bun.write(spec.output, xml);
    const doc = await CptDocument.load(spec.output);
    printOut(
      { ok: true, op: "gen", written: spec.output, xmlChars: xml.length, audit: { masterAddress: doc.model.masterAddress, warnings: doc.model.warnings, cellCount: doc.model.cells.length } },
      flags,
    );
    return;
  }

  if (!file) throw Object.assign(new Error("missing <file> argument"), { code: "USAGE" });
  const doc = await CptDocument.load(file);

  if (cmd === "list") {
    const rowFilter = values.row !== undefined ? Number(values.row) : undefined;
    const cells = doc.model.cells
      .filter((c) => rowFilter === undefined || c.row === rowFilter)
      .map((c) => ({
        address: colAddr(c.col, c.row + 1),
        c: c.col,
        r: c.row,
        style: c.styleRef,
        hasConditionAttr: c.hasConditionAttr,
        binding: c.binding,
        expand: c.expand,
      }));
    printOut(
      {
        file: doc.path,
        masterAddress: doc.model.masterAddress,
        dataRow: doc.model.dataRow,
        datasets: doc.model.datasets.map((d) => d.name),
        warnings: doc.model.warnings,
        cellCount: cells.length,
        cells,
      },
      flags,
    );
    return;
  }

  if (cmd === "audit") {
    const m = doc.model;
    printOut(
      {
        file: doc.path,
        dirty: doc.dirty,
        masterAddress: m.masterAddress,
        dataRow: m.dataRow,
        datasets: m.datasets,
        params: m.params,
        pageAttr: m.pageAttr
          ? { hr: m.pageAttr.hr, fr: m.pageAttr.fr, hc: m.pageAttr.hc, fc: m.pageAttr.fc }
          : null,
        conditionAttrCount: m.conditionAttrCount,
        cellCount: m.cells.length,
        bindings: {
          ds: m.cells.filter((c) => c.binding.kind === "ds").length,
          formula: m.cells.filter((c) => c.binding.kind === "formula").length,
          text: m.cells.filter((c) => c.binding.kind === "text").length,
          empty: m.cells.filter((c) => c.binding.kind === "empty").length,
        },
        warnings: m.warnings,
      },
      flags,
    );
    return;
  }

  if (cmd === "param") {
    if (sub === "list") {
      const r = paramList.apply(doc, { dataset: values.ds });
      printOut(r, flags);
      return;
    }
    if (sub === "set-default") {
      if (!values.ds || !values.name || values.value === undefined) {
        throw Object.assign(new Error("usage: cpt param set-default <file> --ds NAME --name P --value V [--write]"), { code: "USAGE" });
      }
      const r = paramSetDefault.apply(doc, { dataset: values.ds, param: values.name, value: values.value });
      await maybeSave(doc, flags, false);
      printOut({ ...r, saved: flags.write ? savePayload(doc) : undefined }, flags);
      return;
    }
    if (sub === "remove") {
      if (!values.ds || !values.name) {
        throw Object.assign(new Error("usage: cpt param remove <file> --ds NAME --name P [--write]"), { code: "USAGE" });
      }
      const r = paramRemove.apply(doc, { dataset: values.ds, param: values.name });
      await maybeSave(doc, flags, false);
      printOut({ ...r, saved: flags.write ? savePayload(doc) : undefined }, flags);
      return;
    }
    throw Object.assign(new Error("usage: cpt param list|set-default|remove ..."), { code: "USAGE" });
  }

  if (cmd === "col") {
    if (sub === "insert") {
      const at = Number(values.at);
      if (!Number.isInteger(at)) throw Object.assign(new Error("usage: cpt col insert <file> --at N [--count N] [--header 文字] [--width N] [--write]"), { code: "USAGE" });
      const r = colInsert.apply(doc, {
        at,
        count: values.count !== undefined ? Number(values.count) : undefined,
        header: values.header,
        width: values.width !== undefined ? Number(values.width) : undefined,
      });
      await maybeSave(doc, flags, true);
      printOut({ ...r, saved: flags.write ? savePayload(doc) : undefined }, flags);
      return;
    }
    if (sub === "remove") {
      const at = Number(values.at);
      if (!Number.isInteger(at)) throw Object.assign(new Error("usage: cpt col remove <file> --at N [--count N] [--write]"), { code: "USAGE" });
      const r = colRemove.apply(doc, { at, count: values.count !== undefined ? Number(values.count) : undefined });
      await maybeSave(doc, flags, true);
      printOut({ ...r, saved: flags.write ? savePayload(doc) : undefined }, flags);
      return;
    }
    throw Object.assign(new Error("usage: cpt col insert|remove ..."), { code: "USAGE" });
  }

  if (cmd === "cell" && sub === "set") {
    const col = Number(values.c);
    const row = Number(values.r);
    if (!Number.isInteger(col) || !Number.isInteger(row) || !values.spec) {
      throw Object.assign(new Error("usage: cpt cell set <file> --c N --r N --spec SPEC [--left X] [--write]"), { code: "USAGE" });
    }
    const input: CellBindInput = { col, row, spec: values.spec, left: flags.left };
    const result = cellBind.apply(doc, input);
    await maybeSave(doc, flags, false);
    printOut({ ...result, saved: flags.write ? savePayload(doc) : undefined }, flags);
    return;
  }

  if (cmd === "sql" && sub === "set") {
    if (!values.ds) throw Object.assign(new Error("usage: cpt sql set <file> --ds NAME (--sql S | --file F) [--write]"), { code: "USAGE" });
    const input: SqlSetInput = { dataset: values.ds, sql: values.sql, sqlFile: values.file };
    const result = await sqlSet.apply(doc, input);
    await maybeSave(doc, flags, false);
    printOut({ ...result, saved: flags.write ? savePayload(doc) : undefined }, flags);
    return;
  }

  throw Object.assign(
    new Error(
      `unknown command: ${[cmd, sub].filter(Boolean).join(" ")}\ncommands: audit | list | diff | batch | gen | param list|set-default|remove | col insert|remove | cell set | sql set | ops | explain`,
    ),
    { code: "USAGE" },
  );
}

async function maybeSave(doc: CptDocument, flags: GlobalFlags, touchesProtected: boolean): Promise<void> {
  if (!flags.write || !doc.dirty) return;
  const r = await doc.save({
    backup: true,
    guard: touchesProtected ? "allow-protected" : "strict",
  });
  if (r.protectedViolations.length > 0) {
    console.error(
      JSON.stringify({ warn: "protected regions changed (op declares touchesProtected)", violations: r.protectedViolations }),
    );
  }
}

function savePayload(doc: CptDocument) {
  const d = doc.diff();
  return {
    path: doc.path,
    diffStat: { added: d.added, removed: d.removed },
    diffText: d.text.length > 2000 ? d.text.slice(0, 2000) + "\n…(truncated)" : d.text,
  };
}

function colAddr(col: number, row1: number): string {
  let n = col + 1;
  let s = "";
  while (n > 0) {
    n--;
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26);
  }
  return s + row1;
}

main().catch(fail);
