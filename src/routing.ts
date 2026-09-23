import { EmailMessage } from "cloudflare:email";
import { type Kysely } from "kysely";
import { getClawpostAllowedDomains } from "./config";
import type {
  Alias,
  AliasDestination,
  Database,
  Inbox,
} from "./db/schema";
import {
  createWorkerRoute,
  deleteWorkerRoute,
  ensureDestinationAddresses,
  ensureEmailRoutingEnabled,
  getDestinationStatus,
  getRuleMatchedEmail,
  getWorkerName,
  getZoneIdByDomain,
  listRoutingRules,
  ruleTargetsWorker,
  updateWorkerRoute,
} from "./cloudflare";
import type { Env } from "./types";

export interface InboxRecord {
  inbox: Inbox;
}

export interface AliasRecord {
  alias: Alias;
  destinations: AliasDestination[];
}

export interface DiscoveredRoute {
  email: string;
  local_part: string;
  domain: string;
  enabled: boolean;
  name: string | null;
  cf_zone_id: string;
  cf_rule_id: string;
  inferred_kind: "inbox" | "alias" | "unknown";
  managed_as: "inbox" | "alias" | null;
  importable: boolean;
  drifted: boolean;
}

export interface CreateInboxInput {
  email: string;
  enabled?: boolean;
}

export interface UpdateInboxInput {
  email?: string;
  enabled?: boolean;
}

export interface CreateAliasInput {
  source: string;
  destinations: string[];
  enabled?: boolean;
}

export interface UpdateAliasInput {
  source?: string;
  destinations?: string[];
  enabled?: boolean;
}

export function normalizeEmailAddress(value: string): string {
  return value.trim().toLowerCase();
}

export function getAllowedDomains(env: Env): string[] {
  return [...new Set(
    getClawpostAllowedDomains(env)
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean)
  )];
}

export function splitEmailAddress(value: string): {
  email: string;
  localPart: string;
  domain: string;
} {
  const email = normalizeEmailAddress(value);
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) {
    throw new Error(`Invalid email address: ${value}`);
  }
  return {
    email,
    localPart: email.slice(0, at),
    domain: email.slice(at + 1),
  };
}

function uniqueEmails(values: string[]): string[] {
  return [...new Set(values.map(normalizeEmailAddress).filter(Boolean))];
}

function assertAllowedDomain(env: Env, domain: string) {
  const normalizedDomain = domain.trim().toLowerCase();
  const allowedDomains = getAllowedDomains(env);
  if (allowedDomains.length === 0) {
    return;
  }

  if (!allowedDomains.includes(normalizedDomain)) {
    throw new Error(
      `Domain ${normalizedDomain} is not allowed. Set CLAWPOST_ALLOWED_DOMAINS to include it.`
    );
  }
}

function getDiscoveryDomains(env: Env, domain?: string): string[] {
  if (domain) {
    const normalizedDomain = domain.trim().toLowerCase();
    if (!normalizedDomain) {
      throw new Error("Domain is required for routing discovery");
    }
    assertAllowedDomain(env, normalizedDomain);
    return [normalizedDomain];
  }

  const allowedDomains = getAllowedDomains(env);
  if (allowedDomains.length === 0) {
    throw new Error(
      "Provide a domain or set CLAWPOST_ALLOWED_DOMAINS to discover Cloudflare routes"
    );
  }

  return allowedDomains;
}

function assertAliasFanoutSupport(env: Env, destinations: string[]) {
  if (uniqueEmails(destinations).length > 1 && !env.EMAIL) {
    throw new Error(
      "Multi-destination aliases require the EMAIL binding for Worker fan-out"
    );
  }
}

async function ensureRouteAvailability(
  db: Kysely<Database>,
  email: string,
  exclude?: { inboxId?: string; aliasId?: string }
) {
  const inbox = await db
    .selectFrom("inboxes")
    .select("id")
    .where("email", "=", email)
    .executeTakeFirst();
  if (inbox && inbox.id !== exclude?.inboxId) {
    throw new Error(`Inbox already exists for ${email}`);
  }

  const alias = await db
    .selectFrom("aliases")
    .select("id")
    .where("source_email", "=", email)
    .executeTakeFirst();
  if (alias && alias.id !== exclude?.aliasId) {
    throw new Error(`Alias already exists for ${email}`);
  }
}

function inboxRuleName(email: string): string {
  return `Clawpost inbox ${email}`;
}

function aliasRuleName(email: string): string {
  return `Clawpost alias ${email}`;
}

