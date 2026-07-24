# Jamon's Dialogue Editor — AI Agent Guide

## Project Overview

**Jamon's Dialogue Editor** (formerly *Dialogue Forge*; internal identifiers like localStorage keys, the npm package name and the MCP server name keep the old `dialogue-forge`/`dialogueForge` naming for backwards compatibility) is a standalone desktop application (Electron + Vite) for creating branched dialogue trees for games.

## Tech Stack

| Technology | Purpose |
|---|---|
| **Electron** | Desktop app wrapper (standalone .exe) |
| **Vite** | Dev server with HMR, build tool |
| **Vanilla JS (ES Modules)** | All app logic — no React/Vue/frameworks |
| **Vanilla CSS** | Styling — dark theme, no Tailwind |
| **localStorage** | Data persistence |
| **JSON** | Export/import format |
| **OpenRouter API** | AI translation & dialogue generation (HTTP, per-token) |
| **Claude Code CLI** | Alternative AI provider using the local Claude subscription (no API key) |
| **transformers.js** (`@huggingface/transformers`) | Local embeddings for the vector memory / RAG — runs on-device, no API key (Claude cannot generate embeddings) |
| **IndexedDB** | Vector store for the semantic memory (outside project state / undo) |
| **MCP (Model Context Protocol)** | Embedded server so external Claude Code / CLI can drive the app |

## Architecture

```
electron/
  main.js          → Electron main process (window creation, IPC, Claude Code spawn, MCP server startup)
  preload.js       → Secure bridge between main and renderer
  mcp-server.js    → Embedded MCP server (Streamable HTTP on 127.0.0.1:4747) exposing project tools

src/
  main.js          → App entry point, wires all modules together
  style.css        → Complete CSS theme (dark mode, glassmorphism)
  modules/
    state.js       → Global state, CRUD operations, persistence
    canvas.js      → Canvas: pan, zoom, SVG connections
    nodes.js       → Node rendering, drag & drop, inline editing, connection drawing
    inspector.js   → Right panel: property editing, AI actions per node/dialogue
    sidebar.js     → Left panel: NPC/Quest/Dialogue lists, collapsible sections
    ui.js          → Modals, toasts, context menus, confirmDelete, AI settings/generate modals
    lang.js        → Language toggle (ES/EN)
    ai.js          → Multi-provider AI: OpenRouter (HTTP) + Claude Code (local CLI via IPC); per-task dispatcher, translation, generation, PDF/MD parsing
    chat.js        → Integrated AI chat assistant: floating panel, action executor, project context builder, RAG retrieval
    vector-memory.js → Local semantic memory: transformers.js embeddings (lazy-loaded), IndexedDB store, incremental indexing, top-k cosine search, chat memory
    memory-map.js  → "Neural map" overlay: PCA 3D projection of the vector memory on a DPR-aware canvas (orbit camera, similarity links, click-to-navigate)
    mcp-bridge.js  → Renderer-side executor for MCP tools (window.__mcpExecute); runs edits against live State
    prompts.js     → Centralized AI prompt templates (translation, generation, extension, chat)
  utils/
    helpers.js     → uid(), $(), $$(), esc()
```

## Key Concepts

### Bilingual Text Fields
Every text field in dialogue nodes is a `{ es: string, en: string }` object. The active editing language is controlled by a toggle in the toolbar. The `lang.js` module provides helpers:
- `t(textObj)` — get text for current language
- `setText(textObj, value)` — set text for current language
- `newText(value)` — create new bilingual text with value in current language

### Inline Node Editing
Nodes contain a `<textarea>` that allows direct inline text editing on the canvas. The textarea auto-resizes as the user types, and syncs with the inspector panel. When a node textarea is focused, canvas re-renders are skipped to preserve focus.

### State Management
`state.js` is the single source of truth. All CRUD operations go through it. It emits changes via an `onChange` callback that triggers re-renders. The state shape:

```js
{
  npcs: [{ id, name, color, comment }],
  quests: [{ id, name, comment, npcIds: [] }],   // npcIds = related NPCs ("Relacionados")
  dialogues: [{
    id, title, npcId, questId, comment, startNodeId,
    nodes: [{
      id,
      text: { es, en },
      x, y, width, height,
      npcId,
      connections: [{ targetId: string, label: string }, ...]  // Normalized connection objects
    }]
  }],
  story: {              // Global story map ("Historia" view) — same graph shape as a dialogue
    id: 'story',        // fixed id (used as the camera-cache key)
    startNodeId,
    nodes: [{ id, text: {es,en}, questId, x, y, width, height, connections: [{ targetId, label }] }]
    // connection label = the CONDITION for the target quest/step to start (drawn on the arrow)
  }
}
```

