import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  editorJsonToMarkdown,
  markdownToEditorHtml,
  type EditorJsonNode,
} from "../src/features/vault/utils/vaultMarkdownCodec.ts";

describe("vaultMarkdownCodec", () => {
  it("converts headings, formatting, wikilinks, math, callouts, images, tasks, and tables to editor HTML", () => {
    const md = [
      "# K-Means",
      "",
      "Text with **bold**, *italic*, `code`, ==mark==, [[Dijkstra|Shortest Path]], and $x^2 + y^2$.",
      "",
      "![So do](_assets/123-graph.png)",
      "",
      "> [!tip] Meo thi",
      "> Ghi nho cong thuc.",
      "",
      "- [ ] Lam lab",
      "- [x] Nop bai",
      "",
      "$$",
      "\\sum_{i=1}^n x_i",
      "$$",
      "",
      "| Mon | Tin |",
      "| --- | --- |",
      "| CS115 | 4 |",
    ].join("\n");

    const html = markdownToEditorHtml(md);
    assert.match(html, /<h1>K-Means<\/h1>/);
    assert.match(html, /<strong>bold<\/strong>/);
    assert.match(html, /<em>italic<\/em>/);
    assert.match(html, /<code>code<\/code>/);
    assert.match(html, /<mark>mark<\/mark>/);
    assert.match(html, /data-wikilink="Dijkstra"/);
    assert.match(html, /data-inline-math="x\^2 \+ y\^2"/);
    assert.match(html, /data-vault-src="_assets\/123-graph\.png"/);
    assert.match(html, /data-callout="tip"/);
    assert.match(html, /data-type="taskList"/);
    assert.match(html, /data-checked="true"/);
    assert.match(html, /data-block-math="\\sum_\{i=1\}\^n x_i"/);
    assert.match(html, /<table><thead><tr><th><p>Mon<\/p><\/th>/);
  });

  it("terminates cleanly on non-table pipe lines and currency signs", () => {
    const md = ["|-- folder/", "|x| <= 1", "Gia $5 va $10"].join("\n");
    const html = markdownToEditorHtml(md);
    assert.match(html, /\|-- folder\//);
    assert.doesNotMatch(html, /<table>/);
  });

  it("serializes TipTap JSON back to clean Obsidian Markdown", () => {
    const doc: EditorJsonNode = {
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Tong quan" }] },
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Xem " },
            { type: "wikilink", attrs: { target: "Spectral Clustering", label: "Spectral" } },
            { type: "text", text: " voi " },
            { type: "inlineMath", attrs: { latex: "L = D - W" } },
            { type: "text", text: " va " },
            { type: "text", text: "chu y", marks: [{ type: "highlight" }, { type: "bold" }] },
          ],
        },
        {
          type: "image",
          attrs: { vaultSrc: "_assets/999-chart.png", src: "data:image/png;base64,AAA", alt: "Chart" },
        },
        {
          type: "callout",
          attrs: { kind: "warning", title: "Luu y" },
          content: [{ type: "paragraph", content: [{ type: "text", text: "Kiem tra dieu kien bien" }] }],
        },
        {
          type: "taskList",
          content: [
            {
              type: "taskItem",
              attrs: { checked: false },
              content: [{ type: "paragraph", content: [{ type: "text", text: "On tap" }] }],
            },
            {
              type: "taskItem",
              attrs: { checked: true },
              content: [{ type: "paragraph", content: [{ type: "text", text: "Hoan thanh" }] }],
            },
          ],
        },
        { type: "blockMath", attrs: { latex: "E = mc^2" } },
      ],
    };

    const md = editorJsonToMarkdown(doc);
    assert.equal(
      md,
      [
        "## Tong quan",
        "",
        "Xem [[Spectral Clustering|Spectral]] voi $L = D - W$ va **==chu y==**",
        "",
        "![Chart](_assets/999-chart.png)",
        "",
        "> [!warning] Luu y",
        "> Kiem tra dieu kien bien",
        "",
        "- [ ] On tap",
        "- [x] Hoan thanh",
        "",
        "$$",
        "E = mc^2",
        "$$",
        "",
      ].join("\n")
    );
  });
});
