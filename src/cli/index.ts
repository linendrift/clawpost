#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { Command } from "commander";
import pkg from "../../package.json";
import { ClawpostClient } from "./client";
import { formatDate, handleCliError, printResult } from "./format";

type GlobalOptions = {
  baseUrl?: string;
  apiKey?: string;
  json?: boolean;
};

function collectList(value: string, previous: string[] = []) {
  previous.push(value);
  return previous;
}

function resolveClient(program: Command): ClawpostClient {
  const options = program.opts<GlobalOptions>();
  const baseUrl = options.baseUrl || process.env.CLAWPOST_BASE_URL;
  const apiKey = options.apiKey || process.env.CLAWPOST_API_KEY;

  if (!baseUrl) {
    throw new Error("Set --base-url or CLAWPOST_BASE_URL");
  }
  if (!apiKey) {
    throw new Error("Set --api-key or CLAWPOST_API_KEY");
  }

  return new ClawpostClient({ baseUrl, apiKey });
}

async function readBody(body?: string, bodyFile?: string) {
  if (bodyFile) {
    return readFile(bodyFile, "utf8");
  }
  if (body !== undefined) {
    return body;
  }
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf8");
  }
  throw new Error("Provide --body, --body-file, or pipe to stdin");
}

async function buildAttachments(
  filePaths: string[] = [],
  attachmentIds: string[] = []
) {
  const attachments: Array<{ filename: string; content?: string; attachment_id?: string }> = [];

  for (const filePath of filePaths) {
    const content = await readFile(filePath);
    attachments.push({
      filename: basename(filePath),
      content: content.toString("base64"),
    });
  }

  for (const attachmentId of attachmentIds) {
    attachments.push({
      filename: "attachment",
      attachment_id: attachmentId,
    });
  }

  return attachments;
}

function printSimpleList(items: any[], mapper: (item: any) => string) {
  for (const item of items) {
    console.log(mapper(item));
  }
}

const program = new Command();
program
  .name("clawpost")
  .description("Repo-independent CLI for the Clawpost API")
  .version(pkg.version)
  .option("--base-url <url>", "Clawpost base URL (or CLAWPOST_BASE_URL)")
  .option("--api-key <key>", "Clawpost API key (or CLAWPOST_API_KEY)")
  .option("--json", "Output JSON");

program
  .command("send")
  .description("Send an email")
  .requiredOption("--to <email>", "Recipient email address", collectList, [])
  .requiredOption("--subject <subject>", "Email subject")
  .option("--body <text>", "Email body")
  .option("--body-file <path>", "Read body text from file")
  .option("--cc <email>", "CC recipient", collectList, [])
  .option("--bcc <email>", "BCC recipient", collectList, [])
  .option("--attachment <path>", "Attach file from disk", collectList, [])
  .option("--attachment-id <id>", "Forward an existing attachment by id", collectList, [])
  .action(async (options) => {
    try {
      const client = resolveClient(program);
      const body = await readBody(options.body, options.bodyFile);
      const attachments = await buildAttachments(options.attachment, options.attachmentId);
      const result = await client.sendEmail({
        to: options.to.length === 1 ? options.to[0] : options.to,
        subject: options.subject,
        body,
        cc: options.cc.length > 0 ? options.cc : undefined,
        bcc: options.bcc.length > 0 ? options.bcc : undefined,
        attachments: attachments.length > 0 ? attachments : undefined,
      });
      printResult(program, result, (value) => {
        console.log(`Sent message ${value.dbId} in thread ${value.threadId}`);
      });
    } catch (error) {
      handleCliError(program, error);
    }
  });

const message = program.command("message").description("Manage messages");
message
  .command("list")
  .option("--limit <number>", "Limit", "50")
  .option("--offset <number>", "Offset", "0")
  .option("--direction <direction>", "inbound or outbound")
  .option("--from <email>", "Filter by sender")
  .option("--to <email>", "Filter by recipient")
  .option("--label <label>", "Filter by label")
  .option("--include-archived", "Include archived messages")
  .action(async (options) => {
    try {
      const client = resolveClient(program);
      const result = await client.listMessages({
        limit: Number(options.limit),
        offset: Number(options.offset),
        direction: options.direction,
        from: options.from,
        to: options.to,
        label: options.label,
        include_archived: Boolean(options.includeArchived),
      });
      printResult(program, result, (value) => {
        printSimpleList(value, (item) => `${item.id} | ${item.from} -> ${item.to} | ${item.subject}`);
      });
    } catch (error) {
      handleCliError(program, error);
    }
  });

