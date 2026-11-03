import { isCancel, password } from "@clack/prompts";
import type { Command } from "commander";
import { fetchIdentity, planHint } from "../../auth/identity";
import { deleteToken, maskToken, resolveToken, saveToken } from "../../auth/tokenStore";
import { updateProfile } from "../../config/settings";
import { createNotionClient } from "../../notion/client";
import { CliError, ExitCode, toCliError } from "../../notion/errors";
import { parseNotionRef } from "../../notion/ids";
import { createContext, type GlobalOptions } from "../context";

export function registerAuth(program: Command): void {
  const auth = program.command("auth").description("Manage the Notion token for a profile");

  auth
    .command("login")
    .description("Validate a Notion token and store it in the OS keychain")
    .option("--token <token>", "token to store (omit to be prompted; avoids shell history)")
    .option("--parent <url>", "default parent page for templates (URL or ID)")
    .action(async (opts: { token?: string; parent?: string }, cmd: Command) => {
      const ctx = await createContext(cmd.optsWithGlobals<GlobalOptions>());
      const { out } = ctx;

      let token = opts.token?.trim();
      if (!token) {
        if (!process.stdin.isTTY) {
          throw new CliError("No token given.", "Pass --token, or run in an interactive terminal.", ExitCode.Usage);
        }
        out.info("Create a token at https://app.notion.com/developers/connections");
        out.info(out.c.dim("A personal access token acts as you; an internal connection token needs pages shared with it."));
        const answer = await password({ message: "Paste your Notion token" });
        if (isCancel(answer) || !answer.trim()) throw new CliError("Login cancelled.", undefined, ExitCode.Usage);
        token = answer.trim();
      }

      const client = createNotionClient({ token });
      const identity = await fetchIdentity(client).catch((err) => {
        throw toCliError(err, { action: "validating the token" });
      });

      let defaultParent: string | undefined;
      if (opts.parent) {
        const ref = parseNotionRef(opts.parent);
        if (!ref) throw new CliError(`Not a Notion page URL or ID: ${opts.parent}`, undefined, ExitCode.Usage);
        await client.pages.retrieve({ page_id: ref.id }).catch((err) => {
          throw toCliError(err, { action: "checking the parent page", tokenKind: identity.tokenKind });
        });
        defaultParent = ref.id;
      }

      await saveToken(ctx.profileName, token);
      await updateProfile(ctx.profileName, {
        workspaceId: identity.workspaceId,
        workspaceName: identity.workspaceName,
        tokenKind: identity.tokenKind,
        botId: identity.userType === "bot" ? identity.userId : undefined,
        ...(defaultParent ? { defaultParent } : {}),
      });

      out.success(
        `Logged in${identity.workspaceName ? ` to ${out.c.bold(identity.workspaceName)}` : ""} as ${identity.name ?? identity.userId} (profile "${ctx.profileName}")`,
      );
      if (defaultParent) out.info(`Default parent page: ${defaultParent}`);
      out.result({ profile: ctx.profileName, ...identity, planHint: planHint(identity), defaultParent });
    });

  auth
    .command("status")
    .description("Show which token is in use and who it belongs to")
    .action(async (_opts: unknown, cmd: Command) => {
      const ctx = await createContext(cmd.optsWithGlobals<GlobalOptions>());
      const { out } = ctx;
      const token = await resolveToken(ctx.profileName);
      if (!token) {
        throw new CliError(`Not logged in (profile "${ctx.profileName}").`, "Run `notion-cli auth login`.", ExitCode.Auth);
      }
      const identity = await fetchIdentity(createNotionClient({ token: token.token })).catch((err) => {
        throw toCliError(err, { action: "checking the token" });
      });
      out.table(
        [
          ["Profile", ctx.profileName],
          ["Token", `${maskToken(token.token)} (from ${token.source === "env" ? "NOTION_TOKEN" : "OS keychain"})`],
          ["Identity", `${identity.name ?? "?"} (${identity.userType})`],
          ["Token kind", identity.tokenKind],
          ["Workspace", identity.workspaceName ?? identity.workspaceKey],
          ["Plan hint", planHint(identity) ?? "unknown"],
          ["Default parent", ctx.profile.defaultParent ?? "(none — pass --parent)"],
        ],
      );
      out.result({ profile: ctx.profileName, source: token.source, ...identity, planHint: planHint(identity) });
    });

  auth
    .command("logout")
    .description("Remove the stored token for a profile")
    .action(async (_opts: unknown, cmd: Command) => {
      const ctx = await createContext(cmd.optsWithGlobals<GlobalOptions>());
      const removed = await deleteToken(ctx.profileName);
      if (removed) ctx.out.success(`Removed the token for profile "${ctx.profileName}" from the OS keychain.`);
      else ctx.out.info(`No stored token for profile "${ctx.profileName}".`);
      if (process.env.NOTION_TOKEN) ctx.out.warn("NOTION_TOKEN is still set in this shell and will keep being used.");
      ctx.out.result({ profile: ctx.profileName, removed });
    });
}
