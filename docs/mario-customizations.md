# Mario customizations

Date: 2026-07-06

This branch keeps Mario's changes as a small patch set on top of upstream opencode.

- Verified build base: `official/dev@38bb38ecb2b50f81c9dd8e943288a5eaebb180df`
- Latest fetched upstream while writing this note: `official/dev@b0e41ff2c`
- Branch used for the verified build: `mario-restore`

The installed build was intentionally not rebased after upstream moved to `b0e41ff2c`, because the user already verified the current build as OK.

## Added features

### Session side panel layout

- Adds a right-side file tree toggle in the session header.
- Adds an independent file preview panel.
- Keeps review panel and independent file preview mutually exclusive.
- Places independent file preview between the chat panel and the file tree.
- Closing the file tree closes the independent file preview when needed.

Main files:

- `packages/app/src/pages/session.tsx`
- `packages/app/src/pages/session/session-side-panel.tsx`
- `packages/app/src/components/session/session-header.tsx`
- `packages/app/src/context/layout.tsx`

### File preview panel

- Adds `FilePreviewPanel` for local file previews.
- Supports text, Markdown, HTML, images, SVG, audio, PDF, and basic Office previews.
- Supports URL preview in an iframe.
- Supports transient HTML snippet preview from chat messages without writing files to disk.

Main files:

- `packages/app/src/components/file-preview-panel.tsx`
- `packages/app/package.json`
- `bun.lock`

### Chat Markdown rendering

- Renders `mermaid` code blocks as diagrams.
- Renders `html` code blocks as sandboxed previews.
- Keeps streaming/incomplete special blocks as source until complete.
- Adds Mermaid pan, drag, zoom, reset, SVG copy, and SVG download controls.
- Uses SVG width/height resizing for Mermaid zoom so enlarged diagrams stay sharp.
- Adds HTML source/preview toggle.
- Adds double-click preview from chat content:
  - URL opens in the independent preview panel.
  - Inline local file path opens in the independent preview panel.
  - HTML code block opens in the independent preview panel.
- SVG download defaults to the active project directory through the desktop save dialog.

Main files:

- `packages/session-ui/src/components/markdown.tsx`
- `packages/session-ui/src/components/markdown.css`
- `packages/session-ui/src/components/message-part.tsx`
- `packages/session-ui/src/context/data.tsx`
- `packages/session-ui/src/components/markdown-cache.tsx`
- `packages/ui/src/context/marked.tsx`
- `packages/ui/src/v2/components/icon.tsx`
- `packages/session-ui/package.json`
- `bun.lock`

### Desktop save support

- Adds a desktop preload/main IPC bridge for writing selected SVG files.

Main files:

- `packages/desktop/src/main/ipc.ts`
- `packages/desktop/src/preload/index.ts`
- `packages/desktop/src/preload/types.ts`

### Model settings customization

- Adds model capability configuration UI.
- Supports configuring model input modalities, context-window choices, and reasoning toggle.
- Adds the model config entry into settings v2.

Main files:

- `packages/app/src/components/settings-models.tsx`
- `packages/app/src/components/settings-v2/model-config.tsx`
- `packages/app/src/components/settings-v2/dialog-settings-v2.tsx`
- `packages/app/src/context/settings.tsx`

### Default visualization system rule

- Adds a default system instruction asking the assistant to proactively use Mermaid or HTML blocks when they improve readability.
- Mermaid output should choose suitable chart types and include theme frontmatter.
- HTML output should use a light background and can include small CSS/JS interactions when helpful.

Main file:

- `packages/opencode/src/session/system.ts`

## Update workflow when upstream changes

Preferred workflow for a future official update:

```powershell
git fetch official
git checkout mario-restore
git rebase official/dev
```

If the branch history has been rewritten or reset, rebuild Mario's patch from the clean upstream branch:

```powershell
git fetch official
git checkout -B mario-restore official/dev
git cherry-pick <mario-customization-commit>
```

After resolving conflicts, verify from package directories:

```powershell
cd packages/session-ui
bun typecheck

cd ../opencode
bun typecheck

cd ../ui
bun typecheck

cd ../desktop
$env:OPENCODE_CHANNEL='prod'
bun run build
bun run package:win
```

`packages/app` typecheck may fail on Windows because of the known `src/custom-elements.d.ts` symlink text issue. Use the desktop prod build as the app compile verification unless that symlink issue is fixed.

## Conflict hotspots

Expect future upstream conflicts mostly in:

- `packages/app/src/pages/session.tsx`
- `packages/app/src/context/layout.tsx`
- `packages/app/src/components/session/session-header.tsx`
- `packages/app/src/components/file-preview-panel.tsx`
- `packages/session-ui/src/components/markdown.tsx`
- `packages/session-ui/src/components/markdown.css`
- `packages/session-ui/src/components/message-part.tsx`
- `packages/opencode/src/session/system.ts`
- `bun.lock`

When conflicts happen, preserve upstream behavior first, then reapply Mario behavior in these areas:

- independent preview panel location and mutual-exclusion logic
- Mermaid/HTML special Markdown rendering
- double-click preview routing
- desktop SVG save bridge
- model capability settings
- default visualization system rule
