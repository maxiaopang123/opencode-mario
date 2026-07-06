import { useFilteredList } from "@opencode-ai/ui/hooks"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { Switch } from "@opencode-ai/ui/switch"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { TextField } from "@opencode-ai/ui/text-field"
import { type Component, createMemo, createSignal, For, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { useModels } from "@/context/models"
import { useServerSync } from "@/context/server-sync"
import { popularProviders } from "@/hooks/use-providers"
import { SettingsList } from "./settings-list"
import { SettingsServerPicker, SettingsServerScope } from "./settings-server-picker"

type ModelItem = ReturnType<ReturnType<typeof useModels>["list"]>[number]

const ALL_INPUT_TYPES = ["text", "image", "pdf", "audio", "video"] as const
type InputType = (typeof ALL_INPUT_TYPES)[number]

const CONTEXT_OPTIONS = [
  { label: "Auto", value: undefined },
  { label: "200k", value: 200_000 },
  { label: "1M", value: 1_000_000 },
] as const

const ListLoadingState: Component<{ label: string }> = (props) => (
  <div class="flex flex-col items-center justify-center py-12 text-center">
    <span class="text-14-regular text-text-weak">{props.label}</span>
  </div>
)

const ListEmptyState: Component<{ message: string; filter: string }> = (props) => (
  <div class="flex flex-col items-center justify-center py-12 text-center">
    <span class="text-14-regular text-text-weak">{props.message}</span>
    <Show when={props.filter}>
      <span class="text-14-regular text-text-strong mt-1">&quot;{props.filter}&quot;</span>
    </Show>
  </div>
)

const ModelCapabilityPanel: Component<{ item: ModelItem }> = (props) => {
  const serverSync = useServerSync()
  const language = useLanguage()

  // 读取已保存的覆盖配置
  const saved = createMemo(() => {
    const cfg = serverSync().data.config.provider?.[props.item.provider.id]
    return (cfg as any)?.models?.[props.item.id] ?? {}
  })

  // 当前输入类型（覆盖优先，否则用模型默认值）
  const currentInputTypes = createMemo<InputType[]>(() => {
    const override = saved()?.modalities?.input
    if (override?.length) return override as InputType[]
    return (props.item.modalities?.input ?? ["text"]) as InputType[]
  })

  // 当前上下文大小
  const currentContext = createMemo<number | undefined>(() => saved()?.limit?.context)

  // 当前思考模式
  const currentReasoning = createMemo<boolean>(() => saved()?.reasoning ?? props.item.reasoning ?? false)

  const toggleInputType = async (type: InputType, enabled: boolean) => {
    const next = enabled
      ? [...currentInputTypes(), type].filter((v, i, a) => a.indexOf(v) === i)
      : currentInputTypes().filter((t) => t !== type)

    // 保留 text 不可取消
    if (!next.includes("text")) return

    await serverSync().updateConfig({
      provider: {
        [props.item.provider.id]: {
          models: {
            [props.item.id]: { modalities: { input: next } },
          },
        } as any,
      },
    })
  }

  const setContext = async (value: number | undefined) => {
    const current = saved()
    const limitPatch = value !== undefined ? { context: value, output: current?.limit?.output ?? props.item.limit?.output ?? 4096 } : undefined

    await serverSync().updateConfig({
      provider: {
        [props.item.provider.id]: {
          models: {
            [props.item.id]: { ...(limitPatch ? { limit: limitPatch } : {}) },
          },
        } as any,
      },
    })
  }

  const setReasoning = async (enabled: boolean) => {
    await serverSync().updateConfig({
      provider: {
        [props.item.provider.id]: {
          models: {
            [props.item.id]: { reasoning: enabled },
          },
        } as any,
      },
    })
  }

  return (
    <div class="mt-2 mb-3 ml-2 px-4 py-3 rounded-lg bg-surface-base border border-border-weak-base flex flex-col gap-4">
      {/* 输入类型 */}
      <div class="flex flex-col gap-1.5">
        <span class="text-12-medium text-text-weak">输入类型</span>
        <div class="flex flex-wrap gap-2">
          <For each={ALL_INPUT_TYPES}>
            {(type) => {
              const isEnabled = () => currentInputTypes().includes(type)
              const isText = type === "text"
              return (
                <button
                  type="button"
                  disabled={isText}
                  onClick={() => toggleInputType(type, !isEnabled())}
                  classList={{
                    "px-2.5 py-1 rounded-md text-12-medium border transition-colors": true,
                    "bg-surface-info-base border-border-info-base text-text-info-base cursor-default": isText,
                    "bg-surface-raised-base border-border-weaker-base text-text-strong cursor-pointer hover:bg-surface-raised-base-hover":
                      isEnabled() && !isText,
                    "bg-background-base border-border-weaker-base text-text-weaker cursor-pointer hover:bg-surface-base":
                      !isEnabled() && !isText,
                  }}
                >
                  {type}
                </button>
              )
            }}
          </For>
        </div>
      </div>

      {/* 上下文大小 */}
      <div class="flex flex-col gap-1.5">
        <span class="text-12-medium text-text-weak">上下文窗口</span>
        <div class="flex gap-2">
          <For each={CONTEXT_OPTIONS}>
            {(opt) => {
              const isActive = () =>
                opt.value === undefined ? currentContext() === undefined : currentContext() === opt.value
              return (
                <button
                  type="button"
                  onClick={() => setContext(opt.value)}
                  classList={{
                    "px-3 py-1 rounded-md text-12-medium border transition-colors": true,
                    "bg-surface-info-base border-border-info-base text-text-info-base": isActive(),
                    "bg-background-base border-border-weaker-base text-text-weaker hover:bg-surface-base": !isActive(),
                  }}
                >
                  {opt.label}
                </button>
              )
            }}
          </For>
          <Show when={currentContext() !== undefined && !CONTEXT_OPTIONS.some((o) => o.value === currentContext())}>
            <span class="px-3 py-1 text-12-regular text-text-weak">
              {((currentContext() ?? 0) / 1000).toFixed(0)}k（自定义）
            </span>
          </Show>
        </div>
        <span class="text-11-regular text-text-weaker">
          当前默认: {props.item.limit?.context !== undefined ? `${((props.item.limit.context) / 1000).toFixed(0)}k` : "未知"}
        </span>
      </div>

      {/* 思考模式 */}
      <div class="flex items-center justify-between">
        <div class="flex flex-col gap-0.5">
          <span class="text-12-medium text-text-weak">思考模式（Reasoning）</span>
          <span class="text-11-regular text-text-weaker">
            {currentReasoning() ? "已启用，模型会输出推理过程" : "未启用"}
          </span>
        </div>
        <Switch
          checked={currentReasoning()}
          onChange={setReasoning}
          hideLabel
        >
          思考模式
        </Switch>
      </div>
    </div>
  )
}

export const SettingsModels: Component = () => (
  <SettingsServerScope>
    <SettingsModelsContent />
  </SettingsServerScope>
)

const SettingsModelsContent: Component = () => {
  const language = useLanguage()
  const models = useModels()

  const [expanded, setExpanded] = createSignal<Set<string>>(new Set())

  const toggleExpand = (key: string) => {
    const next = new Set(expanded())
    if (next.has(key)) next.delete(key)
    else next.add(key)
    setExpanded(next)
  }

  const list = useFilteredList<ModelItem>({
    items: (_filter) => models.list(),
    key: (x) => `${x.provider.id}:${x.id}`,
    filterKeys: ["provider.name", "name", "id"],
    sortBy: (a, b) => a.name.localeCompare(b.name),
    groupBy: (x) => x.provider.id,
    sortGroupsBy: (a, b) => {
      const aIndex = popularProviders.indexOf(a.category)
      const bIndex = popularProviders.indexOf(b.category)
      const aPopular = aIndex >= 0
      const bPopular = bIndex >= 0
      if (aPopular && !bPopular) return -1
      if (!aPopular && bPopular) return 1
      if (aPopular && bPopular) return aIndex - bIndex
      return a.items[0].provider.name.localeCompare(b.items[0].provider.name)
    },
  })

  return (
    <div class="flex flex-col h-full overflow-y-auto no-scrollbar px-4 pb-10 sm:px-10 sm:pb-10">
      <div class="sticky top-0 z-10 bg-[linear-gradient(to_bottom,var(--surface-stronger-non-alpha)_calc(100%_-_24px),transparent)]">
        <div class="flex flex-col gap-4 pt-6 pb-6 max-w-[720px]">
          <div class="flex items-center justify-between gap-4">
            <h2 class="text-16-medium text-text-strong">{language.t("settings.models.title")}</h2>
            <SettingsServerPicker />
          </div>
          <div class="flex items-center gap-2 px-3 h-9 rounded-lg bg-surface-base">
            <Icon name="magnifying-glass" class="text-icon-weak-base flex-shrink-0" />
            <TextField
              variant="ghost"
              type="text"
              value={list.filter()}
              onChange={list.onInput}
              placeholder={language.t("dialog.model.search.placeholder")}
              spellcheck={false}
              autocorrect="off"
              autocomplete="off"
              autocapitalize="off"
              class="flex-1"
            />
            <Show when={list.filter()}>
              <IconButton icon="circle-x" variant="ghost" onClick={list.clear} />
            </Show>
          </div>
        </div>
      </div>

      <div class="flex flex-col gap-8 max-w-[720px]">
        <Show
          when={!list.grouped.loading}
          fallback={<ListLoadingState label={`${language.t("common.loading")}${language.t("common.loading.ellipsis")}`} />}
        >
          <Show
            when={list.flat().length > 0}
            fallback={<ListEmptyState message={language.t("dialog.model.empty")} filter={list.filter()} />}
          >
            <For each={list.grouped.latest}>
              {(group) => (
                <div class="flex flex-col gap-1">
                  <div class="flex items-center gap-2 pb-2">
                    <ProviderIcon id={group.category} class="size-5 shrink-0 icon-strong-base" />
                    <span class="text-14-medium text-text-strong">{group.items[0].provider.name}</span>
                  </div>
                  <SettingsList>
                    <For each={group.items}>
                      {(item) => {
                        const key = { providerID: item.provider.id, modelID: item.id }
                        const expandKey = `${item.provider.id}:${item.id}`
                        const isExpanded = () => expanded().has(expandKey)
                        return (
                          <div class="border-b border-border-weak-base last:border-none">
                            <div class="flex flex-wrap items-center justify-between gap-4 py-3">
                              {/* 左侧：模型名 + 展开按钮 */}
                              <button
                                type="button"
                                class="flex items-center gap-1.5 min-w-0 flex-1 text-left hover:text-text-strong transition-colors"
                                onClick={() => toggleExpand(expandKey)}
                              >
                                <Icon
                                  name={isExpanded() ? "chevron-down" : "chevron-right"}
                                  size="small"
                                  class="shrink-0 text-icon-weak"
                                />
                                <span class="text-14-regular text-text-strong truncate">{item.name}</span>
                              </button>
                              {/* 右侧：能力标签 + 可见性开关 */}
                              <div class="flex items-center gap-3 shrink-0">
                                <div class="flex items-center gap-1">
                                  <Show when={item.modalities?.input?.includes("image")}>
                                    <span class="text-11-regular text-text-weaker px-1.5 py-0.5 rounded bg-surface-base border border-border-weaker-base">
                                      img
                                    </span>
                                  </Show>
                                  <Show when={item.reasoning}>
                                    <span class="text-11-regular text-text-weaker px-1.5 py-0.5 rounded bg-surface-base border border-border-weaker-base">
                                      think
                                    </span>
                                  </Show>
                                </div>
                                <Switch
                                  checked={models.visible(key)}
                                  onChange={(checked) => models.setVisibility(key, checked)}
                                  hideLabel
                                >
                                  {item.name}
                                </Switch>
                              </div>
                            </div>
                            {/* 展开的配置面板 */}
                            <Show when={isExpanded()}>
                              <ModelCapabilityPanel item={item} />
                            </Show>
                          </div>
                        )
                      }}
                    </For>
                  </SettingsList>
                </div>
              )}
            </For>
          </Show>
        </Show>
      </div>
    </div>
  )
}
