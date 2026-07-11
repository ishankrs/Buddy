# Buddy AI Coding Agent — Architecture

Architecture overview for the [Buddy](https://github.com/ishankrs/Buddy) VS Code extension.

## Interactive diagrams (recommended)

Open **[architecture.html](./architecture.html)** in your browser for scrollable, rendered Mermaid diagrams — the same experience as the chat previews.

```bash
open docs/architecture.html
```

Or in VS Code: right-click `docs/architecture.html` → **Open with Live Server** (if installed).

---

## High-level overview

```mermaid
flowchart TB
    subgraph UI["User interfaces"]
        Chat["@buddy Chat Participant<br/>(chat/participant.ts)"]
        Panel["Sidebar Webview Panel<br/>(panel/BuddyPanelProvider.ts)"]
        Cmds["Commands + Status Bar<br/>(extension.ts, llm/statusBar.ts)"]
    end

    subgraph Core["Agent core"]
        Router["runBuddyRequest<br/>(agent/runBuddyRequest.ts)"]
        Modes["Mode routing<br/>default · plan · think · debug · swarm · subagent"]
        Loop["Agent loop<br/>(agent/loop.ts)"]
        Swarm["Swarm orchestrator<br/>(agent/swarm.ts)"]
        Sub["Subagent runner<br/>(agent/subagent.ts)"]
    end

    subgraph Context["Context layer"]
        Gather["Context gatherer<br/>(context/gatherer.ts)"]
        Mem["Session memory<br/>(agent/memory.ts)"]
        Prompts["System prompts<br/>(agent/prompts.ts)"]
    end

    subgraph LLM["LLM layer"]
        LlmRouter["Provider router<br/>(llm/router.ts)"]
        OpenAI["OpenAI / OpenRouter<br/>(llm/openai.ts)"]
        Anthropic["Anthropic<br/>(llm/anthropic.ts)"]
        Ollama["Ollama<br/>(llm/ollama.ts)"]
        Secrets["API keys<br/>(llm/secrets.ts → SecretStorage)"]
    end

    subgraph Tools["Tool layer"]
        Registry["Tool registry<br/>(tools/registry.ts)"]
        Read["read_file · list_files · search_workspace"]
        Write["edit_file · run_terminal"]
        Web["search_web · fetch_url"]
        Spawn["spawn_subagent"]
        Diff["Diff preview<br/>(diff/preview.ts)"]
    end

    subgraph VSCode["VS Code APIs"]
        WS["Workspace / Editor / Terminal"]
        ChatAPI["ChatResponseStream"]
        Webview["WebviewView"]
    end

    Chat --> Router
    Panel --> Router
    Cmds --> LlmRouter

    Router --> Modes
    Modes --> Loop
    Modes --> Swarm
    Modes --> Sub
    Swarm --> Loop
    Sub --> Loop

    Chat --> Gather
    Panel --> Gather
    Loop --> Gather
    Loop --> Mem
    Loop --> Prompts

    Loop --> LlmRouter
    LlmRouter --> OpenAI
    LlmRouter --> Anthropic
    LlmRouter --> Ollama
    LlmRouter --> Secrets

    Loop --> Registry
    Registry --> Read
    Registry --> Write
    Registry --> Web
    Registry --> Spawn
    Write --> Diff
    Spawn --> Loop

    Read --> WS
    Write --> WS
    Web --> WS
    Loop --> ChatAPI
    Panel --> Webview
```

## Request flow

Single user message from chat or panel through to response.

```mermaid
sequenceDiagram
    actor User
    participant UI as Chat or Panel
    participant Ctx as Context Gatherer
    participant Mem as Session Memory
    participant BuddyReq as runBuddyRequest
    participant AgentLoop as Agent Loop
    participant LLM as LLM Provider
    participant Tools as Tool Registry
    participant VSCode as VS Code APIs

    User->>UI: user message and mode
    UI->>Ctx: gatherContext
    Ctx->>VSCode: editor and workspace context
    Ctx-->>UI: context summary
    UI->>Mem: load prior turns
    UI->>BuddyReq: message stream history

    alt swarm mode
        BuddyReq->>BuddyReq: runSwarm
    else subagent mode
        BuddyReq->>BuddyReq: runSubagentMode
    else default modes
        BuddyReq->>AgentLoop: runAgentLoop
    end

    loop each iteration
        AgentLoop->>LLM: messages and tool schemas
        LLM-->>AgentLoop: text or tool calls
        AgentLoop->>UI: stream response
        AgentLoop->>Tools: execute tools
        Tools->>VSCode: read edit terminal web
        Tools-->>AgentLoop: tool results
    end

    AgentLoop-->>BuddyReq: assistant text
    BuddyReq->>Mem: saveTurn
    BuddyReq-->>UI: final response
    UI-->>User: streamed reply
```

## Agent modes

```mermaid
flowchart LR
    Input["User message"] --> Resolve["resolveUserMessageAndMode"]

    Resolve --> Default["default → agent loop"]
    Resolve --> Plan["/plan → loop + plan prompt"]
    Resolve --> Think["/think → loop + think stream"]
    Resolve --> Debug["/debug → loop + debug logging"]
    Resolve --> Swarm["/swarm → runSwarm"]
    Resolve --> SubCmd["/subagent → runSubagentMode"]
    Resolve --> SubNL["NL 'spawn subagent…' → subagent"]

    Swarm --> W1["Worker 1"]
    Swarm --> W2["Worker 2"]
    Swarm --> W3["Worker N"]
    W1 & W2 & W3 --> Loop["runAgentLoop"]

    SubCmd --> SubLoop["runAgentLoop (scoped)"]
    Spawn["spawn_subagent tool"] --> SubLoop
```

## Data and configuration

```mermaid
flowchart TB
    subgraph Config["VS Code settings (buddy.*)"]
        Provider["provider · model · baseUrl"]
        Agent["maxIterations · trustedMode · uiMode"]
        WebCfg["webSearch.*"]
    end

    subgraph Persist["Persistence"]
        SS["SecretStorage<br/>API keys"]
        WSState["WorkspaceState<br/>conversation memory"]
    end

    Config --> LlmRouter["llm/router.ts"]
    Config --> Loop["agent/loop.ts"]
    Config --> WebTools["tools/webTools.ts"]
    SS --> Secrets["llm/secrets.ts"]
    WSState --> Memory["agent/memory.ts"]
```

## Layer breakdown

| Layer | Key modules | Role |
|-------|-------------|------|
| **Entry** | `extension.ts` | Activates chat, panel, commands, status bar, LM tools |
| **UI** | `chat/participant.ts`, `panel/BuddyPanelProvider.ts`, `chat/streamAdapters.ts` | Two surfaces; panel uses webview + postMessage |
| **Routing** | `agent/requestRouting.ts`, `agent/modes.ts` | Slash commands + natural-language subagent detection |
| **Orchestration** | `agent/runBuddyRequest.ts`, `agent/swarm.ts`, `agent/subagent.ts` | Picks loop vs swarm vs subagent |
| **Agent loop** | `agent/loop.ts`, `agent/thinkStream.ts`, `agent/runContext.ts` | Multi-turn LLM ↔ tool cycle with streaming |
| **Context** | `context/gatherer.ts`, `agent/prompts.ts` | Editor/workspace context injected into system prompt |
| **Memory** | `agent/memory.ts` | Per-workspace turn history + token trimming |
| **LLM** | `llm/router.ts`, `llm/*Provider*.ts`, `llm/secrets.ts` | Multi-provider abstraction; keys in SecretStorage |
| **Tools** | `tools/registry.ts`, `readTools`, `writeTools`, `webTools`, `subagentTool` | Eight tools; read-only auto-approve optional |
| **Safety** | `diff/preview.ts`, approval gates in `writeTools` | Diff before edit; terminal confirmation |

## Source layout

```
src/
├── extension.ts          # activate(): wires everything
├── chat/                 # @buddy participant + stream adapters
├── panel/                # sidebar webview UI
├── agent/                # loop, modes, swarm, subagent, memory, prompts
├── llm/                  # providers, router, secrets, status bar
├── tools/                # tool registry + implementations
├── context/              # editor/workspace context gathering
├── diff/                 # edit preview before apply
└── config/               # uiMode (chat / panel / both)
```

## Tools

| Tool | Module | Read-only |
|------|--------|-----------|
| `read_file` | `tools/readTools.ts` | Yes |
| `list_files` | `tools/readTools.ts` | Yes |
| `search_workspace` | `tools/readTools.ts` | Yes |
| `edit_file` | `tools/writeTools.ts` | No (diff preview) |
| `run_terminal` | `tools/writeTools.ts` | No (user approval) |
| `search_web` | `tools/webTools.ts` | Yes |
| `fetch_url` | `tools/webTools.ts` | Yes |
| `spawn_subagent` | `tools/subagentTool.ts` | Yes (spawns nested loop) |

## LLM providers

| Provider ID | Implementation | Notes |
|-------------|----------------|-------|
| `openai` | `llm/openai.ts` | Optional `buddy.openaiBaseUrl` |
| `anthropic` | `llm/anthropic.ts` | Optional `buddy.anthropicBaseUrl` |
| `openrouter` | `llm/openai.ts` | OpenAI-compatible; default OpenRouter base URL |
| `ollama` | `llm/ollama.ts` | Local; no API key |
| `custom` | `llm/openai.ts` | Any OpenAI-compatible endpoint via `buddy.baseUrl` |

## Viewing diagrams

| Method | Experience |
|--------|------------|
| **[architecture.html](./architecture.html)** | Scrollable rendered diagrams (best) |
| **GitHub** | Renders Mermaid in this markdown file |
| **[mermaid.live](https://mermaid.live)** | Paste a diagram block for editing |
