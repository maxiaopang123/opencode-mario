import { type Component, createMemo, createSignal, For, Show } from "solid-js"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { Icon } from "@opencode-ai/ui/icon"
import { useModels } from "@/context/models"
import { useServerSync } from "@/context/server-sync"
import type { Config } from "@opencode-ai/sdk/v2/client"
import "./settings-v2.css"

type ModelItem = ReturnType<ReturnType<typeof useModels>["list"]>[number]
type ProviderConfig = NonNullable<Config["provider"]>[string]
type ModelConfig = NonNullable<ProviderConfig["models"]>[string]
type InputType = NonNullable<NonNullable<ModelConfig["modalities"]>["input"]>[number]

const REASONING_VARIANTS = {
  low: { body: { reasoning_effort: "low" } },
  high: { body: { reasoning_effort: "high" } },
  max: { body: { reasoning_effort: "max" } },
}

const RECOMMENDED_INPUT: InputType[] = ["text", "image"]

function modelConfig(item: ModelItem, providers: Config["provider"] | undefined) {
  return providers?.[item.provider.id]?.models?.[item.id] ?? {}
}

export const SettingsModelConfigV2: Component = () => {
  const models = useModels()
  const serverSync = useServerSync()
  const [applying, setApplying] = createSignal(false)
  const [done, setDone] = createSignal(false)

  const visibleModels = createMemo(() =>
    models.list().filter((m) => models.visible({ providerID: m.provider.id, modelID: m.id })),
  )

  const stats = createMemo(() => {
    const visible = visibleModels()
    let thinkingCount = 0
    let imageCount = 0

    for (const m of visible) {
      const saved = modelConfig(m, serverSync().data.config.provider)
      const hasThinking = Object.keys(saved.variants ?? {}).length > 0 || saved.reasoning || m.reasoning
      const inputTypes = saved.modalities?.input ?? m.modalities?.input ?? ["text"]
      if (hasThinking) thinkingCount++
      if (inputTypes.includes("image")) imageCount++
    }

    return {
      total: visible.length,
      thinkingCount,
      imageCount,
      allConfigured: thinkingCount === visible.length && imageCount === visible.length,
    }
  })

  const applyRecommended = async () => {
    setApplying(true)
    setDone(false)
    try {
      const byProvider: Record<string, Record<string, ModelConfig>> = {}
      for (const m of visibleModels()) {
        byProvider[m.provider.id] ??= {}
        byProvider[m.provider.id][m.id] = {
          reasoning: true,
          variants: REASONING_VARIANTS,
          modalities: { input: RECOMMENDED_INPUT },
        }
      }
      for (const [providerId, providerModels] of Object.entries(byProvider)) {
        await serverSync().updateConfig({
          provider: { [providerId]: { models: providerModels } },
        })
      }
      setDone(true)
    } finally {
      setApplying(false)
    }
  }

  return (
    <>
      <div class="settings-v2-tab-header">
        <h2 class="settings-v2-tab-title">模型配置</h2>
        <p class="settings-v2-tab-description">一键为所有已选模型配置推荐设置</p>
      </div>

      <div class="settings-v2-tab-body">
        <Show
          when={visibleModels().length > 0}
          fallback={
            <div class="flex flex-col items-center justify-center h-full gap-3 text-v2-label-label-muted-md">
              <span>尚未选择任何模型</span>
              <span class="text-v2-label-label-muted-sm opacity-60">请先在「模型」标签页启用模型</span>
            </div>
          }
        >
          <div class="flex flex-col gap-6 max-w-xl">
            <div class="flex flex-col gap-5 p-5 rounded-xl border border-v2-border-base bg-v2-background-surface-base">
              <div class="flex flex-col gap-1.5">
                <span class="text-v2-label-label-base-md font-semibold">推荐配置</span>
                <span class="text-v2-label-label-muted-sm">
                  将对 {stats().total} 个已选模型应用以下全局设置：
                </span>
              </div>

              <div class="flex flex-col gap-2 pl-1">
                <div class="flex items-center gap-2">
                  <Icon name="check-small" class="w-4 h-4 text-[var(--color-v2-label-success)]" />
                  <span class="text-v2-label-label-base-sm">思考模式（支持 low / high / max 强度选择）</span>
                </div>
                <div class="flex items-center gap-2">
                  <Icon name="check-small" class="w-4 h-4 text-[var(--color-v2-label-success)]" />
                  <span class="text-v2-label-label-base-sm">支持文本 + 图片输入</span>
                </div>
              </div>

              <div class="flex items-center justify-between pt-1 border-t border-v2-border-base">
                <Show
                  when={done()}
                  fallback={
                    <span class="text-v2-label-label-muted-sm">
                      已配置：思考 {stats().thinkingCount}/{stats().total}，图片 {stats().imageCount}/{stats().total}
                    </span>
                  }
                >
                  <span
                    class="flex items-center gap-1.5 text-v2-label-label-muted-sm"
                    style="color: var(--color-v2-label-success)"
                  >
                    <Icon name="circle-check" class="w-4 h-4" />
                    配置已应用
                  </span>
                </Show>

                <button
                  type="button"
                  disabled={applying()}
                  onClick={applyRecommended}
                  class="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-v2-label-label-base-sm font-medium transition-all select-none"
                  style={{
                    background: "var(--color-v2-background-brand)",
                    color: "var(--color-v2-label-on-brand)",
                    opacity: applying() ? "0.7" : "1",
                    cursor: applying() ? "not-allowed" : "pointer",
                  }}
                >
                  <Icon name={applying() ? "settings-gear" : "sliders"} class="w-4 h-4" />
                  {applying() ? "应用中..." : "一键应用"}
                </button>
              </div>
            </div>

            <div class="flex flex-col gap-3">
              <span class="text-v2-label-label-muted-sm px-1">模型配置状态</span>
              <div class="flex flex-col gap-1.5">
                <For each={visibleModels()}>
                  {(m) => {
                    const saved = modelConfig(m, serverSync().data.config.provider)
                    const hasThinking = Object.keys(saved.variants ?? {}).length > 0 || saved.reasoning || m.reasoning
                    const inputTypes = saved.modalities?.input ?? m.modalities?.input ?? ["text"]
                    const hasImage = inputTypes.includes("image")

                    return (
                      <div class="flex items-center justify-between px-3 py-2.5 rounded-lg border border-v2-border-base bg-v2-background-surface-base">
                        <div class="flex items-center gap-2">
                          <ProviderIcon id={m.provider.id} width={14} height={14} class="shrink-0 opacity-50" />
                          <span class="text-v2-label-label-base-sm">{m.name}</span>
                        </div>
                        <div class="flex items-center gap-4">
                          <div
                            class="flex items-center gap-1"
                            style={{
                              color: hasThinking
                                ? "var(--color-v2-label-success)"
                                : "var(--color-v2-label-disabled)",
                            }}
                          >
                            <Icon name={hasThinking ? "check-small" : "circle-x"} class="w-3.5 h-3.5" />
                            <span class="text-[11px]">思考</span>
                          </div>
                          <div
                            class="flex items-center gap-1"
                            style={{
                              color: hasImage ? "var(--color-v2-label-success)" : "var(--color-v2-label-disabled)",
                            }}
                          >
                            <Icon name={hasImage ? "check-small" : "circle-x"} class="w-3.5 h-3.5" />
                            <span class="text-[11px]">图片</span>
                          </div>
                        </div>
                      </div>
                    )
                  }}
                </For>
              </div>
            </div>
          </div>
        </Show>
      </div>
    </>
  )
}
