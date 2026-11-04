import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * FrPull — 从 FineReport 远程服务器批量拉取模板文件到本地目录（同名覆盖）。
 *
 * 复用设计器自带的远程工作空间 RPC 通道（FineWorkspaceConnector / WorkResource 代理），
 * 身份认证、密码解密（SecurityToolbox.defaultDecrypt）、序列化全部走 FR 自己的代码，
 * 不自行实现协议。需将 FineReport 安装目录的 jar 全量放上 classpath：
 *   {FR_HOME}/lib/*, {FR_HOME}/server/lib/*, {FR_HOME}/webapps/webroot/WEB-INF/lib/*,
 *   {FR_HOME}/webapps/webroot/WEB-INF/customLib/*, {FR_HOME}/webapps/webroot/WEB-INF/classes
 *
 * 用法: java FrPull <configJsonFile>
 * config JSON:
 *   url       — 决策平台地址，如 http://host:port/webroot/decision
 *   username  — 用户名
 *   password  — 设计器 FineReportEnv.xml 里存的「加密态」密码（本程序内部解密，不落明文）
 *   target    — 本地落地目录（相对 reportlets 的目录结构原样映射，同名覆盖）
 *   prefix    — 远程起始目录，默认 reportlets
 *   ext       — 逗号分隔的扩展名过滤，默认 "cpt"；传 "*" 拉全部文件
 *   stripLevels — 落地前从相对路径剥掉的目录级数（如 prefix=reportlets/TRRPZJ0002
 *                 且 stripLevels=1 时，TRRPZJ0002/pscs/x.cpt 落到 <target>/pscs/x.cpt）
 *   prune     — "true" 时镜像同步：拉取完成后删除 target 下不在服务器清单里的本地文件
 *               （以及随之变空的目录），使本地与服务器完全一致
 *
 * stdout 行协议（供上层 TS 解析）:
 *   PULLED <remotePath> <bytes>
 *   ERROR  <remotePath> <message>
 *   SUMMARY {"ok":true,"files":N,"bytes":N,"errors":N,"elapsed_ms":M}
 */
public class FrPull {

    public static void main(String[] args) throws Exception {
        if (args.length < 1) {
            System.err.println("usage: java FrPull <configJson>");
            System.exit(2);
            return;
        }
        String cfg = new String(Files.readAllBytes(Paths.get(args[0])), StandardCharsets.UTF_8);
        String url = jsonStr(cfg, "url");
        String username = jsonStr(cfg, "username");
        String password = jsonStr(cfg, "password");
        String target = jsonStr(cfg, "target");
        String prefix = jsonStr(cfg, "prefix");
        String ext = jsonStr(cfg, "ext");
        if (url == null || username == null || password == null || target == null) {
            System.out.println("SUMMARY {\"ok\":false,\"error\":\"config missing url/username/password/target\"}");
            System.exit(2);
            return;
        }
        if (prefix == null || prefix.isEmpty()) prefix = "reportlets";
        Set<String> exts = parseExts(ext);
        String stripStr = jsonStr(cfg, "stripLevels");
        int stripLevels = 0;
        if (stripStr != null && stripStr.matches("[0-9]+")) stripLevels = Integer.parseInt(stripStr);
        boolean prune = "true".equalsIgnoreCase(jsonStr(cfg, "prune"));

        // 1. 解密密码（设计器同一套加密，密文来自 FineReportEnv.xml；
        //    设计器读 XML 后会去掉密文里的 \r\n 再解密，这里保持一致）
        String plainPwd;
        String encPwd = password.replace("\r", "").replace("\n", "");
        try {
            plainPwd = com.fr.security.SecurityToolbox.defaultDecrypt(encPwd);
        } catch (Exception e) {
            System.out.println("SUMMARY {\"ok\":false,\"error\":\"password decrypt failed: "
                    + escJson(String.valueOf(e.getMessage())) + "\"}");
            System.exit(3);
            return;
        }
        if (plainPwd == null) {
            System.out.println("SUMMARY {\"ok\":false,\"error\":\"password decrypt returned null\"}");
            System.exit(3);
            return;
        }

        // 2. 注册 JDK 兜底序列化器（设计器启动时由模块机制完成，命令行需手动触发）
        com.fr.serialization.SerializerSummary.getDefault().complete();

        // 3. 连接远程工作空间（与设计器「远程连接」同一通道）
        com.fr.workspace.WorkContext.setConnector(com.fr.workspace.engine.client.FineWorkspaceConnector.getInstance());
        com.fr.workspace.connect.WorkspaceConnectionInfo info =
                new com.fr.workspace.connect.WorkspaceConnectionInfo(url, username, plainPwd, "", "", true);
        com.fr.workspace.connect.WorkspaceClient client;
        try {
            client = com.fr.workspace.engine.client.FineWorkspaceConnector.getInstance().connect(info);
        } catch (Exception e) {
            System.out.println("SUMMARY {\"ok\":false,\"error\":\"connect failed: "
                    + escJson(String.valueOf(e.getMessage())) + "\"}");
            System.exit(4);
            return;
        }

        // 4. 递归拉取
        Path root = Paths.get(target);
        Files.createDirectories(root);
        List<String> pulled = new ArrayList<>();
        List<String> errors = new ArrayList<>();
        Set<String> pulledRel = new HashSet<>();   // strip 后的本地相对路径（prune 用）
        Set<String> localDirs = new HashSet<>();   // target 下涉及/已见的目录（prune 用）
        long[] bytes = new long[]{0};
        int[] pruned = new int[]{0};
        long t0 = System.currentTimeMillis();
        try {
            pull(client.getPool().get(com.fr.workspace.resource.WorkResource.class),
                    prefix, prefix, root, exts, stripLevels, pulled, pulledRel, localDirs, errors, bytes);
            if (prune) {
                pruned[0] = prune(root, root, pulledRel);
                System.out.println("PRUNED " + pruned[0]);
            }
        } finally {
            try { client.close(); } catch (Exception ignore) { }
        }
        String summary = "{\"ok\":true,\"files\":" + pulled.size()
                + ",\"bytes\":" + bytes[0]
                + ",\"errors\":" + errors.size()
                + ",\"pruned\":" + pruned[0]
                + ",\"elapsed_ms\":" + (System.currentTimeMillis() - t0) + "}";
        System.out.println("SUMMARY " + summary);
        if (!errors.isEmpty()) System.exit(1);
    }

