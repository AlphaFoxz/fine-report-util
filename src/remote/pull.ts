/**
 * 远程模板拉取编排器。
 * 原理：调用 java/FrPull.java 编译产物（java/precompiled/FrPull.class，Java 8 字节码），
 * 复用设计器自带的远程工作空间 RPC 通道。TS 层只负责：定位设计器安装目录 → 拼 classpath
 * → 运行 → 解析行协议。
 *
 * 运行时 JDK/JRE 探测顺序：--java-home → JAVA_HOME → <FR_HOME>/jre（设计器自带，Java 8，
 * 无 javac 但能跑）→ 常见安装位置。class 缺失或源码更新且本机有 javac 时才重新编译
 * （--release 8，保证 FR JRE 8 可运行）。即：**用户只需装 FineReport，无需独立 JDK。**
 */
import { join } from "node:path";
import { readdir, readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolveRemoteEnv, type RemoteEnvInfo } from "./env-config.ts";

export interface PullOptions {
  /** 设计器环境名（FineReportEnv.xml 里的 EnvConfigElement name） */
  env?: string;
  url?: string;
  username?: string;
  password?: string;
  /** 本地落地目录（必填） */
  target: string;
  /** 远程起始目录，默认 reportlets */
  prefix?: string;
  /** 落地前剥掉的路径级数（如 prefix=reportlets/TRRPZJ0002 且 strip=1 → <target>/pscs/x.cpt） */
  stripLevels?: number;
  /**
   * 镜像同步：拉取后删除 target 下不在服务器清单里的同扩展名本地文件（含变空目录）。
   * ⚠ 默认 false。开启前确认 target 里没有想保留的本地旧副本（如手工备份）。
   */
  prune?: boolean;
  /** 扩展名过滤，默认 ["cpt"]；["*"] 或空数组 = 全部 */
  ext?: string[];
  /** FineReport 安装目录，默认 FINE_REPORT_HOME 环境变量 → D:\FineReport_11.0 */
  frHome?: string;
  /** 含 javac 的 JDK，默认 JAVA_HOME → 常见安装位置探测 */
  javaHome?: string;
  /** 不打印逐文件进度 */
  quiet?: boolean;
}

export interface PullResult {
  ok: boolean;
  envName: string;
  url: string;
  target: string;
  prefix: string;
  files: number;
  bytes: number;
  /** prune 模式下删除的本地多余文件数 */
  pruned: number;
  errors: string[];
  elapsedMs: number;
}

const DEFAULT_FR_HOMES = ["D:\\FineReport_11.0", "C:\\FineReport_11.0", "D:\\FineReport_11"];
const JDK_CANDIDATES = ["D:\\Programs\\ms-17.0.19", "C:\\Program Files\\Java\\jdk-17"];
/** 运行 FrPull 只需要 java（JRE 即可），javac 仅在需要重新编译时才要求 */
const JAVA_RUNTIME_CANDIDATES = [...JDK_CANDIDATES];

export function resolveFrHome(explicit?: string): string {
  const cands = [explicit, process.env.FINE_REPORT_HOME, ...DEFAULT_FR_HOMES].filter(Boolean) as string[];
  for (const c of cands) {
    if (existsSync(join(c, "lib")) && existsSync(join(c, "webapps", "webroot", "WEB-INF", "lib"))) return c;
  }
  throw Object.assign(new Error("未定位到 FineReport 安装目录（需要 lib/ 与 webapps/webroot/WEB-INF/lib/）"), {
    code: "FR_HOME_NOT_FOUND",
    hint: "用 --fr-home 显式指定，或设置环境变量 FINE_REPORT_HOME",
  });
}

function hasJava(home: string): boolean {
  return existsSync(join(home, "bin", "java.exe")) || existsSync(join(home, "bin", "java"));
}

function hasJavac(home: string): boolean {
  return existsSync(join(home, "bin", "javac.exe")) || existsSync(join(home, "bin", "javac"));
}

