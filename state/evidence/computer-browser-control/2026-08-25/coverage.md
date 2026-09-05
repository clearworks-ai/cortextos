# Computer/browser-control propagation coverage — 2026-08-25

- Manifest: `/Users/joshweiss/.cortextos/cortextos1/config/enabled-agents.json`
- Source commits: `52c2f53b`, `60742aaf`
- Wrapper SHA-256: `60ae2968821c4600c5b2d34a4225e09fc6a6918728f1b460ee1a9ae69da8f1cf`
- agent-browser SKILL.md SHA-256: `ec699a4f41b68fe9c09bc29a88428309d43a15b87f48f98a9fda09e7733f167c`
- CuaDriver: `~/.cua-driver/skills/cua-driver/SKILL.md` version **0.21.0**
- Restart performed: **false**
- Verify failures: `none`

## Daemon-enabled coverage

| agent | org | runtime | wrapper_discovery | cua_driver | runtime_native_route | restart_required | TOOLS.md sha256 | skill sha256 | wrapper sha256 |
|---|---|---|---|---|---|---|---|---|---|
| maven | clearworksai | claude-code | ok | ok@0.21.0 | ok-codex-computer-use-distinct-from-cdp | true | `83ee1441dbb52a70a89520365ed184b1234f9b3baed89e8cef66cde4a3f872d1` | `ec699a4f41b68fe9c09bc29a88428309d43a15b87f48f98a9fda09e7733f167c` | `60ae2968821c4600c5b2d34a4225e09fc6a6918728f1b460ee1a9ae69da8f1cf` |
| muse | clearworksai | claude-code | ok | ok@0.21.0 | ok-codex-computer-use-distinct-from-cdp | true | `2975034735ff2ff74b8275907fc67d0e431b5ac5dcc59cfa4b03546ade899204` | `ec699a4f41b68fe9c09bc29a88428309d43a15b87f48f98a9fda09e7733f167c` | `60ae2968821c4600c5b2d34a4225e09fc6a6918728f1b460ee1a9ae69da8f1cf` |
| codexer | clearworksai | codex-app-server | ok | ok@0.21.0 | ok-codex-computer-use-distinct-from-cdp | true | `9f1593c661b6ca8f46dd504b8b130a5af79d1d4817e8f3eea37c58d00ebaa078` | `ec699a4f41b68fe9c09bc29a88428309d43a15b87f48f98a9fda09e7733f167c` | `60ae2968821c4600c5b2d34a4225e09fc6a6918728f1b460ee1a9ae69da8f1cf` |
| frank2-codex | clearworksai | codex-app-server | ok | ok@0.21.0 | ok-codex-computer-use-distinct-from-cdp | true | `c3f104b89884c824260797b1e9b947b2f4ecf9cc21e8fa62f86b8b37406d553e` | `ec699a4f41b68fe9c09bc29a88428309d43a15b87f48f98a9fda09e7733f167c` | `60ae2968821c4600c5b2d34a4225e09fc6a6918728f1b460ee1a9ae69da8f1cf` |
| larry-codex | clearworksai | codex-app-server | ok | ok@0.21.0 | ok-codex-computer-use-distinct-from-cdp | true | `a8e94e6c53bdb58e4e4dd4b6d1486b334bf230965c8dd93ad4ee73866120ccd8` | `ec699a4f41b68fe9c09bc29a88428309d43a15b87f48f98a9fda09e7733f167c` | `60ae2968821c4600c5b2d34a4225e09fc6a6918728f1b460ee1a9ae69da8f1cf` |
| auditmaster-codex | clearworksai | codex-app-server | ok | ok@0.21.0 | ok-codex-computer-use-distinct-from-cdp | true | `5dbec172ece0b43777f10d190cbef203380f20b2bd9e858f1dadac6fcee0ec69` | `ec699a4f41b68fe9c09bc29a88428309d43a15b87f48f98a9fda09e7733f167c` | `60ae2968821c4600c5b2d34a4225e09fc6a6918728f1b460ee1a9ae69da8f1cf` |
| knox-codex | clearworksai | codex-app-server | ok | ok@0.21.0 | ok-codex-computer-use-distinct-from-cdp | true | `2975034735ff2ff74b8275907fc67d0e431b5ac5dcc59cfa4b03546ade899204` | `ec699a4f41b68fe9c09bc29a88428309d43a15b87f48f98a9fda09e7733f167c` | `60ae2968821c4600c5b2d34a4225e09fc6a6918728f1b460ee1a9ae69da8f1cf` |
| pa-codex | clearworksai | codex-app-server | ok | ok@0.21.0 | ok-codex-computer-use-distinct-from-cdp | true | `2412985f8aec2f1d5da5278a939570b5083fda7af59b69ec3dd85fd9359460fa` | `ec699a4f41b68fe9c09bc29a88428309d43a15b87f48f98a9fda09e7733f167c` | `60ae2968821c4600c5b2d34a4225e09fc6a6918728f1b460ee1a9ae69da8f1cf` |
| crm-codex | clearworksai | codex-app-server | ok | ok@0.21.0 | ok-codex-computer-use-distinct-from-cdp | true | `c6c9a8d5b4b92e0be434aac897c55d74851d10626ced48135823eb1592dadd99` | `ec699a4f41b68fe9c09bc29a88428309d43a15b87f48f98a9fda09e7733f167c` | `60ae2968821c4600c5b2d34a4225e09fc6a6918728f1b460ee1a9ae69da8f1cf` |
| maven-codex | clearworksai | codex-app-server | ok | ok@0.21.0 | ok-codex-computer-use-distinct-from-cdp | true | `83ee1441dbb52a70a89520365ed184b1234f9b3baed89e8cef66cde4a3f872d1` | `ec699a4f41b68fe9c09bc29a88428309d43a15b87f48f98a9fda09e7733f167c` | `60ae2968821c4600c5b2d34a4225e09fc6a6918728f1b460ee1a9ae69da8f1cf` |
| sage-codex | clearworksai | codex-app-server | ok | ok@0.21.0 | ok-codex-computer-use-distinct-from-cdp | true | `83ee1441dbb52a70a89520365ed184b1234f9b3baed89e8cef66cde4a3f872d1` | `ec699a4f41b68fe9c09bc29a88428309d43a15b87f48f98a9fda09e7733f167c` | `60ae2968821c4600c5b2d34a4225e09fc6a6918728f1b460ee1a9ae69da8f1cf` |
| scout-codex | clearworksai | codex-app-server | ok | ok@0.21.0 | ok-codex-computer-use-distinct-from-cdp | true | `2975034735ff2ff74b8275907fc67d0e431b5ac5dcc59cfa4b03546ade899204` | `ec699a4f41b68fe9c09bc29a88428309d43a15b87f48f98a9fda09e7733f167c` | `60ae2968821c4600c5b2d34a4225e09fc6a6918728f1b460ee1a9ae69da8f1cf` |
| ophir-codex | personal | codex-app-server | ok | ok@0.21.0 | ok-codex-computer-use-distinct-from-cdp | true | `2975034735ff2ff74b8275907fc67d0e431b5ac5dcc59cfa4b03546ade899204` | `ec699a4f41b68fe9c09bc29a88428309d43a15b87f48f98a9fda09e7733f167c` | `60ae2968821c4600c5b2d34a4225e09fc6a6918728f1b460ee1a9ae69da8f1cf` |
| builddifferentprod-codex | clearworksai | codex-app-server | ok | ok@0.21.0 | ok-codex-computer-use-distinct-from-cdp | true | `c7d2614c1f13909249f7e2640762a94d3abe74141a2bb466286bd9376525c286` | `ec699a4f41b68fe9c09bc29a88428309d43a15b87f48f98a9fda09e7733f167c` | `60ae2968821c4600c5b2d34a4225e09fc6a6918728f1b460ee1a9ae69da8f1cf` |

