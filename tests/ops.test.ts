import { describe, test, expect } from "bun:test";
import { CptDocument } from "../src/core/CptDocument.ts";
import { cellBind } from "../src/ops/cell-bind.ts";
import { sqlSet } from "../src/ops/sql-set.ts";
import { tempCopy, readText } from "./helpers.ts";

describe("cell-bind 操作", () => {
  test("普通格改绑：只动该格的 <O>，样式引用与其他格逐字节不动", async () => {
    const p = await tempCopy();
    const doc = await CptDocument.load(p);
    const before = doc.raw;

    const r = cellBind.apply(doc, { col: 1, row: 1, spec: "ds:台账:PUR_AMT" });
    expect(r.ok).toBe(true);

    const after = doc.raw;
    // 唯一变化点：绑定行的 columnName（其余逐字节不动）
    expect(
      after.replace('<Attributes dsName="台账" columnName="PUR_AMT"/>', '<Attributes dsName="台账" columnName="PUR_SUPPLIER"/>'),
    ).toBe(before);
    // 样式引用保留
    expect(after).toContain('<C c="1" r="1" s="3">');
    // XML 仍合法
    expect(doc.validate().ok).toBe(true);
  });

  test("对主扩展格用 ds: 改绑：保留 dir=0（改字段不改扩展结构）", async () => {
    const p = await tempCopy();
    const doc = await CptDocument.load(p);
    const r = cellBind.apply(doc, { col: 2, row: 1, spec: "ds:台账:PUR_SUPPLIER" });
    expect(r.ok).toBe(true);
    expect(doc.raw).toContain('<Expand dir="0"/>');
  });

  test("组格改绑：mono 语义 + 跨数据集过滤 + 左父格自动保留", async () => {
    const p = await tempCopy();
    const doc = await CptDocument.load(p);

    const r = cellBind.apply(doc, { col: 3, row: 1, spec: "group:付款发票:INVOICE_AMT:NM" });
    expect(r.ok).toBe(true);
    expect(doc.raw).toContain('columnName="INVOICE_AMT"');
    expect(doc.raw).toContain("MonoGrouper");
    expect(doc.raw).toContain('<SimpleDSColumn dsName="台账" columnName="NM_CODE"/>');
    expect(doc.raw).toContain('<Expand dir="0" leftParentDefault="false" left="C2"/>');
    expect(doc.validate().ok).toBe(true);
  });

  test("text 格改绑为组格：自动探测主扩展格作为左父格", async () => {
    const p = await tempCopy();
    const doc = await CptDocument.load(p);
    // c=5 r=0 是表头文本格 —— 改成明细组（模拟加列）
    const r = cellBind.apply(doc, { col: 5, row: 0, spec: "group:收款发票:INVOICE_NO:XS" });
    expect(r.ok).toBe(true);
    expect(doc.raw).toContain('<Expand dir="0" leftParentDefault="false" left="C2"/>');
    expect(doc.validate().ok).toBe(true);
  });

  test("blank：移除 <O> 但保留样式引用与 Expand", async () => {
    const p = await tempCopy();
    const doc = await CptDocument.load(p);
    cellBind.apply(doc, { col: 1, row: 1, spec: "blank" });
    const block = /<C c="1" r="1"[\s\S]*?<\/C>/.exec(doc.raw)![0];
    expect(block).not.toContain("<O");
    expect(block).toContain('s="3"');
    expect(block).toContain("<Expand/>");
  });

  test("找不到格 → CELL_NOT_FOUND + hint 指向 list", async () => {
    const p = await tempCopy();
    const doc = await CptDocument.load(p);
    expect(() => cellBind.apply(doc, { col: 99, row: 99, spec: "blank" })).toThrow(
      expect.objectContaining({ code: "CELL_NOT_FOUND" }),
    );
  });
});

