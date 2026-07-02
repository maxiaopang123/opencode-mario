import type { TuiPlugin } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createResource, createMemo, Show, For } from "solid-js"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { useFilePreview } from "../../context/file-preview"
import { useTheme } from "../../context/theme"
import { useTerminalDimensions, useKeyboard } from "@opentui/solid"
import { filetype } from "../../util/filetype"
import { TextAttributes } from "@opentui/core"

const id = "internal:file-preview-panel"

// Image extensions
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".bmp", ".ico"])
// PDF / binary
const BINARY_EXTS = new Set([".pdf", ".zip", ".tar", ".gz", ".exe", ".bin", ".dmg", ".wasm"])

function fileKind(filePath: string): "image" | "markdown" | "binary" | "code" {
  const ext = path.extname(filePath).toLowerCase()
  if (IMAGE_EXTS.has(ext)) return "image"
  if (BINARY_EXTS.has(ext)) return "binary"
  if (ext === ".md" || ext === ".markdown") return "markdown"
  return "code"
}

function fileIcon(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  if (IMAGE_EXTS.has(ext)) return "IMG "
  if (BINARY_EXTS.has(ext)) return "BIN "
  if (ext === ".md" || ext === ".markdown") return " MD "
  if ([".ts", ".tsx"].includes(ext)) return " TS "
  if ([".js", ".jsx", ".mjs"].includes(ext)) return " JS "
  if (ext === ".json") return "JSON"
  if ([".yaml", ".yml"].includes(ext)) return "YAML"
  if ([".sh", ".bash", ".zsh"].includes(ext)) return " SH "
  if (ext === ".rs") return " RS "
  if (ext === ".go") return " GO "
  if (ext === ".py") return " PY "
  if (ext === ".css" || ext === ".scss") return "CSS "
  if (ext === ".html") return "HTML"
  return "FILE"
}

// Line-by-line markdown renderer — handles headings, code fences, lists, HRs
function MarkdownLines(props: { lines: string[] }) {
  const { theme } = useTheme()
  let inFence = false
  return (
    <For each={props.lines}>
      {(line) => {
        if (line.startsWith("```")) {
          inFence = !inFence
          return <box backgroundColor={theme.backgroundElement}><text fg={theme.textMuted}>{line || " "}</text></box>
        }
        if (inFence) {
          return <box backgroundColor={theme.backgroundElement}><text fg={theme.text}> {line}</text></box>
        }
        if (/^# /.test(line)) {
          return <text fg={theme.primary} attributes={TextAttributes.BOLD}>{line.replace(/^# /, "▌ ")}</text>
        }
        if (/^## /.test(line)) {
          return <text fg={theme.text} attributes={TextAttributes.BOLD}>{line.replace(/^## /, "  ▎ ")}</text>
        }
        if (/^#{3,} /.test(line)) {
          return <text fg={theme.textMuted} attributes={TextAttributes.BOLD}>{line.replace(/^#+\s/, "    ▏ ")}</text>
        }
        if (/^-{3,}$/.test(line) || /^\*{3,}$/.test(line)) {
          return <text fg={theme.border}>{"─".repeat(40)}</text>
        }
        if (/^[-*] /.test(line)) {
          return <text fg={theme.text}>{line.replace(/^[-*] /, "  • ")}</text>
        }
        if (/^\d+\. /.test(line)) {
          return <text fg={theme.text}>{line}</text>
        }
        if (!line.trim()) return <text fg={theme.text}>{" "}</text>
        return <text fg={theme.text} wrapMode="word">{line}</text>
      }}
    </For>
  )
}

// Code renderer with line numbers
function CodeLines(props: { lines: string[] }) {
  const { theme } = useTheme()
  const gutterWidth = () => String(props.lines.length).length
  return (
    <For each={props.lines}>
      {(line, i) => (
        <box flexDirection="row">
          <text fg={theme.textMuted}>{String(i() + 1).padStart(gutterWidth())} </text>
          <text fg={theme.border}>│</text>
          <text fg={theme.text} wrapMode="none"> {line}</text>
        </box>
      )}
    </For>
  )
}

function PreviewPanel(props: { filePath: string; onClose: () => void }) {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const panelWidth = () => Math.floor(dimensions().width * 0.5)
  const kind = () => fileKind(props.filePath)
  const fileName = () => path.basename(props.filePath)
  const icon = () => fileIcon(props.filePath)

  const [content] = createResource(
    () => (kind() !== "image" && kind() !== "binary" ? props.filePath : null),
    (p) => readFile(p, "utf-8").catch(() => "[Error reading file]"),
  )

  const lines = createMemo(() => content()?.split("\n") ?? [])

  useKeyboard((evt) => {
    if (evt.name === "escape") {
      evt.preventDefault()
      evt.stopPropagation()
      props.onClose()
    }
  })

  return (
    <box
      position="absolute"
      right={0}
      top={0}
      width={panelWidth()}
      height="100%"
      backgroundColor={theme.backgroundPanel}
      borderStyle="single"
      borderColor={theme.borderActive}
      flexDirection="column"
    >
      {/* Header */}
      <box
        flexDirection="row"
        justifyContent="space-between"
        paddingLeft={1}
        paddingRight={1}
        backgroundColor={theme.backgroundElement}
        flexShrink={0}
      >
        <box flexDirection="row" gap={1}>
          <text fg={theme.primary} attributes={TextAttributes.BOLD}>{icon()}</text>
          <text fg={theme.text} attributes={TextAttributes.BOLD}>{fileName()}</text>
        </box>
        <text fg={theme.textMuted} onMouseDown={props.onClose}>[esc]</text>
      </box>

      {/* Body */}
      <scrollbox flexGrow={1} paddingLeft={1} paddingRight={1}>
        <Show when={kind() === "image"}>
          <box paddingTop={1} gap={1}>
            <text fg={theme.textMuted} attributes={TextAttributes.BOLD}>Image file</text>
            <text fg={theme.textMuted} wrapMode="word">{props.filePath}</text>
            <text fg={theme.info}>Open in an external viewer to preview.</text>
          </box>
        </Show>

        <Show when={kind() === "binary"}>
          <box paddingTop={1} gap={1}>
            <text fg={theme.warning} attributes={TextAttributes.BOLD}>Binary / PDF file</text>
            <text fg={theme.textMuted} wrapMode="word">{props.filePath}</text>
          </box>
        </Show>

        <Show when={content.loading}>
          <text fg={theme.textMuted}>Loading…</text>
        </Show>

        <Show when={kind() === "code" && !content.loading}>
          <CodeLines lines={lines()} />
        </Show>

        <Show when={kind() === "markdown" && !content.loading}>
          <MarkdownLines lines={lines()} />
        </Show>
      </scrollbox>

      {/* Footer */}
      <box
        flexDirection="row"
        justifyContent="space-between"
        paddingLeft={1}
        paddingRight={1}
        backgroundColor={theme.backgroundElement}
        flexShrink={0}
      >
        <text fg={theme.textMuted}>
          {kind() === "code" ? (filetype(props.filePath) || "text") : kind()}
        </text>
        <text fg={theme.textMuted}>
          {lines().length > 0 ? `${lines().length}L  ` : ""}ESC
        </text>
      </box>
    </box>
  )
}

function View() {
  const { selectedFile, setSelectedFile } = useFilePreview()
  return (
    <Show when={selectedFile()}>
      <PreviewPanel filePath={selectedFile()!} onClose={() => setSelectedFile(null)} />
    </Show>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 100,
    slots: {
      session_overlay() {
        return <View />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = { id, tui }
export default plugin
