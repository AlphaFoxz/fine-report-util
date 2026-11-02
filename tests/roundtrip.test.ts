import { describe, test, expect } from "bun:test";
import { CptDocument } from "../src/core/CptDocument.ts";
import { FIXTURE, tempCopy, readText } from "./helpers.ts";
import { readFile } from "node:fs/promises";

describe("保真不变量", () => {
  test("load → 无操作 → save 输出与原文 byte-identical", async () => {
    const p = await tempCopy();
    const doc = await CptDocument.load(p);
    expect(doc.dirty).toBe(false);

    const result = await doc.save({ backup: false });
    expect(result.xmlValid).toBe(true);
    expect(result.protectedViolations).toHaveLength(0);
    expect(result.diffStat).toEqual({ added: 0, removed: 0 });

    // 保存后的副本与 fixture 本体逐字节一致
    const [orig, after] = await Promise.all([readFile(FIXTURE), readFile(p)]);
    expect(after.equals(orig)).toBe(true);
  });

  test("fixture 本体不被任何测试污染", async () => {
    const text = await readText(FIXTURE);
    expect(text).toContain("MonoGrouper");
  });
});