function inferRouteKind(name?: string | null): "inbox" | "alias" | "unknown" {
  const normalized = name?.trim().toLowerCase() ?? "";
  if (normalized.startsWith("clawpost inbox ")) {
    return "inbox";
  }
  if (normalized.startsWith("clawpost alias ")) {
    return "alias";
  }
  return "unknown";
}

async function ensureCloudflareRouteAvailability(
  env: Env,
  zoneId: string,
  email: string,
  excludeRuleId?: string | null
) {
  const normalizedEmail = normalizeEmailAddress(email);
  const rules = await listRoutingRules(env, zoneId);
  const conflict = rules.find(
    (rule) =>
      getRuleMatchedEmail(rule) === normalizedEmail &&
      rule.id !== excludeRuleId
  );

  if (!conflict) {
    return;
  }

  throw new Error(
    conflict.name
      ? `Cloudflare routing rule already exists for ${normalizedEmail} (${conflict.name})`
      : `Cloudflare routing rule already exists for ${normalizedEmail}`
  );
}

async function findImportableWorkerRoute(
  env: Env,
  email: string
): Promise<{ zoneId: string; ruleId: string; enabled: boolean; name: string | null }> {
  const parsed = splitEmailAddress(email);
  const zoneId = await getZoneIdByDomain(env, parsed.domain);
  const rules = await listRoutingRules(env, zoneId);
  const exactMatches = rules.filter(
    (rule) => getRuleMatchedEmail(rule) === parsed.email
  );
  const workerMatch = exactMatches.find((rule) =>
    ruleTargetsWorker(rule, getWorkerName(env))
  );

  if (exactMatches.length === 0) {
    throw new Error(`No Cloudflare Email Routing rule exists for ${parsed.email}`);
  }

  if (!workerMatch) {
    throw new Error(
      `Cloudflare rule for ${parsed.email} does not target worker ${getWorkerName(env)} and cannot be imported`
    );
  }

  return {
    zoneId,
    ruleId: workerMatch.id,
    enabled: workerMatch.enabled !== false,
    name: workerMatch.name ?? null,
  };
}

async function createOrUpdateWorkerRoute(params: {
  env: Env;
  domain: string;
  email: string;
  enabled: boolean;
  existingZoneId?: string | null;
  existingRuleId?: string | null;
  previousDomain?: string | null;
  name: string;
}) {
  const {
    env,
    domain,
    email,
    enabled,
    existingZoneId,
    existingRuleId,
    previousDomain,
    name,
  } = params;

  const zoneId = await getZoneIdByDomain(env, domain);
  await ensureCloudflareRouteAvailability(env, zoneId, email, existingRuleId);
  await ensureEmailRoutingEnabled(env, zoneId);

  if (existingRuleId && existingZoneId && previousDomain === domain) {
    const updated = await updateWorkerRoute(
      env,
      existingZoneId,
      existingRuleId,
      email,
      enabled,
      name
    );
    return { zoneId: existingZoneId, ruleId: updated.id };
  }

  if (existingRuleId && existingZoneId) {
    await deleteWorkerRoute(env, existingZoneId, existingRuleId);
  }

  const created = await createWorkerRoute(env, zoneId, email, enabled, name);
  return { zoneId, ruleId: created.id };
}

export async function listInboxes(db: Kysely<Database>): Promise<Inbox[]> {
  return db.selectFrom("inboxes").selectAll().orderBy("email", "asc").execute();
}

export async function getInbox(
  db: Kysely<Database>,
  id: string
): Promise<Inbox | undefined> {
  return db
    .selectFrom("inboxes")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst();
}

export async function findEnabledInboxByEmail(
  db: Kysely<Database>,
  email: string
): Promise<Inbox | undefined> {
  return db
    .selectFrom("inboxes")
    .selectAll()
    .where("email", "=", normalizeEmailAddress(email))
    .where("enabled", "=", 1)
    .executeTakeFirst();
}

