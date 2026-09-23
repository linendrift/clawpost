export interface CliConfig {
  baseUrl: string;
  apiKey: string;
}

interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  responseType?: "json" | "arrayBuffer";
}

export class ClawpostApiError extends Error {
  status: number;
  payload: unknown;

  constructor(message: string, status: number, payload: unknown) {
    super(message);
    this.name = "ClawpostApiError";
    this.status = status;
    this.payload = payload;
  }
}

export class ClawpostClient {
  private baseUrl: string;
  private apiKey: string;

  constructor(config: CliConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.apiKey = config.apiKey;
  }

  private async request<T>(
    method: string,
    path: string,
    options: RequestOptions = {}
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }

    const response = await fetch(url, {
      method,
      headers: {
        "X-API-Key": this.apiKey,
        ...(options.body ? { "Content-Type": "application/json" } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

    if (options.responseType === "arrayBuffer") {
      if (!response.ok) {
        throw await this.toError(response);
      }
      return (await response.arrayBuffer()) as T;
    }

    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const message =
        typeof payload === "object" &&
        payload !== null &&
        "error" in payload &&
        typeof payload.error === "string"
          ? payload.error
          : `Request failed (${response.status})`;
      throw new ClawpostApiError(message, response.status, payload);
    }

    return payload as T;
  }

  private async toError(response: Response): Promise<ClawpostApiError> {
    const payload = await response.json().catch(() => null);
    const message =
      typeof payload === "object" &&
      payload !== null &&
      "error" in payload &&
      typeof payload.error === "string"
        ? payload.error
        : `Request failed (${response.status})`;
    return new ClawpostApiError(message, response.status, payload);
  }

  sendEmail(payload: unknown) {
    return this.request("POST", "/api/send", { body: payload });
  }

  listMessages(query: RequestOptions["query"]) {
    return this.request("GET", "/api/messages", { query });
  }

  getMessage(id: string) {
    return this.request("GET", `/api/messages/${encodeURIComponent(id)}`);
  }

  replyToMessage(id: string, payload: unknown) {
    return this.request("POST", `/api/messages/${encodeURIComponent(id)}/reply`, {
      body: payload,
    });
  }

  searchMessages(query: string, limit?: number, includeArchived?: boolean) {
    return this.request("GET", "/api/search", {
      query: { q: query, limit, include_archived: includeArchived },
    });
  }

  addLabels(id: string, labels: string[]) {
    return this.request("POST", `/api/messages/${encodeURIComponent(id)}/labels`, {
      body: { labels },
    });
  }

  removeLabel(id: string, label: string) {
    return this.request(
      "DELETE",
      `/api/messages/${encodeURIComponent(id)}/labels/${encodeURIComponent(label)}`
    );
  }

  archiveMessage(id: string) {
    return this.request("POST", `/api/messages/${encodeURIComponent(id)}/archive`);
  }

  unarchiveMessage(id: string) {
    return this.request("POST", `/api/messages/${encodeURIComponent(id)}/unarchive`);
  }

  async getAttachment(id: string): Promise<{ data: ArrayBuffer; filename: string | null; contentType: string }> {
    const url = new URL(`${this.baseUrl}/api/attachments/${encodeURIComponent(id)}`);
    const response = await fetch(url, {
      method: "GET",
      headers: { "X-API-Key": this.apiKey },
    });

    if (!response.ok) {
      throw await this.toError(response);
    }

    const contentType = response.headers.get("Content-Type") ?? "application/octet-stream";
    const disposition = response.headers.get("Content-Disposition") ?? "";
    const filenameMatch = disposition.match(/filename="([^"]+)"/);
    const filename = filenameMatch ? filenameMatch[1] : null;
    const data = await response.arrayBuffer();

    return { data, filename, contentType };
  }

  listThreads(limit?: number, offset?: number) {
    return this.request("GET", "/api/threads", { query: { limit, offset } });
  }

  getThread(id: string) {
    return this.request("GET", `/api/threads/${encodeURIComponent(id)}`);
  }

  listDrafts(limit?: number, offset?: number) {
    return this.request("GET", "/api/drafts", { query: { limit, offset } });
  }

  createDraft(payload: unknown) {
    return this.request("POST", "/api/drafts", { body: payload });
  }

  getDraft(id: string) {
    return this.request("GET", `/api/drafts/${encodeURIComponent(id)}`);
  }

  updateDraft(id: string, payload: unknown) {
    return this.request("PUT", `/api/drafts/${encodeURIComponent(id)}`, {
      body: payload,
    });
  }

  sendDraft(id: string) {
    return this.request("POST", `/api/drafts/${encodeURIComponent(id)}/send`);
  }

  deleteDraft(id: string) {
    return this.request("DELETE", `/api/drafts/${encodeURIComponent(id)}`);
  }

  listPending(limit?: number, offset?: number) {
    return this.request("GET", "/api/pending", { query: { limit, offset } });
  }

  listApprovedSenders() {
    return this.request("GET", "/api/approved-senders");
  }

  approveSender(email: string, name?: string) {
    return this.request("POST", "/api/approved-senders", {
      body: { email, name },
    });
  }

  removeSender(email: string) {
    return this.request(
      "DELETE",
      `/api/approved-senders/${encodeURIComponent(email)}`
    );
  }

  listInboxes() {
    return this.request("GET", "/api/inboxes");
  }

  importInbox(payload: unknown) {
    return this.request("POST", "/api/inboxes/import", { body: payload });
  }

  createInbox(payload: unknown) {
    return this.request("POST", "/api/inboxes", { body: payload });
  }

  getInbox(id: string) {
    return this.request("GET", `/api/inboxes/${encodeURIComponent(id)}`);
  }

  updateInbox(id: string, payload: unknown) {
    return this.request("PUT", `/api/inboxes/${encodeURIComponent(id)}`, {
      body: payload,
    });
  }

  deleteInbox(id: string) {
    return this.request("DELETE", `/api/inboxes/${encodeURIComponent(id)}`);
  }

  listAliases() {
    return this.request("GET", "/api/aliases");
  }

  discoverRoutingRules(domain?: string) {
    return this.request("GET", "/api/routing/discover", {
      query: { domain },
    });
  }

  importAlias(payload: unknown) {
    return this.request("POST", "/api/aliases/import", { body: payload });
  }

  createAlias(payload: unknown) {
    return this.request("POST", "/api/aliases", { body: payload });
  }

  getAlias(id: string) {
    return this.request("GET", `/api/aliases/${encodeURIComponent(id)}`);
  }

  updateAlias(id: string, payload: unknown) {
    return this.request("PUT", `/api/aliases/${encodeURIComponent(id)}`, {
      body: payload,
    });
  }

  deleteAlias(id: string) {
    return this.request("DELETE", `/api/aliases/${encodeURIComponent(id)}`);
  }
}