describe("sql-set 操作", () => {
  test("替换 Query：其余内容逐字节不动", async () => {
    const p = await tempCopy();
    const doc = await CptDocument.load(p);
    const before = doc.raw;

    const r = await sqlSet.apply(doc, { dataset: "付款发票", sql: "SELECT 1 AS X FROM DUAL WHERE 1=0" });
    expect(r.ok).toBe(true);

    const after = doc.raw;
    expect(after).toContain("<![CDATA[SELECT 1 AS X FROM DUAL WHERE 1=0]]></Query>");
    // 逆转替换应还原全文 —— 证明只动了这一处
    expect(
      after.replace(
        "<Query>\n<![CDATA[SELECT 1 AS X FROM DUAL WHERE 1=0]]></Query>",
        "<Query>\n<![CDATA[SELECT si.CONTRACT_CODE, si.INVOICE_NO, si.INVOICE_AMT\nFROM TEST.T_PS_SETTLE_INVOICE si\nWHERE si.ACCTSET_CODE = '5236'\nORDER BY si.CONTRACT_CODE, si.INVOICE_DATE]]></Query>",
      ),
    ).toBe(before);
  });

  test("BOM 兜底 + CDATA 断言", async () => {
    const p = await tempCopy();
    const doc = await CptDocument.load(p);
    await sqlSet.apply(doc, { dataset: "收款发票", sql: "\uFEFFSELECT 2 FROM DUAL" });
    expect(doc.raw).toContain("<![CDATA[SELECT 2 FROM DUAL]]></Query>");
    expect(() => sqlSet.apply(doc, { dataset: "收款发票", sql: "a ]]> b" })).toThrow("CDATA violation");
  });

  test("数据集不存在 → DATASET_NOT_FOUND", async () => {
    const p = await tempCopy();
    const doc = await CptDocument.load(p);
    await expect(sqlSet.apply(doc, { dataset: "不存在", sql: "SELECT 1" })).rejects.toThrow(
      expect.objectContaining({ code: "DATASET_NOT_FOUND" }),
    );
  });
});

describe("save 守卫与备份", () => {
  test("guard=strict：正常 op 保存成功并自动备份", async () => {
    const p = await tempCopy();
    const doc = await CptDocument.load(p);
    cellBind.apply(doc, { col: 1, row: 1, spec: "ds:台账:PUR_AMT" });
    const r = await doc.save({ backup: true });
    expect(r.xmlValid).toBe(true);
    expect(r.backupPath).toBeTruthy();
    expect(r.diffStat).toEqual({ added: 1, removed: 1 }); // 单行替换 = 1 增 1 删
    // 备份内容 == 原文
    const bak = await readText(r.backupPath!);
    expect(bak).toContain("columnName=\"PUR_SUPPLIER\"");
  });

  test("guard=strict：保护区被手工改动时拒绝保存", async () => {
    const p = await tempCopy();
    const doc = await CptDocument.load(p);
    // 模拟误操作：直接改 StyleList 内文本（绕过 op）
    doc.applySpanEdit({
      start: doc.raw.indexOf('size="128"'),
      end: doc.raw.indexOf('size="128"') + 10,
      replacement: 'size="999"',
      description: "test: touch StyleList",
    });
    expect(() => doc.save({ backup: false, guard: "strict" })).toThrow(/protected region/);
    // 显式放行可保存，但结果中记录违规
    const r = await doc.save({ backup: false, guard: "allow-protected" });
    expect(r.protectedViolations.length).toBeGreaterThan(0);
  });

  test("XML 被改坏时拒绝保存", async () => {
    const p = await tempCopy();
    const doc = await CptDocument.load(p);
    doc.applySpanEdit({
      start: doc.raw.indexOf("<CellElementList>"),
      end: doc.raw.indexOf("<CellElementList>") + 17,
      replacement: "<CellElementList",
      description: "test: break xml",
    });
    expect(() => doc.save({ backup: false })).toThrow(/XML invalid/);
  });
});
