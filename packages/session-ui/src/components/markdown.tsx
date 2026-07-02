import { useMarked } from "@opencode-ai/ui/context/marked"
import { useI18n } from "@opencode-ai/ui/context/i18n"
import morphdom from "morphdom"
import { checksum } from "@opencode-ai/core/util/encode"
import {
  ComponentProps,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  createUniqueId,
  onCleanup,
  splitProps,
} from "solid-js"
import { isServer } from "solid-js/web"
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

const iconPaths = {
  copy: '<path d="M6.2513 6.24935V2.91602H17.0846V13.7493H13.7513M13.7513 6.24935V17.0827H2.91797V6.24935H13.7513Z" stroke="currentColor" stroke-linecap="round"/>',
  check: '<path d="M5 11.9657L8.37838 14.7529L15 5.83398" stroke="currentColor" stroke-linecap="square"/>',
}

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
  const name = language && language in bundledLanguages ? language : "text"
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

function createIcon(path: string, slot: string) {
  const icon = document.createElement("div")
  icon.setAttribute("data-component", "icon")
  icon.setAttribute("data-size", "small")
  icon.setAttribute("data-slot", slot)
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
  svg.setAttribute("data-slot", "icon-svg")
  svg.setAttribute("fill", "none")
  svg.setAttribute("viewBox", "0 0 20 20")
  svg.setAttribute("aria-hidden", "true")
  svg.innerHTML = path
  icon.appendChild(svg)
  return icon
}

function createCopyButton(labels: CopyLabels) {
  const button = document.createElement("button")
  button.type = "button"
  button.setAttribute("data-component", "icon-button")
  button.setAttribute("data-variant", "secondary")
  button.setAttribute("data-size", "small")
  button.setAttribute("data-slot", "markdown-copy-button")
  button.setAttribute("aria-label", labels.copy)
  button.setAttribute("data-tooltip", labels.copy)
  button.appendChild(createIcon(iconPaths.copy, "copy-icon"))
  button.appendChild(createIcon(iconPaths.check, "check-icon"))
  return button
}