message
  .command("get <id>")
  .description("Read a message")
  .action(async (id) => {
    try {
      const client = resolveClient(program);
      const result = await client.getMessage(id);
      printResult(program, result, (value) => {
        console.log(`${value.subject}`);
        console.log(`From: ${value.from}`);
        console.log(`To: ${value.to}`);
        if (value.cc) console.log(`Cc: ${value.cc}`);
        if (value.bcc) console.log(`Bcc: ${value.bcc}`);
        console.log(`Date: ${formatDate(value.created_at)}`);
        console.log(`Direction: ${value.direction}`);
        if (value.status) console.log(`Status: ${value.status}`);
        if (value.labels?.length) console.log(`Labels: ${value.labels.join(", ")}`);
        if (value.attachments?.length) {
          console.log(`Attachments: ${value.attachments.map((a: any) => a.filename || a.id).join(", ")}`);
        }
        console.log();
        if (value.body_text) console.log(value.body_text);
      });
    } catch (error) {
      handleCliError(program, error);
    }
  });

message
  .command("search <query>")
  .option("--limit <number>", "Limit", "20")
  .option("--include-archived", "Include archived messages")
  .action(async (query, options) => {
    try {
      const client = resolveClient(program);
      const result = await client.searchMessages(
        query,
        Number(options.limit),
        Boolean(options.includeArchived)
      );
      printResult(program, result, (value) => {
        printSimpleList(value, (item) => `${item.id} | ${item.from} -> ${item.to} | ${item.subject}`);
      });
    } catch (error) {
      handleCliError(program, error);
    }
  });

message
  .command("reply <id>")
  .option("--body <text>", "Reply body")
  .option("--body-file <path>", "Read reply body from file")
  .option("--attachment <path>", "Attach file from disk", collectList, [])
  .option("--attachment-id <id>", "Forward an existing attachment by id", collectList, [])
  .action(async (id, options) => {
    try {
      const client = resolveClient(program);
      const body = await readBody(options.body, options.bodyFile);
      const attachments = await buildAttachments(options.attachment, options.attachmentId);
      const result = await client.replyToMessage(id, {
        body,
        attachments: attachments.length > 0 ? attachments : undefined,
      });
      printResult(program, result, (value) => {
        console.log(`Sent reply ${value.dbId}`);
      });
    } catch (error) {
      handleCliError(program, error);
    }
  });

message
  .command("label-add <id>")
  .description("Add labels to a message")
  .argument("<labels...>", "Labels to add")
  .action(async (id, labels) => {
    try {
      const client = resolveClient(program);
      const result = await client.addLabels(id, labels);
      printResult(program, result, (value) => {
        console.log(`Labels: ${value.labels.join(", ")}`);
      });
    } catch (error) {
      handleCliError(program, error);
    }
  });

message
  .command("label-remove <id> <label>")
  .description("Remove a label from a message")
  .action(async (id, label) => {
    try {
      const client = resolveClient(program);
      const result = await client.removeLabel(id, label);
      printResult(program, result, (value) => {
        console.log(`Removed ${value.removed}`);
      });
    } catch (error) {
      handleCliError(program, error);
    }
  });

message
  .command("archive <id>")
  .action(async (id) => {
    try {
      const client = resolveClient(program);
      const result = await client.archiveMessage(id);
      printResult(program, result, () => {
        console.log(`Archived ${id}`);
      });
    } catch (error) {
      handleCliError(program, error);
    }
  });

message
  .command("unarchive <id>")
  .action(async (id) => {
    try {
      const client = resolveClient(program);
      const result = await client.unarchiveMessage(id);
      printResult(program, result, () => {
        console.log(`Unarchived ${id}`);
      });
    } catch (error) {
      handleCliError(program, error);
    }
  });

const attachment = program.command("attachment").description("Manage attachments");
attachment
  .command("get <id>")
  .option("--output <path>", "Write attachment bytes to disk")
  .action(async (id, options) => {
    try {
      const client = resolveClient(program);
      const { data, filename, contentType } = await client.getAttachment(id);
      if (options.output) {
        await writeFile(options.output, new Uint8Array(data));
        printResult(program, { id, filename, contentType, output: options.output }, () => {
          console.log(`Wrote ${filename ?? id} to ${options.output}`);
        });
        return;
      }

      printResult(program, { id, filename, contentType, content_base64: Buffer.from(data).toString("base64") }, (value) => {
        console.log(value.content_base64);
      });
    } catch (error) {
      handleCliError(program, error);
    }
  });

