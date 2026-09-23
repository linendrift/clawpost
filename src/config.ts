import type { Env } from "./types";

export function getClawpostApiKey(env: Env): string {
  const apiKey = env.CLAWPOST_API_KEY ?? env.API_KEY;
  if (!apiKey) {
    throw new Error("Missing CLAWPOST_API_KEY (or legacy API_KEY)");
  }
  return apiKey;
}

export function getClawpostCloudflareApiToken(env: Env): string | undefined {
  return env.CLAWPOST_CF_API_TOKEN ?? env.CF_API_TOKEN;
}

export function getClawpostCloudflareAccountId(env: Env): string | undefined {
  return env.CLAWPOST_CF_ACCOUNT_ID ?? env.CF_ACCOUNT_ID;
}

export function getClawpostCloudflareWorkerName(env: Env): string {
  return env.CLAWPOST_CF_EMAIL_WORKER_NAME ?? env.CF_EMAIL_WORKER_NAME ?? "clawpost";
}

export function getClawpostAllowedDomains(env: Env): string {
  return env.CLAWPOST_ALLOWED_DOMAINS ?? env.ALLOWED_DOMAINS ?? "";
}
