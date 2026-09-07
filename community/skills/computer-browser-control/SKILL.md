---
name: computer-browser-control
description: Route and execute authorized computer, desktop, browser, and authenticated web work across APIs, connectors, runtime-native browser tools, Codex Computer Use, CuaDriver, and agent-browser. Use before declaring any computer or browser task human-only.
---

# Computer and browser control

Internal fleet skill. Its purpose is to select and exhaust the control surfaces already available to the agent without returning routine authorized work to the user.

## Mandatory preflight

1. Restate the requested outcome and its authorization boundary. Authorization for an action applies across suitable control routes; switching tools does not require the user to re-authorize the same scoped action.
2. Inventory the callable routes in the current runtime. Do not infer absence from one failed tool or from memory.
3. Load the current tool-native instructions before acting:
   - CuaDriver: read `~/.cua-driver/skills/cua-driver/SKILL.md` completely, then every platform or browser reference it requires for this task.
   - agent-browser: run `agent-browser skills get agent-browser --full` before its first use.
   - Runtime-native plugins, connectors, browser control, or Computer Use: follow their current tool descriptions; do not guess command syntax.
4. Snapshot or inspect state before every consequential GUI action and verify the result afterward.

## Capability map

Choose the least intrusive route that can complete the outcome. These are complementary capabilities, not aliases:

- **Direct semantic route:** API, SDK, CLI, filesystem, installed connector, app, or MCP. Prefer this when it provides the required authenticated read/write operation with a verifiable receipt.
- **Runtime-native browser route:** Chrome Plugin or Browser Plugin when exposed. Prefer this for browser content and authenticated Chrome work when it can act directly on the intended page.
- **Codex Computer Use:** first-class control for visible desktop/browser tasks, browser chrome, consent sheets, file pickers, native dialogs, and cases where semantic DOM/CDP routes do not expose the target.
- **CuaDriver typed browser operations:** page-aware work in an existing authenticated profile. Use `browser_prepare` only when browser semantics are needed and let that operation own its exact product-specific setup.
- **CuaDriver native control:** window, accessibility, and pixel routes for macOS and desktop applications. These do not require CDP, Chrome remote-debugging, or browser attachment.
- **agent-browser:** isolated, disposable, unauthenticated, testing, scraping, or explicitly requested CDP sessions.

Within CuaDriver, follow its versioned ladder: typed operation, background accessibility, background pixels, evidenced and authorized foreground delivery, then desktop fallback.

## Failure and escalation rule

A failure in one route is evidence about that route only. It is not evidence that the user must take over.

Before creating a human task or asking the user to click, unlock, copy, upload, or navigate:

- attempt every applicable authorized route in the capability map;
- record the exact terminal evidence for each route attempted;
- distinguish a real human-only dependency (physical presence, unavailable credential, payment, legal confirmation) from a tool-selection failure;
- continue automatically when another route can complete the same authorized outcome.

Never use generic global input to imitate a product-specific security prompt. Use the typed product operation or an exact runtime-native control surface and verify target identity first.

## Completion gate

Do not report completion until the intended state is read back through an independent or fresh inspection. The receipt must name the route used, the target, the resulting state, and any scoped mutation. If the task remains blocked, the receipt must enumerate the exhausted applicable routes and the one concrete dependency that no available route can satisfy.
