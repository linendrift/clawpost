---
name: clawpost
description: >-
  Manage email through Clawpost via the standalone CLI or MCP server — send,
  receive, reply, search, manage drafts and sender approvals, and operate
  Cloudflare-backed inboxes and forwarding aliases. Use when the user asks to
  check email, send a message, reply to someone, search an inbox, manage approved
  senders, or create/update/delete inboxes and aliases.
license: MIT
metadata:
  author: hirefrank
  version: "0.1.0"
compatibility: Requires a deployed Clawpost worker. CLI usage needs `CLAWPOST_BASE_URL` and `CLAWPOST_API_KEY`. Inbox/alias admin also needs the worker configured with Cloudflare API bindings.
---

# Clawpost

Email tools for AI agents via CLI or MCP. All messages go through a sender approval system — only approved senders' messages are visible to query tools.

## Preferred Surface

- Use the `clawpost` CLI when you want a repo-independent operator flow, shell scripting, or `--json` output for agents.
- Use MCP when Clawpost is already connected as a tool server and direct tool calls are the shortest path.
- Keep normal operations HTTP-backed. Do not rely on repo-local `wrangler` or direct D1 access for routine mailbox work.

CLI bootstrap:

```bash
export CLAWPOST_BASE_URL="https://<your-worker>.workers.dev"
export CLAWPOST_API_KEY="..."
clawpost --json message list --limit 10
```

## Sender Approval (Important)

Inbound emails default to unapproved. You must approve senders before their messages appear.

1. Call `list_pending` to see unapproved messages (returns metadata only — sender, subject, timestamp, no body content)
2. Call `approve_sender` with the sender's email to allowlist them — this retroactively approves all their existing messages
3. Future emails from that sender are auto-approved

Outbound messages (sent by you) are always approved.

## CLI Surface

The CLI covers the operational mailbox surface:

- `clawpost send`
- `clawpost message list|get|search|reply|label-add|label-remove|archive|unarchive`
- `clawpost attachment get`
- `clawpost thread list|get`
- `clawpost draft list|get|create|update|send|delete`
- `clawpost sender pending|list|approve|remove`
- `clawpost inbox list|get|create|update|delete`
- `clawpost alias list|get|create|update|delete`

## Sending Email

Use `send_email` for new messages:

```
send_email(to: "alice@example.com", subject: "Hello", body: "Message text")
```

Supports `cc`, `bcc`, and `attachments` (base64 content + filename, or an existing `attachment_id` to forward).

CLI supports multiple recipients: `clawpost send --to a@example.com --to b@example.com --subject "Hello" --body "text"`.

Body input accepts `--body`, `--body-file`, or piped stdin.

## Replying

Use `reply_to_message` with the message `id` (not the email Message-ID). Threading headers (In-Reply-To, References) are set automatically:

```
reply_to_message(id: "uuid-of-message", body: "Reply text")
```

## Reading Email

- `list_messages` — paginated list, filterable by `direction`, `from`, `to`, and `label`
- `read_message` — full message with attachment metadata and labels
- `search_messages` — search by subject or body text
- `list_threads` — conversation threads sorted by most recent activity
- `get_thread` — read a thread with all its approved messages

## Attachments

- `get_attachment` returns base64-encoded content + metadata
- To forward an attachment, pass its `attachment_id` in the `attachments` array of `send_email` or `reply_to_message`
- To attach new content, pass `content` (base64) + `filename`

## Managing Senders

- `list_approved_senders` — see the current allowlist
- `approve_sender` — add a sender (retroactively approves their messages)
- `remove_sender` — remove from allowlist (does not unapprove already-approved messages)

## Inboxes And Aliases

Clawpost now has two Cloudflare-backed admin resources:

- `inbox` — a managed address whose mail is stored in Clawpost
- `alias` — a managed address whose mail is forwarded to one or more validated destination addresses

CLI examples:

```bash
clawpost inbox create quinn@hirefrank.com
clawpost alias create sh@hirefrank.com --to fcharris@gmail.com --to nellwyn.thomas@gmail.com
clawpost alias update <id> --to new@example.com --to second@example.com  # replaces all destinations
clawpost alias update <id> --add-to extra@example.com                    # adds without replacing
clawpost alias update <id> --remove-to old@example.com                   # removes one destination
clawpost inbox delete <id>
```

Important Cloudflare constraints:

1. Destination addresses are account-level and must be validated through Cloudflare's verification email.
2. Cloudflare's native routing rules only support one direct destination per custom address. Multi-recipient aliases must route to the Worker, and the Worker fans out the message.
3. This repo intentionally does not manage domain onboarding. Domains are expected to already exist in the target Cloudflare account.

## Implementation Rules

- Keep the CLI HTTP-backed and repo-independent.
- Prefer `--json` friendly outputs for automation.
- When adding new mailbox features, expose them through the REST API first, then add CLI coverage.
- Avoid `wrangler` subprocesses for production admin flows.
