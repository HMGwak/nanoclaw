# agent-browser CLI Contract

Preserved command-level contract used by NanoClaw.

## Core Interaction Pattern

1. `open <url>`
2. `snapshot -i`
3. interact (`click`, `fill`, `select`, `press`)
4. re-snapshot or extract (`get text`, `get url`, `get title`)

## Why Preserved

- Defines the middle stage between URL rendering and Playwright fallback.
- Keeps NanoClaw browser behavior traceable without service-specific prompts.
