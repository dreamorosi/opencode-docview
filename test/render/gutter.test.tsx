import { afterEach, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { type MarkdownRenderable, SyntaxStyle, getTreeSitterClient } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { type Anchor, RENDERED_MARKDOWN, renderedAnchors, splitFrontmatter } from "../../src/lib.js"

// Renders the fixture with the same OpenTUI version and <markdown> options the plugin uses, then checks that
// every gutter anchor sits on the row showing its source line. This catches changes to the OpenTUI internals
// the rendered-view gutter reads.

const body = splitFrontmatter(readFileSync(new URL("../fixtures/gutter.md", import.meta.url), "utf8")).body
const GUTTER = 4

let cleanup: (() => void) | undefined
afterEach(() => cleanup?.())

async function render(width: number) {
  let element: MarkdownRenderable | undefined
  const setup = await testRender(
    () => (
      <markdown
        ref={(value: MarkdownRenderable) => (element = value)}
        width="100%"
        paddingLeft={GUTTER}
        content={body}
        syntaxStyle={SyntaxStyle.create()}
        treeSitterClient={getTreeSitterClient()}
        {...RENDERED_MARKDOWN}
      />
    ),
    { width, height: 80 },
  )
  cleanup = () => setup.renderer.destroy()
  // Text blocks paint once tree-sitter has highlighted them, which takes real time.
  let frame = ""
  for (let attempt = 0; attempt < 100 && !frame.includes("quote two"); attempt++) {
    await setup.renderOnce()
    frame = setup.captureCharFrame()
    if (!frame.includes("quote two")) await Bun.sleep(50)
  }
  if (!element || !frame.includes("quote two")) throw new Error("markdown did not finish rendering")
  const rows = frame.split("\n")
  const anchors = renderedAnchors(element)
  const rowOf = (line: number) => {
    const anchor = anchors.find((item: Anchor) => item.start === line)
    return anchor === undefined ? undefined : rows[anchor.top]?.slice(GUTTER).trim()
  }
  return { anchors, rows, rowOf }
}

describe("rendered view gutter", () => {
  it("puts each source line on the row that shows it", async () => {
    const { rowOf } = await render(80)
    const expected: [number, string][] = [
      [1, "Title"],
      [2, ""],
      [3, "Para line one"],
      [4, "para line two"],
      [5, ""],
      [7, "Two blank lines above."],
      [9, "- item one"],
      [10, "- item two"],
      [11, "continued"],
      [12, "- nested a"],
      [13, "- nested b"],
      [14, "- item three"],
      [16, "1. first"],
      [17, "2. second"],
      [25, "const a = 1"],
      [26, "const b = 2"],
      [29, "│ quote one"],
      [30, "│ quote two"],
    ]
    for (const [line, text] of expected) expect({ line, text: rowOf(line) }).toEqual({ line, text })
  })

  it("numbers table rows and the header rule", async () => {
    const { rowOf } = await render(80)
    expect(rowOf(19)).toMatch(/^│ A\s+│ B\s+│$/)
    expect(rowOf(20)).toMatch(/^├─+┼─+┤$/)
    expect(rowOf(21)).toMatch(/^│ 1\s+│ 2\s+│$/)
    expect(rowOf(22)).toMatch(/^│ 3\s+│ 4\s+│$/)
  })

  it("covers two blank source lines with one gap row", async () => {
    const { anchors } = await render(80)
    expect(anchors.find((anchor) => anchor.start === 5)?.end).toBe(6)
    expect(anchors.some((anchor) => anchor.start === 6)).toBe(false)
  })

  it("keeps a wrapped line as one anchor spanning its rows", async () => {
    const { anchors } = await render(24)
    const para = anchors.find((anchor) => anchor.start === 7)
    expect(para).toMatchObject({ start: 7, end: 7 })
    expect(para!.height).toBeGreaterThan(1)
  })

  it("orders anchors top to bottom without overlaps", async () => {
    const { anchors } = await render(80)
    anchors.slice(1).forEach((anchor, index) => {
      const previous = anchors[index]!
      expect(anchor.top).toBeGreaterThanOrEqual(previous.top + previous.height)
      expect(anchor.start).toBeGreaterThan(previous.start)
    })
  })
})