> **IMPORTANT**: Connections are always objects `{ targetId, label }`, never plain strings. Use `normalizeConnection(c)` from `state.js` when reading connections to handle any legacy string format. Never use `.includes(nodeId)` on connections arrays — use `.some(c => normalizeConnection(c).targetId === nodeId)`.

Legacy save files without `story`/`npcIds` are migrated on load (`normalizeLoadedExtras()` in `state.js` — called from `load()`, `importJSON()` and `loadFromFile()`); the save format is a strict superset of the old one.

#### View Mode & Story Map ("Historia")
The canvas has two views, switched with tabs over the canvas (`#view-tabs`): **🗨 Diálogo** (edit the active dialogue) and **🗺 Historia** (a single global quest-structure graph). `state.js` tracks `viewMode` (`'dialogue' | 'story'`, persisted in `localStorage df_viewMode`) and exposes:
- `getViewMode()` / `setViewMode(mode)` (clears selection)
- `getActiveGraph()` — **the key abstraction**: returns `state.story` in story mode, else the active dialogue. All node/connection CRUD in `state.js` (`addNode`, `deleteNode`, `addConnection`, `updateConnectionLabel`, ...) and all canvas/nodes interactions operate on `getActiveGraph()`, so drag, connect, multi-select, undo/redo, auto-layout and snap work identically on both graphs.
- `getStory()`, `updateStoryNodeQuest(nodeId, questId)`, `addNpcToQuest(questId, npcId)`, `removeNpcFromQuest(questId, npcId)`

