# Infra Probes G-28..G-33 — Evidence (read-only)

Probe date: 2026-09-15. All commands were list/describe/GET only. No cloud resources created, modified, or deleted. No `users.watch`/`users.stop` calls made. No secrets printed (private key contents never read/echoed; only `client_email`/`project_id`/`type` fields extracted from the service-account JSON).

## G-28: gcloud installed/authenticated, active project

```
$ which gcloud
(not found, exit 127)
$ gcloud config list
zsh: command not found: gcloud
$ gcloud auth list
zsh: command not found: gcloud
```
`gcloud` is not on PATH on this machine. Cannot determine active GCP project or auth state via CLI.

**Verdict: UNVERIFIABLE.** Settle by installing Google Cloud SDK (`brew install --cask google-cloud-sdk` or the gcloud installer) and running `gcloud auth login` / `gcloud config set project <id>`, or by using an alternate credential (the DWD service-account key at `~/.config/gws/service-account-key.json`, project `cortextos-gws-495505` per G-31) with `gcloud auth activate-service-account` if that account has IAM permissions on the target project, or by checking the GCP Console UI directly.

## G-29: Pub/Sub topic + push subscription for Gmail

Depends on gcloud (G-28), which is unavailable.

**Verdict: UNVERIFIABLE** (blocked by G-28). If gcloud were available: `gcloud pubsub topics list --project cortextos-gws-495505` and `gcloud pubsub subscriptions list --project cortextos-gws-495505`. Until confirmed, the patch spec must treat "no topic/subscription exists" as the working assumption and include a prerequisite FR to provision: create topic, create push subscription pointing at the webhook-hub endpoint, and grant `gmail-api-push@system.gserviceaccount.com` the Pub/Sub Publisher role on the topic (see G-31 evidence below).

## G-30: Pub/Sub API and Gmail API enabled

Depends on gcloud (G-28), which is unavailable.

**Verdict: UNVERIFIABLE** (blocked by G-28). Would run: `gcloud services list --enabled --project cortextos-gws-495505 | grep -E 'pubsub|gmail'`.

## G-31: DWD service account identity, scopes, and users.watch readiness

### Identity source 1 — `/Users/joshweiss/.local/bin/gws-dwd`
Full script read (no secrets echoed). Key facts:
- `KEY_FILE = ~/.config/gws/service-account-key.json`
- `SUBJECT = "josh@clearworks.ai"` (DWD-impersonated user)
- Header comment: "Uses gws-agent@cortextos-gws-495505"
- Requested scopes (JWT `scope` claim) for this shim's own calls:
  ```
  https://mail.google.com/
  https://www.googleapis.com/auth/gmail.readonly
  https://www.googleapis.com/auth/gmail.send
  https://www.googleapis.com/auth/gmail.modify
  https://www.googleapis.com/auth/gmail.settings.sharing
  https://www.googleapis.com/auth/gmail.settings.basic
  https://www.googleapis.com/auth/calendar
  https://www.googleapis.com/auth/drive
  ```

### Identity source 2 — `orgs/clearworksai/agents/pa/scripts/gmail_push_listener.py`
`_get_token()` → `_refresh_token()` (lines ~104-165):
- `KEY_FILE = HOME / ".config" / "gws" / "service-account-key.json"` — same key file as gws-dwd.
- `GMAIL_SUBJECT = "josh@clearworks.ai"` — same DWD subject.
- Requested scopes for this listener's own token:
  ```
  https://mail.google.com/
  https://www.googleapis.com/auth/gmail.readonly
  https://www.googleapis.com/auth/gmail.modify
  ```

### Service-account identity (extracted, no key material)
```
client_email: gws-agent@cortextos-gws-495505.iam.gserviceaccount.com
project_id:   cortextos-gws-495505
type:         service_account
```
Both scripts load the **same** key file and impersonate the **same** subject (`josh@clearworks.ai`), so they are the same DWD identity: `gws-agent@cortextos-gws-495505.iam.gserviceaccount.com`.