const thread = program.command("thread").description("Manage threads");
thread
  .command("list")
  .option("--limit <number>", "Limit", "50")
  .option("--offset <number>", "Offset", "0")
  .action(async (options) => {
    try {
      const client = resolveClient(program);
      const result = await client.listThreads(Number(options.limit), Number(options.offset));
      printResult(program, result, (value) => {
        printSimpleList(value, (item) => `${item.id} | ${item.subject} | ${item.message_count} messages`);
      });
    } catch (error) {
      handleCliError(program, error);
    }
  });

thread
  .command("get <id>")
  .action(async (id) => {
    try {
      const client = resolveClient(program);
      const result = await client.getThread(id);
      printResult(program, result, (value) => {
        console.log(`${value.subject}\n`);
        printSimpleList(value.messages, (item: any) => `${formatDate(item.created_at)} | ${item.from} | ${item.subject}`);
      });
    } catch (error) {
      handleCliError(program, error);
    }
  });

const draft = program.command("draft").description("Manage drafts");
draft
  .command("list")
  .option("--limit <number>", "Limit", "50")
  .option("--offset <number>", "Offset", "0")
  .action(async (options) => {
    try {
      const client = resolveClient(program);
      const result = await client.listDrafts(Number(options.limit), Number(options.offset));
      printResult(program, result, (value) => {
        printSimpleList(value, (item) => `${item.id} | ${item.to || "(no recipient)"} | ${item.subject}`);
      });
    } catch (error) {
      handleCliError(program, error);
    }
  });

draft
  .command("create")
  .option("--to <email>", "Recipient")
  .option("--cc <email>", "CC recipient", collectList, [])
  .option("--bcc <email>", "BCC recipient", collectList, [])
  .option("--subject <subject>", "Subject")
  .option("--body <text>", "Draft body")
  .option("--body-file <path>", "Read draft body from file")
  .option("--thread-id <id>", "Associated thread id")
  .action(async (options) => {
    try {
      const client = resolveClient(program);
      const bodyText = options.body !== undefined ? options.body : (options.bodyFile ? await readFile(options.bodyFile, "utf8") : undefined);
      const result = await client.createDraft({
        to: options.to,
        cc: options.cc.length > 0 ? options.cc.join(", ") : undefined,
        bcc: options.bcc.length > 0 ? options.bcc.join(", ") : undefined,
        subject: options.subject,
        body_text: bodyText,
        thread_id: options.threadId,
      });
      printResult(program, result, (value) => {
        console.log(`Created draft ${value.id}`);
      });
    } catch (error) {
      handleCliError(program, error);
    }
  });

draft
  .command("get <id>")
  .action(async (id) => {
    try {
      const client = resolveClient(program);
      const result = await client.getDraft(id);
      printResult(program, result, (value) => {
        console.log(`${value.subject}\nTo: ${value.to || ""}\n\n${value.body_text}`);
      });
    } catch (error) {
      handleCliError(program, error);
    }
  });

draft
  .command("update <id>")
  .option("--to <email>", "Recipient")
  .option("--cc <email>", "CC recipient", collectList, [])
  .option("--bcc <email>", "BCC recipient", collectList, [])
  .option("--subject <subject>", "Subject")
  .option("--body <text>", "Draft body")
  .option("--body-file <path>", "Read draft body from file")
  .option("--thread-id <id>", "Associated thread id")
  .action(async (id, options) => {
    try {
      const client = resolveClient(program);
      const bodyText = options.body !== undefined ? options.body : (options.bodyFile ? await readFile(options.bodyFile, "utf8") : undefined);
      const result = await client.updateDraft(id, {
        to: options.to,
        cc: options.cc.length > 0 ? options.cc.join(", ") : undefined,
        bcc: options.bcc.length > 0 ? options.bcc.join(", ") : undefined,
        subject: options.subject,
        body_text: bodyText,
        thread_id: options.threadId,
      });
      printResult(program, result, () => {
        console.log(`Updated draft ${id}`);
      });
    } catch (error) {
      handleCliError(program, error);
    }
  });

draft
  .command("send <id>")
  .action(async (id) => {
    try {
      const client = resolveClient(program);
      const result = await client.sendDraft(id);
      printResult(program, result, (value) => {
        console.log(`Sent draft ${id} as message ${value.dbId}`);
      });
    } catch (error) {
      handleCliError(program, error);
    }
  });

draft
  .command("delete <id>")
  .action(async (id) => {
    try {
      const client = resolveClient(program);
      const result = await client.deleteDraft(id);
      printResult(program, result, () => {
        console.log(`Deleted draft ${id}`);
      });
    } catch (error) {
      handleCliError(program, error);
    }
  });

