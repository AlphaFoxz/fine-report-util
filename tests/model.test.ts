import { describe, test, expect } from "bun:test";
import { CptDocument } from "../src/core/CptDocument.ts";
import { tempCopy } from "./helpers.ts";

describe("只读模型", () => {
  test("audit：主扩展格 / 数据行 / 数据集 / 参数缺失告警", async () => {
    const doc = await CptDocument.load(await tempCopy());
    const m = doc.model;

    expect(m.masterAddress).toBe("C2");
    expect(m.dataRow).toBe(1);
    expect(m.datasets.map((d) => d.name).sort()).toEqual(["付款发票", "台账", "收款发票"]);

    // fixture 的台账 SQL 引用了 ${acctset} 但没注册 ReportParameter —— 必须告警
    expect(m.params.referencedInSql).toContain("acctset");
    expect(m.params.missing).toContain("acctset");
    expect(m.warnings.join("\n")).toContain("acctset");
  });

  test("逐格绑定解析：文本/公式/主格/组格/空格", async () => {
    const doc = await CptDocument.load(await tempCopy());
    const cells = doc.model.cells;

    const header = cells.find((c) => c.col === 1 && c.row === 0)!;
    expect(header.binding).toEqual({ kind: "text", text: "供应商" });
    expect(header.styleRef).toBe("1");

    const seq = cells.find((c) => c.col === 0 && c.row === 1)!;
    expect(seq.binding).toEqual({ kind: "formula", expression: "=&C2" });
    expect(seq.expand.leftParent).toBe("C2");

    const master = cells.find((c) => c.col === 2 && c.row === 1)!;
    expect(master.binding.kind).toBe("ds");
    if (master.binding.kind === "ds") {
      expect(master.binding.ds).toBe("台账");
      expect(master.binding.column).toBe("NM_CODE");
      expect(master.binding.grouper).toBe("function");
    }
    expect(master.expand.dir).toBe("0");

    const group = cells.find((c) => c.col === 3 && c.row === 1)!;
    expect(group.binding.kind).toBe("ds");
    if (group.binding.kind === "ds") {
      expect(group.binding.grouper).toBe("mono");
      expect(group.binding.filterRef).toEqual({ ds: "台账", column: "NM_CODE" });
    }
    expect(group.expand).toEqual({ dir: "0", leftParent: "C2" });

    const blank = cells.find((c) => c.col === 4 && c.row === 1)!;
    expect(blank.binding.kind).toBe("empty");
    expect(blank.styleRef).toBe("3"); // 空格也有样式引用 —— 格式资产
  });
});
