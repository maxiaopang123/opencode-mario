import { createResource, createSignal, Match, onCleanup, Show, Switch } from "solid-js"
import { Markdown } from "@opencode-ai/session-ui/markdown"
import { mediaKindFromPath, dataUrlFromMediaValue } from "@opencode-ai/session-ui/pierre/media"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { useSDK } from "@/context/sdk"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import type { FileContent } from "@opencode-ai/sdk/v2"

const PREVIEWABLE_EXTS = ["html", "htm", "md", "markdown"] as const
const HTML_PREVIEW_PREFIX = "opencode-preview://html/"

export function isPreviewablePath(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase()
  return !!ext && (PREVIEWABLE_EXTS as readonly string[]).includes(ext)
}

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes.buffer
}

function isUrlPreview(path: string) {
  return /^https?:\/\//i.test(path)
}

function htmlPreviewID(path: string) {
  if (!path.startsWith(HTML_PREVIEW_PREFIX)) return
  return path.slice(HTML_PREVIEW_PREFIX.length)
}

function htmlPreviewContent(path: string) {
  const id = htmlPreviewID(path)
  if (!id || typeof window === "undefined") return
  return window.sessionStorage.getItem(`opencode-preview-html:${id}`) ?? undefined
}

async function docxToHtml(data: FileContent): Promise<string> {
  const { default: mammoth } = await import("mammoth")
  const buf = base64ToArrayBuffer(data.content)
  const result = await mammoth.convertToHtml({ arrayBuffer: buf })
  return result.value
}

async function xlsxToHtml(data: FileContent): Promise<string> {
  const XLSX = await import("xlsx")
  const buf = base64ToArrayBuffer(data.content)
  const wb = XLSX.read(buf, { type: "array" })
  return wb.SheetNames.map((name) => {
    const sheet = wb.Sheets[name]!
    const html = XLSX.utils.sheet_to_html(sheet, { id: name })
    return `<h3 style="margin:12px 0 4px;font-size:13px;color:#666">${name}</h3>${html}`
  }).join("")
}

async function pptxToText(data: FileContent): Promise<string> {
  const { unzipSync, strFromU8 } = await import("fflate")
  const buf = base64ToArrayBuffer(data.content)
  const files = unzipSync(new Uint8Array(buf))

  const slideEntries = Object.entries(files)
    .filter(([name]) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))

  const parser = typeof DOMParser !== "undefined" ? new DOMParser() : null
  if (!parser) return "Unable to parse PPTX: DOMParser is unavailable"

  const slides = slideEntries.map(([, bytes], idx) => {
    const xml = strFromU8(bytes)
    const doc = parser.parseFromString(xml, "application/xml")
    const texts = Array.from(doc.querySelectorAll("t"))
      .map((n) => n.textContent ?? "")
      .filter(Boolean)
    return `Slide ${idx + 1}\n${texts.join(" ")}`
  })

  return slides.join("\n\n") || "(No slide text content)"
}

type OfficeResult = { kind: "html"; html: string } | { kind: "text"; text: string } | { kind: "error"; message: string }

