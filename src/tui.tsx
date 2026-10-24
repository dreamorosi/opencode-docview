/** @jsxImportSource @opentui/solid */
import { Plugin, usePlugin } from "@opencode/plugin/tui"
import type { Context, PanelInput } from "@opencode/plugin/tui/context"
import {
  RGBA,
  SyntaxStyle,
  TextAttributes,
  type CodeRenderable,
  type LineNumberRenderable,
  type MarkdownRenderable,
  type OptimizedBuffer,
  type MouseEvent,
  type ScrollBoxRenderable,
} from "@opentui/core"
import { Match, Show, Switch, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js"
import { spawn } from "node:child_process"
import { existsSync, watch } from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  dimFrontmatter,
  errorMessage,
  RENDERED_MARKDOWN,
  formatRange,
  parseTarget,
  renderedAnchors,
  splitFrontmatter,
  type Range,
} from "./lib.js"

const PANEL = "docview"
const MARKDOWN = /\.(md|mdx|markdown)$/i
const MAX_BYTES = 1024 * 1024
const RECENT_LIMIT = 10
const TRANSPARENT = RGBA.fromValues(0, 0, 0, 0)

type Mode = "rendered" | "source"
type Selection = { anchor: Range; head: Range }

export default Plugin.define({
  id: "opencode-docview",
  setup(context) {
    const [state, update] = context.storage.store("state", {
      initial: { recent: [] as string[], mode: "rendered" as Mode },
    })
    const [doc, setDoc] = createSignal<string>()

    const location = () => {
      const route = context.ui.router.current()
      const session = route.type === "session" ? context.data.session.get(route.sessionID) : undefined
      return session?.location ?? context.location ?? context.data.location.default()
    }

    const resolve = (input: string) => {
      const expanded = input === "~" || input.startsWith("~/") ? path.join(os.homedir(), input.slice(1)) : input
      return path.resolve(location().directory, expanded)
    }

    const open = (file: string) => {
      setDoc(file)
      void update((draft) => {
        draft.recent = [file, ...draft.recent.filter((item) => item !== file)].slice(0, RECENT_LIMIT)
      })
      if (!context.ui.panel.open(PANEL)) context.ui.toast.show({ message: "Open a session to use the doc viewer" })
    }

    const promptPath = async () => {
      const input = await context.ui.dialog.prompt({ title: "Open doc", placeholder: "path/to/doc.md" })
      if (input?.trim()) open(resolve(input.trim()))
    }

    const pick = async () => {
      const base = location().directory
      const found = await context.client.file
        .find({ location: { directory: base }, query: ".md", type: "file", limit: 500 })
        .catch(() => undefined)
      const seen = new Set<string>()
      const label = (file: string) => {
        const relative = path.relative(base, file)
        return relative.startsWith("..") || path.isAbsolute(relative) ? context.ui.format.path(file) : relative
      }
      const options = [
        ...state.recent.map((file) => ({ title: label(file), value: file, category: "Recent" })),
        ...(found?.data ?? [])
          .filter((entry) => MARKDOWN.test(entry.path))
          .map((entry) => ({ title: entry.path, value: path.join(base, entry.path), category: "Project" })),
      ].filter((option) => !seen.has(option.value) && seen.add(option.value))

      if (options.length === 0) return promptPath()
      const chosen = await context.ui.dialog.select({
        title: "Open doc",
        placeholder: "Search markdown files",
        options,
        actions: [
          {
            bind: "ctrl+t",
            title: "type a path",
            selection: "none",
            onTrigger: () => {
              context.ui.dialog.clear()
              void promptPath()
            },
          },
        ],
      })
      if (chosen) open(chosen)
    }

    context.ui.slot({
      append: "session.panel",
      render: (panel) => (
        <Show when={panel.name === PANEL}>
          <DocPanel
            panel={panel}
            file={doc()}
            mode={state.mode ?? "rendered"}
            onToggleMode={() =>
              void update((draft) => {
                draft.mode = draft.mode === "source" ? "rendered" : "source"
              })
            }
            onPick={() => void pick()}
          />
        </Show>
      ),
    })

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "docview.open",
          title: "Open doc in side panel",
          group: "Doc viewer",
          palette: true,
          slash: { name: "doc", arguments: true },
          run: (input) => {
            const arg = input ? parseTarget(input) : ""
            if (arg) open(resolve(arg))
            else void pick()
          },
        },
        {
          id: "docview.toggle",
          title: "Toggle doc viewer",
          group: "Doc viewer",
          palette: true,
          run: () => {
            if (context.ui.panel.current()?.name === PANEL) return context.ui.panel.close()
            const last = doc() ?? state.recent[0]
            if (last) open(last)
            else void pick()
          },
        },
      ],
    }))
  },
})

