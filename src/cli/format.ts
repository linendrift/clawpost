import type { Command } from "commander";
import { ClawpostApiError } from "./client";

export function getJsonMode(program: Command): boolean {
  return Boolean(program.opts().json);
}

export function printResult(
  program: Command,
  data: unknown,
  render?: (value: any) => void
) {
  if (getJsonMode(program) || !render) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  render(data);
}

export function handleCliError(program: Command, error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  if (getJsonMode(program)) {
    const payload =
      error instanceof ClawpostApiError
        ? { error: message, status: error.status, details: error.payload }
        : { error: message };
    console.error(JSON.stringify(payload, null, 2));
  } else {
    console.error(message);
  }
  process.exit(1);
  throw new Error("unreachable");
}

export function formatDate(value: unknown): string {
  if (typeof value !== "number" && typeof value !== "string") return "";
  return new Date(value).toLocaleString();
}
