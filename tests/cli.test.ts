import { describe, test, expect, afterAll } from "bun:test";
import { mkdtemp, copyFile, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { FIXTURE } from "./helpers.ts";

const CLI = path.resolve(import.meta.dir, "../src/cli/index.ts");

let tmp: string;
async function tmpDir(): Promise<string> {
  if (!tmp) tmp = await mkdtemp(path.join(os.tmpdir(), "fru-cli-"));
  return tmp;
}

async function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawnSync(["bun", "run", CLI, ...args]);
  return {
    code: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

describe("CLI", () => {
  test("audit --json --ascii：结构完整且非 ASCII 被转义", async () => {
    const r = await run(["audit", FIXTURE, "--json", "--ascii"]);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.masterAddress).toBe("C2");
    expect(out.dataRow).toBe(1);
    expect(out.cellCount).toBe(12);
    expect(out.params.missing).toContain("acctset");
    // ascii 转义生效
    expect(r.stdout).not.toMatch(/[^\x00-\x7F]/);
  });

  test("list --row 1：只看数据行", async () => {
    const r = await run(["list", FIXTURE, "--row", "1", "--json", "--ascii"]);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.cellCount).toBe(6);
    expect(out.cells.every((c: { r: number }) => c.r === 1)).toBe(true);
  });

  test("cell set dry-run：不落盘", async () => {
    const dir = await tmpDir();
    const p = path.join(dir, "dry.cpt");
    await copyFile(FIXTURE, p);
    const before = await readFile(p);

    const r = await run(["cell", "set", p, "--c", "1", "--r", "1", "--spec", "ds:台账:PUR_AMT", "--json", "--ascii"]);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.ok).toBe(true);
    expect(out.saved).toBeUndefined(); // dry-run 无 saved 载荷
    expect(await readFile(p)).toEqual(before);
  });

  test("cell set --write：落盘 + 自动备份", async () => {
    const dir = await tmpDir();
    const p = path.join(dir, "w.cpt");
    await copyFile(FIXTURE, p);

    const r = await run(["cell", "set", p, "--c", "1", "--r", "1", "--spec", "ds:台账:PUR_AMT", "--write", "--json", "--ascii"]);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.saved.diffStat).toEqual({ added: 1, removed: 1 });

    const after = await readFile(p, "utf8");
    expect(after).toContain('columnName="PUR_AMT"');
    // 备份存在且是原文
    const bakEntry = Object.keys({});
    const dirEntries = await (await import("node:fs/promises")).readdir(dir);
    const bak = dirEntries.find((f) => f.includes("-bak-"));
    expect(bak).toBeTruthy();
    const bakText = await readFile(path.join(dir, bak!), "utf8");
    expect(bakText).toContain('columnName="PUR_SUPPLIER"');
  });

  test("ops：能力自描述", async () => {
    const r = await run(["ops", "--json", "--ascii"]);
    expect(r.code).toBe(0);
    const ops = JSON.parse(r.stdout);
    expect(ops.map((o: { name: string }) => o.name).sort()).toEqual([
      "cell-bind",
      "col-insert",
      "col-remove",
      "ds-rename-column",
      "param-list",
      "param-remove",
      "param-set-default",
      "row-append",
      "sql-set",
    ]);
    for (const o of ops) {
      expect(o.inputSchema.type).toBe("object");
      expect(o.examples.length).toBeGreaterThan(0);
    }
  });

  test("错误输出为结构化 JSON（含 code + hint）", async () => {
    const r = await run(["cell", "set", FIXTURE, "--c", "99", "--r", "99", "--spec", "blank", "--json", "--ascii"]);
    expect(r.code).toBe(1);
    const err = JSON.parse(r.stderr);
    expect(err.code).toBe("CELL_NOT_FOUND");
    expect(err.hint).toBeTruthy();
  });
});
