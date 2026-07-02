import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createSignal, createResource, For, Show } from "solid-js"
import { readdir } from "node:fs/promises"
import { join } from "node:path"
import { useFilePreview } from "../../context/file-preview"

const id = "internal:sidebar-file-tree"

type Entry = { name: string; isDir: boolean; path: string }

function DirNode(props: {
  dirPath: string
  depth: number
  theme: TuiPluginApi["theme"]["current"]
  onSelect: (p: string) => void
}) {
  const [open, setOpen] = createSignal(props.depth === 0)
  const [entries] = createResource(
    () => (open() ? props.dirPath : null),
    async (dir) => {
      const items = await readdir(dir, { withFileTypes: true })
      return items
        .filter((e) => !e.name.startsWith("."))
        .sort((a, b) => {
          if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
          return a.name.localeCompare(b.name)
        })
        .map<Entry>((e) => ({ name: e.name, isDir: e.isDirectory(), path: join(dir, e.name) }))
    },
  )

  const indent = "  ".repeat(props.depth)
  const theme = () => props.theme

  return (
    <Show when={props.depth === 0 || true}>
      <Show when={props.depth > 0}>
        <text fg={theme().text} onMouseDown={() => setOpen((x) => !x)}>
          {indent}
          {open() ? "▼ " : "▶ "}
          {props.depth > 0 && <text fg={theme().textMuted}>{props.depth > 0 ? "" : ""}</text>}
        </text>
      </Show>
      <Show when={open()}>
        <For each={entries()}>
          {(entry) => (
            <Show
              when={entry.isDir}
              fallback={
                <text
                  fg={theme().textMuted}
                  wrapMode="none"
                  onMouseDown={() => props.onSelect(entry.path)}
                >
                  {"  ".repeat(props.depth + 1)}📄 {entry.name}
                </text>
              }
            >
              <box>
                <text fg={theme().text} onMouseDown={() => setOpen((x) => !x)}>
                  {"  ".repeat(props.depth + (props.depth === 0 ? 0 : 1))}
                  {open() ? "▼" : "▶"} 📁 {entry.name}
                </text>
                <Show when={open()}>
                  <DirNode
                    dirPath={entry.path}
                    depth={props.depth + 1}
                    theme={props.theme}
                    onSelect={props.onSelect}
                  />
                </Show>
              </box>
            </Show>
          )}
        </For>
      </Show>
    </Show>
  )
}

function View(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current
  const { setSelectedFile } = useFilePreview()
  const [open, setOpen] = createSignal(false)

  // Get working directory from session
  const session = () => props.api.state.session.get(props.session_id)
  const cwd = () => session()?.directory ?? process.cwd()

  return (
    <box>
      <box flexDirection="row" gap={1} onMouseDown={() => setOpen((x) => !x)}>
        <text fg={theme().text}>{open() ? "▼" : "▶"}</text>
        <text fg={theme().text}>
          <b>Files</b>
        </text>
      </box>
      <Show when={open()}>
        <DirNode dirPath={cwd()} depth={0} theme={theme()} onSelect={setSelectedFile} />
      </Show>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 100,
    slots: {
      sidebar_content(_ctx, props) {
        return <View api={api} session_id={props.session_id} />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = { id, tui }
export default plugin
