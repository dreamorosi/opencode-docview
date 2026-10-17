import { describe, expect, it } from "vitest"
import { type Node, blockAnchors, formatRange, parseTarget, renderedAnchors, splitFrontmatter } from "../src/lib.js"

function node(props: Partial<Node> & { screenY: number; height: number }, children: Node[] = []): Node {
  return { id: "node", isDestroyed: false, getChildren: () => children, ...props }
}

describe("parseTarget", () => {
  it.each([
    ["notes.md", "notes.md"],
    ["  /doc notes.md ", "notes.md"],
    ["@docs/notes.md ", "docs/notes.md"],
    ['"my notes.md"', "my notes.md"],
    ["@src/notes.md#20-45", "src/notes.md"],
    ["notes.md#L3-L8", "notes.md"],
  ])("parses %j", (input, expected) => {
    expect(parseTarget(input)).toBe(expected)
  })
})

describe("formatRange", () => {
  it("formats single lines and ranges GitHub-style", () => {
    expect(formatRange({ start: 5, end: 5 })).toBe("#L5")
    expect(formatRange({ start: 3, end: 8 })).toBe("#L3-L8")
  })
})

describe("splitFrontmatter", () => {
  it("separates frontmatter so the body starts at line 1", () => {
    const doc = splitFrontmatter("---\ntitle: Notes\n---\n# Heading\n\nText\n")
    expect(doc.frontmatter).toBe("---\ntitle: Notes\n---")
    expect(doc.frontmatterLines).toBe(3)
    expect(doc.body).toBe("# Heading\n\nText")
    expect(doc.bodyLines).toBe(3)
  })

  it("leaves documents without frontmatter untouched", () => {
    const doc = splitFrontmatter("# Heading\r\nText\r\n")
    expect(doc.frontmatterLines).toBe(0)
    expect(doc.body).toBe("# Heading\nText")
    expect(doc.bodyLines).toBe(2)
  })

  it("ignores an unclosed fence", () => {
    expect(splitFrontmatter("---\ntitle: Notes\n").frontmatterLines).toBe(0)
  })
})

describe("blockAnchors", () => {
  it("numbers each source line of a paragraph that keeps its line breaks", () => {
    const paragraph = node({ screenY: 10, height: 2, lineInfo: { lineSources: [0, 1] } })
    expect(blockAnchors(paragraph, 3, { type: "paragraph", raw: "one\ntwo" })).toEqual([
      { top: 10, height: 1, start: 3, end: 3 },
      { top: 11, height: 1, start: 4, end: 4 },
    ])
  })

  it("keeps a wrapped line as one anchor", () => {
    const quote = node({ screenY: 0, height: 3, lineInfo: { lineSources: [0, 0, 0] } })
    expect(blockAnchors(quote, 18, { type: "paragraph", raw: "a long line" })).toEqual([
      { top: 0, height: 3, start: 18, end: 18 },
    ])
  })

  it("falls back to the whole block when rows don't map to lines", () => {
    const reflowed = node({ screenY: 4, height: 1, lineInfo: { lineSources: [0] } })
    expect(blockAnchors(reflowed, 7, { type: "paragraph", raw: "one\ntwo\n" })).toEqual([
      { top: 4, height: 1, start: 7, end: 8 },
    ])
  })

  it("skips the fences of a code block", () => {
    const code = node({ screenY: 20, height: 2, lineInfo: { lineSources: [0, 1] } })
    expect(blockAnchors(code, 24, { type: "code", raw: "```ts\nconst a = 1\nconst b = 2\n```" })).toEqual([
      { top: 20, height: 1, start: 25, end: 25 },
      { top: 21, height: 1, start: 26, end: 26 },
    ])
  })

  it("numbers table rows and the delimiter line", () => {
    const table = node({ screenY: 20, height: 7, _layout: { rowOffsets: [0, 2, 4, 6], rowHeights: [1, 1, 1] } })
    const token = { type: "table", raw: "| A |\n|---|\n| 1 |\n| 3 |\n", rows: [[], []] }
    expect(blockAnchors(table, 19, token).map(({ top, start }) => [top, start])).toEqual([
      [21, 19],
      [22, 20],
      [23, 21],
      [25, 22],
    ])
  })

  it("numbers every list item, including nested ones", () => {
    const text = (screenY: number) => node({ screenY, height: 1, lineInfo: { lineSources: [0] } })
    const item = (screenY: number, children: Node[]) =>
      node({ screenY, height: children.length }, [node({ id: "x-content", screenY, height: children.length }, children)])
    const nested = node({ screenY: 12, height: 2 }, [item(12, [text(12)]), item(13, [text(13)])])
    const list = node({ screenY: 10, height: 4 }, [item(10, [text(10)]), item(11, [text(11), nested])])
    const token = {
      type: "list",
      raw: "- one\n- two\n  - a\n  - b",
      items: [
        { type: "list_item", raw: "- one\n", tokens: [{ type: "text", raw: "one" }] },
        {
          type: "list_item",
          raw: "- two\n  - a\n  - b",
          tokens: [
            { type: "text", raw: "two\n" },
            {
              type: "list",
              raw: "- a\n- b",
              items: [
                { type: "list_item", raw: "- a\n", tokens: [{ type: "text", raw: "a" }] },
                { type: "list_item", raw: "- b", tokens: [{ type: "text", raw: "b" }] },
              ],
            },
          ],
        },
      ],
    }
    expect(blockAnchors(list, 9, token).map(({ top, start }) => [top, start])).toEqual([
      [10, 9],
      [11, 10],
      [12, 11],
      [13, 12],
    ])
  })
})

describe("renderedAnchors", () => {
  it("numbers blank lines in the gaps between blocks", () => {
    const heading = { type: "heading", raw: "# Title\n\n" }
    const paragraph = { type: "paragraph", raw: "Text" }
    const space = { type: "space", raw: "\n\n\n" }
    const after = { type: "paragraph", raw: "After" }
    const markdown = {
      _parseState: { tokens: [heading, paragraph, space, after] },
      _blockStates: [
        { token: heading, renderable: node({ screenY: 0, height: 1, lineInfo: { lineSources: [0] } }) },
        { token: paragraph, renderable: node({ screenY: 2, height: 1, lineInfo: { lineSources: [0] } }) },
        { token: after, renderable: node({ screenY: 4, height: 1, lineInfo: { lineSources: [0] } }) },
      ],
    }
    expect(renderedAnchors(markdown).map(({ top, start, end }) => [top, start, end])).toEqual([
      [0, 1, 1],
      [1, 2, 2],
      [2, 3, 3],
      [3, 4, 5],
      [4, 6, 6],
    ])
  })
})
