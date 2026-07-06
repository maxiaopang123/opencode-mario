import { useMarked } from "@opencode-ai/ui/context/marked"
import { useI18n } from "@opencode-ai/ui/context/i18n"
import morphdom from "morphdom"
import { checksum } from "@opencode-ai/core/util/encode"
import {
  type Accessor,
  type ComponentProps,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  createUniqueId,
  onCleanup,
  type Setter,
  splitProps,
} from "solid-js"
import { isServer, render } from "solid-js/web"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { bundledLanguages } from "shiki"
import { canReusePendingBlock, project, type Block, type Projection } from "./markdown-stream"
import {
  disposeStreamingCode,
  highlightStreamingCode,
  MarkdownWorkerDisposedError,
  MarkdownWorkerSupersededError,
  MarkdownWorkerUnavailableError,
} from "./markdown-worker"
import { markdownBlockKey, type MarkdownToken } from "./markdown-worker-protocol"
import { shouldResetCodeTokens, type RenderedCodeState } from "./markdown-code-state"
import { getCachedMarkdown, sanitizeMarkdown, touchCachedMarkdown, type MarkdownCacheEntry } from "./markdown-cache"
import { inlineCodeKind } from "./markdown-inline-code-kind"

type RenderedBlock =
  | (MarkdownCacheEntry & { key: string; mode: Exclude<Block["mode"], "code"> })
  | {
      key: string
      mode: "code"
      raw: string
      hash: string
      language: string
      complete: boolean
      generation: number
      stable: MarkdownToken[]
      unstable: MarkdownToken[]
    }

type RenderResult = {
  text: string
  blocks: RenderedBlock[]
}

const renderedCodeTokens = new WeakMap<HTMLDivElement, RenderedCodeState>()

function escape(text: string) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

function fallback(markdown: string) {
  return escape(markdown).replace(/\r\n?/g, "\n").replace(/\n/g, "<br>")
}

async function code(text: string, language: string | undefined, key: string, complete = false) {
  const normalized = codeBlockLanguage(language)
  const name = normalized in bundledLanguages || isSpecialCodeLanguage(normalized) ? normalized : "text"
  if (isSpecialCodeLanguage(name))
    return { language: name, generation: 0, stable: [], unstable: [[text, ""] as MarkdownToken] }
  try {
    const result = await highlightStreamingCode(key, text, name, complete)
    return { language: name, generation: result.generation, stable: result.stable, unstable: result.unstable }
  } catch (error) {
    if (
      !(error instanceof MarkdownWorkerDisposedError) &&
      !(error instanceof MarkdownWorkerSupersededError) &&
      !(error instanceof MarkdownWorkerUnavailableError)
    )
      console.error("Markdown highlighting worker failed", error)
    return { language: name, generation: 0, stable: [], unstable: [[text, ""] as MarkdownToken] }
  }
}

type CopyLabels = {
  copy: string
  copied: string
}

type CopyButtonState = {
  setLabels: Setter<CopyLabels>
  setCopied: Setter<boolean>
  dispose: () => void
}

const copyButtonState = new WeakMap<HTMLElement, CopyButtonState>()

