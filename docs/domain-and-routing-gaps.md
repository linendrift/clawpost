# Domain and Routing Gap Review

Captured 2026-04-01 during CLI/routing review.

## 1. Duplicate inbox/alias creation (FIXED)

`ensureRouteAvailability` (src/routing.ts) already checked the Clawpost DB before creating an inbox or alias, so Clawpost-side duplicates were rejected with a 400.

That only covered Clawpost's own tables. If Cloudflare routing rules were created outside Clawpost (e.g. via the dashboard or another tool), Clawpost didn't know about them. Creating an inbox for an address that already had a Cloudflare rule could silently create a duplicate rule or produce an opaque Cloudflare API error.

**Fix:** `createOrUpdateWorkerRoute()` now lists exact-address rules for the zone and rejects any conflicting Cloudflare matcher before mutating the rule.

## 2. No import for existing routing rules (FIXED)

If a user already had Cloudflare Email Routing rules configured, there was no way to adopt them into Clawpost. The only path was to delete the old rule and re-create it through Clawpost.

**Fix:** Clawpost now has `routing discover`, `inbox import`, and `alias import` flows through the API and CLI. Discovery is scoped to exact-address Cloudflare rules that already target the configured worker, which is the safe subset Clawpost can adopt without guessing at alias behavior.

## 3. No domain allowlist (FIXED)

The system was implicitly multi-domain. `getZoneIdByDomain` resolved whatever domain appeared in the email address, so any domain in the Cloudflare account could be used. There was no `DOMAIN` or allowlist-style routing configuration.

That meant someone could accidentally create an inbox on the wrong domain and Clawpost would happily create Cloudflare routing rules for it.

**Fix:** `CLAWPOST_ALLOWED_DOMAINS` is now supported as a comma-separated worker var. Clawpost validates create/import operations against it and uses it as the default discovery scope when no `domain` is provided.

## 4. Inbox operations are still best-effort, not rollback-safe (FIXED)

The alias flows already did compensation on failure, but inbox flows still mutated Cloudflare and D1 in a simpler sequence:

- `createInbox()` creates the Cloudflare rule before inserting the DB row
- `updateInbox()` mutates the Cloudflare rule before updating the DB row
- `deleteInbox()` deletes the Cloudflare rule before deleting the DB row

In practice, DB failures after Cloudflare success should be rare, but if they happened, Clawpost could still drift from Cloudflare state and require manual cleanup or recreation.

**Fix:** Inbox create/update/delete now do best-effort compensation:

- `createInbox()` deletes the Cloudflare rule if the DB insert fails
- `updateInbox()` restores the previous Cloudflare rule if the DB update fails
- `deleteInbox()` recreates the rule and updates the stored `cf_rule_id` if the DB delete fails after Cloudflare deletion

This closes the inbox consistency gap that aliases had already moved past.

## 5. Multi-recipient alias fan-out consumed the stream before buffering (FIXED)

`forwardAliasMessage()` called `message.forward()` for the first destination before buffering `message.raw`. Since the inbound body is a single-consumer stream, `streamToArrayBuffer(message.raw)` after the forward would fail or produce an empty payload for the remaining destinations.

**Fix:** Buffer `message.raw` first, then send all destinations (including the first) through the `EMAIL` binding so the stream is never consumed before buffering. Single-destination aliases still short-circuit with `message.forward()`.

## 6. Alias creation was not failure-atomic (FIXED)

`createAlias()` created the Cloudflare rule and inserted the alias row before `replaceAliasDestinations()` ran. If destination sync failed, the API returned an error but the alias and rule were already persisted, making retries collide with existing state.

**Fix:** Wrap `replaceAliasDestinations()` in a try/catch that rolls back the alias row and deletes the Cloudflare rule on failure.

## 7. Alias updates were not rollback-safe (FIXED)

`updateAlias()` mutated the Cloudflare rule and alias record before destination replacement. A destination-sync failure left the alias in a mixed old/new configuration.

**Fix:** On destination-sync failure, restore the alias row to its previous values and best-effort restore the Cloudflare rule.

## Scope Note

Import intentionally adopts only exact-address rules that already target the configured worker. Arbitrary dashboard-created forwarding rules still need to be recreated or converted to a worker-routed rule first, because Clawpost cannot safely infer inbox-versus-alias behavior or alias destinations from those direct-forward rules alone.