Story map specifics:
- Each story node is an independent entity pointing to a quest via `questId` (nullable — the same quest may appear in two nodes for alternate routes). The node header badge shows the quest name (or `SIN QUEST`).
- **Connection labels are rendered ONLY in story view** (`renderConnections()` in `canvas.js`): every edge draws its label at the bezier midpoint — the condition for the next quest to start — or a "＋ condición" placeholder. Click the label (or double-click the cable) to edit; in dialogue view double-click still deletes the connection and labels stay invisible.
- **"Relacionados" live on the Quest** (shared between story nodes of the same quest): related NPCs in `quest.npcIds`, related dialogues via the existing `dialogue.questId` (single source of truth — consistent with the sidebar's "Agrupar por Quest"). The story-node inspector (`renderStoryNode()` in `inspector.js`) edits both; clicking a related dialogue navigates to the dialogue editor (custom `df-open-dialogue` event handled in `main.js`).
- Cascades: `deleteQuest` nulls `questId` on story nodes; `deleteNPC` removes the id from every `quest.npcIds`.
- The chat executor and MCP dialogue-edit tools switch back to dialogue view before mutating (they rely on `getActiveGraph()`-based CRUD); MCP story tools and read tools mutate `state.story` directly and never switch the view (`VIEW_SAFE_TOOLS` in `mcp-bridge.js`).
- AI toolbar buttons (translate/generate) are disabled in story view.

#### Selection Model
Selection uses a `Set<string>` internally (`selectedNodeIds`). The API provides:
- `getSelectedNodeId()` — backward-compat, returns first ID or null
- `setSelectedNodeId(id)` — clear + select one
- `getSelectedNodeIds()` — full Set
- `isNodeSelected(id)`, `toggleNodeSelection(id)`, `addToSelection(id)`, `clearSelection()`

Multi-select interactions:
- **Shift+click** on a node toggles it in the selection
- **Shift+drag** on empty canvas draws a selection rectangle
- Dragging a selected node moves ALL selected nodes
- **Delete** key removes all selected nodes
- Inspector shows "N nodos seleccionados" with bulk delete

#### File Persistence (Electron IPC)
When running in Electron, the app supports file-based persistence:
- `saveToFile()` — saves to disk via `dialog:save` IPC (falls back to `localStorage`)
- `loadFromFile()` — opens file via `dialog:open` IPC
- `currentFilePath` tracks the open file; shown in window title and status bar
- `localStorage` is always used as backup

### Canvas Interactions

#### Camera Persistence (Q10)
Camera position (pan offset + zoom) is saved per dialogue in a memory cache. When switching between dialogues, the camera restores to where you were last looking. This is in-memory only (resets on app restart).

#### Connection Hover Highlighting (Q3)
Hovering over a connection path highlights both the source and target nodes with `.conn-highlighted` class and thickens the connection line.

#### Connection Drag Feedback (Q13)
When dragging from an output connector to create a connection, all valid input connectors glow with `.connect-target-highlight` class.

#### Snap-to-Grid
Toggled via the ⬥ button in canvas controls. When active, node positions snap to a 24px grid during drag. State persisted in `localStorage`.

#### Connection Right-Click
SVG connection paths render with invisible fat hit-areas (12px stroke) for easier clicking. Right-click shows a context menu to delete the connection.

### AI Integration (multi-provider)

The `ai.js` module supports two AI providers, selectable **per task** (generate / translate / chat):

- **OpenRouter** — HTTP API, needs an API key, pay-per-token. `callOpenRouter()`.
- **Claude Code** — runs the user's locally installed `claude` CLI via Electron IPC (`window.electronAPI.claudeCall`), using the Claude Pro/Max subscription (no API key). `callClaudeCode()`. Desktop-only.

`callProvider(messages, { task })` is the dispatcher: it reads `config.provider{Generate,Translate,Chat}` (`'openrouter' | 'claude'`) and routes accordingly. All internal call sites go through it. All prompt templates are centralized in `prompts.js`.

#### Claude Code provider (Electron main)
- `electron/main.js` spawns `claude -p --output-format json --model <model>`; the system prompt + prompt are sent via **stdin** (avoids Windows arg-length/escaping limits). The model arg is regex-validated (`/^[a-zA-Z0-9._-]+$/`).
- IPC handlers: `ai:claude-call` (generation), `ai:claude-check` (CLI availability). Both return `{ ok, text | error }` with friendly Spanish messages for not-logged-in / rate-limit / overload.
- Requires the `claude` CLI on the system PATH and a logged-in session (`claude` → `/login`).
- Model field accepts aliases: `sonnet`, `opus`, `haiku` (defaults to `sonnet`).

### External control via MCP

An **embedded MCP server** (`electron/mcp-server.js`, Streamable HTTP on `http://127.0.0.1:4747/mcp`) lets an *external* Claude Code session — e.g. from your GDD/story repo — read and edit the project without using the in-app chat. It boots in `app.whenReady()` and forwards each tool call to the renderer via `win.webContents.executeJavaScript('window.__mcpExecute(...)')`, so edits run on the live canvas with normal undo/redo and persistence.

Register once (user scope, available from any repo) while Dialogue Forge is open:
```bash
claude mcp add --transport http --scope user dialogue-forge http://127.0.0.1:4747/mcp
```

Tools (`src/modules/mcp-bridge.js`). Every dialogue edit tool accepts an optional `dialogue_id` (defaults to the **active** dialogue) — no implicit-global-state failures when the active dialogue changes mid-session:
- **Read**: `get_project_summary` (now includes `relatedNpcs` per quest and a `storyMap` node count), `get_dialogue` (`format`: `compact` default — nodes with empty fields omitted plus `edges` as `[from, to, label?]` tuples; also `structure` = ids/edges only and `full` = verbose legacy), `get_story_map` (story nodes with quest names, `edges` as `[from, to, condition?]`, and per-quest Relacionados), `validate_dialogue` (unreachable nodes, broken connections, empty ES/EN texts, endings), `validate_story` (same checks on the story map + nodes without quest / edges without condition)
- **Bulk write**: `write_dialogue_graph` — a whole tree (nodes + connections + start) in ONE call with caller temp ids (`"n1"`); returns `idMap` temp→real. With `title` it creates + activates a new dialogue; otherwise `mode: 'replace'` (default, rewrites the target) or `'append'`. The payload is validated before mutating (atomic) and the tree auto-layouts. **Preferred write path** — avoids the N×add_node + M×connect_nodes round-trips. `write_story_map` is its story-map twin (nodes `{id, quest?, text_es?, text_en?}` + connections `{from, to, condition?}`; same replace/append/atomic/auto-layout semantics).
- **Edit**: `create_dialogue`, `update_dialogue` (title/npc/quest/comment), `delete_dialogue` (requires explicit `dialogue_id`), `clear_dialogue` (leaves one empty start node), `set_active_dialogue`, `add_node` / `update_node` (both accept `condition`/`action` game-logic fields), `connect_nodes` (relabels if the connection already exists), `disconnect_nodes`, `delete_node`, `set_start_node`, `create_npc`, `auto_layout`, `set_comment` (author note on an npc/quest/dialogue)
- **Story map edit**: `add_story_node` / `update_story_node` (quest by name, created if missing; `""` unlinks), `delete_story_node`, `connect_story_nodes` / `disconnect_story_nodes` (`condition` = the label drawn on the arrow; connect upserts), `set_story_start`, `update_quest_relations` (`add/remove_npcs` by name, `add/remove_dialogues` by id or exact title — adding a dialogue sets its `questId`). Story tools mutate `state.story` directly (inside batches) and are listed in `VIEW_SAFE_TOOLS`, so they never force the view back to the dialogue editor.

Implementation notes: node edits on non-active dialogues mutate state directly inside `startBatch()/endBatch()`. Batches **nest** via a depth counter in `state.js` (only the outermost batch pushes the undo checkpoint / emits the render), so `writeDialogueGraph` can run inside the chat executor's batch. `writeDialogueGraph`, `buildValidationReport` and `clearDialogueContent` are exported from `mcp-bridge.js` and reused by `chat.js`, so chat actions and MCP tools behave identically.

The MCP server only responds while the app window is open; tool calls return `{ ok: false, error }` if the window is closed or the bridge hasn't loaded.

The `ai.js` module integrates with the OpenRouter API. All prompt templates are centralized in `prompts.js` for easy editing.

#### Prompts (`prompts.js`)
- `TRANSLATE_SINGLE_SYSTEM` — System prompt for single node translation
- `TRANSLATE_BATCH_SYSTEM` — System prompt for batch translation
- `buildGenerateSystemPrompt(...)` — Builds the system prompt for new dialogue generation
- `buildExtendSystemPrompt(...)` — Builds the system prompt for extending existing dialogues

Translation prompts explicitly instruct the AI to preserve profanity, slang, and vulgar language without censoring.

#### Configuration (stored in localStorage)
```js
{
  apiKey: string,              // OpenRouter API key (only used by the OpenRouter provider)
  modelGenerate: string,       // Model for dialogue generation & extension (e.g. 'anthropic/claude-sonnet-4' or 'sonnet')
  modelTranslate: string,      // Model for ES→EN translation (e.g. 'google/gemini-2.5-flash')
  modelChat: string,           // Model for the integrated chat assistant
  providerGenerate: string,    // 'openrouter' | 'claude' — provider for generation/extension
  providerTranslate: string,   // 'openrouter' | 'claude' — provider for translation
  providerChat: string,        // 'openrouter' | 'claude' — provider for chat
  temperature: number,         // Default 0.7 (OpenRouter only)
  isThinking: boolean,         // Strip <thinking> blocks from response
  contextFiles: [{name, text}],  // Multiple PDF/MD/TXT files for context
  contextPrompt: string,       // Global context prompt
  embeddingsEnabled: boolean,  // Vector memory on/off (default true)
  embeddingsModel: string      // transformers.js model id; empty = Xenova/paraphrase-multilingual-MiniLM-L12-v2
}
```

The AI settings modal (`ui.js`) shows: "same provider everywhere" shortcuts, `<datalist>` model suggestions per provider, the OpenRouter key field only when some task uses OpenRouter, a "🔌 Probar conexión" button (OpenRouter `/api/v1/key` check + `ai:claude-check` IPC), and the embeddings toggle/model field.

### Vector Memory (RAG) & Neural Map

- `vector-memory.js` embeds **dialogue nodes, dialogues (title + NPC/quest relations + author note), context files (chunked ~800 chars), NPCs, quests and chat exchanges** with a local transformers.js model (lazy `import()`, `dtype: 'q8'`, downloads once then cached by the browser). Vectors live in **IndexedDB** (`dialogueForge_vectors`), deliberately outside `state` so the undo system never serializes them.
- Indexing is **incremental** (djb2 content hash per item; stale project items are pruned; chat items are only managed by `addChatExchange`/`clearChatMemory`, capped at 300). A debounced (45 s) background refresh runs from `renderAll()` **only if an index already exists** — the first index is always an explicit user action (Memory Map → "⚡ Indexar proyecto") so the model download is never a surprise.
- **Model tracking**: every stored item records the embedding `model` it was vectorized with. `indexProject()` re-embeds items whose model no longer matches the configured one (chat items included — they migrate instead of being pruned), and `search()` skips mismatched vectors, so switching the embeddings model never silently mixes incompatible vector spaces. After changing the model, run "⚡ Reindexar" once to migrate the whole index.
- **Model profiles**: `getModelProfile()` (matched by model id) decides pooling and query/passage formatting per model family — getting this wrong doesn't error, it silently retrieves worse. Qwen3-Embedding → `last_token` pooling + instruction-formatted queries (`Instruct: ...\nQuery:...`); E5 family → `mean` pooling + `"query: "`/`"passage: "` prefixes; BGE-M3 → `cls` pooling; default (MiniLM/mpnet) → `mean`, raw text. `embedTexts(texts, kind)` applies the profile.
- **Device selection**: `getEmbedder()` tries **WebGPU first** (`device: 'webgpu'`, `dtype: 'fp16'`, with a warmup inference to catch late failures) and falls back to WASM/CPU (`dtype: 'q8'`). WebGPU makes the large models practical (10-100x faster). `getStats().device` / the memory-map footer show which backend is active.
- **Recommended models** (quality order, `<datalist>` in the settings modal): `onnx-community/Qwen3-Embedding-0.6B-ONNX` (best, ~1 GB, wants GPU) > `Xenova/multilingual-e5-large` ≈ `Xenova/bge-m3` > `Xenova/multilingual-e5-base` > `Xenova/multilingual-e5-small` (safe CPU pick).
- The Memory Map header has a "🗑 Borrar índice" button (`confirmDelete` + `VectorMemory.clearAll()`) that wipes all vectors including chat memory.
- The chat performs top-k (8) cosine retrieval per message and injects a `Relevant Project Memory` block into the system prompt; when there is no index it falls back to the old full-text dump of context files. Each successful exchange is remembered (fire-and-forget). The 🗑 button in the chat header clears history + chat vectors.
- Dialogue **generation & extension** (`ai.js` → `getContextAndNpcs(query)`) also use RAG: top-k (10) retrieval against the generation prompt, filtered to `file`/`node`/`npc`/`quest` types (chat exchanges are excluded — they are not world lore). Falls back to the raw 8000-char context-file dump when there is no index or retrieval fails. Uses a dynamic `import('./vector-memory.js')` because `vector-memory.js` statically imports `ai.js` (cycle avoidance).
- `memory-map.js` ("🧠 Memoria" toolbar button) renders the vectors in **3D** on a full-screen canvas overlay — plain canvas 2D with a hand-rolled perspective projection, no WebGL/three.js. PCA to 3 components via covariance-free power iteration (deflation against previous PCs), each axis normalized into a ±500 world cube. Orbit camera: drag = rotate (yaw/pitch, pitch clamped ±1.55), shift/right/middle-drag = pan, wheel = dolly zoom (cursor-anchored via pan compensation), double-click = reset view. Idle auto-rotation via a rAF loop (stops on first drag; the "⟳ Girar" button toggles it; paused while hovering a point). Depth cues: painter's-algorithm sorting, perspective-scaled radii, depth-based alpha, link fade with distance, and a faint wireframe of the world cube. kNN similarity links (threshold slider; skipped above 600 items, hover-only links instead), legend toggles per type, and tooltips on projected positions. **Clicking a point opens a right-side detail panel** (`#memmap-detail`: type badge, metadata, full text, top-6 cosine neighbors — clickable; node/dialogue items get a "→ Ir/Abrir" button which is the only thing that navigates to the editor; clicks after a >4 px drag are ignored, empty-space click closes the panel). The toolbar **RAG test search** (`#memmap-search`, Enter) runs `VectorMemory.search()` — the exact chat/generation retrieval path — listing ranked results with scores in the panel and spotlighting hits on the canvas (gold rings, non-hits dimmed). **Model load feedback**: `getEmbedder()` passes a `progress_callback` that aggregates per-file byte progress into `{phase:'download', loaded, total}`; the map renders it as MB text + a progress bar (also used for embed progress). Escape peels layers: detail panel → search highlights → overlay. `reload()` only projects the largest same-model vector group (mixed embedding models would corrupt the PCA) and shows a "Reindexar para migrarlos" hint when vectors are hidden.
Legacy configs with a single `model` field are auto-migrated to all three on first load. Missing `provider*` fields default to `'openrouter'`. The settings modal (`ui.js`) shows a provider dropdown next to each per-task model input; the model field placeholder/hint switches between OpenRouter model IDs and Claude aliases based on the selected provider.

#### Translation (ES → EN only)
- `translateNode(nodeId)` — Translates a single node's Spanish text to English
- `translateAllNodes()` — Batch-translates all nodes that have ES text but no EN text
- All prompts sent to the AI are in **English**
- Accessible from: toolbar button, inspector (per-node or per-dialogue)

## Future Plans

- **Search**: Find nodes by text content.
- **Dialogue Simulator**: Interactive chat modal to test dialogue trees.
- **Minimap**: Visual overview of large dialogue trees.
- ~~**Sidebar Drag & Drop**~~: ✅ Implemented — Reorder NPCs, Quests, Dialogues by dragging items in the sidebar. Uses `State.reorderList(collection, fromIndex, toIndex)`.
- **Copy/Paste Nodes**: Ctrl+C/V for duplicating nodes.
- **Project Statistics**: Dashboard showing total NPCs, nodes, translation coverage.

### Audio Slicer (`src/modules/audio-slicer.js`)
Self-contained tool for splitting dialogue recordings into individual audio clips.
- **Toolbar button**: "Audio Slicer" in toolbar opens a full-screen overlay
- **Audio loading**: Drag & drop or file picker. Supports `.wav`, `.mp3`, `.ogg`
- **Waveform**: Rendered on `<canvas>` via `AudioContext.decodeAudioData()`. Two stacked canvases: waveform (static) + overlay (markers/cursor, re-rendered on interaction)
- **Markers**: Click waveform to add cut markers. Drag to reposition. Right-click to delete
- **Zoom/Scroll**: Ctrl+Wheel = zoom, Wheel = horizontal scroll
- **Playback**: `AudioBufferSourceNode` for segment previews. Animated cursor via `requestAnimationFrame`
- **Segments list**: Editable names, play buttons, time ranges
- **Naming**: pattern-based (`{file}`, `{num}` = 01, `{num3}` = 001; default `{file}_{num}`). Manual per-segment overrides persist in `customNames[]` across list re-renders (marker edits no longer lose typed names). Batch tools: "↻ Aplicar a todos" (reset to pattern) and find/replace across all names. Export dedupes duplicate filenames automatically.
- **Export**: `wav-encoder.js` for pure JS WAV encoding (44-byte header + Int16 PCM). JSZip (lazy-imported) for .zip bundle export
- **State**: Fully self-contained (no interaction with dialogue State module)

#### Dialogue Generation
- `generateDialogue(prompt, npcName)` — Generates a branching dialogue tree from a prompt
- `insertGeneratedDialogue(data)` — Inserts the generated nodes and connections into the canvas
- Context: semantic retrieval from the vector memory when an index exists (top-10 fragments relevant to the prompt); otherwise falls back to dumping the raw context files (first 8000 chars)
- Output is JSON with `{ nodes: [{id, text_es, text_en, connections}], startNodeId }`

#### File Parsing
- `extractFileText(file)` — Dispatches to PDF or text parser based on extension
- Supports `.pdf` (via PDF.js CDN), `.md`, and `.txt` files
- Multiple files can be added as context in the AI settings modal

### Module Communication
Modules communicate via:
1. **Callbacks** — set up in `main.js` (e.g., `State.onChange(renderAll)`)
2. **Custom events** — `langchange` event on `document` for language switches
3. **Direct imports** — modules import `state.js` for data access

## Development

```bash
npm run dev      # Start Vite + Electron in parallel
npm run build    # Build for production (dist/)
```

## Conventions

- **Author Notes (`comment`)**: NPCs, quests and dialogues carry an optional `comment` string ("Nota del autor"), edited via a textarea in the inspector (same silent-update pattern as names: `updateNPCComment`/`updateQuestComment`/`updateDialogue`). It exists because the AI can't infer nomenclature on its own (e.g. "dialogue that triggers at the end of quest X"). It is exposed to the AI everywhere: chat project context (`NOTE:"..."` + a system-prompt rule), generation/extension prompts (NPC list + active-dialogue note block), the vector index (npc/quest/dialogue item texts) and MCP (`get_project_summary`, `get_dialogue`, `create_dialogue.comment`, `set_comment`). Legacy data without the field is handled with `|| ''` guards.
- **Language**: Code is in English. UI text is in Spanish.
- **AI Prompts**: All system prompts sent to the LLM are in English.
- **No frameworks**: Pure vanilla JS with ES modules.
- **XSS Prevention**: All user-provided strings (NPC names, dialogue titles, quest names) MUST be escaped with `esc()` from `helpers.js` before inserting into HTML templates.
- **Delete Confirmation**: Destructive actions (delete NPC, Quest, Dialogue) use `confirmDelete(message, onConfirm)` from `ui.js` to show a confirmation modal.
- **IDs**: Generated with `uid()` (timestamp + counter + random base36). Counter prevents collisions during batch creation.
- **CSS**: All custom properties in `:root`. No utility classes.
- **Event cleanup**: Global listeners use `window._handlerName` pattern for cleanup on re-render.
- **Node editing**: Inline textarea on canvas + inspector panel. Canvas skips re-render when textarea is focused.
- **Undo/Redo**: Ctrl+Z and Ctrl+Y are only intercepted when the user is NOT in a text input field. Inside inputs/textareas, the browser's native undo/redo works normally.
- **NPC Colors**: Users can customize NPC colors via `<input type="color">` in the inspector. Use `State.updateNPCColor(id, color)`. Colors are stored in `npc.color`.
- **Sidebar Sections**: Collapsible via click on section header. State saved in localStorage (`df_collapsed_sections`).
- **Session Persistence**: Active dialogue ID is saved in localStorage (`df_activeDialogueId`) and restored on app load.
- **Unsaved Changes**: Electron main process shows a native dialog when closing with unsaved changes. Renderer exposes `window.__dialogueForgeDirty()` and `window.__dialogueForgeSave()`.
- **Connection Reordering**: Outgoing connections can be reordered via ▲/▼ buttons in inspector. Use `State.reorderConnection(sourceId, targetId, 'up'|'down')`.
- **Connection Navigation**: Clicking a connection card in the inspector navigates to and selects the target node.
- **API Errors**: `callOpenRouter()` returns descriptive Spanish error messages for common HTTP status codes (401, 402, 404, 429, 503).
- **Undo Flood Prevention**: When editing properties that emit continuous events (like color pickers on `input`), the app registers a `focus` or `mousedown` event listener to trigger `State.pushUndoCheckpoint()` once before editing begins, avoiding saturating the undo/redo stacks.
- **Connection Navigation Click Guards**: Clicking a connection card in the inspector navigates to the target node, but any clicks targeting child action buttons like deletion (`.conn-delete`) or reordering (`.conn-reorder`) are explicitly ignored by checking event targets to prevent unwanted navigation.
- **Color Resiliency Guards**: When rendering nodes or inspector cards for NPCs, check for null/undefined color values (`npc.color`) before applying inline style overrides (e.g. `undefined20` hex overrides) to prevent breaking css rules on legacy data.

## Bugs & Inconsistencies Analysis (June 2026)

A systematic analysis of the codebase was conducted and the following bugs were **confirmed and fixed**:
- **Undo/Redo Fragmentation** (FIXED): Multi-delete and multi-duplicate now use `startBatch()/endBatch()` for atomic undo. Node resize now registers an undo checkpoint.
- **Performance** (FIXED): Batch translation (`translateAllNodes`) now uses `startBatch()/endBatch()` instead of triggering N individual re-renders.
- **UI Desynchronization** (FIXED): Sidebar modals now call `State.notifyChange()` after editing NPC/Quest/Dialogue names to trigger an immediate re-render.
- **Chat Actions** (FIXED): The chat executor now always batches actions (`mutatingActions.length > 0` instead of `> 1`).

Remaining item (not a bug): Canvas re-renders fully when editing node text in the Inspector panel. This is a performance concern for large dialogues (15+ nodes) that would require canvas rendering refactoring.

False positives discarded: NPC color picker undo (already handled via `focus` event), inspector crash on NPC deletion (already has a null guard).

See [Analisis de bugs posibles.md](file:///c:/Users/Benja/Desktop/NWBI/NWBI_Repo/Dialogues/Analisis%20de%20bugs%20posibles.md) for the full verified report.