function DocPanel(props: {
  panel: PanelInput
  file: string | undefined
  mode: Mode
  onToggleMode: () => void
  onPick: () => void
}) {
  const context = usePlugin()
  const syntax = createSyntax(context)
  const [version, setVersion] = createSignal(0)
  const [live, setLive] = createSignal(false)
  const [selection, setSelection] = createSignal<Selection>()
  const [gutter, setGutter] = createSignal<LineNumberRenderable>()
  const [source, setSource] = createSignal<CodeRenderable>()
  const [rendered, setRendered] = createSignal<MarkdownRenderable>()
  let scroll: ScrollBoxRenderable | undefined

  // Last good text and load errors are kept apart: a failed reload (for example while an editor deletes
  // and rewrites the file) must keep showing the last version instead of throwing out of the panel.
  const [text, setText] = createSignal<string>()
  const [loadError, setLoadError] = createSignal<unknown>()
  const [loading, setLoading] = createSignal(false)

  createEffect(
    on(
      () => props.file,
      () => {
        setText(undefined)
        setLoadError(undefined)
      },
    ),
  )

  createEffect(
    on([() => props.file, version], ([file]) => {
      if (!file) return
      let current = true
      onCleanup(() => (current = false))
      setLoading(true)
      context.client.file
        .read({ location: { directory: path.dirname(file) }, path: path.basename(file) })
        .then((bytes) => {
          if (bytes.byteLength > MAX_BYTES) throw new Error("File is larger than 1 MB")
          return new TextDecoder().decode(bytes)
        })
        .then(
          (value) => {
            if (!current) return
            setText(value)
            setLoadError(undefined)
          },
          (error: unknown) => current && setLoadError(error),
        )
        .finally(() => current && setLoading(false))
    }),
  )
  const doc = createMemo(() => splitFrontmatter(text() ?? ""))

  // Watch the parent directory: editors often save by renaming over the file, which breaks a file watch.
  createEffect(() => {
    const file = props.file
    setLive(false)
    if (!file || !existsSync(path.dirname(file))) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const watcher = watch(path.dirname(file), (_event, name) => {
      if (name && name.toString() !== path.basename(file)) return
      clearTimeout(timer)
      timer = setTimeout(() => setVersion((value) => value + 1), 100)
    })
    watcher.on("error", () => setLive(false))
    setLive(true)
    onCleanup(() => {
      clearTimeout(timer)
      watcher.close()
    })
  })

  createEffect(on(() => props.file, () => scroll?.scrollTo(0), { defer: true }))
  createEffect(on(() => props.file, () => setSelection(undefined), { defer: true }))

  // Frontmatter lines keep their rows but get no number, so the first body line is L1.
  createEffect(() => {
    const element = gutter()
    if (!element) return
    const count = doc().frontmatterLines
    element.setHideLineNumbers(new Set(Array.from({ length: count }, (_, index) => index)))
    element.lineNumberOffset = -count
  })

  const selectionColors = () => ({
    gutter: context.theme.background.action.primary.focused,
    content: context.theme.background.raised.high,
    text: context.theme.text.action.primary.focused,
  })

  createEffect(() => {
    const element = gutter()
    if (!element) return
    const range = selected()
    const offset = doc().frontmatterLines
    const colors = new Map<number, { gutter: RGBA; content: RGBA }>()
    if (range) {
      const { gutter, content } = selectionColors()
      for (let line = range.start; line <= range.end; line++) colors.set(line - 1 + offset, { gutter, content })
    }
    element.setLineColors(colors)
  })

  createEffect(() => {
    selected()
    rendered()?.requestRender()
  })

  const selected = (): Range | undefined => {
    const current = selection()
    if (!current) return undefined
    return {
      start: Math.min(current.anchor.start, current.head.start),
      end: Math.max(current.anchor.end, current.head.end),
    }
  }

  const rangeLabel = () => {
    const range = selected()
    return range ? formatRange(range) : undefined
  }

  const copySelection = () => {
    const label = rangeLabel()
    if (!label) return false
    copyText(context, label)
    context.ui.toast.show({ message: `Copied ${label}`, variant: "success", duration: 1500 })
  }

  const gutterWidth = () => Math.max(3, String(doc().bodyLines).length + 2)

  // Source view: maps a mouse row to a 1-based body line, accounting for wrapped rows and the frontmatter.
  const sourceLineAt = (screenY: number): Range | undefined => {
    const element = source()
    if (!element) return undefined
    const sources = element.lineInfo.lineSources
    if (sources.length === 0) return undefined
    const row = Math.max(0, Math.min(sources.length - 1, screenY - element.screenY))
    const line = Math.max(1, Math.min(doc().bodyLines, sources[row]! - doc().frontmatterLines + 1))
    return { start: line, end: line }
  }

  // Rendered view: anchors cover single source lines where possible, whole blocks otherwise.
  const blockAt = (screenY: number, clamp: boolean): Range | undefined => {
    const element = rendered()
    if (!element) return undefined
    const anchors = renderedAnchors(element)
    const hit = anchors.find((anchor) => screenY >= anchor.top && screenY < anchor.top + anchor.height)
    if (hit || !clamp || anchors.length === 0) return hit
    return anchors.reduce((best, anchor) => (Math.abs(anchor.top - screenY) < Math.abs(best.top - screenY) ? anchor : best))
  }

  const rangeAt = (event: MouseEvent, clamp: boolean) =>
    props.mode === "source" ? sourceLineAt(event.y) : blockAt(event.y, clamp)

  const inGutter = (event: MouseEvent) => {
    const element = props.mode === "source" ? source() : rendered()
    if (!element) return false
    const left = props.mode === "source" ? element.screenX : element.screenX + gutterWidth()
    return event.x < left
  }

  let dragging = false

  const onMouseDown = (event: MouseEvent) => {
    if (event.button !== 0 || !inGutter(event)) return
    const range = rangeAt(event, false)
    if (!range) return
    dragging = true
    event.preventDefault()
    const current = selection()
    setSelection(event.modifiers.shift && current ? { anchor: current.anchor, head: range } : { anchor: range, head: range })
  }

  const onMouseDrag = (event: MouseEvent) => {
    const current = selection()
    if (!dragging || !current) return
    const range = rangeAt(event, true)
    if (!range || (range.start === current.head.start && range.end === current.head.end)) return
    setSelection({ anchor: current.anchor, head: range })
  }

  const onMouseUp = () => {
    if (!dragging) return
    dragging = false
    copySelection()
  }

  const drawRenderedGutter = function (this: MarkdownRenderable, buffer: OptimizedBuffer) {
    const width = gutterWidth()
    const range = selected()
    const colors = selectionColors()
    const anchors = renderedAnchors(this)
    const active = (anchor: Range) => range !== undefined && anchor.start <= range.end && anchor.end >= range.start
    const picked = anchors.filter(active)
    if (picked.length > 0) {
      const top = picked[0]!.top
      const bottom = Math.max(...picked.map((anchor) => anchor.top + anchor.height))
      buffer.fillRect(this.screenX + width, top, Math.max(0, this.width - width), bottom - top, colors.content)
      buffer.fillRect(this.screenX, top, width, bottom - top, colors.gutter)
    }
    for (const anchor of anchors) {
      const on = active(anchor)
      const label = String(anchor.start).padStart(width - 1)
      buffer.drawText(label, this.screenX, anchor.top, on ? colors.text : context.theme.text.muted, on ? colors.gutter : undefined)
    }
  }

  context.keymap.layer(() => ({
    commands: [
      { id: "docview.down", title: "Scroll down", group: "Doc viewer", bind: "j,down", run: () => scroll?.scrollBy(1) },
      { id: "docview.up", title: "Scroll up", group: "Doc viewer", bind: "k,up", run: () => scroll?.scrollBy(-1) },
      {
        id: "docview.page.down",
        title: "Page down",
        group: "Doc viewer",
        bind: "ctrl+d,pagedown,space",
        run: () => scroll?.scrollBy(0.5, "viewport"),
      },
      {
        id: "docview.page.up",
        title: "Page up",
        group: "Doc viewer",
        bind: "ctrl+u,pageup",
        run: () => scroll?.scrollBy(-0.5, "viewport"),
      },
      { id: "docview.top", title: "Top", group: "Doc viewer", bind: "g,home", run: () => scroll?.scrollTo(0) },
      {
        id: "docview.bottom",
        title: "Bottom",
        group: "Doc viewer",
        bind: "shift+g,end",
        run: () => scroll?.scrollTo(scroll.scrollHeight),
      },
      { id: "docview.mode", title: "Toggle source view", group: "Doc viewer", bind: "s", run: props.onToggleMode },
      { id: "docview.copy", title: "Copy line range", group: "Doc viewer", bind: "y", run: copySelection },
      {
        id: "docview.clear",
        title: "Clear line selection",
        group: "Doc viewer",
        bind: "escape",
        run: () => {
          if (!selection()) return false
          setSelection(undefined)
        },
      },
      {
        id: "docview.reload",
        title: "Reload doc",
        group: "Doc viewer",
        bind: "r",
        run: () => void setVersion((value) => value + 1),
      },
      { id: "docview.pick", title: "Open another doc", group: "Doc viewer", bind: "o", run: props.onPick },
      {
        id: "docview.fullscreen",
        title: "Toggle fullscreen",
        group: "Doc viewer",
        bind: "f",
        run: props.panel.toggleFullscreen,
      },
      { id: "docview.close", title: "Close doc viewer", group: "Doc viewer", bind: "q", run: props.panel.close },
    ],
  }))

  const theme = () => context.theme
  const title = () => {
    if (!props.file) return "Doc viewer"
    const session = context.data.session.get(props.panel.sessionID)
    const base = session?.location.directory ?? context.data.location.default().directory
    const relative = path.relative(base, props.file)
    return relative && !relative.startsWith("..") && !path.isAbsolute(relative)
      ? relative
      : context.ui.format.path(props.file)
  }
  const status = () => {
    if (loadError()) return text() === undefined ? "error" : "reload failed · showing last version"
    if (loading() && text() === undefined) return "loading…"
    const parts = [rangeLabel() ?? (props.mode === "source" ? "source" : undefined), live() ? "live" : undefined]
    return parts.filter(Boolean).join(" · ")
  }
  const hints = () => {
    if (!props.panel.focused) return "click to focus"
    const prompt = context.keymap.shortcuts("pane.focus.left")[0]
    const mode = props.mode === "source" ? "s rendered" : "s source"
    return `j/k scroll · click/drag numbers to copy · ${mode} · o open · f fullscreen · q close${prompt ? ` · ${prompt} prompt` : ""}`
  }

  return (
    <box flexDirection="column" flexGrow={1} minHeight={0}>
      <box flexDirection="row" flexShrink={0} paddingLeft={2} paddingRight={2} paddingTop={1}>
        <text fg={theme().text.base} attributes={TextAttributes.BOLD} flexShrink={1} wrapMode="none">
          {title()}
        </text>
        <box flexGrow={1} />
        <text fg={loadError() ? theme().text.feedback.warning.base : live() ? theme().text.feedback.success.base : theme().text.muted}>
          {status()}
        </text>
      </box>
      <scrollbox
        ref={(element: ScrollBoxRenderable) => (scroll = element)}
        flexGrow={1}
        minHeight={0}
        paddingRight={2}
        paddingTop={1}
      >
        <Switch>
          <Match when={!props.file}>
            <box paddingLeft={2}>
              <text fg={theme().text.muted}>No doc open. Focus this panel and press o, or run /doc path/to/file.md</text>
            </box>
          </Match>
          <Match when={loadError() !== undefined && text() === undefined}>
            <box paddingLeft={2}>
              <text fg={theme().text.feedback.error.base}>
                Could not read {title()}: {errorMessage(loadError())}
              </text>
            </box>
          </Match>
          <Match when={text() !== undefined && props.mode === "source"}>
            <line_number
              ref={setGutter}
              width="100%"
              fg={theme().text.muted}
              bg={TRANSPARENT}
              onMouseDown={onMouseDown}
              onMouseDrag={onMouseDrag}
              onMouseUp={onMouseUp}
            >
              <code
                ref={setSource}
                flexGrow={1}
                content={doc().source}
                filetype="markdown"
                syntaxStyle={syntax()}
                conceal={false}
                wrapMode="word"
                fg={theme().text.base}
                onHighlight={(highlights) => dimFrontmatter(highlights, doc().frontmatterChars)}
              />
            </line_number>
          </Match>
          <Match when={text() !== undefined}>
            <Show when={doc().frontmatter}>
              <box paddingLeft={gutterWidth()} paddingBottom={1}>
                <text fg={theme().text.muted}>{doc().frontmatter}</text>
              </box>
            </Show>
            <markdown
              ref={setRendered}
              width="100%"
              paddingLeft={gutterWidth()}
              content={doc().body}
              syntaxStyle={syntax()}
              {...RENDERED_MARKDOWN}
              fg={theme().markdown.text}
              renderAfter={drawRenderedGutter}
              onMouseDown={onMouseDown}
              onMouseDrag={onMouseDrag}
              onMouseUp={onMouseUp}
            />
          </Match>
        </Switch>
      </scrollbox>
      <box flexShrink={0} paddingLeft={2} paddingRight={2}>
        <text fg={theme().text.muted}>{hints()}</text>
      </box>
    </box>
  )
}

