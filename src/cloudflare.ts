import {
  getClawpostCloudflareAccountId,
  getClawpostCloudflareApiToken,
  getClawpostCloudflareWorkerName,
} from "./config";
import type { Env } from "./types";

const CF_API_BASE = "https://api.cloudflare.com/client/v4";

interface CloudflareEnvelope<T> {
  success: boolean;
  result: T;
  result_info?: {
    page?: number;
    per_page?: number;
    total_pages?: number;
    total_count?: number;
    count?: number;
  };
  errors?: Array<{ code?: number; message?: string }>;
  messages?: Array<{ code?: number; message?: string }>;
}

interface Zone {
  id: string;
  name: string;
}

interface EmailRoutingSettings {
  enabled?: boolean;
  status?: string;
}

export interface CloudflareDestinationAddress {
  id: string;
  email: string;
  verified?: boolean;
  status?: string;
}

export interface CloudflareMatcher {
  type: string;
  field?: string;
  value?: string;
}

export interface CloudflareAction {
  type: string;
  value: string[];
}

export interface CloudflareRule {
  id: string;
  name?: string;
  enabled?: boolean;
  matchers?: CloudflareMatcher[];
  actions?: CloudflareAction[];
}

function requireCloudflareConfig(env: Env) {
  if (!getClawpostCloudflareApiToken(env)) {
    throw new Error(
      "Cloudflare alias management requires CLAWPOST_CF_API_TOKEN (or legacy CF_API_TOKEN)"
    );
  }
  if (!getClawpostCloudflareAccountId(env)) {
    throw new Error(
      "Cloudflare alias management requires CLAWPOST_CF_ACCOUNT_ID (or legacy CF_ACCOUNT_ID)"
    );
  }
}

async function cfApiEnvelope<T>(
  env: Env,
  path: string,
  init?: RequestInit
): Promise<CloudflareEnvelope<T>> {
  requireCloudflareConfig(env);

  const response = await fetch(`${CF_API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${getClawpostCloudflareApiToken(env)}`,
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });

  const payload = (await response.json()) as CloudflareEnvelope<T>;
  if (response.ok && payload.success) {
    return payload;
  }

  const details = [
    ...(payload.errors ?? []).map((entry) => entry.message).filter(Boolean),
    ...(payload.messages ?? []).map((entry) => entry.message).filter(Boolean),
  ].join("; ");

  throw new Error(
    details || `Cloudflare API request failed (${response.status})`
  );
}

async function cfApi<T>(
  env: Env,
  path: string,
  init?: RequestInit
): Promise<T> {
  const payload = await cfApiEnvelope<T>(env, path, init);
  return payload.result;
}

async function cfApiList<T>(
  env: Env,
  path: string
): Promise<T[]> {
  const results: T[] = [];
  let page = 1;

  while (true) {
    const separator = path.includes("?") ? "&" : "?";
    const payload = await cfApiEnvelope<T[]>(
      env,
      `${path}${separator}page=${page}&per_page=100`
    );
    results.push(...payload.result);

    const totalPages = payload.result_info?.total_pages ?? 1;
    if (page >= totalPages) {
      break;
    }
    page += 1;
  }

  return results;
}

export function getWorkerName(env: Env): string {
  return getClawpostCloudflareWorkerName(env);
}

export function getDestinationStatus(address: CloudflareDestinationAddress): string {
  if (typeof address.status === "string" && address.status.length > 0) {
    return address.status;
  }
  if (address.verified === true) return "verified";
  if (address.verified === false) return "pending";
  return "unknown";
}

export async function getZoneIdByDomain(env: Env, domain: string): Promise<string> {
  const zones = await cfApi<Zone[]>(
    env,
    `/zones?name=${encodeURIComponent(domain)}`
  );
  const zone = zones.find((entry) => entry.name.toLowerCase() === domain.toLowerCase());
  if (!zone) {
    throw new Error(`Cloudflare zone not found for ${domain}`);
  }
  return zone.id;
}