## Config-enabled extras (not in daemon enabled manifest)

Reported only. Not part of the canonical daemon restart set.

| agent | org | runtime | config_enabled | daemon_enabled |
|---|---|---|---|---|
| crm | clearworksai | claude-code | true | false |
| frank2 | clearworksai | claude-code | true | false |
| larry | clearworksai | claude-code | true | false |
| opencode | clearworksai | opencode | true | false |
| pa | clearworksai | claude-code | true | false |
| sage | clearworksai | claude-code | true | false |
| scout | clearworksai | claude-code | true | false |
| maven | personal | claude-code | true | false |
| ophir | personal | claude-code | true | false |
| scout | personal | claude-code | true | false |

## Restart set (not executed)

- `clearworksai/maven`
- `clearworksai/muse`
- `clearworksai/codexer`
- `clearworksai/frank2-codex`
- `clearworksai/larry-codex`
- `clearworksai/auditmaster-codex`
- `clearworksai/knox-codex`
- `clearworksai/pa-codex`
- `clearworksai/crm-codex`
- `clearworksai/maven-codex`
- `clearworksai/sage-codex`
- `clearworksai/scout-codex`
- `personal/ophir-codex`
- `clearworksai/builddifferentprod-codex`

## CuaDriver global links (unaltered)

- `agents`: `/Users/joshweiss/.agents/skills/cua-driver` → `/Users/joshweiss/.cua-driver/skills/cua-driver` (altered=False)
- `claude`: `/Users/joshweiss/.claude/skills/cua-driver` → `/Users/joshweiss/.cua-driver/skills/cua-driver` (altered=False)
- `opencode`: `/Users/joshweiss/.config/opencode/skills/cua-driver` → `/Users/joshweiss/.cua-driver/skills/cua-driver` (altered=False)
- `hermes`: `/Users/joshweiss/.hermes/skills/cua-driver` → `/Users/joshweiss/.cua-driver/skills/cua-driver` (altered=False)
