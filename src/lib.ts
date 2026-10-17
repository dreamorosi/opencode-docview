import type { SimpleHighlight } from "@opentui/core"

export type Range = { start: number; end: number }
export type Anchor = Range & { top: number; height: number }
type Token = { type: string; raw?: string; items?: Token[]; tokens?: Token[]; rows?: unknown[][] }
export type Node = {
  id: string
  screenY: number
  height: number
  isDestroyed: boolean
  getChildren(): Node[]
  lineInfo?: { lineSources: number[] }
  _layout?: { rowOffsets: number[]; rowHeights: number[] }
}
// The parts of OpenTUI's MarkdownRenderable the gutter reads.
export type RenderedMarkdown = {
  _parseState: { tokens: readonly object[] } | null
  _blockStates: readonly { token: object; renderable: object }[]
}

// Options for the rendered view's <markdown>. Shared with the render tests so they exercise the same layout.
export const RENDERED_MARKDOWN = {
  conceal: true,
  internalBlockMode: "top-level",
  tableOptions: { style: "grid", cellPaddingX: 1 },
} as const

export function formatRange(range: Range) {
  return range.start === range.end ? `#L${range.start}` : `#L${range.start}-L${range.end}`
}

const newlines = (text: string) => text.split("\n").length - 1
const span = (raw: string) => newlines(raw.replace(/\n+$/, "")) + 1
const whole = (node: Node, start: number, raw: string): Anchor[] => [
  { top: node.screenY, height: Math.max(1, node.height), start, end: start + span(raw) - 1 },
]

// One anchor per source line when the rendered text keeps the source line breaks; otherwise one for the block.
function textAnchors(node: Node, start: number, lines: number, raw: string): Anchor[] {
  const sources = node.lineInfo?.lineSources
  if (!sources || sources.length === 0 || Math.max(...sources) + 1 !== lines) return whole(node, start, raw)
  const anchors: Anchor[] = []
  sources.forEach((source, row) => {
    const last = anchors.at(-1)
    if (last && last.start === start + source) last.height++
    else anchors.push({ top: node.screenY + row, height: 1, start: start + source, end: start + source })
  })
  return anchors
}

function tableAnchors(node: Node, start: number, token: Token): Anchor[] {
  const layout = node._layout
  const rows = (token.rows?.length ?? 0) + 1
  if (!layout || layout.rowHeights.length !== rows) return whole(node, start, token.raw ?? "")
  const { rowOffsets, rowHeights } = layout
  const row = (index: number, line: number): Anchor => ({
    top: node.screenY + rowOffsets[index]! + 1,
    height: rowHeights[index]!,
    start: line,
    end: line,
  })
  // The rule under the header row stands in for the |---| delimiter line.
  const anchors = [row(0, start), { top: node.screenY + rowOffsets[1]!, height: 1, start: start + 1, end: start + 1 }]
  for (let index = 1; index < rows; index++) anchors.push(row(index, start + 1 + index))
  return anchors
}

function listAnchors(node: Node, start: number, token: Token): Anchor[] {
  const items = token.items ?? []
  const children = node.getChildren()
  if (children.length !== items.length) return whole(node, start, token.raw ?? "")
  const anchors: Anchor[] = []
  let line = start
  items.forEach((item, index) => {
    anchors.push(...itemAnchors(children[index]!, line, item))
    line += newlines(item.raw ?? "")
  })
  return anchors
}

function itemAnchors(node: Node, start: number, item: Token): Anchor[] {
  const content = node.getChildren().find((child) => child.id.endsWith("-content"))
  const tokens = item.tokens ?? []
  const children = content?.getChildren() ?? []
  if (children.length !== tokens.filter((token) => token.type !== "space").length || children.length === 0) {
    return whole(node, start, item.raw ?? "")
  }
  const anchors: Anchor[] = []
  let line = start
  let index = 0
  for (const token of tokens) {
    if (token.type !== "space") anchors.push(...blockAnchors(children[index++]!, line, token))
    line += newlines(token.raw ?? "")
  }
  return anchors
}