export async function ensureEmailRoutingEnabled(
  env: Env,
  zoneId: string
): Promise<EmailRoutingSettings> {
  const settings = await cfApi<EmailRoutingSettings>(
    env,
    `/zones/${zoneId}/email/routing`
  );

  if (settings.enabled && settings.status === "ready") {
    return settings;
  }

  await cfApi<Record<string, unknown>>(env, `/zones/${zoneId}/email/routing/dns`, {
    method: "POST",
    body: JSON.stringify({}),
  });

  return cfApi<EmailRoutingSettings>(env, `/zones/${zoneId}/email/routing`);
}

export async function listDestinationAddresses(
  env: Env
): Promise<CloudflareDestinationAddress[]> {
  return cfApi<CloudflareDestinationAddress[]>(
    env,
    `/accounts/${getClawpostCloudflareAccountId(env)}/email/routing/addresses`
  );
}

export async function ensureDestinationAddress(
  env: Env,
  email: string
): Promise<CloudflareDestinationAddress> {
  const normalized = email.toLowerCase();
  const existing = await listDestinationAddresses(env);
  const found = existing.find((entry) => entry.email.toLowerCase() === normalized);
  if (found) return found;

  return cfApi<CloudflareDestinationAddress>(
    env,
    `/accounts/${getClawpostCloudflareAccountId(env)}/email/routing/addresses`,
    {
      method: "POST",
      body: JSON.stringify({ email: normalized }),
    }
  );
}

export async function ensureDestinationAddresses(
  env: Env,
  emails: string[]
): Promise<CloudflareDestinationAddress[]> {
  const results: CloudflareDestinationAddress[] = [];
  for (const email of emails) {
    results.push(await ensureDestinationAddress(env, email));
  }
  return results;
}

export async function deleteDestinationAddress(
  env: Env,
  addressId: string
): Promise<void> {
  await cfApi<Record<string, unknown>>(
    env,
    `/accounts/${getClawpostCloudflareAccountId(env)}/email/routing/addresses/${addressId}`,
    { method: "DELETE" }
  );
}

export function getRuleMatchedEmail(rule: CloudflareRule): string | null {
  const matcher = rule.matchers?.find(
    (entry) =>
      entry.type === "literal" &&
      entry.field === "to" &&
      typeof entry.value === "string" &&
      entry.value.length > 0
  );

  return matcher?.value ? matcher.value.trim().toLowerCase() : null;
}

export function ruleTargetsWorker(
  rule: CloudflareRule,
  workerName: string
): boolean {
  const normalizedWorkerName = workerName.toLowerCase();
  return (
    rule.actions?.some(
      (action) =>
        action.type === "worker" &&
        action.value.some(
          (value) => value.trim().toLowerCase() === normalizedWorkerName
        )
    ) ?? false
  );
}

export async function listRoutingRules(
  env: Env,
  zoneId: string
): Promise<CloudflareRule[]> {
  return cfApiList<CloudflareRule>(env, `/zones/${zoneId}/email/routing/rules`);
}

export async function createWorkerRoute(
  env: Env,
  zoneId: string,
  email: string,
  enabled: boolean,
  name: string
): Promise<CloudflareRule> {
  return cfApi<CloudflareRule>(env, `/zones/${zoneId}/email/routing/rules`, {
    method: "POST",
    body: JSON.stringify({
      name,
      enabled,
      matchers: [{ type: "literal", field: "to", value: email }],
      actions: [{ type: "worker", value: [getWorkerName(env)] }],
    }),
  });
}

export async function updateWorkerRoute(
  env: Env,
  zoneId: string,
  ruleId: string,
  email: string,
  enabled: boolean,
  name: string
): Promise<CloudflareRule> {
  return cfApi<CloudflareRule>(
    env,
    `/zones/${zoneId}/email/routing/rules/${ruleId}`,
    {
      method: "PUT",
      body: JSON.stringify({
        name,
        enabled,
        matchers: [{ type: "literal", field: "to", value: email }],
        actions: [{ type: "worker", value: [getWorkerName(env)] }],
      }),
    }
  );
}

export async function deleteWorkerRoute(
  env: Env,
  zoneId: string,
  ruleId: string
): Promise<void> {
  await cfApi<Record<string, unknown>>(
    env,
    `/zones/${zoneId}/email/routing/rules/${ruleId}`,
    { method: "DELETE" }
  );
}
