import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseMarkdownBlocks } from "../src/features/vault/utils/markdownBlocks.ts";

describe("parseMarkdownBlocks", () => {
  it("terminates cleanly on lines starting with pipe without a table separator", () => {
    const md = [
      "|-- src/",
      "|x - y| <= 1",
      "|",
      "Trailing line",
    ].join("\n");

    const blocks = parseMarkdownBlocks(md);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].type, "paragraph");
    assert.equal(blocks[0].text, "|-- src/ |x - y| <= 1 | Trailing line");
  });

  it("handles empty heading markers and level-5 headings without looping", () => {
    const md = ["# ", "##", "##### Deep heading", "Normal body"].join("\n");

    const blocks = parseMarkdownBlocks(md);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].type, "paragraph");
    assert.equal(blocks[0].text, "#  ## ##### Deep heading Normal body");
  });

  it("parses valid markdown tables and resumes normal blocks afterward", () => {
    const md = [
      "| Mon | Tin |",
      "| --- | --- |",
      "| CS115 | 4 |",
      "| IT004 | 4 |",
      "Done",
    ].join("\n");

    const blocks = parseMarkdownBlocks(md);
    assert.equal(blocks.length, 2);
    assert.deepEqual(blocks[0], {
      type: "table",
      startLine: 0,
      headers: ["Mon", "Tin"],
      rows: [
        ["CS115", "4"],
        ["IT004", "4"],
      ],
    });
    assert.deepEqual(blocks[1], {
      type: "paragraph",
      startLine: 4,
      text: "Done",
    });
  });

  it("parses code blocks (including unclosed), callouts, checklists, ordered lists, and hr", () => {
    const md = [
      "> [!tip] Meo",
      "> Line 1",
      "",
      "- [ ] Todo",
      "- [x] Done",
      "",
      "1. First",
      "2. Second",
      "",
      "---",
      "",
      "```python",
      "print(1)",
    ].join("\n");

    const blocks = parseMarkdownBlocks(md);
    assert.equal(blocks.length, 5);
    assert.deepEqual(blocks[0], {
      type: "callout",
      startLine: 0,
      kind: "tip",
      customTitle: "Meo",
      lines: ["Line 1"],
    });
    assert.deepEqual(blocks[1], {
      type: "ul",
      startLine: 3,
      items: [
        { lineIndex: 3, text: "Todo", isTask: true, checked: false },
        { lineIndex: 4, text: "Done", isTask: true, checked: true },
      ],
    });
    assert.deepEqual(blocks[2], {
      type: "ol",
      startLine: 6,
      items: [
        { lineIndex: 6, num: "1", text: "First" },
        { lineIndex: 7, num: "2", text: "Second" },
      ],
    });
    assert.deepEqual(blocks[3], { type: "hr", startLine: 9 });
    assert.deepEqual(blocks[4], {
      type: "code",
      startLine: 11,
      language: "python",
      code: "print(1)",
    });
  });
});
