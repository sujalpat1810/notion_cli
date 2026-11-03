import { join } from "node:path";
import { APIResponseError, type Client } from "@notionhq/client";
import { paths } from "../config/paths";
import { errorEvidence, type ErrorEvidence } from "../notion/errors";
import { readJsonIfExists, writeFileAtomic } from "../util/fs";

export const CAPABILITIES = [
  "markdownPages",
  "databases",
  "statusOptions",
  "dualRelations",
  "databaseViews",
  "linkedViews",
  "dashboardViews",
  "chartViews",
  "fileUploads",
] as const;
export type Capability = (typeof CAPABILITIES)[number];

export interface CapabilityResult {
  value: "yes" | "no" | "unknown" | "skipped";
  evidence?: ErrorEvidence;
  note?: string;
}

export interface ProbeReport {
  probedAt: string;
  results: Record<Capability, CapabilityResult>;
  probePageId?: string;
  cleanedUp: boolean;
}

export interface ProbeOptions {
  parentPageId: string;
  /** Free plans allow one chart per workspace, so the chart probe is opt-in. */
  includeCharts: boolean;
  onProgress?: (capability: Capability, result: CapabilityResult) => void;
}

// 1x1 transparent PNG
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

const text = (content: string) => [{ type: "text" as const, text: { content } }];

/**
 * Runs each capability check in a throwaway page under the parent, records the
 * exact API evidence for anything refused, then moves the page to the trash.
 * Each probe is independent so one refusal doesn't hide the others.
 */
export async function runProbes(client: Client, opts: ProbeOptions): Promise<ProbeReport> {
  const results = Object.fromEntries(CAPABILITIES.map((c) => [c, { value: "skipped" } as CapabilityResult])) as Record<
    Capability,
    CapabilityResult
  >;
  const record = (cap: Capability, result: CapabilityResult) => {
    results[cap] = result;
    opts.onProgress?.(cap, result);
  };
  const attempt = async <T>(cap: Capability, fn: () => Promise<T>): Promise<T | undefined> => {
    try {
      const value = await fn();
      record(cap, { value: "yes" });
      return value;
    } catch (err) {
      record(cap, { value: refusal(err) ? "no" : "unknown", evidence: errorEvidence(err) });
      return undefined;
    }
  };

  const title = `notion-cli probe ${new Date().toISOString()} (safe to delete)`;

  // Probe page: try with a markdown body; fall back to a plain page so the rest can still run.
  let probePageId = await attempt("markdownPages", async () => {
    const page = await client.pages.create({
      parent: { page_id: opts.parentPageId },
      properties: { title: { title: text(title) } },
      markdown: "Created by `notion-cli doctor --probe`.\n\n<callout>Probe content</callout>",
      markdown_version: "v2",
    });
    return page.id;
  });
  if (!probePageId) {
    const page = await client.pages.create({
      parent: { page_id: opts.parentPageId },
      properties: { title: { title: text(title) } },
    });
    probePageId = page.id;
  }

  const report: ProbeReport = { probedAt: new Date().toISOString(), results, probePageId, cleanedUp: false };
  try {
    const db = await attempt("databases", async () => {
      const created = await client.databases.create({
        parent: { type: "page_id", page_id: probePageId },
        title: text("Probe DB"),
        initial_data_source: {
          properties: {
            Name: { title: {} },
            Amount: { number: { format: "rupee" } },
          },
        },
      });
      const dataSourceId = "data_sources" in created ? created.data_sources[0]?.id : undefined;
      if (!dataSourceId) throw new Error("databases.create returned no data source id");
      return { databaseId: created.id, dataSourceId };
    });

    if (db) {
      await attempt("statusOptions", () =>
        client.dataSources.update({
          data_source_id: db.dataSourceId,
          properties: {
            Stage: {
              status: {
                options: [
                  { name: "Lead", color: "gray", group: "To-do" },
                  { name: "Negotiation", color: "blue", group: "In progress" },
                  { name: "Won", color: "green", group: "Complete" },
                ],
              },
            },
          },
        }),
      );

      await attempt("dualRelations", async () => {
        const other = await client.databases.create({
          parent: { type: "page_id", page_id: probePageId },
          title: text("Probe DB 2"),
          initial_data_source: { properties: { Name: { title: {} } } },
        });
        const otherDs = "data_sources" in other ? other.data_sources[0]?.id : undefined;
        if (!otherDs) throw new Error("databases.create returned no data source id");
        await client.dataSources.update({
          data_source_id: db.dataSourceId,
          properties: {
            Related: { relation: { data_source_id: otherDs, dual_property: { synced_property_name: "Back" } } },
          },
        });
      });

      await attempt("databaseViews", () =>
        client.views.create({ data_source_id: db.dataSourceId, database_id: db.databaseId, name: "Probe table", type: "table" }),
      );

      await attempt("linkedViews", () =>
        client.views.create({
          data_source_id: db.dataSourceId,
          name: "Probe linked view",
          type: "table",
          create_database: { parent: { type: "page_id", page_id: probePageId } },
        }),
      );

      await attempt("dashboardViews", () =>
        client.views.create({ data_source_id: db.dataSourceId, database_id: db.databaseId, name: "Probe dashboard", type: "dashboard" }),
      );

      if (opts.includeCharts) {
        await attempt("chartViews", () =>
          client.views.create({
            data_source_id: db.dataSourceId,
            database_id: db.databaseId,
            name: "Probe chart",
            type: "chart",
            configuration: { type: "chart", chart_type: "number", value: { aggregator: "count" } },
          }),
        );
      } else {
        record("chartViews", { value: "skipped", note: "pass --probe-charts (uses the Free plan's single chart)" });
      }
    }

    await attempt("fileUploads", async () => {
      const upload = await client.fileUploads.create({ mode: "single_part", filename: "probe.png", content_type: "image/png" });
      await client.fileUploads.send({
        file_upload_id: upload.id,
        file: { filename: "probe.png", data: new Blob([PNG_1X1], { type: "image/png" }) },
      });
      await client.blocks.children.append({
        block_id: probePageId,
        children: [{ type: "image", image: { type: "file_upload", file_upload: { id: upload.id } } }],
      });
    });
  } finally {
    try {
      await client.pages.update({ page_id: probePageId, in_trash: true });
      report.cleanedUp = true;
    } catch {
      report.cleanedUp = false;
    }
  }
  return report;
}

/** A 4xx validation/permission answer means "not available"; anything else is inconclusive. */
function refusal(err: unknown): boolean {
  return APIResponseError.isAPIResponseError(err) && err.status >= 400 && err.status < 500 && err.status !== 429;
}

function cacheFile(workspaceKey: string): string {
  return join(paths.data, "capabilities", `${workspaceKey.replace(/[^a-z0-9_-]/gi, "_")}.json`);
}

export async function saveProbeReport(workspaceKey: string, report: ProbeReport): Promise<string> {
  const file = cacheFile(workspaceKey);
  await writeFileAtomic(file, `${JSON.stringify(report, null, 2)}\n`);
  return file;
}

export async function loadProbeReport(workspaceKey: string): Promise<ProbeReport | undefined> {
  return (await readJsonIfExists(cacheFile(workspaceKey))) as ProbeReport | undefined;
}