export async function createInbox(
  env: Env,
  db: Kysely<Database>,
  input: CreateInboxInput
): Promise<InboxRecord> {
  const parsed = splitEmailAddress(input.email);
  assertAllowedDomain(env, parsed.domain);
  await ensureRouteAvailability(db, parsed.email);

  const synced = await createOrUpdateWorkerRoute({
    env,
    domain: parsed.domain,
    email: parsed.email,
    enabled: input.enabled ?? true,
    name: inboxRuleName(parsed.email),
  });

  const now = Date.now();
  const id = crypto.randomUUID();

  try {
    await db
      .insertInto("inboxes")
      .values({
        id,
        email: parsed.email,
        local_part: parsed.localPart,
        domain: parsed.domain,
        enabled: input.enabled === false ? 0 : 1,
        cf_zone_id: synced.zoneId,
        cf_rule_id: synced.ruleId,
        created_at: now,
        updated_at: now,
      })
      .execute();
  } catch (error) {
    await deleteWorkerRoute(env, synced.zoneId, synced.ruleId).catch(() => {});
    throw error;
  }

  const inbox = await getInbox(db, id);
  if (!inbox) {
    throw new Error("Failed to create inbox");
  }

  return { inbox };
}

export async function updateInbox(
  env: Env,
  db: Kysely<Database>,
  id: string,
  input: UpdateInboxInput
): Promise<InboxRecord | null> {
  const existing = await getInbox(db, id);
  if (!existing) return null;

  const nextEmail = input.email ? splitEmailAddress(input.email) : splitEmailAddress(existing.email);
  if (input.email) {
    assertAllowedDomain(env, nextEmail.domain);
  }
  await ensureRouteAvailability(db, nextEmail.email, { inboxId: id });

  const enabled = input.enabled ?? existing.enabled === 1;
  const synced = await createOrUpdateWorkerRoute({
    env,
    domain: nextEmail.domain,
    email: nextEmail.email,
    enabled,
    existingZoneId: existing.cf_zone_id,
    existingRuleId: existing.cf_rule_id,
    previousDomain: existing.domain,
    name: inboxRuleName(nextEmail.email),
  });

  try {
    await db
      .updateTable("inboxes")
      .set({
        email: nextEmail.email,
        local_part: nextEmail.localPart,
        domain: nextEmail.domain,
        enabled: enabled ? 1 : 0,
        cf_zone_id: synced.zoneId,
        cf_rule_id: synced.ruleId,
        updated_at: Date.now(),
      })
      .where("id", "=", id)
      .execute();
  } catch (error) {
    let restoredRoute: { zoneId: string; ruleId: string } | null = null;

    if (existing.cf_zone_id && existing.cf_rule_id) {
      restoredRoute = await createOrUpdateWorkerRoute({
        env,
        domain: existing.domain,
        email: existing.email,
        enabled: existing.enabled === 1,
        existingZoneId: synced.zoneId,
        existingRuleId: synced.ruleId,
        previousDomain: nextEmail.domain,
        name: inboxRuleName(existing.email),
      }).catch(() => null);
    } else {
      await deleteWorkerRoute(env, synced.zoneId, synced.ruleId).catch(() => {});
    }

    if (
      restoredRoute &&
      (
        restoredRoute.zoneId !== existing.cf_zone_id ||
        restoredRoute.ruleId !== existing.cf_rule_id
      )
    ) {
      await db
        .updateTable("inboxes")
        .set({
          cf_zone_id: restoredRoute.zoneId,
          cf_rule_id: restoredRoute.ruleId,
          updated_at: existing.updated_at,
        })
        .where("id", "=", id)
        .execute()
        .catch(() => {});
    }

    throw error;
  }

  const inbox = await getInbox(db, id);
  if (!inbox) {
    throw new Error("Failed to load updated inbox");
  }

  return { inbox };
}

export async function deleteInbox(
  env: Env,
  db: Kysely<Database>,
  id: string
): Promise<Inbox | null> {
  const existing = await getInbox(db, id);
  if (!existing) return null;

  if (existing.cf_zone_id && existing.cf_rule_id) {
    await deleteWorkerRoute(env, existing.cf_zone_id, existing.cf_rule_id);
  }

  try {
    await db.deleteFrom("inboxes").where("id", "=", id).execute();
  } catch (error) {
    if (existing.cf_zone_id && existing.cf_rule_id) {
      const restoredRoute = await createOrUpdateWorkerRoute({
        env,
        domain: existing.domain,
        email: existing.email,
        enabled: existing.enabled === 1,
        name: inboxRuleName(existing.email),
      }).catch(() => null);

      if (restoredRoute) {
        await db
          .updateTable("inboxes")
          .set({
            cf_zone_id: restoredRoute.zoneId,
            cf_rule_id: restoredRoute.ruleId,
            updated_at: Date.now(),
          })
          .where("id", "=", id)
          .execute()
          .catch(() => {});
      }
    }

    throw error;
  }
  return existing;
}

