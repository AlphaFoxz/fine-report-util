import { describe, test, expect } from "bun:test";
import { parseFineReportEnvXml } from "../src/remote/env-config.ts";

const FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<Designer xmlVersion="20211223" releaseVersion="11.5.0">
  <Attributes DialogCurrentDirectory="reportlets/TRRPZJ0002/pscs"/>
  <RecentOpenedFilePath/>
  <EnvConfigMap currentEnv="远程服务器2">
    <EnvConfigElement name="默认">
      <Local class="com.fr.design.env.LocalDesignerWorkspaceInfo" name="" path="D:\\FineReport_11.0\\webapps\\webroot\\WEB-INF"/>
    </EnvConfigElement>
    <EnvConfigElement name="远程服务器2">
      <Remote class="com.fr.design.env.RemoteDesignerWorkspaceInfo" name="" remindTime="" newCreated="true">
        <Connection url="http://10.81.107.15/webroot/decision" username="TRRPZJ0002" password="abc123&#13;&#10;xyz==" certPath="" certSecretKey="" rememberPwd="true"/>
      </Remote>
    </EnvConfigElement>
  </EnvConfigMap>
</Designer>`;

describe("remote env-config", () => {
  test("解析远程环境（含 &#13;&#10; 实体、中文环境名）", () => {
    const { currentEnv, remoteEnvs } = parseFineReportEnvXml(FIXTURE);
    expect(currentEnv).toBe("远程服务器2");
    expect(remoteEnvs.length).toBe(1);
    const env = remoteEnvs[0];
    expect(env).toBeDefined();
    expect(env!.name).toBe("远程服务器2");
    expect(env!.url).toBe("http://10.81.107.15/webroot/decision");
    expect(env!.username).toBe("TRRPZJ0002");
    // 数字字符引用已解码；解析器会把属性值里的 \r\n 规范为 \n
    expect(env!.password).toBe("abc123\nxyz==");
  });

  test("纯本地环境 → 空清单", () => {
    const { remoteEnvs } = parseFineReportEnvXml(
      `<Designer><EnvConfigMap currentEnv="默认"><EnvConfigElement name="默认"><Local path="X"/></EnvConfigElement></EnvConfigMap></Designer>`,
    );
    expect(remoteEnvs.length).toBe(0);
  });
});
