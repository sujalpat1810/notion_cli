import { APIErrorCode, APIResponseError, RequestTimeoutError } from "@notionhq/client";
import { UncertainOutcomeError } from "./httpPolicy";

export const ExitCode = {
  Ok: 0,
  Error: 1,
  Usage: 2,
  Partial: 3,
  Auth: 4,
  Interrupted: 130,
} as const;

/** An error with a user-facing message, an optional hint, and a process exit code. */
export class CliError extends Error {
  override readonly name = "CliError";
  constructor(
    message: string,
    readonly hint?: string,
    readonly exitCode: number = ExitCode.Error,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

export type TokenKind = "pat" | "internal" | "unknown";

export interface ErrorContext {
  tokenKind?: TokenKind;
  /** What we were doing, e.g. "reading the parent page". */
  action?: string;
}

/** Evidence recorded for capability probes and debug output. */
export interface ErrorEvidence {
  status?: number;
  code?: string;
  message: string;
}

export function errorEvidence(err: unknown): ErrorEvidence {
  if (APIResponseError.isAPIResponseError(err)) {
    return { status: err.status, code: err.code, message: err.message };
  }
  if (err instanceof Error) return { code: err.name, message: err.message };
  return { message: String(err) };
}

/** Converts any thrown value into a CliError with an actionable hint. */
export function toCliError(err: unknown, ctx: ErrorContext = {}): CliError {
  if (err instanceof CliError) return err;
  const doing = ctx.action ? ` while ${ctx.action}` : "";

  if (err instanceof UncertainOutcomeError) {
    return new CliError(
      `Notion did not confirm a change${doing}: ${err.message}`,
      "Re-run the same command; the CLI will look for the object before creating it again.",
      ExitCode.Partial,
      { cause: err },
    );
  }
  if (RequestTimeoutError.isRequestTimeoutError(err)) {
    return new CliError(`Notion request timed out${doing}.`, "Check your connection and re-run.", ExitCode.Error, { cause: err });
  }
  if (APIResponseError.isAPIResponseError(err)) {
    switch (err.code) {
      case APIErrorCode.Unauthorized:
        return new CliError(
          `Notion rejected the token${doing}.`,
          "Create a new token at https://app.notion.com/developers/connections and run `notion-cli auth login`.",
          ExitCode.Auth,
          { cause: err },
        );
      case APIErrorCode.ObjectNotFound:
        return new CliError(
          `Notion object not found${doing}.`,
          ctx.tokenKind === "internal"
            ? "Internal connections only see pages shared with them: open the page in Notion → ••• → Connections → add your connection."
            : "Check the URL/ID. If you use an internal connection token, share the page with it (••• → Connections).",
          ExitCode.Error,
          { cause: err },
        );
      case APIErrorCode.RestrictedResource:
        return new CliError(
          `The token is not allowed to do this${doing}: ${err.message}`,
          "Enable the needed capabilities (read/update/insert content) for the token in the Notion developer portal.",
          ExitCode.Auth,
          { cause: err },
        );
      case APIErrorCode.RateLimited:
        return new CliError(
          `Notion rate limit${doing}: ${err.message}`,
          err.additional_data?.rate_limit_reason === "public_api_request_blocked"
            ? "API access is blocked for this connection or workspace; ask a workspace admin."
            : "Wait a minute and re-run; progress is saved.",
          ExitCode.Error,
          { cause: err },
        );
      default:
        return new CliError(`Notion API error${doing} (${err.status} ${err.code}): ${err.message}`, undefined, ExitCode.Error, {
          cause: err,
        });
    }
  }
  if (err instanceof Error) return new CliError(err.message, undefined, ExitCode.Error, { cause: err });
  return new CliError(String(err));
}