// OSC 52 covers SSH and most modern terminals; pbcopy is a local fallback for terminals that ignore it.
function copyText(context: Context, text: string) {
  context.renderer.copyToClipboardOSC52(text)
  if (process.platform !== "darwin") return
  const child = spawn("pbcopy", { stdio: ["pipe", "ignore", "ignore"] })
  child.on("error", () => {})
  child.stdin.end(text)
}

// Mirrors the host's markdown/syntax scopes so docs render like assistant messages and follow theme changes.
function createSyntax(context: Context) {
  return createMemo(() => {
    const theme = context.theme
    const { syntax, markdown } = theme
    const rule = (scope: string[], foreground: unknown, style: Record<string, unknown> = {}) => ({
      scope,
      style: { foreground: foreground as never, ...style },
    })
    const style = SyntaxStyle.fromTheme([
      rule(["default"], theme.text.base),
      rule(["comment", "comment.documentation"], syntax.comment, { italic: true }),
      rule(["string", "symbol", "character", "character.special"], syntax.string),
      rule(["number", "boolean", "constant", "float"], syntax.number),
      rule(["keyword", "keyword.return", "keyword.conditional", "keyword.repeat"], syntax.keyword, { italic: true }),
      rule(["keyword.import", "keyword.export", "string.escape", "string.regexp", "tag.attribute"], syntax.keyword),
      rule(["keyword.type"], syntax.type, { bold: true, italic: true }),
      rule(["keyword.function", "function", "function.method", "variable.member", "constructor"], syntax.function),
      rule(["operator", "keyword.operator", "punctuation.delimiter"], syntax.operator),
      rule(["variable", "variable.parameter", "function.call", "function.method.call", "property", "field"], syntax.variable),
      rule(["type", "type.definition", "module", "class", "namespace"], syntax.type),
      rule(["punctuation", "punctuation.bracket", "punctuation.special", "tag.delimiter"], syntax.punctuation),
      rule(["tag", "variable.builtin", "type.builtin", "function.builtin", "constant.builtin"], theme.text.feedback.error.base),
      rule(["markup.heading", "markup.heading.2", "markup.heading.3", "markup.heading.4", "markup.heading.5", "markup.heading.6"], markdown.heading, { bold: true }),
      rule(["markup.heading.1"], markdown.heading, { bold: true, underline: true }),
      rule(["markup.bold", "markup.strong"], markdown.strong, { bold: true }),
      rule(["markup.italic"], markdown.emphasis, { italic: true }),
      rule(["markup.list"], markdown.listItem),
      rule(["markup.quote"], markdown.blockQuote, { italic: true }),
      rule(["markup.raw", "markup.raw.block"], markdown.code),
      rule(["markup.raw.inline"], markdown.code, { background: theme.background.base }),
      rule(["markup.link", "markup.link.url", "string.special", "string.special.url"], markdown.link, { underline: true }),
      rule(["markup.link.label", "label"], markdown.linkText, { underline: true }),
      rule(["markup.strikethrough", "markup.list.unchecked"], theme.text.muted),
      rule(["markup.list.checked"], theme.text.feedback.success.base),
      rule(["markup.underline"], theme.text.base, { underline: true }),
      rule(["docview.frontmatter"], theme.text.muted),
    ], context.renderer.nativeScene)
    // Defer destroy until the markdown renderable has switched to the replacement style.
    onCleanup(() => setTimeout(() => style.destroy(), 0))
    return style
  })
}
