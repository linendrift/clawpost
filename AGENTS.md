# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
bun run dev          # wrangler dev --remote (requires wrangler.toml with real IDs)
bun run deploy       # wrangler deploy
bun run db:migrate   # wrangler d1 migrations apply DB --remote
bun run typecheck    # tsc --noEmit (no tests yet)
bun run cli          # run CLI from source: bun run ./src/cli/index.ts
bun run build:cli    # bundle CLI to dist/clawpost.js for Node
```

## Architecture

Cloudflare Worker with three surfaces: HTTP API (Hono), MCP server (Durable Object), and inbound email handler. All defined in `src/index.ts`.

**Request routing in `src/index.ts`:**
- `/mcp` → Bearer token auth → `EmailMCP.serve()` (Durable Object)
- Everything else → Hono app (`src/api.ts`) which handles `/api/*` with `X-API-Key` auth and `/webhooks/*` unauthenticated

**Standalone CLI (`src/cli/`):** HTTP-backed, repo-independent. Talks to the deployed Worker via `CLAWPOST_BASE_URL` and `CLAWPOST_API_KEY`. Commander.js with `--json` for machine output. Body input accepts `--body`, `--body-file`, or piped stdin.

**Data flow:**
- Inbound email (`src/email.ts`): checks alias table first (forward if matched), then inbox table (store if matched), then rejects if the domain is managed but the address isn't, otherwise stores as catch-all. Parsed via `postal-mime` → D1 + R2 → webhook dispatch
- Outbound email (`src/mail.ts`): sends via Cloudflare Email Service (default) or Resend → stores in D1 with `approved=1` and `status='sent'`, attachments in R2
- Email provider selection: set `EMAIL_PROVIDER` var to `"cloudflare"` or `"resend"`, or omit to auto-detect (prefers Cloudflare `EMAIL` binding, falls back to `RESEND_API_KEY`)
- Per-provider sender config: `FROM_EMAIL`/`FROM_NAME` required; `REPLY_TO_EMAIL` optional. Set `RESEND_FROM_EMAIL`/`RESEND_FROM_NAME`/`RESEND_REPLY_TO_EMAIL` to override when Resend uses a different sending domain
- Both API routes and MCP tools call shared service functions: `src/mail.ts` (send/reply), `src/labels.ts`, `src/archive.ts`, `src/search.ts`, `src/drafts.ts`

**Routing system (`src/routing.ts` + `src/cloudflare.ts`):** Manages Cloudflare Email Routing rules for inboxes (store mail) and aliases (forward mail). Two-phase operations: sync Cloudflare first, then DB, with rollback on failure. Requires `CF_API_TOKEN` and `CF_ACCOUNT_ID`.
- Inboxes: CRUD with Cloudflare rule sync and rollback safety on create/update/delete
- Aliases: CRUD with multi-destination support; fan-out via Worker `EMAIL` binding; destination rows and CF rule rolled back on failure
- Discovery: `discoverRoutingRules()` scans Cloudflare zones for existing rules targeting the Worker
- Import: `importInbox()`/`importAlias()` adopt existing Cloudflare rules into Clawpost DB
- Domain guard: `ALLOWED_DOMAINS` env var (comma-separated) validated on create, import, and discovery. If unset, no restriction.

**MCP server (`src/mcp.ts`):** `McpAgent` Durable Object with `McpServer`. Tools registered in `init()` using `this.server.registerTool()` with Zod schemas. MCP does not expose inbox/alias admin tools — those are CLI/API only.

**Database:** Kysely over D1 via `kysely-d1`. Schema types in `src/db/schema.ts`, factory in `src/db/client.ts`. Use `sql` template tag from Kysely for raw expressions (e.g., `sql\`message_count + 1\``), not `db.raw()`.

**Full-text search:** `messages_fts` FTS5 virtual table synced via SQLite triggers. Search endpoints try FTS5 MATCH first and fall back to LIKE on invalid query syntax.

## Key Patterns

- `Env` interface in `src/types.ts` defines all Worker bindings — update it when adding new bindings to `wrangler.toml`
- Auth is timing-safe comparison via `crypto.subtle.timingSafeEqual` in both API middleware and MCP routing
- Threading: messages link to threads via `thread_id`; inbound emails match existing threads by looking up `In-Reply-To` and `References` against `messages.message_id`
- Attachments support two input modes: inline base64 (`content` + `filename`) or R2 reference (`attachment_id` to forward an existing attachment)
- R2 keys follow `{messageId}/{attachmentId}/{filename}` pattern
- All timestamps are Unix milliseconds (`Date.now()`)
- `wrangler.toml` is committed with placeholder values (for Deploy to Cloudflare button). Local changes are hidden via `git update-index --assume-unchanged wrangler.toml`. To edit the committed version: `git update-index --no-assume-unchanged wrangler.toml`
- **Sender approval (anti-injection):** All query routes/tools filter `approved=1` by default. `list_pending` returns metadata only (no body/html) to prevent prompt injection during review. `approve_sender` allowlists + retroactively approves. Sender emails are normalized to lowercase everywhere.
- **Labels:** Stored in `message_labels` junction table (composite PK: message_id + label). Use `onConflict(...).doNothing()` when adding labels to handle duplicates.
- **Archival:** `archived` column on messages (default 0). All list/search queries exclude archived messages unless `include_archived` is explicitly set.
- **Drafts:** Separate `drafts` table with full CRUD. `send_draft` converts to a real email via `sendEmail()` (with threading headers if `thread_id` is set) and deletes the draft.
- **Delivery status:** `status` column on messages (`null` for inbound, `sent`/`delivered`/`bounced`/`complained` for outbound). Updated via Resend webhook at `/webhooks/resend`.
- **Webhooks:** `src/webhooks.ts` dispatches HMAC-signed POSTs. Called from `email.ts` via `ctx.waitUntil()` to avoid blocking the email handler.
- **Routing rollback safety:** Inbox and alias mutations are two-phase (Cloudflare then DB). On failure, the catch block rolls back Cloudflare state and (for alias updates) restores previous destination rows from a snapshot taken at the start of the operation.
- **Cloudflare duplicate detection:** `createOrUpdateWorkerRoute()` lists existing rules for the zone and rejects conflicting matchers before creating or updating.
- **Alias fan-out:** Multi-destination aliases buffer `message.raw` into an ArrayBuffer before forwarding, so the single-consumer stream is not consumed before all destinations are served. Single-destination aliases short-circuit with `message.forward()`.