/** 运行时 java 目录：--java-home → JAVA_HOME → <FR_HOME>/jre → 常见位置 */
function resolveRuntimeJava(explicit: string | undefined, frHome: string): string {
  const cands = [explicit, process.env.JAVA_HOME, join(frHome, "jre"), ...JAVA_RUNTIME_CANDIDATES].filter(Boolean) as string[];
  for (const c of cands) {
    if (hasJava(c)) return c;
  }
  throw Object.assign(new Error("未找到可用的 JRE/JDK（bin/java）"), {
    code: "JAVA_NOT_FOUND",
    hint: "用 --java-home 指定，或设置 JAVA_HOME（设计器自带 jre 也可以）",
  });
}

/** 拼 FR 全量 classpath（与设计器 designer.bat 一致：lib + server/lib + WEB-INF/lib + customLib + classes） */
async function buildClasspathEntries(frHome: string): Promise<string[]> {
  const jarDirs = [
    join(frHome, "lib"),
    join(frHome, "server", "lib"),
    join(frHome, "webapps", "webroot", "WEB-INF", "lib"),
    join(frHome, "webapps", "webroot", "WEB-INF", "customLib"),
  ];
  const entries: string[] = [];
  for (const d of jarDirs) {
    if (!existsSync(d)) continue;
    for (const f of await readdir(d)) {
      if (f.toLowerCase().endsWith(".jar")) entries.push(join(d, f));
    }
  }
  const classes = join(frHome, "webapps", "webroot", "WEB-INF", "classes");
  if (existsSync(classes)) entries.push(classes);
  return entries;
}

function toArgfileSafe(p: string): string {
  return p.replace(/\\/g, "/");
}

/**
 * 确保 FrPull.class 可用（java/precompiled/，随仓库分发、Java 8 字节码）。
 * 仅当 class 缺失，或 FrPull.java 比 class 新且本机有 javac 时才重新编译（--release 8）。
 */
async function ensureClasses(frHome: string): Promise<string> {
  const libRoot = join(import.meta.dir, "..", ".."); // 仓库根（src/remote/ → 上两级）
  const src = join(libRoot, "java", "FrPull.java");
  const outDir = join(libRoot, "java", "precompiled");
  const cls = join(outDir, "FrPull.class");
  await mkdir(outDir, { recursive: true });
  const [srcSt, clsSt] = await Promise.all([stat(src).catch(() => null), stat(cls).catch(() => null)]);
  const stale = srcSt && (!clsSt || clsSt.mtimeMs < srcSt.mtimeMs);

  if (!clsSt || stale) {
    // 找一个带 javac 的目录（优先系统 JDK；FR 自带 jre 没有 javac）
    const cands = [process.env.JAVA_HOME, ...JDK_CANDIDATES].filter(Boolean) as string[];
    const jdk = cands.find((c) => hasJavac(c));
    if (!jdk) {
      if (clsSt && stale) return outDir; // 有旧 class 先用旧的（源码改动未生效）
      throw Object.assign(new Error(`缺少 ${cls} 且本机找不到 javac，无法编译 FrPull.java`), {
        code: "JAVAC_NOT_FOUND",
        hint: "设置 JAVA_HOME 指向一个 JDK 后重试",
      });
    }
    const entries = await buildClasspathEntries(frHome);
    const cpFile = join(outDir, ".javac-cp.txt");
    await writeFile(cpFile, `-cp "${toArgfileSafe(entries.join(";"))}"\n`, "utf8");
    const javac = hasJavac(jdk) ? join(jdk, "bin", "javac.exe") : join(jdk, "bin", "javac");
    const proc = Bun.spawnSync([
      javac, "-encoding", "UTF-8", "-proc:none", "--release", "8",
      `@${toArgfileSafe(cpFile)}`, "-d", toArgfileSafe(outDir), toArgfileSafe(src),
    ]);
    if (proc.exitCode !== 0) {
      throw Object.assign(new Error(`FrPull.java 编译失败：\n${proc.stderr.toString()}`), { code: "JAVAC_FAILED" });
    }
  }
  return outDir;
}