const urlPattern = /^https?:\/\/[^\s<>()`"']+$/

function codeUrl(text: string) {
  const href = text.trim().replace(/[),.;!?]+$/, "")
  if (!urlPattern.test(href)) return
  try {
    const url = new URL(href)
    return url.toString()
  } catch {
    return
  }
}

function createCopyButton(labels: CopyLabels) {
  const host = document.createElement("div")
  host.setAttribute("data-slot", "markdown-copy-button")

  const state: Partial<CopyButtonState> = {}
  const dispose = render(() => {
    const [labelState, setLabels] = createSignal(labels, { equals: false })
    const [copied, setCopied] = createSignal(false)
    state.setLabels = setLabels
    state.setCopied = setCopied
    return <MarkdownCopyButton labels={labelState} copied={copied} />
  }, host)
  state.dispose = dispose
  copyButtonState.set(host, state as CopyButtonState)
  return host
}

function MarkdownCopyButton(props: { labels: Accessor<CopyLabels>; copied: Accessor<boolean> }) {
  const label = () => (props.copied() ? props.labels().copied : props.labels().copy)
  return (
    <TooltipV2 placement="top" value={label()}>
      <IconButtonV2
        type="button"
        size="normal"
        variant="ghost-muted"
        aria-label={label()}
        icon={
          <>
            <IconV2 name="outline-copy" data-copy-icon />
            <IconV2 name="check" data-check-icon />
          </>
        }
      />
    </TooltipV2>
  )
}

function setCopyState(host: HTMLElement, labels: CopyLabels, copied: boolean) {
  const state = copyButtonState.get(host)
  state?.setLabels(labels)
  state?.setCopied(copied)
  if (copied) {
    host.setAttribute("data-copied", "true")
    return
  }
  host.removeAttribute("data-copied")
}

function disposeCopyButton(host: HTMLElement) {
  copyButtonState.get(host)?.dispose()
  copyButtonState.delete(host)
}

function disposeCopyButtons(root: Element) {
  const hosts = [
    ...(root instanceof HTMLElement && root.getAttribute("data-slot") === "markdown-copy-button" ? [root] : []),
    ...Array.from(root.querySelectorAll('[data-slot="markdown-copy-button"]')).filter(
      (el): el is HTMLElement => el instanceof HTMLElement,
    ),
  ]
  hosts.forEach(disposeCopyButton)
}

const shellLanguages = new Set(["bash", "sh", "shell", "zsh", "fish", "console", "terminal"])

function codeKind(language: string | undefined) {
  const value = language?.toLowerCase()
  if (!value) return
  if (shellLanguages.has(value)) return "shell"
}

function codeLanguage(block: HTMLPreElement) {
  const code = block.querySelector("code")
  if (!(code instanceof HTMLElement)) return
  return code.className.match(/(?:^|\s)language-([^\s]+)/)?.[1]
}

function applyCodeMetadata(wrapper: HTMLElement, language: string | undefined) {
  if (!document.body.hasAttribute("data-new-layout")) {
    delete wrapper.dataset.language
    delete wrapper.dataset.codeKind
    return
  }

  if (language) wrapper.dataset.language = language
  else delete wrapper.dataset.language

  const kind = codeKind(language)
  if (kind) wrapper.dataset.codeKind = kind
  else delete wrapper.dataset.codeKind
}

function ensureCodeWrapper(block: HTMLPreElement, labels: CopyLabels) {
  const parent = block.parentElement
  if (!parent) return
  const wrapped = parent.getAttribute("data-component") === "markdown-code"
  if (!wrapped) {
    const wrapper = document.createElement("div")
    wrapper.setAttribute("data-component", "markdown-code")
    applyCodeMetadata(wrapper, codeLanguage(block))
    parent.replaceChild(wrapper, block)
    wrapper.appendChild(block)
    wrapper.appendChild(createCopyButton(labels))
    return
  }

  applyCodeMetadata(parent, codeLanguage(block))

  const buttons = Array.from(parent.querySelectorAll('[data-slot="markdown-copy-button"]')).filter(
    (el): el is HTMLButtonElement => el instanceof HTMLButtonElement,
  )

  if (buttons.length === 0) {
    parent.appendChild(createCopyButton(labels))
    return
  }

  for (const button of buttons.slice(1)) {
    disposeCopyButton(button)
    button.remove()
  }
}

function markCodeLinks(root: HTMLDivElement) {
  const codeNodes = Array.from(root.querySelectorAll(":not(pre) > code"))
  for (const code of codeNodes) {
    const href = codeUrl(code.textContent ?? "")
    const parentLink =
      code.parentElement instanceof HTMLAnchorElement && code.parentElement.classList.contains("external-link")
        ? code.parentElement
        : null

    if (!href) {
      if (parentLink) parentLink.replaceWith(code)
      continue
    }

    if (parentLink) {
      parentLink.href = href
      continue
    }

    const link = document.createElement("a")
    link.href = href
    link.className = "external-link"
    link.target = "_blank"
    link.rel = "noopener noreferrer"
    code.parentNode?.replaceChild(link, code)
    link.appendChild(code)
  }
}

function markInlineCode(root: HTMLDivElement) {
  const codeNodes = Array.from(root.querySelectorAll(":not(pre) > code"))
  for (const code of codeNodes) {
    if (!(code instanceof HTMLElement)) continue
    delete code.dataset.inlineCodeKind
    const kind = inlineCodeKind(code.textContent ?? "")
    if (kind) code.dataset.inlineCodeKind = kind
  }
}

function decorateSpecialCodeBlocks(root: HTMLDivElement, labels: CopyLabels, downloadDirectory: string | undefined) {
  const mermaidPlaceholders = Array.from(root.querySelectorAll("[data-mermaid-block]"))
  for (const el of mermaidPlaceholders) {
    if (!(el instanceof HTMLElement)) continue
    const wrapper = document.createElement("div")
    wrapper.setAttribute("data-component", "markdown-mermaid")
    el.parentNode?.replaceChild(wrapper, el)
    void renderMermaidBlock(
      wrapper,
      decodeURIComponent(el.getAttribute("data-mermaid-block") ?? ""),
      true,
      labels,
      downloadDirectory,
    )
  }

  const htmlPlaceholders = Array.from(root.querySelectorAll("[data-html-block]"))
  for (const el of htmlPlaceholders) {
    if (!(el instanceof HTMLElement)) continue
    const wrapper = document.createElement("div")
    wrapper.setAttribute("data-component", "markdown-html-preview")
    el.parentNode?.replaceChild(wrapper, el)
    renderHtmlPreviewBlock(
      wrapper,
      decodeURIComponent(el.getAttribute("data-html-block") ?? ""),
      true,
      labels,
      downloadDirectory,
    )
  }
}

function decorate(root: HTMLDivElement, labels: CopyLabels, downloadDirectory: string | undefined) {
  const blocks = Array.from(root.querySelectorAll("pre"))
  for (const block of blocks) {
    ensureCodeWrapper(block, labels)
  }
  decorateSpecialCodeBlocks(root, labels, downloadDirectory)
  if (!document.body.hasAttribute("data-new-layout")) return
  markInlineCode(root)
  markCodeLinks(root)
}

function setupCodeCopy(root: HTMLDivElement, getLabels: () => CopyLabels) {
  const timeouts = new Map<HTMLElement, ReturnType<typeof setTimeout>>()

  const updateLabel = (button: HTMLElement) => {
    const labels = getLabels()
    const copied = button.getAttribute("data-copied") === "true"
    setCopyState(button, labels, copied)
  }

  const handleClick = async (event: MouseEvent) => {
    const target = event.target
    if (!(target instanceof Element)) return

    const button = target.closest('[data-slot="markdown-copy-button"]')
    if (!(button instanceof HTMLElement)) return
    const copyRoot = button.closest(
      '[data-component="markdown-code"], [data-component="markdown-mermaid"], [data-component="markdown-html-preview"]',
    )
    const code = copyRoot?.querySelector("code")
    const content = copyRoot instanceof HTMLElement ? (copyRoot.dataset.copyText ?? code?.textContent ?? "") : ""
    if (!content) return
    const clipboard = navigator?.clipboard
    if (!clipboard) return
    await clipboard.writeText(content)
    const labels = getLabels()
    setCopyState(button, labels, true)
    const existing = timeouts.get(button)
    if (existing) clearTimeout(existing)
    const timeout = setTimeout(() => setCopyState(button, labels, false), 2000)
    timeouts.set(button, timeout)
  }

  const buttons = Array.from(root.querySelectorAll('[data-slot="markdown-copy-button"]'))
  for (const button of buttons) {
    if (button instanceof HTMLElement) updateLabel(button)
  }

  root.addEventListener("click", handleClick)

  return () => {
    root.removeEventListener("click", handleClick)
    for (const timeout of timeouts.values()) {
      clearTimeout(timeout)
    }
    disposeCopyButtons(root)
  }
}

function htmlPreviewTarget(raw: string) {
  const id = checksum(raw) ?? `${Date.now()}-${raw.length}`
  const key = `opencode-preview-html:${id}`
  const storage = typeof window === "undefined" ? undefined : window.sessionStorage
  if (storage) storage.setItem(key, raw)
  return `opencode-preview://html/${id}`
}