    private static void pull(com.fr.workspace.resource.WorkResource res, String remoteDir, String prefix,
                             Path root, Set<String> exts, int stripLevels,
                             List<String> pulled, Set<String> pulledRel, Set<String> localDirs,
                             List<String> errors, long[] bytes) throws Exception {
        String[] names;
        try {
            names = res.list(remoteDir);
        } catch (Exception e) {
            errors.add(remoteDir + " : " + e.getMessage());
            System.out.println("ERROR " + remoteDir + " " + escJson(String.valueOf(e.getMessage())));
            return;
        }
        if (names == null) return;
        for (String name : names) {
            if (name == null || name.isEmpty()) continue;
            String child = remoteDir + "/" + name;
            boolean isDir;
            try {
                isDir = res.isDirectory(child);
            } catch (Exception e) {
                isDir = false;
            }
            try {
                if (isDir) {
                    pull(res, child, prefix, root, exts, stripLevels, pulled, pulledRel, localDirs, errors, bytes);
                } else if (matchExt(name, exts)) {
                    // 相对 prefix 的路径 → 剥掉 stripLevels 级 → 落地路径
                    String rel = child.length() > prefix.length() + 1
                            ? child.substring(prefix.length() + 1) : name;
                    String localRel = strip(rel, stripLevels);
                    Path dest = root.resolve(localRel);
                    if (dest.getParent() != null) {
                        Files.createDirectories(dest.getParent());
                        localDirs.add(root.relativize(dest.getParent()).toString());
                    }
                    byte[] data = res.readFully(child);
                    Files.write(dest, data);
                    bytes[0] += data.length;
                    pulled.add(child);
                    pulledRel.add(localRel);
                    System.out.println("PULLED " + child + " " + data.length);
                }
            } catch (Exception e) {
                errors.add(child + " : " + e.getMessage());
                System.out.println("ERROR " + child + " " + escJson(String.valueOf(e.getMessage())));
            }
        }
    }

    /** 剥掉前 stripLevels 级目录；剥空了落在 target 根 */
    private static String strip(String rel, int stripLevels) {
        if (stripLevels <= 0) return rel;
        String cur = rel;
        for (int i = 0; i < stripLevels; i++) {
            int slash = cur.indexOf('/');
            if (slash < 0) return cur; // 级数比路径还深 → 原样保留文件名
            cur = cur.substring(slash + 1);
        }
        return cur;
    }

    /**
     * 镜像清理：递归删除 dir 下不在 keep 集合里的文件，随后删除变空的目录。
     * 返回删除的文件数。
     */
    private static int prune(Path root, Path dir, Set<String> keep) throws Exception {
        int removed = 0;
        java.util.List<Path> subDirs = new ArrayList<>();
        try (java.util.stream.Stream<Path> stream = Files.list(dir)) {
            java.util.List<Path> children = stream.sorted().collect(java.util.stream.Collectors.toList());
            for (Path p : children) {
                String rel = root.relativize(p).toString().replace('\\', '/');
                if (Files.isDirectory(p)) {
                    subDirs.add(p);
                } else if (!keep.contains(rel)) {
                    Files.delete(p);
                    removed++;
                    System.out.println("PRUNE  " + rel);
                }
            }
        }
        for (Path sub : subDirs) {
            removed += prune(root, sub, keep);
            try (java.util.stream.Stream<Path> s = Files.list(sub)) {
                if (!s.findAny().isPresent()) Files.delete(sub); // 空目录一并删
            }
        }
        return removed;
    }

    private static Set<String> parseExts(String ext) {
        Set<String> set = new HashSet<>();
        if (ext == null || ext.isEmpty() || "*".equals(ext.trim())) return set; // 空 = 全部文件
        for (String e : ext.split(",")) {
            e = e.trim().toLowerCase(Locale.ROOT);
            if (!e.isEmpty()) set.add(e.startsWith(".") ? e : "." + e);
        }
        return set;
    }

    private static boolean matchExt(String name, Set<String> exts) {
        if (exts.isEmpty()) return true;
        int dot = name.lastIndexOf('.');
        String e = dot < 0 ? "" : name.substring(dot).toLowerCase(Locale.ROOT);
        return exts.contains(e);
    }

    /** 极简 JSON 字符串取值（支持常见转义） */
    private static String jsonStr(String json, String key) {
        Matcher m = Pattern.compile("\"" + key + "\"\\s*:\\s*\"(([^\"\\\\]|\\\\.)*)\"").matcher(json);
        if (!m.find()) return null;
        String v = m.group(1);
        return v.replace("\\/", "/")
                .replace("\\\\", "\\")
                .replace("\\\"", "\"")
                .replace("\\r", "\r")
                .replace("\\n", "\n");
    }

    private static String escJson(String s) {
        if (s == null) return "";
        return s.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n").replace("\r", "\\r");
    }
}