function setCopyState(button: HTMLButtonElement, labels: CopyLabels, copied: boolean) {
  if (copied) {
    button.setAttribute("data-copied", "true")
    button.setAttribute("aria-label", labels.copied)
    button.setAttribute("data-tooltip", labels.copied)
    return
  }
  button.removeAttribute("data-copied")
  button.setAttribute("aria-label", labels.copy)
  button.setAttribute("data-tooltip", labels.copy)
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

function decorateSpecialCodeBlocks(root: HTMLDivElement, labels: CopyLabels) {
  const mermaidPlaceholders = Array.from(root.querySelectorAll("[data-mermaid-block]"))
  for (const el of mermaidPlaceholders) {
    if (!(el instanceof HTMLElement)) continue
    const raw = decodeURIComponent(el.getAttribute("data-mermaid-block") ?? "")
    const wrapper = document.createElement("div")
    wrapper.setAttribute("data-component", "markdown-mermaid")
    wrapper.style.cssText = "position:relative;margin:12px 0"
    el.parentNode?.replaceChild(wrapper, el)
    void renderMermaidBlock(wrapper, raw, true, labels)
  }

  const htmlPlaceholders = Array.from(root.querySelectorAll("[data-html-block]"))
  for (const el of htmlPlaceholders) {
    if (!(el instanceof HTMLElement)) continue
    const raw = decodeURIComponent(el.getAttribute("data-html-block") ?? "")
    const wrapper = document.createElement("div")
    wrapper.setAttribute("data-component", "markdown-html-preview")
    wrapper.style.cssText = "position:relative;margin:12px 0"
    el.parentNode?.replaceChild(wrapper, el)
    renderHtmlPreviewBlock(wrapper, raw, true, labels)
  }
}

function decorate(root: HTMLDivElement, labels: CopyLabels) {
  const blocks = Array.from(root.querySelectorAll("pre"))
  for (const block of blocks) {
    ensureCodeWrapper(block, labels)
  }
  if (!document.body.hasAttribute("data-new-layout")) return
  markInlineCode(root)
  markCodeLinks(root)
}

function setupCodeCopy(root: HTMLDivElement, getLabels: () => CopyLabels) {
  const timeouts = new Map<HTMLButtonElement, ReturnType<typeof setTimeout>>()

  const updateLabel = (button: HTMLButtonElement) => {
    const labels = getLabels()
    const copied = button.getAttribute("data-copied") === "true"
    setCopyState(button, labels, copied)
  }

  const handleClick = async (event: MouseEvent) => {
    const target = event.target
    if (!(target instanceof Element)) return

    const button = target.closest('[data-slot="markdown-copy-button"]')
    if (!(button instanceof HTMLButtonElement)) return
    const copyRoot = button.closest(
      '[data-component="markdown-code"], [data-component="markdown-mermaid"], [data-component="markdown-html-preview"]',
    ) as HTMLElement | null
    const code = copyRoot?.querySelector("code")
    const content = copyRoot?.dataset.copyText ?? code?.textContent ?? ""
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
    if (button instanceof HTMLButtonElement) updateLabel(button)
  }

  root.addEventListener("click", handleClick)

  return () => {
    root.removeEventListener("click", handleClick)
    for (const timeout of timeouts.values()) {
      clearTimeout(timeout)
    }
  }
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
    class?: string
    classList?: Record<string, boolean>
  },
) {
  const [local, others] = splitProps(props, ["text", "cacheKey", "streaming", "class", "classList"])
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
            const language = codeBlockLanguage(block.language)
            const result = language === "mermaid" || language === "html"
              ? { language, generation: 0, stable: [] as MarkdownToken[], unstable: [[block.src, ""] as MarkdownToken] }
              : await code(block.src, block.language, blockKey, block.complete)
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

  createEffect(() => {
    const container = root()
    const result = html.latest ?? html()
    const projected = projection()
    const content = local.text ? pendingBlocks(result, projected, local.cacheKey, owner) : []
    if (!container) return
    if (isServer) return
    if (content.length === 0) {
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
    content.forEach((block, index) => updateBlock(container, index, block, labels))
    while (container.children.length > content.length) container.lastElementChild?.remove()
    container
      .querySelectorAll<HTMLButtonElement>('[data-slot="markdown-copy-button"]')
      .forEach((button) => setCopyState(button, labels, button.dataset.copied === "true"))
    if (!copyCleanup)
      copyCleanup = setupCodeCopy(container, () => ({
        copy: i18n.t("ui.message.copy"),
        copied: i18n.t("ui.message.copied"),
      }))
  })

  onCleanup(() => {
    if (copyCleanup) copyCleanup()
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

function updateBlock(container: HTMLDivElement, index: number, block: RenderedBlock, labels: CopyLabels) {
  const current = container.children[index]
  if (block.mode === "code") {
    updateCodeBlock(container, current, block, labels)
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
  decorate(next, labels)

  if (!(current instanceof HTMLDivElement)) {
    container.appendChild(next)
    decorateSpecialCodeBlocks(next as HTMLDivElement, labels)
    return
  }

  morphdom(current, next, {
    onBeforeElUpdated: (fromEl, toEl) => {
      if (
        fromEl instanceof HTMLButtonElement &&
        toEl instanceof HTMLButtonElement &&
        fromEl.getAttribute("data-slot") === "markdown-copy-button" &&
        toEl.getAttribute("data-slot") === "markdown-copy-button"
      ) {
        return false
      }
      if (fromEl.isEqualNode(toEl)) return false
      return true
    },
  })
  decorateSpecialCodeBlocks(current as HTMLDivElement, labels)
}

function updateCodeBlock(
  container: HTMLDivElement,
  current: Element | undefined,
  block: Extract<RenderedBlock, { mode: "code" }>,
  labels: CopyLabels,
) {
  const language = codeBlockLanguage(block.language)

  if (language === "mermaid") {
    const existing = current instanceof HTMLDivElement && current.dataset.markdownKey === block.key ? current : undefined
    const next = existing ?? document.createElement("div")
    next.dataset.markdownBlock = ""
    next.dataset.markdownKey = block.key
    next.dataset.markdownHash = block.hash
    next.style.display = "contents"
    const wrapper =
      (existing?.querySelector("[data-component='markdown-mermaid']") as HTMLElement | null) ??
      (() => {
        const el = document.createElement("div")
        el.setAttribute("data-component", "markdown-mermaid")
        el.style.cssText = "position:relative;margin:12px 0"
        next.appendChild(el)
        return el
      })()
    void renderMermaidBlock(wrapper, specialCodeSource(block), block.complete, labels)
    if (!existing) {
      if (current) current.replaceWith(next)
      else container.appendChild(next)
    }
    return
  }

  if (language === "html") {
    const existing = current instanceof HTMLDivElement && current.dataset.markdownKey === block.key ? current : undefined
    const next = existing ?? document.createElement("div")
    next.dataset.markdownBlock = ""
    next.dataset.markdownKey = block.key
    next.dataset.markdownHash = block.hash
    next.style.display = "contents"
    const wrapper =
      (existing?.querySelector("[data-component='markdown-html-preview']") as HTMLElement | null) ??
      (() => {
        const el = document.createElement("div")
        el.setAttribute("data-component", "markdown-html-preview")
        el.style.cssText = "position:relative;margin:12px 0"
        next.appendChild(el)
        return el
      })()
    renderHtmlPreviewBlock(wrapper, specialCodeSource(block), block.complete, labels)
    if (!existing) {
      if (current) current.replaceWith(next)
      else container.appendChild(next)
    }
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
  if (current) current.replaceWith(next)
  else container.appendChild(next)
}

function codeBlockLanguage(language: string | undefined) {
  return language?.trim().split(/\s+/, 1)[0]?.toLowerCase() || "text"
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

// --- Mermaid rendering ---

let mermaidInitialized = false

async function renderMermaidBlock(wrapper: HTMLElement, raw: string, complete: boolean, labels: CopyLabels) {
  wrapper.dataset.copyText = raw
  if (!complete) {
    let pending = wrapper.querySelector("[data-mermaid-pending]") as HTMLPreElement | null
    if (!pending) {
      wrapper.innerHTML = ""
      pending = document.createElement("pre")
      pending.setAttribute("data-mermaid-pending", "")
      pending.style.cssText = "opacity:0.4;font-size:12px;overflow:auto;padding:12px;margin:0"
      wrapper.appendChild(pending)
    }
    pending.textContent = raw
    wrapper.dataset.renderedRaw = raw
    wrapper.dataset.renderedComplete = "false"
    return
  }

  if (wrapper.dataset.renderedRaw === raw && wrapper.dataset.renderedComplete === "true") return

  const id = `mermaid-${Math.random().toString(36).slice(2)}`
  try {
    const mermaid = await import("mermaid")
    if (!mermaidInitialized) {
      mermaid.default.initialize({
        startOnLoad: false,
        theme: document.documentElement.classList.contains("dark") ? "dark" : "default",
        securityLevel: "strict",
      })
      mermaidInitialized = true
    }
    const { svg } = await mermaid.default.render(id, raw)
    wrapper.innerHTML = ""

    // 外层容器：固定高度 + overflow hidden，作为视口
    const viewport = document.createElement("div")
    viewport.setAttribute("data-mermaid-viewport", "")
    viewport.style.cssText =
      "position:relative;overflow:hidden;cursor:grab;user-select:none;" +
      "min-height:120px;max-height:500px;padding:12px 0;"

    // 内层：承载 SVG，接受 transform
    const svgWrap = document.createElement("div")
    svgWrap.setAttribute("data-mermaid-svg", "")
    svgWrap.style.cssText = "transform-origin:0 0;display:inline-block;position:absolute;"
    svgWrap.innerHTML = svg

    const svgEl = svgWrap.querySelector("svg")
    if (svgEl instanceof SVGElement) {
      svgEl.style.display = "block"
    }

    viewport.appendChild(svgWrap)

    // 悬浮按钮组（右上角，hover 时显示）
    const floatBtns = document.createElement("div")
    floatBtns.style.cssText =
      "position:absolute;top:8px;right:8px;display:flex;gap:4px;z-index:20;" +
      "opacity:0;transition:opacity 0.15s;pointer-events:none"

    const btnStyle =
      "font-size:11px;padding:2px 7px;border-radius:4px;cursor:pointer;" +
      "border:0.5px solid var(--v2-border-border-base);" +
      "background:var(--v2-background-bg-layer-02,#222);" +
      "color:var(--v2-text-text-muted);pointer-events:auto"

    const zoomInBtn = document.createElement("button")
    zoomInBtn.type = "button"; zoomInBtn.textContent = "+"; zoomInBtn.title = "放大"
    zoomInBtn.style.cssText = btnStyle

    const zoomOutBtn = document.createElement("button")
    zoomOutBtn.type = "button"; zoomOutBtn.textContent = "−"; zoomOutBtn.title = "缩小"
    zoomOutBtn.style.cssText = btnStyle

    const resetBtn = document.createElement("button")
    resetBtn.type = "button"; resetBtn.textContent = "⟳"; resetBtn.title = "重置居中"
    resetBtn.style.cssText = btnStyle

    const toggleSourceBtn = document.createElement("button")
    toggleSourceBtn.type = "button"; toggleSourceBtn.textContent = "源码"; toggleSourceBtn.title = "查看源码"
    toggleSourceBtn.style.cssText = btnStyle

    const saveSvgBtn = document.createElement("button")
    saveSvgBtn.type = "button"; saveSvgBtn.textContent = "保存"; saveSvgBtn.title = "保存 SVG"
    saveSvgBtn.style.cssText = btnStyle

    floatBtns.appendChild(zoomInBtn)
    floatBtns.appendChild(zoomOutBtn)
    floatBtns.appendChild(resetBtn)
    floatBtns.appendChild(toggleSourceBtn)
    floatBtns.appendChild(saveSvgBtn)
    viewport.appendChild(floatBtns)

    // hover 时显示按钮
    wrapper.addEventListener("mouseenter", () => { floatBtns.style.opacity = "1" })
    wrapper.addEventListener("mouseleave", () => { floatBtns.style.opacity = "0" })

    // 源码 pre 块
    const sourcePre = document.createElement("pre")
    sourcePre.style.cssText =
      "display:none;font-size:12px;padding:12px;margin:0;overflow:auto;" +
      "border:0.5px solid var(--v2-border-border-base);" +
      "background:var(--v2-background-bg-layer-02);font-family:var(--font-family-mono);" +
      "color:var(--v2-text-text-base);white-space:pre-wrap;word-break:break-all;border-radius:6px"
    sourcePre.textContent = raw

    wrapper.appendChild(viewport)
    wrapper.appendChild(sourcePre)

    // 变换状态
    let tx = 0, ty = 0, scale = 1
    let dragging = false
    let startX = 0, startY = 0

    function applyTransform() {
      svgWrap.style.transform = `translate(${tx}px,${ty}px) scale(${scale})`
    }

    function centerSvg() {
      const vw = viewport.clientWidth
      const vh = viewport.clientHeight
      const sw = svgWrap.offsetWidth
      const sh = svgWrap.offsetHeight
      tx = (vw - sw) / 2
      ty = Math.max(8, (vh - sh) / 2)
      applyTransform()
    }

    // 初始居中（等 DOM 渲染完成后读取实际尺寸）
    requestAnimationFrame(() => {
      // 先让 viewport 撑开高度
      const sh = svgWrap.offsetHeight
      viewport.style.height = `${Math.min(Math.max(sh + 24, 120), 500)}px`
      centerSvg()
    })

    // 拖动
    viewport.addEventListener("mousedown", (e: MouseEvent) => {
      if ((e.target as Element)?.closest("button")) return
      dragging = true
      startX = e.clientX - tx
      startY = e.clientY - ty
      viewport.style.cursor = "grabbing"
      e.preventDefault()
    })

    window.addEventListener("mousemove", (e: MouseEvent) => {
      if (!dragging) return
      tx = e.clientX - startX
      ty = e.clientY - startY
      applyTransform()
    })

    window.addEventListener("mouseup", () => {
      if (!dragging) return
      dragging = false
      viewport.style.cursor = "grab"
    })

    // 滚轮缩放（以鼠标位置为中心）
    viewport.addEventListener("wheel", (e: WheelEvent) => {
      e.preventDefault()
      const rect = viewport.getBoundingClientRect()
      const mouseX = e.clientX - rect.left
      const mouseY = e.clientY - rect.top
      const delta = e.deltaY > 0 ? 0.9 : 1.1
      const newScale = Math.min(Math.max(scale * delta, 0.1), 8)
      tx = mouseX - (mouseX - tx) * (newScale / scale)
      ty = mouseY - (mouseY - ty) * (newScale / scale)
      scale = newScale
      applyTransform()
    }, { passive: false })

    // 双击重置居中
    viewport.addEventListener("dblclick", (e: MouseEvent) => {
      if ((e.target as Element)?.closest("button")) return
      scale = 1
      centerSvg()
    })

    zoomInBtn.addEventListener("click", () => {
      const newScale = Math.min(scale * 1.25, 8)
      const vw = viewport.clientWidth, vh = viewport.clientHeight
      tx = vw / 2 - (vw / 2 - tx) * (newScale / scale)
      ty = vh / 2 - (vh / 2 - ty) * (newScale / scale)
      scale = newScale
      applyTransform()
    })

    zoomOutBtn.addEventListener("click", () => {
      const newScale = Math.max(scale * 0.8, 0.1)
      const vw = viewport.clientWidth, vh = viewport.clientHeight
      tx = vw / 2 - (vw / 2 - tx) * (newScale / scale)
      ty = vh / 2 - (vh / 2 - ty) * (newScale / scale)
      scale = newScale
      applyTransform()
    })

    resetBtn.addEventListener("click", () => {
      scale = 1
      centerSvg()
    })

    // 源码切换
    let showingSource = false
    toggleSourceBtn.addEventListener("click", () => {
      showingSource = !showingSource
      viewport.style.display = showingSource ? "none" : "block"
      sourcePre.style.display = showingSource ? "block" : "none"
      toggleSourceBtn.textContent = showingSource ? "预览" : "源码"
    })

    // 保存 SVG
    saveSvgBtn.addEventListener("click", async () => {
      const svgContent = svgWrap.innerHTML
      const fileName = `mermaid-${Date.now()}.svg`
      const api = (window as any).api
      if (api?.saveFilePicker) {
        const filePath = await api.saveFilePicker({ title: "保存 SVG", defaultPath: fileName })
        if (filePath) await api.writeFile(filePath, svgContent)
      } else {
        const url = URL.createObjectURL(new Blob([svgContent], { type: "image/svg+xml" }))
        const a = document.createElement("a")
        a.href = url; a.download = fileName
        document.body.appendChild(a); a.click()
        document.body.removeChild(a); URL.revokeObjectURL(url)
      }
    })
    wrapper.dataset.renderedRaw = raw
    wrapper.dataset.renderedComplete = "true"
  } catch {
    wrapper.innerHTML = ""
    const errPre = document.createElement("pre")
    errPre.setAttribute("data-mermaid-error", "")
    errPre.style.cssText = "color:var(--v2-text-text-danger,#f87171);font-size:12px;padding:12px;margin:0"
    errPre.textContent = `Mermaid error:\n${raw}`
    wrapper.appendChild(errPre)
    wrapper.dataset.renderedRaw = raw
    wrapper.dataset.renderedComplete = "true"
  }
}

// --- HTML preview rendering ---

const htmlPreviewButtonBaseStyle =
  "font-size:11px;padding:2px 8px;border-radius:4px;cursor:pointer;" +
  "border:0.5px solid var(--v2-border-border-base);transition:background 0.15s,color 0.15s;"
const htmlPreviewButtonActiveStyle = "background:var(--v2-background-bg-layer-03,#444);color:var(--v2-text-text-base,#fff)"
const htmlPreviewButtonInactiveStyle = "background:transparent;color:var(--v2-text-text-muted)"

function applyHtmlMode(wrapper: HTMLElement, toSource: boolean) {
  const iframe = wrapper.querySelector("iframe[data-html-preview]") as HTMLIFrameElement | null
  const sourcePre = wrapper.querySelector("pre[data-html-source]") as HTMLPreElement | null
  const toggleBtn = wrapper.querySelector("button[data-html-toggle-button]") as HTMLButtonElement | null
  if (!iframe || !sourcePre) return
  wrapper.dataset.showingSource = String(toSource)
  iframe.style.display = toSource ? "none" : "block"
  sourcePre.style.display = toSource ? "block" : "none"
  if (toggleBtn) toggleBtn.textContent = toSource ? "预览" : "源码"
}

function renderHtmlPreviewBlock(wrapper: HTMLElement, raw: string, complete: boolean, labels: CopyLabels) {
  wrapper.dataset.copyText = raw

  // 增量更新：DOM 结构已存在则只更新内容
  const existingIframe = wrapper.querySelector("iframe[data-html-preview]") as HTMLIFrameElement | null
  if (existingIframe) {
    const existingSource = wrapper.querySelector("pre[data-html-source]") as HTMLPreElement | null
    const wasComplete = wrapper.dataset.renderedComplete === "true"
    if (existingSource) existingSource.textContent = raw
    if (complete && wrapper.dataset.renderedRaw !== raw) existingIframe.srcdoc = raw
    wrapper.dataset.renderedRaw = raw
    wrapper.dataset.renderedComplete = String(complete)
    if (complete && !wasComplete && !wrapper.dataset.htmlMode) applyHtmlMode(wrapper, false)
    return
  }

  wrapper.innerHTML = ""

  // 悬浮按钮组（右上角，hover 时显示）
  const floatBtns = document.createElement("div")
  floatBtns.style.cssText =
    "position:absolute;top:8px;right:8px;display:flex;gap:4px;z-index:20;" +
    "opacity:0;transition:opacity 0.15s;pointer-events:none"

  const btnStyle =
    "font-size:11px;padding:2px 7px;border-radius:4px;cursor:pointer;" +
    "border:0.5px solid var(--v2-border-border-base);" +
    "background:var(--v2-background-bg-layer-02,#222);" +
    "color:var(--v2-text-text-muted);pointer-events:auto"

  const toggleBtn = document.createElement("button")
  toggleBtn.setAttribute("data-html-toggle-button", "")
  toggleBtn.type = "button"
  toggleBtn.textContent = "源码"
  toggleBtn.style.cssText = btnStyle

  const saveBtn = document.createElement("button")
  saveBtn.type = "button"
  saveBtn.textContent = "保存"
  saveBtn.title = "保存 HTML 文件"
  saveBtn.style.cssText = btnStyle

  floatBtns.appendChild(toggleBtn)
  floatBtns.appendChild(saveBtn)
  wrapper.appendChild(floatBtns)

  wrapper.addEventListener("mouseenter", () => { floatBtns.style.opacity = "1" })
  wrapper.addEventListener("mouseleave", () => { floatBtns.style.opacity = "0" })

  // iframe 预览（高度自适应内容）
  const iframe = document.createElement("iframe")
  iframe.setAttribute("data-html-preview", "")
  iframe.setAttribute("sandbox", "allow-scripts")
  iframe.style.cssText =
    "width:100%;height:200px;border:0.5px solid var(--v2-border-border-base);" +
    "border-radius:6px;background:#fff;display:block;overflow:auto"
  iframe.srcdoc = complete ? raw : ""
  wrapper.appendChild(iframe)

  // iframe 加载后自适应高度
  iframe.addEventListener("load", () => {
    try {
      const body = iframe.contentDocument?.body
      if (!body) return
      const h = Math.min(body.scrollHeight + 20, 600)
      iframe.style.height = `${Math.max(h, 80)}px`
    } catch { /* cross-origin 保护 */ }
  })

  // 源码 pre
  const sourcePre = document.createElement("pre")
  sourcePre.setAttribute("data-html-source", "")
  sourcePre.style.cssText =
    "display:none;font-size:12px;padding:12px;margin:0;overflow:auto;" +
    "border:0.5px solid var(--v2-border-border-base);border-top:none;" +
    "border-radius:0 0 6px 6px;background:var(--v2-background-bg-layer-02);" +
    "font-family:var(--font-family-mono);color:var(--v2-text-text-base);white-space:pre-wrap"
  sourcePre.textContent = raw
  wrapper.appendChild(sourcePre)

  // 按钮事件
  toggleBtn.addEventListener("click", () => {
    const toSource = wrapper.dataset.showingSource !== "true"
    wrapper.dataset.htmlMode = toSource ? "source" : "preview"
    applyHtmlMode(wrapper, toSource)
  })

  saveBtn.addEventListener("click", async () => {
    const fileName = `html-${Date.now()}.html`
    const api = (window as any).api
    if (api?.saveFilePicker) {
      const filePath = await api.saveFilePicker({ title: "保存 HTML", defaultPath: fileName })
      if (filePath) await api.writeFile(filePath, raw)
    } else {
      const url = URL.createObjectURL(new Blob([raw], { type: "text/html;charset=utf-8" }))
      const a = document.createElement("a")
      a.href = url; a.download = fileName
      document.body.appendChild(a); a.click()
      document.body.removeChild(a); URL.revokeObjectURL(url)
    }
  })

  applyHtmlMode(wrapper, !complete)
  wrapper.dataset.renderedRaw = raw
  wrapper.dataset.renderedComplete = String(complete)
}