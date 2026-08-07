# Outbound policy specification

Export `classifyRoutineAuthorizationDisclaimer(text)` from `src/utils/outbound-policy.ts`.

It returns a human-readable block reason only when text combines (a) first-person future/refusal language, (b) a routine controlled operation such as merge/deploy/restart, and (c) approval/authorization language. It returns `undefined` for ordinary status, explicit approval requests, and incident reports. `send-telegram` must print the reason and exit before deduplication or any Telegram API call.
