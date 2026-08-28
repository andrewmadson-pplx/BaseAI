---
'baseai': minor
'@baseai/core': minor
---

Add Perplexity Agent API support with the `fast`, `low`, `medium`, and `high`
presets for local BaseAI Pipes. The existing Perplexity Sonar identifiers remain
on Chat Completions but are deprecated ahead of their scheduled September 27,
2026 shutdown; existing Pipes are not migrated automatically. Agent responses
preserve the executing model and available usage, provider HTTP errors retain
their BaseAI status categories, and tool-free Core streams return immediately.
