/**
 * widget-set-default：设置参数面板控件的默认值。
 *
 * 定位 `<InnerWidget>` 块（按 `<WidgetName name="X"/>` 精确匹配，不会误伤
 * `Label` 前缀的同名标签控件），改写其中已有 `<widgetValue>` 或在块尾插入。
 * 三种形态：文本值（CDATA）/ 公式（如 =TODAY()）/ 清空。
 * widgetValue 不在保护区清单内；样式与控件其余属性原样保留。
 */
import { assertCdataSafe } from "../core/surgery.ts";
import type { CptDocument } from "../core/CptDocument.ts";
import type { OpResult } from "../core/types.ts";
import type { Operation } from "./types.ts";

export interface WidgetSetDefaultInput {
  /** 控件名（widgetName，如 bookId_c；标签控件名是 Labelxxx，勿混淆） */
  widget: string;
  /** 文本默认值（CDATA 安全自动断言）；与 formula/clear 三选一 */
  value?: string;
  /** 公式默认值（如 =MONTHDELTA(TODAY(),-1)）；CDATA 安全自动断言 */
  formula?: string;
  /** 清空默认值 */
  clear?: boolean;
}

export const widgetSetDefault: Operation<WidgetSetDefaultInput> = {
  name: "widget-set-default",
  description:
    "设置参数面板控件默认值（text / formula / clear 三选一）。按 WidgetName 精确匹配 InnerWidget 块，" +
    "只改 <widgetValue>，控件其余属性（字典/校验/样式）原样保留。",
  inputSchema: {
    type: "object",
    properties: {
      widget: { type: "string", description: "控件名（widgetName）" },
      value: { type: "string", description: "文本默认值" },
      formula: { type: "string", description: "公式默认值（=开头，不含等号也可）" },
      clear: { type: "boolean", description: "清空默认值" },
    },
    required: ["widget"],
  },
  examples: [
    `widget set-default 台账.cpt --widget bookId_c --value 5300 --write`,
    `widget set-default 台账.cpt --widget beginDate_c --formula "=MONTHDELTA(TODAY(),-1)" --write`,
    `widget set-default 台账.cpt --widget beginDate_c --clear --write`,
  ],
  apply(doc: CptDocument, input: WidgetSetDefaultInput): OpResult {
    const modes = [input.value !== undefined, input.formula !== undefined, input.clear === true].filter(Boolean);
    if (modes.length !== 1) {
      throw Object.assign(
        new Error("value / formula / clear 必须三选一"),
        { code: "USAGE", hint: "示例：--widget bookId_c --value 5300" },
      );
    }
    let inner: string;
    if (input.formula !== undefined) {
      const f = input.formula.startsWith("=") ? input.formula : "=" + input.formula;
      assertCdataSafe(f, `widget ${input.widget} formula`);
      inner = `<O t="XMLable" class="com.fr.base.Formula">\n<Attributes>\n<![CDATA[${f}]]></Attributes>\n</O>`;
    } else if (input.clear) {
      inner = "<O>\n<![CDATA[]]></O>";
    } else {
      assertCdataSafe(input.value ?? "", `widget ${input.widget} value`);
      inner = `<O>\n<![CDATA[${input.value}]]></O>`;
    }
    const newValue = `<widgetValue>\n${inner}\n</widgetValue>`;

    const raw = doc.raw;
    const blocks = [...raw.matchAll(/<InnerWidget(?:\s[^>]*)?>[\s\S]*?<\/InnerWidget>/g)];
    const hit = blocks.find((b) => b[0].includes(`<WidgetName name="${input.widget}"/>`));
    if (!hit) {
      throw Object.assign(
        new Error(`widget not found: ${input.widget}`),
        {
          code: "WIDGET_NOT_FOUND",
          hint: "用 audit 的 params.formWidgetNames 核对控件名；标签控件名带 Label 前缀",
        },
      );
    }
    const block = hit[0];
    let newBlock: string;
    const vm = /<widgetValue>[\s\S]*?<\/widgetValue>/.exec(block);
    if (vm) {
      newBlock = block.slice(0, vm.index) + newValue + block.slice(vm.index + vm[0].length);
    } else {
      newBlock = block.replace(/<\/InnerWidget>\s*$/, newValue + "\n</InnerWidget>");
    }
    if (newBlock === block) {
      return { ok: true, op: this.name, summary: "no change (same default already set)" };
    }
    doc.applySpanEdit({
      start: hit.index,
      end: hit.index + block.length,
      replacement: newBlock,
      description: `set default of widget ${input.widget}`,
    });
    return {
      ok: true,
      op: this.name,
      summary: `widget ${input.widget} default ${
        input.clear ? "cleared" : input.formula !== undefined ? `set to formula ${input.formula}` : `set to "${input.value}"`
      }`,
      detail: { before: block, after: newBlock },
      next: "save 后在设计器里打开参数面板核对该控件的默认值",
    };
  },
} satisfies Operation<WidgetSetDefaultInput>;
