---
name: docx
description: 用 docx 库生成排版规整的 Word 文档（报告、方案、公文、合同草稿），以及改写已有 .docx 里的文字
---

# Word 文档技能

生成 .docx 用 run_node 跑 `docx` 这个库（项目自带，直接 `require("docx")`）。
不要拼 XML、不要先写 HTML 再转——那样出来的文件在 WPS 里常常乱版。

## 基本模板

```js
const fs = require("fs");
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
  Table, TableRow, TableCell, WidthType, ShadingType, Header, Footer, PageNumber,
  TableOfContents, LevelFormat, PageBreak,
} = require("docx");

// 中文字体要单独给 eastAsia，只写一个字体名的话中文会落回宋体
const FONT = { ascii: "Calibri", hAnsi: "Calibri", eastAsia: "微软雅黑" };
const th = (t) => new TableCell({
  shading: { type: ShadingType.CLEAR, color: "auto", fill: "1F4E79" },
  children: [new Paragraph({ children: [new TextRun({ text: t, bold: true, color: "FFFFFF" })] })],
});
const td = (t, right) => new TableCell({
  children: [new Paragraph({ alignment: right ? AlignmentType.RIGHT : AlignmentType.LEFT, text: String(t) })],
});

const doc = new Document({
  features: { updateFields: true },            // 有目录时要它：打开时让 Word 刷新页码
  styles: { default: { document: { run: { font: FONT, size: 22 } } } },   // size 单位是半磅，22 = 11 磅
  numbering: { config: [{ reference: "dots", levels: [{
    level: 0, format: LevelFormat.BULLET, text: "•", alignment: AlignmentType.LEFT,
    style: { paragraph: { indent: { left: 420, hanging: 260 } } },
  }] }] },
  sections: [{
    properties: { page: { margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 } } },  // 1440 = 1 英寸
    headers: { default: new Header({ children: [new Paragraph({ alignment: AlignmentType.RIGHT,
      children: [new TextRun({ text: "某某公司 · 内部资料", size: 18, color: "888888" })] })] }) },
    footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER,
      children: [new TextRun({ children: ["第 ", PageNumber.CURRENT, " 页 / 共 ", PageNumber.TOTAL_PAGES, " 页"], size: 18 })] })] }) },
    children: [
      new Paragraph({ heading: HeadingLevel.TITLE, alignment: AlignmentType.CENTER, text: "2026 年三季度经营报告" }),
      new TableOfContents("目录", { hyperlink: true, headingStyleRange: "1-3" }),
      new Paragraph({ children: [new PageBreak()] }),
      new Paragraph({ heading: HeadingLevel.HEADING_1, text: "一、总体情况" }),
      new Paragraph({ children: [
        new TextRun("本季度营收 "), new TextRun({ text: "1,234 万元", bold: true }), new TextRun("，同比增长 18%。"),
      ] }),
      new Paragraph({ numbering: { reference: "dots", level: 0 }, text: "新签客户 42 家" }),
      new Paragraph({ heading: HeadingLevel.HEADING_1, text: "二、分产品数据" }),
      new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: [
          new TableRow({ tableHeader: true, children: [th("产品"), th("营收（万元）"), th("同比")] }),
          new TableRow({ children: [td("A 系列"), td("812.0", true), td("+21%", true)] }),
        ],
      }),
    ],
  }],
});

// run_node 按 CommonJS 跑，顶层不能写 await
Packer.toBuffer(doc).then((buf) => fs.writeFileSync("经营报告.docx", buf));
```

## 规范

- **标题用 HeadingLevel，不要用加粗大字冒充标题**。目录、导航窗格、大纲视图全靠标题级别认，
  假标题在这三处都不存在
- 列表用 numbering 配置，不要在文字前面手打「•」「1.」——手打的列表一改动就对不齐，也没法续号
- 表格宽度给百分比；表头行加 `tableHeader: true`，跨页时表头会在下一页重复
- 数字列右对齐；金额写千分位
- 插图：`new ImageRun({ type: "png", data: fs.readFileSync("图.png"), transformation: { width: 480, height: 270 } })`，
  放进一个 Paragraph 的 children 里。`type` 必须写，这一版的库不写会报错
- 分页用 `new PageBreak()`，不要连打一串空段落把内容顶到下一页
- 公文类（红头、文号、落款）：页边距按上 37mm 下 35mm 左 28mm 右 26mm，正文仿宋三号（size 32），
  标题小标宋二号（size 44）。本机没有这些字体时照写字体名，对方电脑上有就会生效

## 改已有的 .docx

.docx 是个 zip，正文在 `word/document.xml`。只改几处文字时用项目自带的 jszip：

```js
const fs = require("fs");
const JSZip = require("jszip");
(async () => {
  const zip = await JSZip.loadAsync(fs.readFileSync("合同.docx"));
  let xml = await zip.file("word/document.xml").async("string");
  xml = xml.split("甲方名称").join("某某科技有限公司");
  zip.file("word/document.xml", xml);
  fs.writeFileSync("合同-已改.docx", await zip.generateAsync({ type: "nodebuffer" }));
})();
```

- 先确认要换的文字在 XML 里是连着的。Word 常把一句话拆进好几个 `<w:r>`（改过格式、拼写检查过的地方尤其多），
  拆开了的话 `split/join` 找不到，要先把那一段的几个 run 合并，再替换
- 替换的文字里有 `&` `<` `>` 要先转义，不然文件打不开
- 结构性的改动（加章节、改表格）不要在 XML 上动刀，读出内容后用上面的模板重新生成一份

## 交付前自查

- 用 read_document 把生成的文件读回来，看一遍标题层级和表格内容是不是都在
- 文件名用中文说清是什么（「三季度经营报告.docx」），不要叫 output.docx
