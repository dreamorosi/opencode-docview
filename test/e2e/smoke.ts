// Smoke test against the real OpenCode binary: loads the built package the way an installed npm
// package is loaded, opens the fixture with /doc, and checks the gutter and line-range copying.
//
// Usage: npm run build && bun test/e2e/smoke.ts
// Env:   OPENCODE_BIN (default "opencode"), SMOKE_TIMEOUT_MS (default 20000)
//
// Runs in an isolated HOME, so it never touches your OpenCode config, sessions, or background service.
// No model is called: the test only opens a doc in an empty session.

import { spawnSync } from "node:child_process"
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Terminal } from "@xterm/headless"

const ROOT = path.resolve(import.meta.dir, "../..")
const BIN = process.env.OPENCODE_BIN ?? "opencode"
const TIMEOUT = Number(process.env.SMOKE_TIMEOUT_MS ?? 20_000)
const COLS = 160
const ROWS = 50

const sandbox = mkdtempSync(path.join(tmpdir(), "docview-smoke-"))
const home = path.join(sandbox, "home")
const project = path.join(sandbox, "project")
const plugin = path.join(sandbox, "node_modules", "opencode-docview")
for (const dir of [home, project, plugin]) mkdirSync(dir, { recursive: true })
for (const entry of ["package.json", "tui.js", "dist"]) cpSync(path.join(ROOT, entry), path.join(plugin, entry), { recursive: true })
cpSync(path.join(ROOT, "test/fixtures/gutter.md"), path.join(project, "gutter.md"))

const env = {
  ...process.env,
  HOME: home,
  XDG_CONFIG_HOME: path.join(home, ".config"),
  XDG_DATA_HOME: path.join(home, ".local/share"),
  XDG_STATE_HOME: path.join(home, ".local/state"),
  XDG_CACHE_HOME: path.join(home, ".cache"),
  OPENCODE_CLI_CONFIG_CONTENT: JSON.stringify({ plugins: [plugin], highlights: false }),
  TERM: "xterm-256color",
  COLORTERM: "truecolor",
}

function opencode(...args: string[]) {
  const result = spawnSync(BIN, args, { env, encoding: "utf8", timeout: TIMEOUT })
  if (result.status !== 0) throw new Error(`opencode ${args.join(" ")} failed:\n${result.stderr || result.stdout}`)
  return result.stdout
}

const terminal = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true })
let output = ""
let tui: ReturnType<typeof Bun.spawn> | undefined

const screen = () =>
  Array.from({ length: ROWS }, (_, row) => terminal.buffer.active.getLine(row)?.translateToString(true) ?? "")

async function waitFor(description: string, check: (rows: string[]) => boolean) {
  const deadline = Date.now() + TIMEOUT
  while (Date.now() < deadline) {
    await new Promise<void>((resolve) => terminal.write("", resolve))
    if (check(screen())) return screen()
    await Bun.sleep(100)
  }
  throw new Error(`Timed out waiting for ${description}`)
}

const send = async (keys: string) => {
  tui!.terminal!.write(keys)
  await Bun.sleep(200)
}

// The panel's text starts after the chat column; find a gutter row by its number and visible text.
function findRow(rows: string[], line: number, text: string) {
  const pattern = new RegExp(`(^|\\s)(${line})\\s+${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
  for (const [row, value] of rows.entries()) {
    const match = pattern.exec(value)
    if (match) return { row, column: match.index + match[1]!.length }
  }
  return undefined
}

async function main() {
  const version = opencode("--version").trim()
  console.log(`OpenCode ${version}`)

  // The sandbox gets its own background service; pick a free port so it never collides with a real one.
  const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } })
  const port = probe.port
  probe.stop(true)
  opencode("service", "set", "port", String(port))

  const created = JSON.parse(
    opencode("api", "post", "/api/session", "-d", JSON.stringify({ title: "docview smoke", location: { directory: project } })),
  )
  const sessionID: string = created.data.id

  tui = Bun.spawn([BIN, "-s", sessionID, project], {
    env,
    terminal: {
      cols: COLS,
      rows: ROWS,
      data(_terminal, chunk) {
        const text = new TextDecoder().decode(chunk)
        output += text
        terminal.write(text)
      },
    },
  })
  // Answer the TUI's terminal queries (cursor position, device attributes) like a real terminal would.
  terminal.onData((data) => tui?.terminal?.write(data))

  await waitFor("the session to open", (rows) => rows.some((row) => row.includes("docview smoke")))
  await send("/doc gutter.md")
  await send("\r")

  const rendered = await waitFor("the rendered doc", (rows) => findRow(rows, 30, "│ quote two") !== undefined)
  const expected: [number, string][] = [
    [1, "Title"],
    [3, "Para line one"],
    [10, "- item two"],
    [12, "- nested a"],
    [16, "1. first"],
    [19, "│ A"],
    [21, "│ 1"],
    [25, "const a = 1"],
    [29, "│ quote one"],
  ]
  for (const [line, text] of expected) {
    if (!findRow(rendered, line, text)) throw new Error(`Rendered view: line ${line} is not next to "${text}"`)
  }
  if (!rendered.some((row) => row.includes("title: Gutter fixture"))) throw new Error("Frontmatter is not shown")
  console.log("✓ rendered view gutter")

  const item = findRow(rendered, 10, "- item two")!
  await send(`\x1b[<0;${item.column + 1};${item.row + 1}M\x1b[<0;${item.column + 1};${item.row + 1}m`)
  await waitFor("the copy toast", (rows) => rows.some((row) => row.includes("Copied #L10")))
  console.log("✓ gutter click copies #L10")

  await send("s")
  const source = await waitFor("the source view", (rows) => findRow(rows, 1, "# Title") !== undefined)
  const frontmatter = source.find((row) => row.includes("title: Gutter fixture"))
  if (!frontmatter || /\d\s+title: Gutter fixture/.test(frontmatter)) throw new Error("Frontmatter should be unnumbered")
  if (!findRow(source, 11, "continued")) throw new Error("Source view: line 11 is not next to its text")
  console.log("✓ source view gutter")

  if (output.includes("Plugin failed") || screen().some((row) => row.includes("Plugin failed"))) {
    throw new Error("OpenCode reported a plugin failure")
  }
}

let failed = false
try {
  await main()
  console.log("Smoke test passed")
} catch (error) {
  failed = true
  console.error(`Smoke test failed: ${error instanceof Error ? error.message : String(error)}`)
  console.error("--- screen ---")
  console.error(screen().map((row) => row.trimEnd()).join("\n"))
} finally {
  tui?.kill()
  spawnSync(BIN, ["service", "stop"], { env, timeout: TIMEOUT })
  rmSync(sandbox, { recursive: true, force: true })
}
process.exit(failed ? 1 : 0)