export function blockAnchors(node: Node, start: number, token: Token): Anchor[] {
  const raw = token.raw ?? ""
  switch (token.type) {
    case "list":
      return listAnchors(node, start, token)
    case "table":
      return tableAnchors(node, start, token)
    case "code": {
      const fenced = /^ {0,3}(`{3,}|~{3,})/.test(raw)
      const lines = span(raw) - (fenced ? 2 : 0)
      return lines > 0 ? textAnchors(node, start + (fenced ? 1 : 0), lines, raw) : whole(node, start, raw)
    }
    case "blockquote": {
      const content = node.getChildren()
      return content.length === 1 ? textAnchors(content[0]!, start, span(raw), raw) : whole(node, start, raw)
    }
    case "heading":
    case "paragraph":
    case "text":
      return textAnchors(node, start, span(raw), raw)
    default:
      return whole(node, start, raw)
  }
}

// Gutter anchors for the rendered view: per source line where rows map cleanly, per block otherwise,
// plus blank lines between blocks wherever the renderer leaves a gap row for them.
export function renderedAnchors(element: RenderedMarkdown): Anchor[] {
  const tokens = element._parseState?.tokens as readonly Token[] | undefined
  if (!tokens) return []
  const starts = new Map<object, number>()
  let line = 1
  for (const token of tokens) {
    starts.set(token, line)
    line += newlines(token.raw ?? "")
  }
  const anchors: Anchor[] = []
  let previous: { end: number; bottom: number } | undefined
  for (const state of element._blockStates) {
    const node = state.renderable as unknown as Node
    const start = starts.get(state.token)
    if (start === undefined || node.isDestroyed) continue
    if (previous) {
      const rows = node.screenY - previous.bottom
      const first = previous.end + 1
      const last = start - 1
      for (let row = 0; row < rows && first + row <= last; row++) {
        const blank = first + row
        anchors.push({ top: previous.bottom + row, height: 1, start: blank, end: row === rows - 1 ? last : blank })
      }
    }
    const token = state.token as Token
    anchors.push(...blockAnchors(node, start, token))
    previous = { end: start + span(token.raw ?? "") - 1, bottom: node.screenY + Math.max(1, node.height) }
  }
  return anchors.sort((left, right) => left.top - right.top)
}

// Splits a leading YAML/TOML-style `---` block from the body. Line counts ignore one trailing newline, like editors do.
export function splitFrontmatter(text: string) {
  const source = text.replace(/^\uFEFF/, "").replace(/\r?\n$/, "")
  const lines = source.split(/\r?\n/)
  const close = lines[0]?.trim() === "---" ? lines.findIndex((line, index) => index > 0 && /^(---|\.\.\.)\s*$/.test(line)) : -1
  const frontmatterLines = close === -1 ? 0 : close + 1
  const frontmatter = lines.slice(0, frontmatterLines).join("\n")
  const body = lines.slice(frontmatterLines).join("\n")
  return {
    source,
    frontmatter,
    body,
    frontmatterLines,
    frontmatterChars: frontmatterLines === 0 ? 0 : frontmatter.length,
    bodyLines: Math.max(1, lines.length - frontmatterLines),
  }
}

export function dimFrontmatter(highlights: SimpleHighlight[], end: number): SimpleHighlight[] {
  if (end === 0) return highlights
  return [[0, end, "docview.frontmatter"], ...highlights.filter((highlight) => highlight[0] >= end)]
}

// Accepts "path", "@path" (prompt file mention), quoted paths, and an optional "#20" / "#20-45" line suffix.
export function parseTarget(input: string) {
  const value = input
    .trim()
    .replace(/^\/doc(\s+|$)/, "")
    .trim()
    .replace(/^@/, "")
    .replace(/^(["'])(.*)\1$/, "$2")
  return value.replace(/#L?\d+(-L?\d+)?$/, "")
}

export function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message
  if (error && typeof error === "object" && "message" in error) return String(error.message)
  return String(error)
}