export async function listAliases(db: Kysely<Database>): Promise<AliasRecord[]> {
  const aliases = await db
    .selectFrom("aliases")
    .selectAll()
    .orderBy("source_email", "asc")
    .execute();

  const destinationRows = await db
    .selectFrom("alias_destinations")
    .selectAll()
    .orderBy("destination_email", "asc")
    .execute();

  return aliases.map((alias) => ({
    alias,
    destinations: destinationRows.filter((row) => row.alias_id === alias.id),
  }));
}

export async function getAlias(
  db: Kysely<Database>,
  id: string
): Promise<AliasRecord | undefined> {
  const alias = await db
    .selectFrom("aliases")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst();

  if (!alias) return undefined;

  const destinations = await db
    .selectFrom("alias_destinations")
    .selectAll()
    .where("alias_id", "=", id)
    .orderBy("destination_email", "asc")
    .execute();

  return { alias, destinations };
}

export async function findEnabledAliasBySource(
  db: Kysely<Database>,
  email: string
): Promise<AliasRecord | undefined> {
  const alias = await db
    .selectFrom("aliases")
    .selectAll()
    .where("source_email", "=", normalizeEmailAddress(email))
    .where("enabled", "=", 1)
    .executeTakeFirst();

  if (!alias) return undefined;

  const destinations = await db
    .selectFrom("alias_destinations")
    .selectAll()
    .where("alias_id", "=", alias.id)
    .orderBy("destination_email", "asc")
    .execute();

  return { alias, destinations };
}

async function replaceAliasDestinations(
  env: Env,
  db: Kysely<Database>,
  aliasId: string,
  destinations: string[]
) {
  const unique = uniqueEmails(destinations);
  assertAliasFanoutSupport(env, unique);
  if (unique.length === 0) {
    throw new Error("Alias requires at least one destination");
  }

  const cloudflareAddresses = await ensureDestinationAddresses(env, unique);
  const byEmail = new Map(
    cloudflareAddresses.map((address) => [normalizeEmailAddress(address.email), address])
  );

  await db.deleteFrom("alias_destinations").where("alias_id", "=", aliasId).execute();

  const now = Date.now();
  if (unique.length > 0) {
    await db
      .insertInto("alias_destinations")
      .values(
        unique.map((email) => {
          const cloudflareAddress = byEmail.get(email);
          return {
            id: crypto.randomUUID(),
            alias_id: aliasId,
            destination_email: email,
            cf_destination_id: cloudflareAddress?.id ?? null,
            status: cloudflareAddress ? getDestinationStatus(cloudflareAddress) : "unknown",
            created_at: now,
            updated_at: now,
          };
        })
      )
      .execute();
  }
}

export async function createAlias(
  env: Env,
  db: Kysely<Database>,
  input: CreateAliasInput
): Promise<AliasRecord> {
  const parsed = splitEmailAddress(input.source);
  assertAllowedDomain(env, parsed.domain);
  await ensureRouteAvailability(db, parsed.email);
  assertAliasFanoutSupport(env, input.destinations);

  const synced = await createOrUpdateWorkerRoute({
    env,
    domain: parsed.domain,
    email: parsed.email,
    enabled: input.enabled ?? true,
    name: aliasRuleName(parsed.email),
  });

  const now = Date.now();
  const id = crypto.randomUUID();
  await db
    .insertInto("aliases")
    .values({
      id,
      source_email: parsed.email,
      local_part: parsed.localPart,
      domain: parsed.domain,
      enabled: input.enabled === false ? 0 : 1,
      cf_zone_id: synced.zoneId,
      cf_rule_id: synced.ruleId,
      created_at: now,
      updated_at: now,
    })
    .execute();

  try {
    await replaceAliasDestinations(env, db, id, input.destinations);
  } catch (error) {
    // Roll back the alias row and Cloudflare rule so retries don't collide
    // with partially-created state.
    await db.deleteFrom("aliases").where("id", "=", id).execute();
    await deleteWorkerRoute(env, synced.zoneId, synced.ruleId).catch(() => {});
    throw error;
  }

  const alias = await getAlias(db, id);
  if (!alias) {
    throw new Error("Failed to create alias");
  }

  return alias;
}