export function FilePreviewPanel(props: { path: string }) {
  const sdk = useSDK()
  const language = useLanguage()
  const layout = useLayout()

  const ext = () => props.path.split(".").pop()?.toLowerCase() ?? ""
  const fileName = () => {
    if (htmlPreviewID(props.path)) return "HTML Preview"
    if (isUrlPreview(props.path)) return props.path.match(/^https?:\/\/([^/?#]+)/i)?.[1] ?? props.path
    return props.path.split(/[\\/]/).pop() ?? props.path
  }
  const mediaKind = () => mediaKindFromPath(props.path)
  const isPdf = () => ext() === "pdf"
  const isDocx = () => ext() === "docx" || ext() === "doc"
  const isXlsx = () => ["xlsx", "xls", "xlsm", "ods", "csv"].includes(ext())
  const isPptx = () => ext() === "pptx" || ext() === "ppt"

  const [content] = createResource(
    () => props.path,
    async (path) => {
      if (isUrlPreview(path) || htmlPreviewID(path)) return null
      const result = await sdk().client.file.read({ path })
      return result.data ?? null
    },
  )

  const textContent = () => {
    const data = content()
    if (!data || data.type === "binary") return ""
    return data.content ?? ""
  }

  const mediaDataUrl = () => {
    const data = content()
    const kind = mediaKind()
    if (!data || !kind) return undefined
    return dataUrlFromMediaValue(data, kind)
  }

  const pdfDataUrl = () => {
    const data = content()
    if (!data || !isPdf()) return undefined
    if (data.type === "binary" && data.content) return `data:application/pdf;base64,${data.content}`
    return undefined
  }

  const [officeResult, setOfficeResult] = createSignal<OfficeResult | null>(null)
  const [officeLoading, setOfficeLoading] = createSignal(false)
  const isOffice = () => isDocx() || isXlsx() || isPptx()

  createResource(
    () => {
      const data = content()
      if (!data || !isOffice() || data.type !== "binary") return null
      return { ext: ext(), data }
    },
    async (input) => {
      if (!input) return
      setOfficeLoading(true)
      setOfficeResult(null)
      try {
        if (input.ext === "docx" || input.ext === "doc") {
          const html = await docxToHtml(input.data)
          setOfficeResult({ kind: "html", html })
          return
        }
        if (["xlsx", "xls", "xlsm", "ods"].includes(input.ext)) {
          const html = await xlsxToHtml(input.data)
          setOfficeResult({ kind: "html", html })
          return
        }
        if (input.ext === "csv") {
          setOfficeResult({ kind: "text", text: input.data.content })
          return
        }
        if (input.ext === "pptx" || input.ext === "ppt") {
          const text = await pptxToText(input.data)
          setOfficeResult({ kind: "text", text })
        }
      } catch (e) {
        setOfficeResult({ kind: "error", message: String(e) })
      } finally {
        setOfficeLoading(false)
      }
    },
  )

  onCleanup(() => setOfficeResult(null))

  return (
    <div class="h-full flex flex-col bg-background-base border-l border-border-weaker-base">
      <div class="shrink-0 flex items-center justify-between gap-2 px-4 py-2.5 border-b border-border-weaker-base">
        <span class="text-13-medium text-text-strong truncate min-w-0 flex-1">{fileName()}</span>
        <IconButton
          icon="close-small"
          variant="ghost"
          class="shrink-0"
          onClick={() => layout.filePreview.close()}
          aria-label={language.t("common.close")}
        />
      </div>
      <div class="flex-1 min-h-0 relative">
        <Show when={content.loading || officeLoading()}>
          <div class="flex items-center justify-center h-full text-text-weak text-13-regular">
            {language.t("common.loading")}
            {language.t("common.loading.ellipsis")}
          </div>
        </Show>
        <Show when={content.error}>
          <div class="flex items-center justify-center h-full text-text-weak text-13-regular">
            {language.t("toast.file.loadFailed.title")}
          </div>
        </Show>
        <Show when={isUrlPreview(props.path)}>
          <iframe
            title={fileName()}
            src={props.path}
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
            class="h-full w-full border-0 bg-white"
          />
        </Show>
        <Show when={htmlPreviewID(props.path)}>
          <Show
            when={htmlPreviewContent(props.path)}
            fallback={
              <div class="flex items-center justify-center h-full text-text-weak text-13-regular">
                HTML preview is unavailable
              </div>
            }
          >
            {(html) => (
              <iframe
                title={fileName()}
                sandbox="allow-scripts"
                srcdoc={html()}
                class="h-full w-full border-0 bg-white"
              />
            )}
          </Show>
        </Show>
        <Show
          when={
            !isUrlPreview(props.path) &&
            !htmlPreviewID(props.path) &&
            !content.loading &&
            !content.error &&
            content() !== null &&
            !officeLoading()
          }
        >
          <Switch>
            <Match when={isPdf()}>
              <Show
                when={pdfDataUrl()}
                fallback={
                  <div class="flex items-center justify-center h-full text-text-weak text-13-regular">
                    Unable to load PDF
                  </div>
                }
              >
                {(url) => <iframe title={fileName()} src={url()} class="h-full w-full border-0" />}
              </Show>
            </Match>

            <Match when={isOffice()}>
              <Switch
                fallback={
                  <div class="flex items-center justify-center h-full text-text-weak text-13-regular">
                    Parsing document...
                  </div>
                }
              >
                <Match when={officeResult()?.kind === "html"}>
                  <div
                    class="h-full overflow-auto p-4 text-text-strong text-13-regular [&_table]:border-collapse [&_td]:border [&_td]:border-border-weaker-base [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-border-weaker-base [&_th]:px-2 [&_th]:py-1 [&_h3]:text-12-medium [&_h3]:text-text-weak"
                    innerHTML={(officeResult() as { kind: "html"; html: string }).html}
                  />
                </Match>
                <Match when={officeResult()?.kind === "text"}>
                  <pre class="h-full overflow-auto whitespace-pre-wrap font-mono text-13-regular p-4 text-text-strong select-text">
                    {(officeResult() as { kind: "text"; text: string }).text}
                  </pre>
                </Match>
                <Match when={officeResult()?.kind === "error"}>
                  <div class="flex flex-col items-center justify-center h-full gap-2 text-text-weak">
                    <span class="text-13-regular">Document parsing failed</span>
                    <span class="text-12-regular opacity-60">
                      {(officeResult() as { kind: "error"; message: string }).message}
                    </span>
                  </div>
                </Match>
              </Switch>
            </Match>

            <Match when={mediaKind() === "image" || mediaKind() === "svg"}>
              <Show
                when={mediaDataUrl()}
                fallback={
                  <div class="flex items-center justify-center h-full text-text-weak text-13-regular">
                    Unable to render image
                  </div>
                }
              >
                {(url) => (
                  <div class="h-full overflow-auto flex items-center justify-center p-4">
                    <img src={url()} alt={fileName()} class="max-w-full max-h-full object-contain" />
                  </div>
                )}
              </Show>
            </Match>

            <Match when={mediaKind() === "audio"}>
              <Show
                when={mediaDataUrl()}
                fallback={
                  <div class="flex items-center justify-center h-full text-text-weak text-13-regular">
                    Unable to render audio
                  </div>
                }
              >
                {(url) => (
                  <div class="flex items-center justify-center h-full p-8">
                    <audio controls src={url()} class="w-full max-w-md" />
                  </div>
                )}
              </Show>
            </Match>

            <Match when={ext() === "html" || ext() === "htm"}>
              <iframe
                title={fileName()}
                sandbox="allow-scripts allow-same-origin allow-popups"
                srcdoc={textContent()}
                class="h-full w-full border-0 bg-white"
              />
            </Match>

            <Match when={ext() === "md" || ext() === "markdown"}>
              <div class="h-full overflow-auto px-6 py-4">
                <Markdown text={textContent()} cacheKey={`file-preview:${props.path}`} />
              </div>
            </Match>

            <Match when={!content()?.type || content()?.type === "text"}>
              <pre class="h-full overflow-auto whitespace-pre font-mono text-13-regular p-4 text-text-strong select-text">
                {textContent()}
              </pre>
            </Match>

            <Match when={true}>
              <div class="flex items-center justify-center h-full text-text-weak text-13-regular">
                Binary file preview is unavailable
              </div>
            </Match>
          </Switch>
        </Show>
      </div>
    </div>
  )
}
