import { z } from "zod";
import { readJsonIfExists, writeFileAtomic } from "../util/fs";
import { paths } from "./paths";

export const PLANS = ["free", "plus", "business", "enterprise"] as const;
export type Plan = (typeof PLANS)[number];

/** Non-secret metadata per profile. The token itself lives in the OS keychain. */
const ProfileSchema = z.object({
  workspaceId: z.string().optional(),
  workspaceName: z.string().optional(),
  tokenKind: z.enum(["pat", "internal", "unknown"]).optional(),
  botId: z.string().optional(),
  defaultParent: z.string().optional(),
  /** Manual override; takes priority over capability probes. */
  plan: z.enum(PLANS).optional(),
  rateLimitPerMinute: z.number().int().positive().optional(),
});
export type Profile = z.infer<typeof ProfileSchema>;

const SettingsSchema = z.object({
  version: z.literal(1).default(1),
  defaultProfile: z.string().default("default"),
  profiles: z.record(z.string(), ProfileSchema).default({}),
});
export type Settings = z.infer<typeof SettingsSchema>;

export async function loadSettings(): Promise<Settings> {
  const raw = await readJsonIfExists(paths.configFile);
  const parsed = SettingsSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    throw new Error(`Invalid config file ${paths.configFile}: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

export async function saveSettings(settings: Settings): Promise<void> {
  await writeFileAtomic(paths.configFile, `${JSON.stringify(settings, null, 2)}\n`);
}

export async function updateProfile(name: string, patch: Partial<Profile> | null): Promise<Settings> {
  const settings = await loadSettings();
  if (patch === null) {
    delete settings.profiles[name];
  } else {
    settings.profiles[name] = { ...settings.profiles[name], ...patch };
  }
  await saveSettings(settings);
  return settings;
}
