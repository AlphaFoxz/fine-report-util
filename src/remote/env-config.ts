/**
 * 设计器远程连接配置解析。
 * 来源：%USERPROFILE%\.FineReport115\FineReportEnv.xml（版本号随设计器变化，做通配枚举）。
 * 注意：这里拿到的 password 是设计器加密态密文，解密由 java/FrPull.java 内的
 * SecurityToolbox.defaultDecrypt 完成，本层不接触明文。
 */
import { join, dirname } from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { XMLParser } from "fast-xml-parser";

export interface RemoteEnvInfo {
  /** 设计器里显示的环境名，如「远程服务器2」 */
  name: string;
  /** 决策平台地址，如 http://host/webroot/decision */
  url: string;
  username: string;
  /** 加密态密码（解密在 FrPull.java 内做） */
  password: string;
}

export interface FineReportEnvFile {
  dir: string;
  currentEnv?: string;
  remoteEnvs: RemoteEnvInfo[];
}

/** 解析 FineReportEnv.xml 文本 → 远程环境清单（导出以便测试） */
export function parseFineReportEnvXml(xml: string): { currentEnv?: string; remoteEnvs: RemoteEnvInfo[] } {
  // fast-xml-parser 不解码数字字符引用（&#13; 等），先手动解码
  const decoded = xml
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)));
  const parser = new XMLParser({ ignoreAttributes: false, isArray: (name) => name === "EnvConfigElement" });
  const doc = parser.parse(decoded) as Record<string, unknown>;
  const designer = doc.Designer as Record<string, unknown> | undefined;
  const map = designer?.EnvConfigMap as Record<string, unknown> | undefined;
  const elements = (map?.EnvConfigElement ?? []) as Array<Record<string, unknown>>;
  const remoteEnvs: RemoteEnvInfo[] = [];
  for (const el of elements) {
    const remote = el.Remote as Record<string, unknown> | undefined;
    if (!remote) continue;
    const conn = remote.Connection as Record<string, string> | undefined;
    if (!conn) continue;
    const name = (el["@_name"] as string) ?? "";
    remoteEnvs.push({
      name,
      url: conn["@_url"] ?? "",
      username: conn["@_username"] ?? "",
      password: conn["@_password"] ?? "",
    });
  }
  return { currentEnv: map?.["@_currentEnv"] as string | undefined, remoteEnvs };
}

/** 枚举 %USERPROFILE%\.FineReport* 目录（按名字倒序 = 版本号高的优先） */
export async function findFineReportEnvFiles(): Promise<FineReportEnvFile[]> {
  const home = homedir();
  const out: FineReportEnvFile[] = [];
  let entries: string[];
  try {
    entries = await readdir(home);
  } catch {
    return out;
  }
  const dirs = entries
    .filter((n) => n.startsWith(".FineReport"))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  for (const d of dirs) {
    const file = join(home, d, "FineReportEnv.xml");
    let xml: string;
    try {
      xml = await readFile(file, "utf8");
    } catch {
      continue;
    }
    const parsed = parseFineReportEnvXml(xml);
    if (parsed.remoteEnvs.length > 0) {
      out.push({ dir: dirname(file), currentEnv: parsed.currentEnv, remoteEnvs: parsed.remoteEnvs });
    }
  }
  return out;
}

/**
 * 选出要用的远程环境：
 * 1) 显式 url/username/password 优先（完全自备连接信息）
 * 2) 按 env 名匹配（在所有 .FineReport* 目录里找）
 * 3) 默认取第一个含远程环境的文件里的 currentEnv，其次第一个远程环境
 */
export async function resolveRemoteEnv(opts: {
  env?: string;
  url?: string;
  username?: string;
  password?: string;
}): Promise<RemoteEnvInfo> {
  if (opts.url && opts.username && opts.password) {
    return { name: "(manual)", url: opts.url, username: opts.username, password: opts.password };
  }
  const files = await findFineReportEnvFiles();
  if (files.length === 0) {
    throw Object.assign(new Error("未找到设计器远程连接配置（%USERPROFILE%/.FineReport*/FineReportEnv.xml 无远程环境）"), {
      code: "ENV_NOT_FOUND",
      hint: "先在设计器里配置一次远程连接并勾选记住密码，或用 --url/--username/--password 直接指定",
    });
  }
  if (opts.env) {
    for (const f of files) {
      const hit = f.remoteEnvs.find((e) => e.name === opts.env);
      if (hit) return hit;
    }
    throw Object.assign(new Error(`找不到名为「${opts.env}」的远程环境`), { code: "ENV_NOT_FOUND" });
  }
  const first = files[0];
  if (!first) throw Object.assign(new Error("配置文件里没有远程环境"), { code: "ENV_NOT_FOUND" });
  if (first.currentEnv) {
    const hit = first.remoteEnvs.find((e) => e.name === first.currentEnv);
    if (hit) return hit;
  }
  const fallback = first.remoteEnvs[0];
  if (!fallback) throw Object.assign(new Error("配置文件里没有远程环境"), { code: "ENV_NOT_FOUND" });
  return fallback;
}
