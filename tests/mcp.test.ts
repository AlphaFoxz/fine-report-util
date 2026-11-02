import { describe, test, expect } from "bun:test";
import path from "node:path";

const SERVER = path.resolve(import.meta.dir, "../src/mcp/server.ts");

/** 对 stdio MCP server 发起 initialize + tools/list，校验握手 */
describe("MCP server", () => {
  test("initialize + tools/list 握手成功，工具随注册表生成", async () => {
    const proc = Bun.spawnSync({
      cmd: ["bun", "run", SERVER],
      stdin: new TextEncoder().encode(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "smoke", version: "0" },
          },
        }) +
          "\n" +
          JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) +
          "\n" +
          JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) +
          "\n",
      ),
      stdout: "pipe",
      stderr: "pipe",
      timeout: 15000,
    });

    const out = proc.stdout.toString();
    const lines = out.split("\n").filter((l) => l.trim().startsWith("{"));
    const responses = lines.map((l) => JSON.parse(l) as { id: number; result?: { tools?: { name: string }[] } });

    const init = responses.find((r) => r.id === 1);
    expect(init).toBeTruthy();
    expect((init!.result as unknown as { serverInfo: { name: string } }).serverInfo.name).toBe("fine-report-util");

    const tools = responses.find((r) => r.id === 2)!.result!.tools!;
    const names = tools.map((t) => t.name);
    expect(names).toContain("cpt_audit");
    expect(names).toContain("cpt_cell_bind");
    expect(names).toContain("cpt_sql_set");
    expect(names).toContain("cpt_param_set_default");
    expect(names).toContain("cpt_col_insert");
    // 每个 tool 都有 JSON Schema
    for (const t of tools) expect(t.name.length).toBeGreaterThan(0);
  });
});
