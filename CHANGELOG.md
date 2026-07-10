# Changelog

All notable changes to Buddy are documented in this file.

## [0.2.0] - 2026-07-10

### Added

- OpenRouter as a first-class LLM provider
- **Select Provider and Model** / **Select Model** commands and panel UI
- Status bar indicator for current provider and model
- Web search tools (`search_web`, `fetch_url`) with multiple providers
- Subagent mode, natural-language detection, and `spawn_subagent` tool
- Agent modes: `/plan`, `/think`, `/debug`, `/swarm`, `/subagent`
- Buddy sidebar panel alongside native `@buddy` chat
- Unit and integration test suite
- MIT license

### Changed

- Commands use `category: Buddy` for clearer Command Palette grouping
- Extension activates commands before optional LM tool registration

## [0.1.0] - 2026-07-10

### Added

- Initial release: `@buddy` chat participant
- Multi-provider LLM support (OpenAI, Anthropic, Ollama, custom endpoints)
- Tool-calling agent loop (read, search, edit, terminal)
- Session memory per workspace
- Diff preview for file edits
- API key storage via VS Code SecretStorage