export async function pullTemplates(opts: PullOptions): Promise<PullResult> {
  const env: RemoteEnvInfo = await resolveRemoteEnv(opts);
  const frHome = resolveFrHome(opts.frHome);
  const javaHome = resolveRuntimeJava(opts.javaHome, frHome);
  const classesDir = await ensureClasses(frHome);

  const prefix = opts.prefix ?? "reportlets";
  const ext = opts.ext && opts.ext.length > 0 && !opts.ext.includes("*") ? opts.ext.join(",") : "*";

  const work = join(tmpdir(), "fr-pull-" + Date.now());
  await mkdir(work, { recursive: true });
  const cfgFile = join(work, "cfg.json");
  await writeFile(
    cfgFile,
    JSON.stringify({
      url: env.url,
      username: env.username,
      password: env.password,
      target: opts.target,
      prefix,
      ext,
      stripLevels: opts.stripLevels ?? 0,
      prune: opts.prune ? "true" : "false",
    }),
    "utf8",
  );

  const entries = await buildClasspathEntries(frHome);
  // Java 8（FR 自带 jre）不支持 @argfile，直接传 -cp（jar 路径总长远低于 Windows 32K 限制）
  const cpArg = [toArgfileSafe(classesDir), ...entries.map(toArgfileSafe)].join(";");

  const java = join(javaHome, "bin", "java");
  const javaExe = existsSync(java) ? java : join(javaHome, "bin", "java.exe");
  const proc = Bun.spawn(
    [javaExe, "-Dfile.encoding=UTF-8", "-Djava.awt.headless=true", "-cp", cpArg, "FrPull", toArgfileSafe(cfgFile)],
    { stdout: "pipe", stderr: "pipe" },
  );

  const errors: string[] = [];
  let files = 0;
  let bytes = 0;
  let pruned = 0;
  let summary: { ok: boolean; files?: number; bytes?: number; errors?: number; pruned?: number; elapsed_ms?: number; error?: string } | null = null;

  // 行协议解析：PULLED / ERROR / SUMMARY
  const decoder = new TextDecoder("utf-8");
  const reader = proc.stdout.getReader();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (value) buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      if (line.startsWith("PULLED ")) {
        files++;
        const size = Number(line.split(" ").pop());
        if (Number.isFinite(size)) bytes += size;
        if (!opts.quiet) console.log(line);
      } else if (line.startsWith("PRUNE  ")) {
        if (!opts.quiet) console.log(line);
      } else if (line.startsWith("PRUNED ")) {
        pruned = Number(line.slice(7)) || 0;
      } else if (line.startsWith("ERROR ")) {
        errors.push(line.slice(6));
        if (!opts.quiet) console.error(line);
      } else if (line.startsWith("SUMMARY ")) {
        try { summary = JSON.parse(line.slice(8)); } catch { /* ignore */ }
      }
    }
    if (done) break;
  }
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  // 清理临时目录里的配置（含密文）
  await writeFile(cfgFile, "").catch(() => {});

  if (!summary) {
    throw Object.assign(
      new Error(`FrPull 未返回 SUMMARY（exit=${exitCode}）${stderr ? `\nstderr: ${stderr.slice(-2000)}` : ""}`),
      { code: "PULL_FAILED" },
    );
  }
  if (summary.ok === false) {
    throw Object.assign(new Error(summary.error ?? "FrPull 失败"), { code: "PULL_FAILED" });
  }
  return {
    ok: true,
    envName: env.name,
    url: env.url,
    target: opts.target,
    prefix,
    files: summary.files ?? files,
    bytes: summary.bytes ?? bytes,
    pruned: summary.pruned ?? pruned,
    errors: errors.length > 0 ? errors : [],
    elapsedMs: summary.elapsed_ms ?? 0,
  };
}