export async function updateAlias(
  env: Env,
  db: Kysely<Database>,
  id: string,
  input: UpdateAliasInput
): Promise<AliasRecord | null> {
  const existing = await getAlias(db, id);
  if (!existing) return null;

  const nextSource = input.source
    ? splitEmailAddress(input.source)
    : splitEmailAddress(existing.alias.source_email);
  if (input.source) {
    assertAllowedDomain(env, nextSource.domain);
  }
  await ensureRouteAvailability(db, nextSource.email, { aliasId: id });
  if (input.destinations) {
    assertAliasFanoutSupport(env, input.destinations);
  }

  const enabled = input.enabled ?? existing.alias.enabled === 1;
  const synced = await createOrUpdateWorkerRoute({
    env,
    domain: nextSource.domain,
    email: nextSource.email,
    enabled,
    existingZoneId: existing.alias.cf_zone_id,
    existingRuleId: existing.alias.cf_rule_id,
    previousDomain: existing.alias.domain,
    name: aliasRuleName(nextSource.email),
  });

  const updateTimestamp = Date.now();
  await db
    .updateTable("aliases")
    .set({
      source_email: nextSource.email,
      local_part: nextSource.localPart,
      domain: nextSource.domain,
      enabled: enabled ? 1 : 0,
      cf_zone_id: synced.zoneId,
      cf_rule_id: synced.ruleId,
      updated_at: updateTimestamp,
    })
    .where("id", "=", id)
    .execute();

  if (input.destinations) {
    try {
      await replaceAliasDestinations(env, db, id, input.destinations);
    } catch (error) {
      // Restore the alias row to its previous state so the caller sees an
      // error without the alias being stranded in a mixed configuration.
      await db
        .updateTable("aliases")
        .set({
          source_email: existing.alias.source_email,
          local_part: existing.alias.local_part,
          domain: existing.alias.domain,
          enabled: existing.alias.enabled,
          cf_zone_id: existing.alias.cf_zone_id,
          cf_rule_id: existing.alias.cf_rule_id,
          updated_at: existing.alias.updated_at,
        })
        .where("id", "=", id)
        .execute();
      // Restore the previous destination rows — replaceAliasDestinations
      // deletes old rows before inserting, so they may be gone at this point.
      await db.deleteFrom("alias_destinations").where("alias_id", "=", id).execute();
      if (existing.destinations.length > 0) {
        await db
          .insertInto("alias_destinations")
          .values(
            existing.destinations.map((d) => ({
              id: d.id,
              alias_id: d.alias_id,
              destination_email: d.destination_email,
              cf_destination_id: d.cf_destination_id,
              status: d.status,
              created_at: d.created_at,
              updated_at: d.updated_at,
            }))
          )
          .execute();
      }
      // Best-effort: restore the Cloudflare rule to previous state
      if (existing.alias.cf_zone_id && existing.alias.cf_rule_id) {
        await createOrUpdateWorkerRoute({
          env,
          domain: existing.alias.domain,
          email: existing.alias.source_email,
          enabled: existing.alias.enabled === 1,
          existingZoneId: synced.zoneId,
          existingRuleId: synced.ruleId,
          previousDomain: nextSource.domain,
          name: aliasRuleName(existing.alias.source_email),
        }).catch(() => {});
      }
      throw error;
    }
  }

  const alias = await getAlias(db, id);
  if (!alias) {
    throw new Error("Failed to load updated alias");
  }

  return alias;
}

export async function deleteAlias(
  env: Env,
  db: Kysely<Database>,
  id: string
): Promise<AliasRecord | null> {
  const existing = await getAlias(db, id);
  if (!existing) return null;

  if (existing.alias.cf_zone_id && existing.alias.cf_rule_id) {
    await deleteWorkerRoute(env, existing.alias.cf_zone_id, existing.alias.cf_rule_id);
  }

  await db.deleteFrom("alias_destinations").where("alias_id", "=", id).execute();
  await db.deleteFrom("aliases").where("id", "=", id).execute();
  return existing;
}

