<div align="center">

<img src="media/icon.png" width="96" height="96" alt="Buddy AI Coding Agent logo" />

# Buddy AI Coding Agent

An AI coding agent for VS Code.

</div>

Ask questions in chat, let it read your repo, edit files, run commands, and search the web — with the provider and model you choose.

Buddy runs as `@buddy` in VS Code Chat or in a dedicated sidebar panel. It keeps conversation context per workspace, shows diffs before applying edits, and asks before running terminal commands (unless you opt into trusted mode).

## Install

**From the Marketplace**

```bash
code --install-extension ishankrs.buddy-ai-coding-agent
```

Or search **Buddy AI Coding Agent** in the Extensions view.

**From source (development)**

```bash
git clone https://github.com/ishankrs/Buddy.git
cd Buddy
npm install
npm run compile
```

Press **F5** in VS Code to open the Extension Development Host with Buddy loaded.

**From a VSIX**

```bash
npm run package
```

Then in VS Code: Extensions → `…` → **Install from VSIX…** → select `buddy-ai-coding-agent-0.2.1.vsix`.

## Setup

1. Open the Command Palette and run **Buddy: Select Provider and Model** (or use the dropdowns in the sidebar panel).
2. Pick a provider and enter an API key when prompted. Keys are stored in VS Code SecretStorage — not in settings files.

Supported providers:

| Provider | Notes |
|----------|--------|
| OpenAI | Default. Set `buddy.model` or pick from the command. |
| Anthropic | Claude models via the Anthropic API. |
| OpenRouter | OpenAI-compatible gateway; models like `openai/gpt-4o`, `anthropic/claude-3.5-sonnet`. |
| Ollama | Local models; no API key. Default URL `http://localhost:11434`. |
| Custom | Any OpenAI-compatible endpoint. Set `buddy.baseUrl` and `buddy.model`. |

For a self-hosted or proxy API, use **Buddy: Configure API Endpoint (URL + Key)** instead.

## Using Buddy

In VS Code Chat:

```
@buddy explain this function
@buddy /plan refactor the auth module
@buddy /debug why is this test failing?
@buddy /think how should I split this service?
@buddy /swarm add login end-to-end
@buddy /subagent write tests for auth.ts
```

**Chat commands**

| Command | Purpose |
|---------|---------|
| `/plan` | Outline steps before changing anything |
| `/think` | Reasoning blocks before tool use |
| `/debug` | Focus on errors, logs, and verification |
| `/swarm` | Split work across parallel workers |
| `/subagent` | Hand off a scoped subtask |

You can also say things like *“open a subagent to refactor the logger”* — Buddy will pick that up in normal chat.

**UI modes** (`buddy.uiMode`)

- `both` — Chat and sidebar panel (default)
- `chat` — `@buddy` only
- `panel` — Sidebar only (activity bar icon)

Switch anytime via **Buddy: Switch UI (Chat / Panel / Both)**.

## What Buddy can do

The agent loop can call tools to:

- Read and search files in your workspace (requires `rg` in PATH)
- Edit files with a diff preview before apply
- Run terminal commands (with confirmation)
- Search the web and fetch public URLs
- Spawn subagents for isolated subtasks

It uses your active editor, selection, `@` file references, and diagnostics as context.

## Configuration

Common settings (Settings → search `buddy`):

```
buddy.provider          openai | anthropic | openrouter | ollama | custom
buddy.model             Model ID (provider-specific)
buddy.maxIterations     Tool loop limit per request (default 25)
buddy.autoApproveReadOnly   Auto-run read-only tools (default true)
buddy.trustedMode       Skip terminal approval (default false)
buddy.maxMemoryTurns    History kept per workspace (default 20)
```

Web search (`buddy.webSearch.*`) is on by default. Provider `auto` uses Serper, Brave, Tavily, or Google when keys exist; otherwise DuckDuckGo. Optional keys via **Buddy: Set Web Search API Key**.

Provider-specific base URLs: `buddy.openaiBaseUrl`, `buddy.anthropicBaseUrl`, `buddy.openrouterBaseUrl`, `buddy.baseUrl` (custom), `buddy.ollamaBaseUrl`.

## Commands

| Command | |
|---------|--|
| **Buddy: Select Provider and Model** | Change provider and model |
| **Buddy: Select Model** | Change model for the current provider |
| **Buddy: Set API Key** | Store a provider API key |
| **Buddy: Configure API Endpoint (URL + Key)** | Custom OpenAI-compatible API |
| **Buddy: Open Panel** | Open the sidebar chat |
| **Buddy: Switch UI (Chat / Panel / Both)** | Change where Buddy appears |
| **Buddy: Clear Conversation Memory** | Reset chat history for this workspace |
| **Buddy: Set Web Search API Key** | Serper, Brave, Tavily, or Google CSE |
| **Buddy: Open LLM Settings** | Jump to Buddy settings |

The status bar shows the active provider and model; click it to change them.

## Development

Requires Node 20+, VS Code 1.95+.

```bash
npm run compile      # build extension
npm run watch        # rebuild on change
npm run check        # typecheck
npm run package      # create .vsix
```

## Requirements

- VS Code 1.95 or newer
- An API key for your chosen provider (except Ollama)
- `ripgrep` (`rg`) on PATH for workspace search

## License

MIT — see [LICENSE](LICENSE).
