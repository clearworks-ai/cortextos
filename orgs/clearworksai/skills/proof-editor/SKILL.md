# Proof Document Editor — Shared Agent Skill

Proof is a collaborative document editor running locally at `http://localhost:4000`. All agents can create, read, and collaborate on documents via HTTP API.

## Server

- **URL**: `http://localhost:4000`
- **PM2 process**: `proof-sdk`
- **Auth mode**: `none` (local only)
- **Source**: `~/code/proof-sdk` (EveryInc/proof-sdk)

## Quick Reference

### Create a document

```bash
curl -s -X POST http://localhost:4000/documents \
  -H "Content-Type: application/json" \
  -d '{
    "markdown": "# Document Title\n\nContent here.",
    "title": "Document Title",
    "role": "editor",
    "ownerId": "agent:'$CTX_AGENT_NAME'"
  }'
```

Returns: `slug`, `shareUrl`, `ownerSecret`, `accessToken`

### Read document state

```bash
curl -s http://localhost:4000/documents/<slug>/state
```

### Edit a document (replace content)

```bash
curl -s -X POST http://localhost:4000/documents/<slug>/edit \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <ownerSecret>" \
  -d '{"markdown": "# Updated content"}'
```

### Add a comment

```bash
curl -s -X POST http://localhost:4000/documents/<slug>/bridge/comments \
  -H "Content-Type: application/json" \
  -d '{"text": "Comment text", "range": {"from": 0, "to": 10}}'
```

### Add a suggestion

```bash
curl -s -X POST http://localhost:4000/documents/<slug>/bridge/suggestions \
  -H "Content-Type: application/json" \
  -d '{"original": "old text", "replacement": "new text"}'
```

### Poll for events (collaboration updates)

```bash
curl -s http://localhost:4000/documents/<slug>/events/pending?after=0
```

### Acknowledge events

```bash
curl -s -X POST http://localhost:4000/documents/<slug>/events/ack \
  -H "Content-Type: application/json" \
  -d '{"lastEventId": <id>}'
```

## Agent Workflow

1. **Create** a doc with `POST /documents` — save the `ownerSecret` and `slug`
2. **Share** the `shareUrl` with Josh via Telegram (he opens it in browser at localhost:4000)
3. **Collaborate** using comments, suggestions, rewrites via the bridge API
4. **Poll** for Josh's edits via the events endpoint
5. **Always send `Idempotency-Key` header** on mutation requests for safe retries

## Token Semantics

- `ownerSecret` — full control (edit, delete, pause). Store securely, never share.
- `accessToken` — scoped to the `role` specified at creation. Use for non-owner ops.

## Use Cases

- Drafting documents for Josh's review (proposals, briefs, plans)
- Multi-agent collaboration on a shared doc (one creates, others comment/suggest)
- Iterative editing with real-time collaboration between Josh and agents