export async function discoverRoutingRules(
  env: Env,
  db: Kysely<Database>,
  domain?: string
): Promise<DiscoveredRoute[]> {
  const domains = getDiscoveryDomains(env, domain);
  const inboxes = await db
    .selectFrom("inboxes")
    .select(["email", "cf_zone_id", "cf_rule_id"])
    .execute();
  const aliases = await db
    .selectFrom("aliases")
    .select(["source_email", "cf_zone_id", "cf_rule_id"])
    .execute();

  const discovered: DiscoveredRoute[] = [];

  for (const currentDomain of domains) {
    const zoneId = await getZoneIdByDomain(env, currentDomain);
    const rules = await listRoutingRules(env, zoneId);

    for (const rule of rules) {
      const email = getRuleMatchedEmail(rule);
      if (!email || !ruleTargetsWorker(rule, getWorkerName(env))) {
        continue;
      }

      const parsed = splitEmailAddress(email);
      if (parsed.domain !== currentDomain) {
        continue;
      }

      const managedInbox = inboxes.find((entry) => entry.email === parsed.email);
      const managedAlias = aliases.find(
        (entry) => entry.source_email === parsed.email
      );
      const managedAs = managedInbox ? "inbox" : managedAlias ? "alias" : null;
      const managedRule = managedInbox ?? managedAlias ?? null;

      discovered.push({
        email: parsed.email,
        local_part: parsed.localPart,
        domain: parsed.domain,
        enabled: rule.enabled !== false,
        name: rule.name ?? null,
        cf_zone_id: zoneId,
        cf_rule_id: rule.id,
        inferred_kind: inferRouteKind(rule.name),
        managed_as: managedAs,
        importable: managedAs === null,
        drifted: Boolean(
          managedRule &&
          (
            managedRule.cf_zone_id !== zoneId ||
            managedRule.cf_rule_id !== rule.id
          )
        ),
      });
    }
  }

  return discovered.sort((a, b) => a.email.localeCompare(b.email));
}

export async function importInbox(
  env: Env,
  db: Kysely<Database>,
  input: CreateInboxInput
): Promise<InboxRecord> {
  const parsed = splitEmailAddress(input.email);
  assertAllowedDomain(env, parsed.domain);
  await ensureRouteAvailability(db, parsed.email);

  const matched = await findImportableWorkerRoute(env, parsed.email);
  const now = Date.now();
  const id = crypto.randomUUID();

  await db
    .insertInto("inboxes")
    .values({
      id,
      email: parsed.email,
      local_part: parsed.localPart,
      domain: parsed.domain,
      enabled: matched.enabled ? 1 : 0,
      cf_zone_id: matched.zoneId,
      cf_rule_id: matched.ruleId,
      created_at: now,
      updated_at: now,
    })
    .execute();

  const inbox = await getInbox(db, id);
  if (!inbox) {
    throw new Error("Failed to import inbox");
  }

  return { inbox };
}

export async function importAlias(
  env: Env,
  db: Kysely<Database>,
  input: CreateAliasInput
): Promise<AliasRecord> {
  const parsed = splitEmailAddress(input.source);
  assertAllowedDomain(env, parsed.domain);
  await ensureRouteAvailability(db, parsed.email);
  assertAliasFanoutSupport(env, input.destinations);

  const matched = await findImportableWorkerRoute(env, parsed.email);
  const now = Date.now();
  const id = crypto.randomUUID();

  await db
    .insertInto("aliases")
    .values({
      id,
      source_email: parsed.email,
      local_part: parsed.localPart,
      domain: parsed.domain,
      enabled: matched.enabled ? 1 : 0,
      cf_zone_id: matched.zoneId,
      cf_rule_id: matched.ruleId,
      created_at: now,
      updated_at: now,
    })
    .execute();

  try {
    await replaceAliasDestinations(env, db, id, input.destinations);
  } catch (error) {
    await db.deleteFrom("aliases").where("id", "=", id).execute();
    throw error;
  }

  const alias = await getAlias(db, id);
  if (!alias) {
    throw new Error("Failed to import alias");
  }

  return alias;
}

async function streamToArrayBuffer(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalLength = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    totalLength += value.length;
  }

  const combined = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }

  return combined.buffer;
}

function arrayBufferToStream(buffer: ArrayBuffer): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(buffer));
      controller.close();
    },
  });
}

export async function forwardAliasMessage(
  message: ForwardableEmailMessage,
  env: Env,
  alias: AliasRecord
) {
  if (alias.destinations.length === 0) {
    throw new Error(`Alias ${alias.alias.source_email} has no destinations`);
  }

  const [first, ...rest] = alias.destinations;

  if (rest.length === 0) {
    await message.forward(first.destination_email);
    return;
  }

  if (!env.EMAIL) {
    throw new Error(
      "Additional alias destinations require the EMAIL binding for fan-out forwarding"
    );
  }

  // Buffer the raw stream before any forwarding — it is single-consumer,
  // so reading it after message.forward() would yield an empty payload.
  const rawBuffer = await streamToArrayBuffer(message.raw);

  // Forward to first destination using the EMAIL binding (same path as the
  // rest) so we never consume the stream before buffering.
  for (const destination of [first, ...rest]) {
    const forwarded = new EmailMessage(
      alias.alias.source_email,
      destination.destination_email,
      arrayBufferToStream(rawBuffer)
    );
    await env.EMAIL.send(forwarded as any);
  }
}