const sender = program.command("sender").description("Manage sender approvals");
sender
  .command("pending")
  .option("--limit <number>", "Limit", "50")
  .option("--offset <number>", "Offset", "0")
  .action(async (options) => {
    try {
      const client = resolveClient(program);
      const result = await client.listPending(Number(options.limit), Number(options.offset));
      printResult(program, result, (value) => {
        printSimpleList(value, (item) => `${item.id} | ${item.from} | ${item.subject}`);
      });
    } catch (error) {
      handleCliError(program, error);
    }
  });

sender
  .command("list")
  .action(async () => {
    try {
      const client = resolveClient(program);
      const result = await client.listApprovedSenders();
      printResult(program, result, (value) => {
        printSimpleList(value, (item) => `${item.email}${item.name ? ` (${item.name})` : ""}`);
      });
    } catch (error) {
      handleCliError(program, error);
    }
  });

sender
  .command("approve <email>")
  .option("--name <name>", "Optional sender name")
  .action(async (email, options) => {
    try {
      const client = resolveClient(program);
      const result = await client.approveSender(email, options.name);
      printResult(program, result, (value) => {
        console.log(`Approved ${value.email} (${value.approved_count} messages)`);
      });
    } catch (error) {
      handleCliError(program, error);
    }
  });

sender
  .command("remove <email>")
  .action(async (email) => {
    try {
      const client = resolveClient(program);
      const result = await client.removeSender(email);
      printResult(program, result, (value) => {
        console.log(`Removed ${value.removed}`);
      });
    } catch (error) {
      handleCliError(program, error);
    }
  });

const inbox = program.command("inbox").description("Manage Clawpost inbox addresses");
inbox
  .command("list")
  .action(async () => {
    try {
      const client = resolveClient(program);
      const result = await client.listInboxes();
      printResult(program, result, (value) => {
        printSimpleList(value, (item) => `${item.id} | ${item.email} | ${item.enabled ? "enabled" : "disabled"}`);
      });
    } catch (error) {
      handleCliError(program, error);
    }
  });

inbox
  .command("import <email>")
  .description("Adopt an existing Cloudflare worker-routed inbox into Clawpost")
  .action(async (email) => {
    try {
      const client = resolveClient(program);
      const result = await client.importInbox({ email });
      printResult(program, result, (value) => {
        console.log(`Imported inbox ${value.inbox.email}`);
      });
    } catch (error) {
      handleCliError(program, error);
    }
  });

inbox
  .command("create <email>")
  .option("--disabled", "Create the inbox in a disabled state")
  .action(async (email, options) => {
    try {
      const client = resolveClient(program);
      const result = await client.createInbox({
        email,
        enabled: !options.disabled,
      });
      printResult(program, result, (value) => {
        console.log(`Created inbox ${value.inbox.email}`);
      });
    } catch (error) {
      handleCliError(program, error);
    }
  });

inbox
  .command("get <id>")
  .action(async (id) => {
    try {
      const client = resolveClient(program);
      const result = await client.getInbox(id);
      printResult(program, result, (value) => {
        console.log(`${value.inbox.email} | ${value.inbox.enabled ? "enabled" : "disabled"}`);
      });
    } catch (error) {
      handleCliError(program, error);
    }
  });

inbox
  .command("update <id>")
  .option("--email <email>", "New inbox email")
  .option("--enable", "Enable the inbox")
  .option("--disable", "Disable the inbox")
  .action(async (id, options) => {
    try {
      const client = resolveClient(program);
      const enabled =
        options.enable ? true : options.disable ? false : undefined;
      const result = await client.updateInbox(id, {
        email: options.email,
        enabled,
      });
      printResult(program, result, (value) => {
        console.log(`Updated inbox ${value.inbox.email}`);
      });
    } catch (error) {
      handleCliError(program, error);
    }
  });

inbox
  .command("delete <id>")
  .action(async (id) => {
    try {
      const client = resolveClient(program);
      const result = await client.deleteInbox(id);
      printResult(program, result, (value) => {
        console.log(`Deleted inbox ${value.deleted.email}`);
      });
    } catch (error) {
      handleCliError(program, error);
    }
  });

const routing = program
  .command("routing")
  .description("Discover existing Cloudflare worker routes");

