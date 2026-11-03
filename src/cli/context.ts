import { createWriteStream, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "@notionhq/client";
import { type ResolvedToken, resolveToken } from "../auth/tokenStore";
import { paths } from "../config/paths";
import { loadSettings, type Profile, type Settings } from "../config/settings";
import { CliError, ExitCode } from "../notion/errors";
import { createNotionClient } from "../notion/client";
import type { HttpEvent } from "../notion/httpPolicy";
import { Output } from "./output";

export interface GlobalOptions {
  profile?: string;
  json?: boolean;
  debug?: boolean;
  color?: boolean;
}

export interface CommandContext {
  profileName: string;
  settings: Settings;
  profile: Profile;
  out: Output;
  /** Resolves the token and builds a throttled client; throws a CliError when not logged in. */
  connect(): Promise<{ client: Client; token: ResolvedToken }>;
}

export async function createContext(opts: GlobalOptions): Promise<CommandContext> {
  const out = new Output(Boolean(opts.json), opts.color !== false);
  const settings = await loadSettings();
  const profileName = opts.profile ?? process.env.NOTION_CLI_PROFILE ?? settings.defaultProfile;
  const profile = settings.profiles[profileName] ?? {};

  return {
    profileName,
    settings,
    profile,
    out,
    async connect() {
      const token = await resolveToken(profileName);
      if (!token) {
        throw new CliError(
          `No Notion token for profile "${profileName}".`,
          "Run `notion-cli auth login` or set the NOTION_TOKEN environment variable.",
          ExitCode.Auth,
        );
      }
      const client = createNotionClient({
        token: token.token,
        rateLimitPerMinute: profile.rateLimitPerMinute,
        onHttpEvent: opts.debug ? debugLogger(out) : undefined,
      });
      return { client, token };
    },
  };
}

/** --debug: one NDJSON line per HTTP attempt (no headers, so the token never lands on disk). */
function debugLogger(out: Output): (event: HttpEvent) => void {
  mkdirSync(paths.log, { recursive: true });
  const file = join(paths.log, `http-${new Date().toISOString().slice(0, 10)}.ndjson`);
  const stream = createWriteStream(file, { flags: "a" });
  out.info(out.c.dim(`Debug log: ${file}`));
  return (event) => {
    stream.write(`${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
  };
}