function cleanPreviewText(text: string) {
  return text
    .trim()
    .replace(/^[<"'`]+/, "")
    .replace(/[>"'`]+$/, "")
    .replace(/[),.;!?]+$/, "")
}

function stripLineSuffix(text: string) {
  return text.replace(/:(\d+)(?::\d+)?$/, "")
}

function isAbsoluteLocalPath(path: string) {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\") || path.startsWith("/") || path.startsWith("~/")
}

function isLocalPath(path: string) {
  if (isAbsoluteLocalPath(path)) return true
  if (path.startsWith("./") || path.startsWith("../") || path.startsWith(".\\") || path.startsWith("..\\")) return true
  return /[\\/]/.test(path) && /\.[A-Za-z0-9][A-Za-z0-9_-]{0,15}(?:[#?].*)?$/.test(path)
}

function joinPreviewPath(directory: string | undefined, path: string) {
  if (!directory || isAbsoluteLocalPath(path)) return path
  const separator = directory.includes("\\") ? "\\" : "/"
  const root = directory.endsWith("/") || directory.endsWith("\\") ? directory.slice(0, -1) : directory
  return `${root}${separator}${path.replace(/^\.?[\\/]/, "")}`
}

function previewTargetFromText(text: string, directory: string | undefined) {
  const value = cleanPreviewText(text)
  const url = codeUrl(value)
  if (url) return url
  if (value.toLowerCase().startsWith("file://")) {
    const path = decodeURIComponent(value.slice("file://".length).replace(/^\/([A-Za-z]:)/, "$1"))
    return path || undefined
  }
  const path = stripLineSuffix(value)
  if (!isLocalPath(path)) return
  return joinPreviewPath(directory, path)
}

function setupPreviewOpen(
  root: HTMLDivElement,
  getOpenPreview: () => ((target: string) => void) | undefined,
  getDirectory: () => string | undefined,
) {
  const handleDoubleClick = (event: MouseEvent) => {
    const target = event.target instanceof Text ? event.target.parentElement : event.target
    if (!(target instanceof Element)) return
    if (target.closest("button, [data-slot='markdown-copy-button'], [data-special-toolbar]")) return

    const html = target.closest('[data-component="markdown-html-preview"]')
    if (html instanceof HTMLElement) {
      const raw = html.dataset.copyText
      const open = getOpenPreview()
      if (!raw || !open) return
      event.preventDefault()
      open(htmlPreviewTarget(raw))
      return
    }

    const link = target.closest("a[href]")
    if (link instanceof HTMLAnchorElement) {
      const open = getOpenPreview()
      const previewTarget = previewTargetFromText(link.getAttribute("href") ?? link.href, getDirectory())
      if (!open || !previewTarget) return
      event.preventDefault()
      open(previewTarget)
      return
    }

    const code = target.closest("code")
    if (!(code instanceof HTMLElement) || code.closest("pre")) return
    const open = getOpenPreview()
    const previewTarget = previewTargetFromText(code.textContent ?? "", getDirectory())
    if (!open || !previewTarget) return
    event.preventDefault()
    open(previewTarget)
  }

  root.addEventListener("dblclick", handleDoubleClick)
  return () => root.removeEventListener("dblclick", handleDoubleClick)
}

function initialResult(text: string, key: string | undefined, projection: Projection, owner: string): RenderResult {
  if (!text) return { text, blocks: [] }
  const base = key ?? checksum(text)
  if (base) {
    const blocks = projection.blocks.flatMap((block, index) => {
      if (block.mode === "code") return []
      const cacheKey = `${base}:${index}:${block.mode}`
      const cached = getCachedMarkdown(cacheKey)
      if (cached?.raw !== block.raw) return []
      return [{ key: `${owner}:${cacheKey}`, mode: block.mode, ...cached }]
    })
    if (blocks.length === projection.blocks.length) return { text, blocks }
  }
  return {
    text,
    blocks: [
      {
        key: "initial",
        mode: "full",
        raw: text,
        hash: checksum(text) ?? "",
        html: fallback(text),
      },
    ],
  }
}

export function Markdown(
  props: ComponentProps<"div"> & {
    text: string
    cacheKey?: string
    streaming?: boolean
    downloadDirectory?: string
    onOpenPreview?: (target: string) => void
    class?: string
    classList?: Record<string, boolean>
  },
) {
  const [local, others] = splitProps(props, [
    "text",
    "cacheKey",
    "streaming",
    "downloadDirectory",
    "onOpenPreview",
    "class",
    "classList",
  ])
  const marked = useMarked()
  const i18n = useI18n()
  const [root, setRoot] = createSignal<HTMLDivElement>()
  const owner = createUniqueId()
  const activeCodeKeys = new Set<string>()
  const completedCode = new Map<string, Extract<RenderedBlock, { mode: "code" }>>()
  const projection = createMemo((previous: Projection | undefined) =>
    project(previous, local.text, local.streaming ?? false),
  )
  const [html] = createResource(
    () => {
      return {
        text: local.text,
        key: local.cacheKey,
        projection: projection(),
      }
    },
    async (src) => {
      if (isServer)
        return {
          text: src.text,
          blocks: [
            {
              key: "server",
              mode: "full" as const,
              raw: src.text,
              hash: checksum(src.text) ?? "",
              html: fallback(src.text),
            },
          ],
        } satisfies RenderResult
      if (!src.text) return { text: src.text, blocks: [] } satisfies RenderResult

      const base = src.key ?? checksum(src.text)
      return Promise.all(
        src.projection.blocks.map(async (block, index) => {
          const key = base ? `${base}:${index}:${block.mode}` : undefined
          const blockKey = markdownBlockKey(owner, src.key, index, block.mode)

          if (block.mode === "code") {
            const cached = completedCode.get(blockKey)
            if (block.complete && cached?.raw === block.raw) return cached
            const result = await code(block.src, block.language, blockKey, block.complete)
            const rendered = {
              key: blockKey,
              mode: block.mode,
              raw: block.raw,
              hash: String(block.raw.length),
              complete: !!block.complete,
              ...result,
            }
            if (block.complete) completedCode.set(blockKey, rendered)
            return rendered
          }

          if (key) {
            const cached = getCachedMarkdown(key)
            if (cached?.raw === block.raw) {
              touchCachedMarkdown(key, cached)
              return { key: blockKey, mode: block.mode, ...cached }
            }
          }

          const hash = checksum(block.raw)
          const safe = sanitizeMarkdown(await Promise.resolve(marked.parse(block.src)))
          if (key && hash) touchCachedMarkdown(key, { raw: block.raw, hash, html: safe })
          return { key: blockKey, mode: block.mode, raw: block.raw, hash: hash ?? "", html: safe }
        }),
      )
        .then((blocks) => ({ text: src.text, blocks }) satisfies RenderResult)
        .catch(
          () =>
            ({
              text: src.text,
              blocks: [
                {
                  key: base ?? "fallback",
                  mode: "full" as const,
                  raw: src.text,
                  hash: checksum(src.text) ?? "",
                  html: fallback(src.text),
                },
              ],
            }) satisfies RenderResult,
        )
    },
    {
      initialValue: initialResult(local.text, local.cacheKey, projection(), owner),
    },
  )

  let copyCleanup: (() => void) | undefined
  let previewCleanup: (() => void) | undefined

  createEffect(() => {
    const container = root()
    const result = html.latest ?? html()
    const projected = projection()
    const content = local.text ? pendingBlocks(result, projected, local.cacheKey, owner) : []
    if (!container) return
    if (isServer) return
    if (content.length === 0) {
      disposeCopyButtons(container)
      container.innerHTML = ""
      return
    }

    const labels = {
      copy: i18n.t("ui.message.copy"),
      copied: i18n.t("ui.message.copied"),
    }
    const nextCodeKeys = new Set(content.filter((block) => block.mode === "code").map((block) => block.key))
    activeCodeKeys.forEach((key) => {
      if (!nextCodeKeys.has(key)) disposeCode(key)
    })
    activeCodeKeys.clear()
    nextCodeKeys.forEach((key) => activeCodeKeys.add(key))
    content.forEach((block, index) => updateBlock(container, index, block, labels, local.downloadDirectory))
    while (container.children.length > content.length) {
      const child = container.lastElementChild
      if (!child) break
      disposeCopyButtons(child)
      child.remove()
    }
    container
      .querySelectorAll<HTMLElement>('[data-slot="markdown-copy-button"]')
      .forEach((button) => setCopyState(button, labels, button.dataset.copied === "true"))
    if (!copyCleanup)
      copyCleanup = setupCodeCopy(container, () => ({
        copy: i18n.t("ui.message.copy"),
        copied: i18n.t("ui.message.copied"),
      }))
    if (!previewCleanup)
      previewCleanup = setupPreviewOpen(
        container,
        () => local.onOpenPreview,
        () => local.downloadDirectory,
      )
  })

  onCleanup(() => {
    if (copyCleanup) copyCleanup()
    if (previewCleanup) previewCleanup()
    activeCodeKeys.forEach(disposeCode)
    completedCode.clear()
  })

  return (
    <div
      data-component="markdown"
      classList={{
        ...local.classList,
        [local.class ?? ""]: !!local.class,
      }}
      ref={setRoot}
      {...others}
    />
  )
}

function pendingBlocks(
  result: RenderResult | undefined,
  projection: Projection | undefined,
  cacheKey: string | undefined,
  owner: string,
) {
  if (!result) return []
  if (!projection || result.text === projection.text) return result.blocks
  const initial = result.blocks.length === 1 && result.blocks[0]?.key === "initial"
  return projection.blocks.map((block, index) => {
    const current = initial ? undefined : result.blocks[index]
    if (current && canReusePendingBlock(current, block)) return current
    const key = markdownBlockKey(owner, cacheKey, index, block.mode)
    if (block.mode !== "code")
      return { key, mode: block.mode, raw: block.raw, hash: String(block.raw.length), html: fallback(block.src) }
    return {
      key,
      mode: block.mode,
      raw: block.raw,
      hash: String(block.raw.length),
      language: block.language ?? "text",
      complete: !!block.complete,
      stable: [],
      generation: 0,
      unstable: [[block.src, ""] as MarkdownToken],
    }
  })
}

function disposeCode(key: string) {
  disposeStreamingCode(key)
}

function updateBlock(
  container: HTMLDivElement,
  index: number,
  block: RenderedBlock,
  labels: CopyLabels,
  downloadDirectory: string | undefined,
) {
  const current = container.children[index]
  if (block.mode === "code") {
    updateCodeBlock(container, current, block, labels, downloadDirectory)
    return
  }
  if (
    current instanceof HTMLDivElement &&
    current.dataset.markdownKey === block.key &&
    current.dataset.markdownHash === block.hash
  )
    return

  const next = document.createElement("div")
  next.dataset.markdownBlock = ""
  next.dataset.markdownKey = block.key
  next.dataset.markdownHash = block.hash
  next.style.display = "contents"
  next.innerHTML = block.html
  decorate(next, labels, downloadDirectory)

  if (!(current instanceof HTMLDivElement)) {
    container.appendChild(next)
    return
  }

  morphdom(current, next, {
    onBeforeElUpdated: (fromEl, toEl) => {
      if (
        fromEl instanceof HTMLElement &&
        toEl instanceof HTMLElement &&
        fromEl.getAttribute("data-slot") === "markdown-copy-button" &&
        toEl.getAttribute("data-slot") === "markdown-copy-button"
      ) {
        return false
      }
      if (fromEl.isEqualNode(toEl)) return false
      return true
    },
    onBeforeNodeDiscarded: (node) => {
      if (node instanceof Element) disposeCopyButtons(node)
      return true
    },
  })
}

function updateCodeBlock(
  container: HTMLDivElement,
  current: Element | undefined,
  block: Extract<RenderedBlock, { mode: "code" }>,
  labels: CopyLabels,
  downloadDirectory: string | undefined,
) {
  const language = codeBlockLanguage(block.language)
  if (language === "mermaid") {
    updateSpecialCodeBlock(container, current, block, labels, downloadDirectory, "markdown-mermaid", renderMermaidBlock)
    return
  }
  if (language === "html") {
    updateSpecialCodeBlock(container, current, block, labels, downloadDirectory, "markdown-html-preview", renderHtmlPreviewBlock)
    return
  }

  const existing = current instanceof HTMLDivElement && current.dataset.markdownKey === block.key ? current : undefined
  const next = existing ?? document.createElement("div")
  next.dataset.markdownBlock = ""
  next.dataset.markdownKey = block.key
  next.dataset.markdownHash = block.hash
  next.dataset.markdownComplete = block.complete ? "true" : "false"
  next.style.display = "contents"

  const code = existing?.querySelector("code")
  if (code instanceof HTMLElement) {
    const wrapper = code.closest('[data-component="markdown-code"]')
    if (wrapper instanceof HTMLElement) applyCodeMetadata(wrapper, block.language)
    code.className = `language-${block.language}`
    const previous = renderedCodeTokens.get(next)
    const reset = shouldResetCodeTokens(previous, {
      language: block.language,
      generation: block.generation,
      stableCount: block.stable.length,
      raw: block.raw,
    })
    const stableCount = reset ? 0 : previous!.stableCount
    const tail = [...block.stable.slice(stableCount), ...block.unstable]
    const prior = reset ? [] : previous!.unstable
    const prefix = prior.findIndex((token, index) => !sameToken(token, tail[index]))
    const keep = stableCount + (prefix < 0 ? Math.min(prior.length, tail.length) : prefix)
    while (code.children.length > keep) code.lastElementChild?.remove()
    tail
      .slice(keep - stableCount)
      .map(createTokenSpan)
      .forEach((span) => code.appendChild(span))
    renderedCodeTokens.set(next, {
      language: block.language,
      generation: block.generation,
      stableCount: block.stable.length,
      unstable: block.unstable,
      raw: block.raw,
    })
    return
  }

  const wrapper = document.createElement("div")
  wrapper.setAttribute("data-component", "markdown-code")
  applyCodeMetadata(wrapper, block.language)
  const pre = document.createElement("pre")
  pre.className = "shiki OpenCode"
  const codeElement = document.createElement("code")
  codeElement.className = `language-${block.language}`
  ;[...block.stable, ...block.unstable].map(createTokenSpan).forEach((span) => codeElement.appendChild(span))
  pre.appendChild(codeElement)
  wrapper.appendChild(pre)
  wrapper.appendChild(createCopyButton(labels))
  next.appendChild(wrapper)
  renderedCodeTokens.set(next, {
    language: block.language,
    generation: block.generation,
    stableCount: block.stable.length,
    unstable: block.unstable,
    raw: block.raw,
  })
  if (current) {
    disposeCopyButtons(current)
    current.replaceWith(next)
    return
  }
  container.appendChild(next)
}

function updateSpecialCodeBlock(
  container: HTMLDivElement,
  current: Element | undefined,
  block: Extract<RenderedBlock, { mode: "code" }>,
  labels: CopyLabels,
  downloadDirectory: string | undefined,
  component: "markdown-mermaid" | "markdown-html-preview",
  renderBlock: (
    wrapper: HTMLElement,
    raw: string,
    complete: boolean,
    labels: CopyLabels,
    downloadDirectory: string | undefined,
  ) => void | Promise<void>,
) {
  const existing = current instanceof HTMLDivElement && current.dataset.markdownKey === block.key ? current : undefined
  const next = existing ?? document.createElement("div")
  next.dataset.markdownBlock = ""
  next.dataset.markdownKey = block.key
  next.dataset.markdownHash = block.hash
  next.dataset.markdownComplete = block.complete ? "true" : "false"
  next.style.display = "contents"

  const wrapper =
    (existing?.querySelector(`[data-component="${component}"]`) as HTMLElement | null) ??
    (() => {
      const el = document.createElement("div")
      el.setAttribute("data-component", component)
      next.appendChild(el)
      return el
    })()
  void renderBlock(wrapper, specialCodeSource(block), block.complete, labels, downloadDirectory)

  if (existing) return
  if (current) {
    disposeCopyButtons(current)
    current.replaceWith(next)
    return
  }
  container.appendChild(next)
}

function codeBlockLanguage(language: string | undefined) {
  return language?.trim().split(/\s+/, 1)[0]?.toLowerCase() || "text"
}

function isSpecialCodeLanguage(language: string) {
  return language === "mermaid" || language === "html"
}

function specialCodeSource(block: Extract<RenderedBlock, { mode: "code" }>) {
  return [...block.stable, ...block.unstable].map((token) => token[0]).join("")
}

function sameToken(left: MarkdownToken, right: MarkdownToken | undefined) {
  return !!right && left[0] === right[0] && left[1] === right[1]
}

function createTokenSpan(token: MarkdownToken) {
  const span = document.createElement("span")
  span.setAttribute("style", token[1])
  span.textContent = token[0]
  return span
}

let mermaidInitialized = false

type DesktopFileApi = {
  saveFilePicker?: (opts?: { title?: string; defaultPath?: string }) => Promise<string | null>
  writeFile?: (filePath: string, content: string) => Promise<void>
}

function desktopFileApi() {
  if (typeof window === "undefined") return
  return (window as unknown as { api?: DesktopFileApi }).api
}

function downloadPath(directory: string | undefined, filename: string) {
  if (!directory) return filename
  const separator = directory.includes("\\") ? "\\" : "/"
  if (directory.endsWith("/") || directory.endsWith("\\")) return `${directory}${filename}`
  return `${directory}${separator}${filename}`
}

async function writeClipboardText(text: string) {
  const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard
  if (!clipboard?.writeText) return false
  return clipboard.writeText(text).then(
    () => true,
    () => false,
  )
}

async function saveTextFile(input: { title: string; filename: string; content: string; directory?: string }) {
  const api = desktopFileApi()
  const filePath = await api?.saveFilePicker?.({
    title: input.title,
    defaultPath: downloadPath(input.directory, input.filename),
  })
  if (filePath && api?.writeFile) {
    await api.writeFile(filePath, input.content)
    return
  }
  if (filePath === null) return

  const url = URL.createObjectURL(new Blob([input.content], { type: "image/svg+xml;charset=utf-8" }))
  const link = document.createElement("a")
  link.href = url
  link.download = input.filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

function specialButton(label: string, title: string, onClick: () => void | Promise<void>) {
  const button = document.createElement("button")
  button.type = "button"
  button.textContent = label
  button.title = title
  button.setAttribute("data-special-button", "")
  button.addEventListener("click", () => void onClick())
  return button
}

function markCopied(button: HTMLButtonElement, original: string) {
  button.textContent = "已复制"
  window.setTimeout(() => {
    button.textContent = original
  }, 1600)
}

async function renderMermaidBlock(
  wrapper: HTMLElement,
  raw: string,
  complete: boolean,
  labels: CopyLabels,
  downloadDirectory: string | undefined,
) {
  wrapper.dataset.copyText = raw
  const request = checksum(`${complete}:${raw}`) ?? `${complete}:${raw.length}`
  wrapper.dataset.renderRequest = request
  if (wrapper.dataset.renderedRaw === raw && wrapper.dataset.renderedComplete === String(complete)) return

  renderSpecialCodeSource(wrapper, raw, labels, "data-mermaid-pending")
  if (!complete) {
    wrapper.dataset.renderedRaw = raw
    wrapper.dataset.renderedComplete = "false"
    return
  }

  try {
    const mermaid = await import("mermaid")
    if (wrapper.dataset.renderRequest !== request) return
    if (!mermaidInitialized) {
      mermaid.default.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: document.documentElement.classList.contains("dark") ? "dark" : "default",
      })
      mermaidInitialized = true
    }

    const { svg } = await mermaid.default.render(`markdown-mermaid-${request}`, raw)
    if (wrapper.dataset.renderRequest !== request) return

    disposeCopyButtons(wrapper)
    wrapper.innerHTML = ""

    const viewport = document.createElement("div")
    viewport.setAttribute("data-mermaid-viewport", "")

    const diagram = document.createElement("div")
    diagram.setAttribute("data-mermaid-svg", "")
    diagram.innerHTML = svg
    viewport.appendChild(diagram)
    const svgElement = diagram.querySelector("svg")

    const toolbar = document.createElement("div")
    toolbar.setAttribute("data-special-toolbar", "")
    const zoomOut = specialButton("-", "缩小", () => undefined)
    const zoomIn = specialButton("+", "放大", () => undefined)
    const reset = specialButton("重置", "重置视图", () => undefined)
    const copySvg = specialButton("复制", "复制 SVG", async () => {
      if (await writeClipboardText(svg)) markCopied(copySvg, "复制")
    })
    const downloadSvg = specialButton("SVG", "下载 SVG", () =>
      saveTextFile({
        title: "保存 SVG",
        filename: `mermaid-${Date.now()}.svg`,
        content: svg,
        directory: downloadDirectory,
      }),
    )
    toolbar.append(zoomOut, zoomIn, reset, copySvg, downloadSvg)

    wrapper.append(viewport, toolbar)
    setupMermaidPanZoom(viewport, diagram, svgElement instanceof SVGSVGElement ? svgElement : undefined, {
      zoomIn,
      zoomOut,
      reset,
    })
    wrapper.dataset.renderedRaw = raw
    wrapper.dataset.renderedComplete = "true"
  } catch (error) {
    if (wrapper.dataset.renderRequest !== request) return
    disposeCopyButtons(wrapper)
    wrapper.innerHTML = ""

    const message = document.createElement("pre")
    message.setAttribute("data-mermaid-error", "")
    message.textContent = `Mermaid render failed\n\n${String(error)}\n\n${raw}`
    wrapper.appendChild(message)
    wrapper.appendChild(createCopyButton(labels))
    wrapper.dataset.renderedRaw = raw
    wrapper.dataset.renderedComplete = "true"
  }
}

function setupMermaidPanZoom(
  viewport: HTMLElement,
  diagram: HTMLElement,
  svg: SVGSVGElement | undefined,
  controls: { zoomIn: HTMLButtonElement; zoomOut: HTMLButtonElement; reset: HTMLButtonElement },
) {
  let x = 0
  let y = 0
  let scale = 1
  let baseWidth = 0
  let baseHeight = 0
  let drag: { id: number; x: number; y: number } | undefined

  const measure = () => {
    const viewBox = svg?.viewBox.baseVal
    const width = Number.parseFloat(svg?.getAttribute("width") ?? "")
    const height = Number.parseFloat(svg?.getAttribute("height") ?? "")
    baseWidth = viewBox?.width || width || svg?.getBoundingClientRect().width || diagram.offsetWidth
    baseHeight = viewBox?.height || height || svg?.getBoundingClientRect().height || diagram.offsetHeight
  }

  const applyScale = () => {
    if (!svg) return
    svg.style.width = `${baseWidth * scale}px`
    svg.style.height = `${baseHeight * scale}px`
  }

  const apply = () => {
    applyScale()
    diagram.style.transform = `translate(${x}px, ${y}px)`
  }

  const center = () => {
    scale = 1
    applyScale()
    const width = svg ? baseWidth * scale : diagram.offsetWidth
    const height = svg ? baseHeight * scale : diagram.offsetHeight
    x = Math.max(12, (viewport.clientWidth - width) / 2)
    y = Math.max(12, (viewport.clientHeight - height) / 2)
    apply()
  }

  requestAnimationFrame(() => {
    measure()
    center()
  })

  const zoomAt = (nextScale: number, originX = viewport.clientWidth / 2, originY = viewport.clientHeight / 2) => {
    const value = Math.min(Math.max(nextScale, 0.2), 6)
    x = originX - (originX - x) * (value / scale)
    y = originY - (originY - y) * (value / scale)
    scale = value
    apply()
  }

  viewport.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return
    if ((event.target as Element).closest("[data-special-toolbar]")) return
    drag = { id: event.pointerId, x: event.clientX - x, y: event.clientY - y }
    viewport.setPointerCapture(event.pointerId)
    viewport.dataset.dragging = "true"
  })
  viewport.addEventListener("pointermove", (event) => {
    if (!drag || drag.id !== event.pointerId) return
    x = event.clientX - drag.x
    y = event.clientY - drag.y
    apply()
  })
  const endDrag = (event: PointerEvent) => {
    if (!drag || drag.id !== event.pointerId) return
    drag = undefined
    delete viewport.dataset.dragging
  }
  viewport.addEventListener("pointerup", endDrag)
  viewport.addEventListener("pointercancel", endDrag)
  viewport.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault()
      const rect = viewport.getBoundingClientRect()
      zoomAt(scale * (event.deltaY > 0 ? 0.9 : 1.1), event.clientX - rect.left, event.clientY - rect.top)
    },
    { passive: false },
  )

  controls.zoomIn.addEventListener("click", () => zoomAt(scale * 1.25))
  controls.zoomOut.addEventListener("click", () => zoomAt(scale * 0.8))
  controls.reset.addEventListener("click", center)
}