### Official docs (WebFetch, developers.google.com/workspace/gmail/api/guides/push)
- Pub/Sub permission: the topic must grant **Publish** privileges to `gmail-api-push@system.gserviceaccount.com`.
- Watch expiration: must be renewed **at least once every 7 days** (Google recommends renewing daily); response includes an expiration timestamp.
- Notification payload: `message.data` (Base64URL JSON containing `emailAddress` + `historyId`), plus `message.messageId`, `message.publishTime`, and `subscription`.

### Official docs (WebFetch, developers.google.com/workspace/gmail/api/reference/rest/v1/users/watch)
`users.watch` requires **one of**:
```
https://mail.google.com/
https://www.googleapis.com/auth/gmail.modify
https://www.googleapis.com/auth/gmail.readonly
https://www.googleapis.com/auth/gmail.metadata
```

### Verdict on "the existing DWD identity can call users.watch with its current scopes"
The listener's own token request (`mail.google.com`, `gmail.readonly`, `gmail.modify`) already includes three of the four scopes accepted by `users.watch` — scope-wise the identity is sufficient, no scope change needed.
However, `users.watch` succeeding end-to-end also requires the target Pub/Sub topic to grant `gmail-api-push@system.gserviceaccount.com` the Publisher role — that is a Pub/Sub-side IAM binding, independent of the DWD identity's OAuth scopes, and is **unverified** here (blocked by G-28/G-29, gcloud unavailable).

**Verdict: PARTIAL.** Scope requirement = VERIFIED satisfied. Full call-readiness (topic IAM grant to the Gmail push system account) = UNVERIFIABLE pending gcloud access.

## G-32: webhook-hub and bridge reachability

```
$ curl -s -o /dev/null -w "HTTP_STATUS:%{http_code}\n" https://webhook-hub-production-0194.up.railway.app/healthz --max-time 15
HTTP_STATUS:200

$ curl -s -o /dev/null -w "HTTP_STATUS:%{http_code}\n" https://bridge.clearworks.ai/healthz --max-time 15
HTTP_STATUS:200
```
Both endpoints returned HTTP 200 via curl (per the note in the claim, curl was used instead of Python urllib for the bridge host to avoid the Cloudflare 1010 block).

**Verdict: VERIFIED.** Both webhook-hub (Railway) and the local bridge (bridge.clearworks.ai) are publicly reachable and healthy, so a Pub/Sub push subscription could target the hub endpoint.

## G-33: Railway env vars on webhook-hub service

```
$ which railway; railway --version
/opt/homebrew/bin/railway
railway 4.40.0

$ railway status
Project: briefs
Environment: production
Service: briefs
```
The Railway CLI is installed and authenticated, but the directory-linked project (keyed globally in `~/.railway/config.json` under path `/Users/joshweiss`) is **`briefs`**, not `webhook-hub`:
```
$ railway variables --service webhook-hub
Service 'webhook-hub' not found
```
`railway list` confirms a `webhook-hub` project exists under clearworks-ai's Projects, but `railway variables` has no `--project` flag to target it without re-linking (`railway variables --help` shows only `-s/--service`, `-e/--environment`). Re-linking would overwrite the shared global CLI link (`~/.railway/config.json`, keyed by home-directory path, not per-repo) as a side effect of this read-only probe — out of scope for this task, so it was not performed.

**Verdict: UNVERIFIABLE** (CLI not linked to the webhook-hub project; re-linking was avoided to prevent side effects on shared global CLI state). Settle by either: (a) `railway link` into the `webhook-hub` project in a disposable/throwaway shell or scratch directory, then `railway variables --service webhook-hub --kv` (names only), or (b) checking the Railway dashboard UI directly, or (c) the remote Railway MCP (`mcp.railway.com`) if it exposes a variables-list tool scoped to that project.
