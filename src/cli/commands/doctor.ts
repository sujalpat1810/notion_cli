import type { Command } from "commander";
import type { Client, GetPageResponse } from "@notionhq/client";
import { fetchIdentity, type Identity, planHint } from "../../auth/identity";
import { maskToken } from "../../auth/tokenStore";
import { type CapabilityResult, runProbes, saveProbeReport } from "../../capabilities/probes";
import { paths } from "../../config/paths";
import { CliError, ExitCode, toCliError } from "../../notion/errors";
import { parseNotionRef } from "../../notion/ids";
import { createContext, type GlobalOptions } from "../context";
import type { Output } from "../output";

type Status = "ok" | "warn" | "fail" | "skip";
interface Check {
  name: string;
  status: Status;
  detail: string;
  hint?: string;
}

interface DoctorOptions {
  parent?: string;
  probe?: boolean;
  probeCharts?: boolean;
}

export function registerDoctor(program: Command): void {
  program
    .command("doctor")
    .description("Check the token, parent page access and what this workspace's plan allows")
    .option("--parent <url>", "parent page to check (defaults to the profile's default parent)")
    .option("--probe", "create a throwaway page and test databases, views, dashboards and uploads")
    .option("--probe-charts", "also test chart views (uses the Free plan's single chart)")
    .action(async (opts: DoctorOptions, cmd: Command) => {
      const ctx = await createContext(cmd.optsWithGlobals<GlobalOptions>());
      const { out } = ctx;
      const checks: Check[] = [];
      const add = (check: Check) => checks.push(check);

      const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
      add(
        major > 22 || (major === 22 && minor >= 12)
          ? { name: "Node.js", status: "ok", detail: process.versions.node }
          : { name: "Node.js", status: "fail", detail: process.versions.node, hint: "Install Node 22.12 or newer." },
      );
      add({ name: "Config", status: "ok", detail: paths.configFile });

      let client: Client | undefined;
      let identity: Identity | undefined;
      try {
        const conn = await ctx.connect();
        client = conn.client;
        add({
          name: "Token",
          status: "ok",
          detail: `${maskToken(conn.token.token)} from ${conn.token.source === "env" ? "NOTION_TOKEN" : "OS keychain"}`,
        });
      } catch (err) {
        const e = toCliError(err);
        add({ name: "Token", status: "fail", detail: e.message, hint: e.hint ?? "Set NOTION_TOKEN if the OS keychain is unavailable." });
      }

      if (client) {
        try {
          identity = await fetchIdentity(client);
          const hint = planHint(identity);
          add({
            name: "Notion API",
            status: "ok",
            detail: `${identity.name ?? identity.userId} · ${identity.tokenKind} token · ${identity.workspaceName ?? identity.workspaceKey}${hint ? ` · plan: ${hint}` : ""}`,
          });
        } catch (err) {
          const e = toCliError(err, { action: "calling users.me" });
          add({ name: "Notion API", status: "fail", detail: e.message, hint: e.hint });
        }
      }

      const parentInput = opts.parent ?? ctx.profile.defaultParent;
      let parentId: string | undefined;
      if (!parentInput) {
        add({ name: "Parent page", status: "skip", detail: "none set", hint: "Pass --parent <page URL> or save one with `auth login --parent`." });
      } else if (client && identity) {
        const ref = parseNotionRef(parentInput);
        if (!ref) {
          add({ name: "Parent page", status: "fail", detail: `not a Notion URL or ID: ${parentInput}` });
        } else if (ref.viewId) {
          add({ name: "Parent page", status: "fail", detail: "that URL is a database view", hint: "Use a regular page as the parent." });
        } else {
          try {
            const page = await client.pages.retrieve({ page_id: ref.id });
            parentId = ref.id;
            add({ name: "Parent page", status: "ok", detail: `"${pageTitle(page)}" (${ref.id})` });
          } catch (err) {
            const e = toCliError(err, { action: "reading the parent page", tokenKind: identity.tokenKind });
            add({ name: "Parent page", status: "fail", detail: e.message, hint: e.hint });
          }
        }
      }

      let probeReport;
      if (opts.probe || opts.probeCharts) {
        if (!client || !identity || !parentId) {
          add({ name: "Capabilities", status: "skip", detail: "needs a working token and parent page" });
        } else {
          out.info(out.c.dim("Probing capabilities in a throwaway page…"));
          probeReport = await runProbes(client, {
            parentPageId: parentId,
            includeCharts: Boolean(opts.probeCharts),
            onProgress: (cap, r) => out.info(out.c.dim(`  ${cap}: ${r.value}`)),
          });
          for (const [cap, r] of Object.entries(probeReport.results)) add(capabilityCheck(cap, r));
          if (!probeReport.cleanedUp) {
            add({ name: "Cleanup", status: "warn", detail: `could not trash probe page ${probeReport.probePageId}` });
          }
          const file = await saveProbeReport(identity.workspaceKey, probeReport);
          add({ name: "Probe report", status: "ok", detail: file });
        }
      } else if (client && identity) {
        add({ name: "Capabilities", status: "skip", detail: "run `notion-cli doctor --probe` to test dashboards, views and uploads" });
      }

      printChecks(out, checks);
      out.result({ checks, identity, probe: probeReport });
      if (checks.some((c) => c.status === "fail")) {
        throw new CliError("Some checks failed.", undefined, ExitCode.Error);
      }
    });
}

function capabilityCheck(name: string, r: CapabilityResult): Check {
  const status: Status = r.value === "yes" ? "ok" : r.value === "skipped" ? "skip" : "warn";
  const detail =
    r.value === "yes"
      ? "available"
      : r.evidence
        ? `${r.value}: ${r.evidence.status ?? ""} ${r.evidence.code ?? ""} ${r.evidence.message}`.replace(/\s+/g, " ").trim()
        : (r.note ?? r.value);
  return { name: `  ${name}`, status, detail };
}

function printChecks(out: Output, checks: Check[]): void {
  const icon: Record<Status, string> = {
    ok: out.c.green("✔"),
    warn: out.c.yellow("▲"),
    fail: out.c.red("✖"),
    skip: out.c.dim("–"),
  };
  out.table(checks.map((c) => [icon[c.status], c.name, c.detail]));
  for (const c of checks.filter((c) => c.hint && c.status !== "ok")) {
    out.info(out.c.dim(`  ${c.name.trim()}: ${c.hint}`));
  }
}

function pageTitle(page: GetPageResponse): string {
  if (!("properties" in page)) return "(untitled)";
  for (const prop of Object.values(page.properties)) {
    if (prop.type === "title") return prop.title.map((t) => t.plain_text).join("") || "(untitled)";
  }
  return "(untitled)";
}