function renderHtmlPreviewBlock(
  wrapper: HTMLElement,
  raw: string,
  complete: boolean,
  labels: CopyLabels,
  _downloadDirectory: string | undefined,
) {
  wrapper.dataset.copyText = raw
  if (wrapper.dataset.renderedRaw === raw && wrapper.dataset.renderedComplete === String(complete)) return

  if (!complete) {
    renderSpecialCodeSource(wrapper, raw, labels, "data-html-source")
    wrapper.dataset.renderedRaw = raw
    wrapper.dataset.renderedComplete = "false"
    return
  }

  disposeCopyButtons(wrapper)
  wrapper.innerHTML = ""

  const toolbar = document.createElement("div")
  toolbar.setAttribute("data-special-toolbar", "")
  const toggle = specialButton("源码", "显示源码", () => {
    const showingSource = wrapper.dataset.htmlMode === "source"
    wrapper.dataset.htmlMode = showingSource ? "preview" : "source"
    toggle.textContent = showingSource ? "源码" : "预览"
    toggle.title = showingSource ? "显示源码" : "显示预览"
  })
  toolbar.appendChild(toggle)

  const frame = document.createElement("iframe")
  frame.setAttribute("data-html-preview", "")
  frame.setAttribute("sandbox", "allow-scripts")
  frame.title = "HTML preview"
  frame.srcdoc = raw

  const source = document.createElement("pre")
  source.setAttribute("data-html-source", "")
  const code = document.createElement("code")
  code.textContent = raw
  source.appendChild(code)

  wrapper.dataset.htmlMode = "preview"
  wrapper.append(toolbar, frame, source)
  wrapper.dataset.renderedRaw = raw
  wrapper.dataset.renderedComplete = "true"
}

function renderSpecialCodeSource(wrapper: HTMLElement, raw: string, labels: CopyLabels, attribute: string) {
  disposeCopyButtons(wrapper)
  wrapper.innerHTML = ""

  const pre = document.createElement("pre")
  pre.setAttribute(attribute, "")
  const code = document.createElement("code")
  code.textContent = raw
  pre.appendChild(code)
  wrapper.appendChild(pre)
  wrapper.appendChild(createCopyButton(labels))
}
