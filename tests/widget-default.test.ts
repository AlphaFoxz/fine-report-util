/**
 * widget-set-default 测试：参数面板控件默认值（text/formula/clear 三形态）。
 * 夹具 fixture-widgets.cpt：bookId_c（多选下拉，空默认）、beginDate_c（日期，公式默认）、
 * LabelbookId_c（标签，同名前缀防误伤用例）。
 */
import { describe, test, expect } from "bun:test";
import { CptDocument } from "../src/core/CptDocument.ts";
import { widgetSetDefault } from "../src/ops/widget-set-default.ts";

const FIX = "tests/fixtures/fixture-widgets.cpt";

describe("widget-set-default", () => {
  test("text 值：填入空 widgetValue，字典/RAAttr 等其余属性不动", async () => {
    const doc = await CptDocument.load(FIX);
    const r = await widgetSetDefault.apply(doc, { widget: "bookId_c", value: "5300" });
    expect(r.ok).toBe(true);
    const block = /<InnerWidget class="com\.fr\.form\.ui\.ComboCheckBox">[\s\S]*?<\/InnerWidget>/.exec(doc.raw)?.[0] ?? "";
    expect(block).toContain("<![CDATA[5300]]>");
    expect(block).toContain('viName="memberAlias"'); // 字典没动
    expect(block).toContain('<RAAttr delimiter="&apos;,&apos;" isArray="false"/>'); // IN 适配器没动
    expect(doc.checkProtected()).toEqual([]); // 保护区零触碰
  });

  test("formula 值：替换已有公式默认", async () => {
    const doc = await CptDocument.load(FIX);
    const r = await widgetSetDefault.apply(doc, { widget: "beginDate_c", formula: "=TODAY()" });
    expect(r.ok).toBe(true);
    const block = /<InnerWidget class="com\.fr\.form\.ui\.DateEditor">[\s\S]*?<\/InnerWidget>/.exec(doc.raw)?.[0] ?? "";
    expect(block).toContain("=TODAY()");
    expect(block).not.toContain("MONTHDELTA");
    expect(block).toContain('<DateAttr format="yyyyMMdd"/>'); // 其余属性不动
  });

  test("clear：清空默认值", async () => {
    const doc = await CptDocument.load(FIX);
    const r = await widgetSetDefault.apply(doc, { widget: "beginDate_c", clear: true });
    expect(r.ok).toBe(true);
    const block = /<InnerWidget class="com\.fr\.form\.ui\.DateEditor">[\s\S]*?<\/InnerWidget>/.exec(doc.raw)?.[0] ?? "";
    expect(block).toContain("<![CDATA[]]></O>");
    expect(block).not.toContain("MONTHDELTA");
  });

  test("同前缀标签控件不被误伤（bookId_c ≠ LabelbookId_c）", async () => {
    const doc = await CptDocument.load(FIX);
    widgetSetDefault.apply(doc, { widget: "bookId_c", value: "5300" });
    const labelBlock = /<InnerWidget class="com\.fr\.form\.ui\.Label">[\s\S]*?<\/InnerWidget>/.exec(doc.raw)?.[0] ?? "";
    expect(labelBlock).toContain("<![CDATA[账套：]]>");
    expect(labelBlock).not.toContain("5300");
  });

  test("控件不存在 → WIDGET_NOT_FOUND", async () => {
    const doc = await CptDocument.load(FIX);
    expect(() => widgetSetDefault.apply(doc, { widget: "nope_c", value: "x" })).toThrow();
  });

  test("未选模式 → USAGE", async () => {
    const doc = await CptDocument.load(FIX);
    expect(() => widgetSetDefault.apply(doc, { widget: "bookId_c" })).toThrow();
  });
});
