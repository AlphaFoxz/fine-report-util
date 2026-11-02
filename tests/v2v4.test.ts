import { describe, test, expect } from "bun:test";
import { CptDocument } from "../src/core/CptDocument.ts";
import { paramList, paramSetDefault, paramRemove } from "../src/ops/params.ts";
import { colInsert, colRemove } from "../src/ops/columns.ts";
import { generateCpt } from "../src/generation/generator.ts";
import { parseXlsx } from "../src/generation/from-xlsx.ts";
import { zipSync, strToU8 } from "fflate";
import { FIXTURE, tempCopy, readText } from "./helpers.ts";
import path from "node:path";
import os from "node:os";
import { mkdtemp } from "node:fs/promises";

const PARAMS_FIXTURE = path.resolve(import.meta.dir, "fixtures/fixture-params.cpt");

// ---------------------------------------------------------------- v2 参数

describe("v2 参数体系", () => {
  test("参数三来源审计：数据集绑定消解 missing", async () => {
    const ledger = await CptDocument.load(await tempCopy());
    // fixture-ledger 无任何来源 → missing
    expect(ledger.model.params.missing).toContain("acctset");

    // fixture-params 有数据集绑定 → 不再 missing
    const withParams = await CptDocument.load(PARAMS_FIXTURE);
    expect(withParams.model.params.datasetBound).toContain("acctset");
    expect(withParams.model.params.missing).toEqual([]);
  });

  test("param-list：按数据集列出绑定", async () => {
    const doc = await CptDocument.load(PARAMS_FIXTURE);
    const r = paramList.apply(doc, {});
    expect(r.ok).toBe(true);
    const detail = r.detail as { perDataset: Record<string, { name: string; value: string }[]> };
    expect(detail.perDataset!["台账"]).toEqual([{ name: "acctset", value: "5236" }]);
    expect(detail.perDataset!["付款发票"]).toEqual([]);
  });

  test("param-set-default：更新已有绑定", async () => {
    const p = await tempCopy();
    const doc = await CptDocument.load(p);
    const r = paramSetDefault.apply(doc, { dataset: "台账", param: "acctset", value: "5361" });
    expect(r.ok).toBe(true);
    expect(doc.raw).toContain("<![CDATA[5361]]></O>");
    // 只有这一处变化
    expect(doc.validate().ok).toBe(true);
  });

  test("param-set-default：<Parameters/> 自闭合 → 展开并插入", async () => {
    const p = await tempCopy();
    const doc = await CptDocument.load(p);
    const r = paramSetDefault.apply(doc, { dataset: "付款发票", param: "year", value: "2026" });
    expect(r.ok).toBe(true);
    expect(doc.raw).toContain('<Attributes name="year"/>');
    expect(doc.raw).toContain("<![CDATA[2026]]></O>");
    expect(doc.validate().ok).toBe(true);
  });

  test("param-remove：删条目并收回 <Parameters/>", async () => {
    const doc = await CptDocument.load(PARAMS_FIXTURE);
    const r = paramRemove.apply(doc, { dataset: "台账", param: "acctset" });
    expect(r.ok).toBe(true);
    expect(doc.raw).toContain("<Parameters/>");
    expect(doc.raw).not.toContain('<Attributes name="acctset"/>');
  });
});

// ---------------------------------------------------------------- v2 体检扩充

describe("v2 体检扩充", () => {
  async function docWithEdit(mutate: (raw: string) => string): Promise<CptDocument> {
    const doc = await CptDocument.load(await tempCopy());
    doc.applySpanEdit({ start: 0, end: doc.raw.length, replacement: mutate(doc.raw), description: "test" });
    return doc;
  }

  test("多个主扩展格告警", async () => {
    const doc = await docWithEdit((raw) =>
      raw.replace(/<Expand\/>\n<\/C>\n<C c="2" r="1" s="3">/, '<Expand dir="0"/>\n</C>\n<C c="2" r="1" s="3">'),
    );
    expect(doc.model.warnings.join("\n")).toContain("multiple master expand cells");
  });

  test("左父格指向自身 → 死循环告警", async () => {
    const doc = await docWithEdit((raw) => raw.replace('<Expand leftParentDefault="false" left="C2"/>', '<Expand leftParentDefault="false" left="A2"/>'));
    expect(doc.model.warnings.join("\n")).toContain("self-referencing left parent");
  });

  test("空 Query 数据集告警", async () => {
    const doc = await docWithEdit((raw) =>
      raw.replace(/(<TableData name="付款发票"[\s\S]*?<Query>\s*<!\[CDATA\[)[\s\S]*?(\]\]><\/Query>)/, "$1$2"),
    );
    expect(doc.model.warnings.join("\n")).toContain('dataset "付款发票" has no <Query>');
  });

  test("组格过滤键在被引数据集 SQL 中找不到 → 告警", async () => {
    const doc = await docWithEdit((raw) => raw.replace("NM_CODE</CNAME>", "NOT_EXIST</CNAME>"));
    // 台账 SQL 里没有 NOT_EXIST
    expect(doc.model.warnings.join("\n")).toContain("filter references column");
  });
});

// ---------------------------------------------------------------- v4 列操作