routing
  .command("discover")
  .option("--domain <domain>", "Limit discovery to one domain")
  .action(async (options) => {
    try {
      const client = resolveClient(program);
      const result = await client.discoverRoutingRules(options.domain);
      printResult(program, result, (value) => {
        printSimpleList(value, (item) => {
          const status = item.enabled ? "enabled" : "disabled";
          const managed = item.managed_as ? `managed:${item.managed_as}` : "importable";
          const drift = item.drifted ? "drifted" : "in-sync";
          return `${item.email} | ${status} | ${item.inferred_kind} | ${managed} | ${drift}`;
        });
      });
    } catch (error) {
      handleCliError(program, error);
    }
  });

const alias = program.command("alias").description("Manage forwarding aliases");
alias
  .command("list")
  .action(async () => {
    try {
      const client = resolveClient(program);
      const result = await client.listAliases();
      printResult(program, result, (value) => {
        printSimpleList(value, (item) => {
          const destinations = item.destinations.map((entry: any) => entry.destination_email).join(", ");
          return `${item.alias.id} | ${item.alias.source_email} -> ${destinations}`;
        });
      });
    } catch (error) {
      handleCliError(program, error);
    }
  });

alias
  .command("import <source>")
  .description("Adopt an existing Cloudflare worker-routed alias into Clawpost")
  .requiredOption("--to <email>", "Destination email", collectList, [])
  .action(async (source, options) => {
    try {
      const client = resolveClient(program);
      const result = await client.importAlias({
        source,
        destinations: options.to,
      });
      printResult(program, result, (value) => {
        const destinations = value.destinations
          .map((entry: any) => `${entry.destination_email} (${entry.status || "unknown"})`)
          .join(", ");
        console.log(`Imported alias ${value.alias.source_email} -> ${destinations}`);
      });
    } catch (error) {
      handleCliError(program, error);
    }
  });

alias
  .command("create <source>")
  .requiredOption("--to <email>", "Destination email", collectList, [])
  .option("--disabled", "Create the alias in a disabled state")
  .action(async (source, options) => {
    try {
      const client = resolveClient(program);
      const result = await client.createAlias({
        source,
        destinations: options.to,
        enabled: !options.disabled,
      });
      printResult(program, result, (value) => {
        const destinations = value.destinations.map((entry: any) => `${entry.destination_email} (${entry.status || "unknown"})`).join(", ");
        console.log(`Created alias ${value.alias.source_email} -> ${destinations}`);
      });
    } catch (error) {
      handleCliError(program, error);
    }
  });

alias
  .command("get <id>")
  .action(async (id) => {
    try {
      const client = resolveClient(program);
      const result = await client.getAlias(id);
      printResult(program, result, (value) => {
        const destinations = value.destinations.map((entry: any) => `${entry.destination_email} (${entry.status || "unknown"})`).join(", ");
        console.log(`${value.alias.source_email} -> ${destinations}`);
      });
    } catch (error) {
      handleCliError(program, error);
    }
  });

alias
  .command("update <id>")
  .option("--source <email>", "New source email")
  .option("--to <email>", "Replace destinations with one or more addresses", collectList, [])
  .option("--add-to <email>", "Add a destination address", collectList, [])
  .option("--remove-to <email>", "Remove a destination address", collectList, [])
  .option("--enable", "Enable the alias")
  .option("--disable", "Disable the alias")
  .action(async (id, options) => {
    try {
      const client = resolveClient(program);
      const enabled =
        options.enable ? true : options.disable ? false : undefined;
      let destinations: string[] | undefined;
      if (options.to.length > 0) {
        destinations = options.to;
      } else if (options.addTo.length > 0 || options.removeTo.length > 0) {
        const current = await client.getAlias(id) as any;
        const currentDests: string[] = current.destinations.map((d: any) => d.destination_email);
        const removeSet = new Set(options.removeTo.map((e: string) => e.toLowerCase()));
        destinations = [
          ...currentDests.filter((e: string) => !removeSet.has(e.toLowerCase())),
          ...options.addTo.filter((e: string) => !currentDests.some((c: string) => c.toLowerCase() === e.toLowerCase())),
        ];
      }
      const result = await client.updateAlias(id, {
        source: options.source,
        destinations,
        enabled,
      });
      printResult(program, result, (value) => {
        console.log(`Updated alias ${value.alias.source_email}`);
      });
    } catch (error) {
      handleCliError(program, error);
    }
  });

alias
  .command("delete <id>")
  .action(async (id) => {
    try {
      const client = resolveClient(program);
      const result = await client.deleteAlias(id);
      printResult(program, result, (value) => {
        console.log(`Deleted alias ${value.deleted.alias.source_email}`);
      });
    } catch (error) {
      handleCliError(program, error);
    }
  });

program.parseAsync().catch((error) => handleCliError(program, error));
