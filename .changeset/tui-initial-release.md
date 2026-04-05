---
"@koi/cli": minor
---

feat(tui): interactive terminal console wired to model API

- `koi tui` opens a full TUI backed by OpenRouter / OpenAI-compatible APIs
- Slash command overlay (`/sessions`, `/help`, `/clear`, etc.)
- Streaming responses with Shift+Enter multiline input
- Set `OPENROUTER_API_KEY` or `OPENAI_API_KEY` to use
