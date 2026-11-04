/**
 * v5 新 Operation 测试：ds-rename-column（列改名联动）与 row-append（底部追加行），
 * 以及 cell-bind 的过滤列覆盖参数（列名中文化后的 group 绑定）。
 */
import { describe, test, expect } from "bun:test";
import { CptDocument } from "../src/core/CptDocument.ts";
import { dsRenameColumn } from "../src/ops/ds-rename-column.ts";
import { rowAppend } from "../src/ops/row-append.ts";
import { cellBind } from "../src/ops/cell-bind.ts";

const FIX = "tests/fixtures/fixture-ledger.cpt";

async function loadFresh(): Promise<CptDocument> {
  return CptDocument.load(FIX);
}

describe("ds-rename-column", () => {
  test("已有别名：Query 别名 + 主格 Attributes 联动更新", async () => {
    const doc = await loadFresh();
    const r = await dsRenameColumn.apply(doc, { dataset: "台账", from: "NM_CODE", to: "采购合同号" });
    expect(r.ok).toBe(true);
    const raw = doc.raw;
    expect(raw).toContain('AS "采购合同号"');
    expect(raw).not.toContain("AS NM_CODE");
    // 主扩展格绑定（fixture 中 c=0 r=1 绑定 NM_CODE——先探一下是否存在）
    expect(raw).toContain('columnName="采购合同号"');
    expect(raw).not.toContain('columnName="NM_CODE"');
  });

  test("裸列（无别名）：在 select list 首个出现处补 AS", async () => {
    const doc = await loadFresh();
    // fixture 付款发票 Query: SELECT si.CONTRACT_CODE, si.INVOICE_NO, ...（裸列）
    const r = await dsRenameColumn.apply(doc, { dataset: "付款发票", from: "CONTRACT_CODE", to: "合同号" });
    expect(r.ok).toBe(true);
    const q = /<TableData name="付款发票"[\s\S]*?<Query>\s*<!\[CDATA\[([\s\S]*?)\]\]>/.exec(doc.raw)?.[1] ?? "";
    expect(q).toContain('si.CONTRACT_CODE AS "合同号"');
    // ORDER BY 的旧列名不动（指向源表列，语义不变）
    expect(q).toContain("ORDER BY si.CONTRACT_CODE");
    // 绑定付款发票的组格 CNAME 同步
    expect(doc.raw).toContain("<CNAME>\n<![CDATA[合同号]]></CNAME>");
    // 引用台账的 SimpleDSColumn 不受影响
    expect(doc.raw).toContain('<SimpleDSColumn dsName="台账" columnName="XS_CODE"/>');
  });

  test("跨数据集过滤引用：SimpleDSColumn 联动", async () => {
    const doc = await loadFresh();
    dsRenameColumn.apply(doc, { dataset: "台账", from: "XS_CODE", to: "销售合同号" });
    expect(doc.raw).toContain('<SimpleDSColumn dsName="台账" columnName="销售合同号"/>');
    expect(doc.raw).not.toContain('dsName="台账" columnName="XS_CODE"');
  });

  test("目标列名重复 → DUPLICATE_COLUMN", async () => {
    const doc = await loadFresh();
    expect(() => dsRenameColumn.apply(doc, { dataset: "台账", from: "PUR_SUPPLIER", to: "NM_CODE" })).toThrow(
      /DUPLICATE_COLUMN|已有输出列/,
    );
  });

  test("列不存在 → COLUMN_NOT_FOUND", async () => {
    const doc = await loadFresh();
    expect(() => dsRenameColumn.apply(doc, { dataset: "台账", from: "NOT_EXIST", to: "任意" })).toThrow(
      /找不到输出列/,
    );
  });

  test("改名后 round-trip 仍保真（除目标 span）", async () => {
    const doc = await loadFresh();
    const before = doc.raw;
    dsRenameColumn.apply(doc, { dataset: "台账", from: "NM_CODE", to: "采购合同号" });
    const after = doc.raw;
    // 只有出现 NM_CODE 的行发生变化
    const bLines = before.split("\n");
    const aLines = after.split("\n");
    expect(bLines.length).toBe(aLines.length);
    let changed = 0;
    for (let i = 0; i < bLines.length; i++) {
      if (bLines[i] !== aLines[i]) {
        changed++;
        expect(bLines[i]).toMatch(/NM_CODE/);
      }
    }
    expect(changed).toBeGreaterThan(0);
  });
});

describe("row-append", () => {
  test("追加到 max r + 1，不触碰 RowHeight", async () => {
    const doc = await loadFresh();
    const before = doc.raw;
    const rhBefore = /<RowHeight[^>]*>\s*<!\[CDATA\[[^\]]*\]\]>/.exec(before)?.[0];
    const r = await rowAppend.apply(doc, {
      cells: [
        { c: 0, text: "备注" },
        { c: 41, text: "结算单金额-实际付款总额" },
      ],
    });
    expect(r.ok).toBe(true);
    const after = doc.raw;
    // RowHeight 原样
    expect(/<RowHeight[^>]*>\s*<!\[CDATA\[[^\]]*\]\]>/.exec(after)?.[0]).toBe(rhBefore);
    // 新行 r = 之前 max + 1；fixture 数据行 r=1 → 新行 r=2
    expect(after).toContain('<C c="0" r="2">');
    expect(after).toContain("<![CDATA[备注]]>");
    expect(after).toContain("<![CDATA[结算单金额-实际付款总额]]>");
    // summary 说明行号
    expect(r.summary).toContain("r=2");
  });

  test("row-append 追加无样式格不触发保护区违规；改动样式格开标签会触发", async () => {
    const doc = await loadFresh();
    await rowAppend.apply(doc, { cells: [{ c: 0, text: "备注" }] });
    expect(doc.checkProtected()).toEqual([]);
    // 直接改一个带样式引用的开标签 → 应检出违规
    const before = doc.raw;
    const m = /<C c="1" r="1" s="\d+"/.exec(before);
    expect(m).not.toBeNull();
    const idx = m!.index;
    doc.applySpanEdit({
      start: idx,
      end: idx + m![0].length,
      replacement: m![0].replace(/s="\d+"/, 's="99"'),
      description: "test: touch styled open tag",
    });
    expect(doc.checkProtected().some((v) => v.region === "CellOpenTag")).toBe(true);
  });

  test("text 含 ]]> → 拒绝", async () => {
    const doc = await loadFresh();
    expect(async () => {
      await rowAppend.apply(doc, { cells: [{ c: 0, text: "bad]]>text" }] });
    }).toThrow();
  });

  test("空 cells → EMPTY_CELLS", async () => {
    const doc = await loadFresh();
    expect(() => rowAppend.apply(doc, { cells: [] })).toThrow(/empty cells/);
  });
});

describe("cell-bind 过滤列覆盖（列名中文化场景）", () => {
  test("filterColumn/refColumn 覆盖 NM/XS 约定", async () => {
    const doc = await loadFresh();
    const r = cellBind.apply(doc, {
      col: 5,
      row: 1,
      spec: "group:收款发票:INVOICE_NO:XS",
      filterColumn: "合同号",
      refColumn: "采购合同号",
    });
    expect(r.ok).toBe(true);
    const block = /<C c="5" r="1"[^>]*>[\s\S]*?<\/C>/.exec(doc.raw)?.[0] ?? "";
    expect(block).toContain("<![CDATA[合同号]]></CNAME>");
    expect(block).toContain('<SimpleDSColumn dsName="台账" columnName="采购合同号"/>');
    expect(block).toContain("MonoGrouper");
  });
});
