---
name: agent-browser
description: Browser automation CLI for isolated, disposable, unauthenticated, test, or explicitly requested CDP sessions. Before using it, apply the fleet computer/browser route hierarchy and load the canonical CuaDriver skill for authenticated existing-profile or visible desktop work.
allowed-tools: Bash(cua-driver:*), Bash(agent-browser:*), Bash(npx agent-browser:*)
---

# agent-browser

Browser automation CLI for AI agents. Uses Chrome/Chromium via CDP directly.

Install: `npm i -g agent-browser && agent-browser install`

## Fleet route hierarchy — mandatory preflight

Computer control is not synonymous with Chrome remote-debugging attachment. Before acting, load the version-matched canonical CuaDriver bundle (`~/.cua-driver/skills/cua-driver/SKILL.md` plus its required `MACOS.md` and `BROWSER.md` references) and use its route ladder:

1. Headless API, SDK, CLI, or filesystem route when it can complete the outcome.
2. Runtime-native computer use (including Codex Computer Use when available).
3. Typed CuaDriver operation.
4. Background native accessibility action.
5. Background native pixel action.
6. Foreground delivery only after evidence establishes it is required and the action is authorized.
7. Desktop fallback.

Native CuaDriver window, accessibility, and pixel control does **not** require CDP, a Chrome remote-debugging prompt, or browser attachment. Use `browser_prepare` only when page-aware browser semantics in an authenticated existing profile are actually needed; let that typed operation own its exact product-specific setup instead of manually clicking lookalike prompts.

Use `agent-browser` for isolated/unauthenticated automation, disposable sessions, testing, or when the user explicitly requests it. Never create a human dependency until the applicable authorized routes above have been attempted and their exact terminal evidence recorded.

## Loading Skills

**You must run `agent-browser skills get <name>` before running any agent-browser commands.**
This file does not contain command syntax, flags, or workflows. That content is served
by the CLI and changes between versions. Guessing at commands without loading the skill
will produce incorrect or outdated invocations.

```bash
agent-browser skills get agent-browser    # Required before any browser automation
agent-browser skills get <name> --full    # Include references and templates
```

## Available Skills

- **agent-browser** — Core browser automation
- **dogfood** — Exploratory testing and QA
- **electron** — Electron desktop app automation
- **slack** — Slack workspace automation
- **vercel-sandbox** — Browser automation in Vercel Sandbox
- **agentcore** — Browser automation on AWS Bedrock AgentCore

## Why agent-browser

- Fast native Rust CLI, not a Node.js wrapper
- Works with any AI agent (Cursor, Claude Code, Codex, Continue, Windsurf, etc.)
- Chrome/Chromium via CDP with no Playwright or Puppeteer dependency
- Accessibility-tree snapshots with element refs for reliable interaction
- Sessions, authentication vault, state persistence, video recording
- Specialized skills for Electron apps, Slack, exploratory testing, cloud providers