describe("v4 列插入/删除", () => {
  test("col-insert：右移 + 新格 + 表头 + ColumnWidth", async () => {
    const p = await tempCopy();
    const doc = await CptDocument.load(p);
    const r = colInsert.apply(doc, { at: 2, header: "新备注列" });
    expect(r.ok).toBe(true);

    // 原主格 c=2 → c=3
    expect(doc.raw).toContain('<C c="3" r="1" s="3">');
    expect(doc.raw).toContain('<C c="3" r="1" s="3">\n<O t="DSColumn">\n<Attributes dsName="台账" columnName="NM_CODE"/>');
    // 新表头格在 c=2 r=0
    expect(doc.raw).toContain('<C c="2" r="0">\n<O>\n<![CDATA[新备注列]]></O>');
    // 数据行新空格 c=2 r=1
    expect(doc.raw).toContain('<C c="2" r="1">\n<PrivilegeControl/>');
    // ColumnWidth 从 6 项变 7 项
    const w = /<!\[CDATA\[1828800,2743200,2743200,2286000,2743200,2286000\]\]><\/ColumnWidth>/.test(doc.raw);
    expect(w).toBe(false);
    expect(doc.validate().ok).toBe(true);
  });

  test("col-insert：保护区违规被 strict 拒绝，allow-protected 放行并记录", async () => {
    const p = await tempCopy();
    const doc = await CptDocument.load(p);
    colInsert.apply(doc, { at: 2 });
    expect(() => doc.save({ backup: false, guard: "strict" })).toThrow(/protected region/);
    const r = await doc.save({ backup: false, guard: "allow-protected" });
    const regions = r.protectedViolations.map((v) => v.region);
    expect(regions).toContain("ColumnWidth");
    expect(regions).toContain("CellOpenTag");
  });

  test("col-remove：删除列 + 左移 + ColumnWidth 收缩", async () => {
    const p = await tempCopy();
    const doc = await CptDocument.load(p);
    const r = colRemove.apply(doc, { at: 3, count: 1 });
    expect(r.ok).toBe(true);
    // 原 c=4 空格被删；原 c=5 组格左移到 c=4
    expect(doc.raw).toContain('<C c="4" r="1" s="3">\n<O t="DSColumn">\n<Attributes dsName="收款发票"');
    expect(doc.raw).not.toContain('dsName="付款发票"');
    expect(doc.validate().ok).toBe(true);
  });
});

// ---------------------------------------------------------------- v3 生成链路

describe("v3 生成链路", () => {
  test("parseXlsx：从内存构建的迷你 xlsx 提取表头", async () => {
    const sharedStrings = `<?xml version="1.0"?><sst count="3"><si><t>序号</t></si><si><t>合同编码</t></si><si><t>发票号</t></si></sst>`;
    const sheet = `<?xml version="1.0"?><worksheet><sheetData>` +
      `<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>` +
      `<row r="2"><c r="A2"><v>1</v></c><c r="B2"><v>5236-01-2609-0001</v></c></row>` +
      `</sheetData><mergeCells><mergeCell ref="A2:A3"/><mergeCell ref="B2:B3"/></mergeCells></worksheet>`;
    const wb = `<?xml version="1.0"?><workbook><sheets><sheet name="台账" sheetId="1" r:id="rId1"/></sheets></workbook>`;
    const rels = `<?xml version="1.0"?><Relationships><Relationship Id="rId1" Type="x" Target="worksheets/sheet1.xml"/></Relationships>`;
    const zip = zipSync({
      "xl/workbook.xml": strToU8(wb),
      "xl/_rels/workbook.xml.rels": strToU8(rels),
      "xl/sharedStrings.xml": strToU8(sharedStrings),
      "xl/worksheets/sheet1.xml": strToU8(sheet),
    });
    const dir = await mkdtemp(path.join(os.tmpdir(), "fru-xlsx-"));
    const xlsxPath = path.join(dir, "sample.xlsx");
    await (await import("node:fs/promises")).writeFile(xlsxPath, zip);

    const grid = parseXlsx(xlsxPath);
    expect(grid.sheetName).toBe("台账");
    const headers = grid.headers(1);
    expect(headers.map((h) => h.text)).toEqual(["序号", "合同编码", "发票号"]);
    expect(grid.merges).toEqual(["A2:A3", "B2:B3"]);
  });

  test("generateCpt：主格/组格/普通列/空白列的完整骨架", async () => {
    const xml = generateCpt({
      output: "x.cpt",
      connection: "测试连接",
      datasets: [{ name: "台账", sql: "SELECT 1 AS NM_CODE FROM DUAL WHERE 1=0" }],
      columns: [
        { header: "序号", spec: "formula:=&C2" },
        { header: "合同编码", spec: "master:台账:NM_CODE" },
        { header: "发票号", spec: "group:台账:INVOICE_NO:NM", groupJoinColumn: "NM_CODE" },
        { header: "备注" },
      ],
    });
    expect(xml).toContain('<Expand dir="0"/>');
    expect(xml).toContain("MonoGrouper");
    expect(xml).toContain('<SimpleDSColumn dsName="台账" columnName="NM_CODE"/>');
    expect(xml).toContain("<![CDATA[序号]]>");
    // master 列左邻的序号格带左父格
    expect(xml).toContain('<Expand leftParentDefault="false" left="B2"/>');
    // 可被自己的 XML 校验器通过
    const { XMLValidator } = await import("fast-xml-parser");
    expect(XMLValidator.validate(xml)).toBe(true);
  });

  test("generateCpt：XS 组列缺 filterColumn 报错", () => {
    expect(() =>
      generateCpt({
        output: "x.cpt",
        connection: "c",
        datasets: [{ name: "d", sql: "SELECT 1" }],
        columns: [
          { header: "m", spec: "master:台账:NM_CODE" },
          { header: "g", spec: "group:收款发票:INVOICE_NO:XS" },
        ],
      }),
    ).toThrow(/filterColumn/);
  });

  test("generateCpt：缺主格报错", () => {
    expect(() =>
      generateCpt({
        output: "x.cpt",
        connection: "c",
        datasets: [],
        columns: [{ header: "a", spec: "ds:台账:A" }],
      }),
    ).toThrow(/master/);
  });
});
