# Buddy AI Coding Agent — Agent Instructions

This is a VS Code extension (TypeScript + esbuild). Be precise, minimal, and
verify with the typechecker/build before finishing.

## API keys — local only (never commit)

- Never put API keys, tokens, or secrets in `opencode.json`, `AGENTS.md`,
  source files, settings, or chat logs.
- For opencode itself: run `/connect`, pick a provider (e.g. OpenCode Zen),
  and paste the key. It is stored locally only in
  `~/.local/share/opencode/auth.json` — that file must never be committed.
- Alternatively use env vars (e.g. `OPENCODE_ZEN_API_KEY`, `OPENAI_API_KEY`,
  `ANTHROPIC_API_KEY`) or `{env:...}` / `{file:...}` references in your
  *global* config (`~/.config/opencode/opencode.json`), not in this repo.
- For the Buddy VS Code extension: keys are entered via
  `Buddy: Set API Key` and stored only in VS Code SecretStorage (OS keychain).
  `Buddy: Remove API Key` deletes them. Nothing key-related belongs in git.

## Build / check / test

Requires Node 20+.

```bash
npm install
npm run check      # typecheck (tsc --noEmit) — run before finishing
npm run compile    # build extension via esbuild to dist/
npm run watch      # rebuild on change (dev only)
npm run test:unit  # unit tests (tsx --test test/unit/*.test.ts)
npm run package    # create .vsix (needs vsce)
```

Press `F5` in VS Code to open the Extension Development Host with Buddy loaded.

## Project structure

```
src/
  extension.ts          # activate(): commands, status bar, chat/panel wiring
  chat/                 # @buddy chat participant + stream adapters
  panel/                # sidebar webview (BuddyPanelProvider + media/panel/*)
  agent/                # loop, modes, swarm, subagent, memory, prompts
  llm/                  # router, providerCatalog, openai/anthropic/ollama,
                        # secrets (SecretStorage only), statusBar, panel settings
                        # opencode/ = local OpenCode backend (detector, JSON-RPC,
                        # ACP client, process manager, LLM adapter, vscode glue)
                        # — all vscode-free except opencode/vscode.ts
  tools/                # read/write/web/subagent tools + registry
  context/              # editor/workspace context gathering
  diff/                 # edit preview before apply
  config/               # uiMode (chat / panel / both)
media/panel/            # webview CSS + JS (no secrets here)
docs/                   # ARCHITECTURE.md + architecture.html (Mermaid)
test/unit/              # unit tests
```

## Conventions

- Providers: `openai | anthropic | openrouter | ollama | opencode | custom`.
  `opencode` = OpenCode (Local): Buddy spawns `opencode acp` and talks ACP
  (JSON-RPC/stdio). NEVER add hosted OpenCode endpoints (`opencode.ai/zen`,
  `/inference`), API-key flows, or hardcoded model lists for it — models come
  from the local session's `configOptions` (`session/set_config_option` to
  switch). Auth/permissions/tools/sessions belong to the user's OpenCode
  install. New code under `llm/opencode/` must stay `vscode`-free (except
  `vscode.ts`) and unit-tested with fakes (`test/unit/opencode*.test.ts`).
- Adding a provider means touching: `llm/router.ts` (ProviderId + case),
  `llm/providerCatalog.ts` (definition), `package.json` (`buddy.provider`
  enum + `buddy.<id>BaseUrl`), `src/extension.ts` (baseUrlKey mapping),
  plus README/docs table rows.
- `buddy.*` settings hold only non-secret config (provider, model, URLs).
  Secrets go only through `llm/secrets.ts` → `context.secrets`.
- Keep diffs small; prefer editing existing files over creating new ones.
- Safety behavior is intentional: diff preview before edits, confirmation
  before terminal commands (unless `buddy.trustedMode`), read-only tools
  auto-approved only when `buddy.autoApproveReadOnly`.

## opencode slash commands in this repo

`.opencode/commands/*.md` mirrors Buddy's chat modes (`/plan`, `/think`,
`/debug`, `/swarm`, `/subagent`). Keep them in sync with
`src/agent/modes.ts` and the `chatParticipants` commands in `package.json`.
