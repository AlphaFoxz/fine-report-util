import { describe, test, expect } from "bun:test";
import { mkdtemp, readFile, writeFile, copyFile, readdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { CptDocument } from "../src/core/CptDocument.ts";

export const FIXTURE = path.resolve(import.meta.dir, "fixtures/fixture-ledger.cpt");

/** 把 fixture 复制到独立临时目录，返回副本路径（测试对副本做修改，不碰 fixture 本体） */
export async function tempCopy(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fru-test-"));
  const dest = path.join(dir, "fixture-ledger.cpt");
  await copyFile(FIXTURE, dest);
  return dest;
}

export async function readText(p: string): Promise<string> {
  const buf = await readFile(p);
  let off = 0;
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) off = 3;
  return buf.subarray(off).toString("utf8");
}

export { describe, test, expect, mkdtemp, readFile, writeFile, readdir, path, os };
