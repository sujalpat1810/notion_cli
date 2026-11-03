import type { Client, GetSelfResponse } from "@notionhq/client";
import type { TokenKind } from "../notion/errors";

export interface Identity {
  userId: string;
  userType: "bot" | "person";
  name: string | null;
  tokenKind: TokenKind;
  workspaceId?: string;
  workspaceName?: string;
  /** Free workspaces cap uploads at 5 MiB; paid plans allow far more. */
  maxUploadBytes?: number;
  /** Stable key for per-workspace state and capability caches. */
  workspaceKey: string;
}

const FREE_UPLOAD_LIMIT = 5 * 1024 * 1024;

export async function fetchIdentity(client: Client): Promise<Identity> {
  return toIdentity(await client.users.me({}));
}

export function toIdentity(me: GetSelfResponse): Identity {
  if (me.type === "person") {
    // Personal access tokens act as the user themselves.
    return { userId: me.id, userType: "person", name: me.name, tokenKind: "pat", workspaceKey: `user-${me.id}` };
  }
  const bot = "workspace_id" in me.bot ? me.bot : undefined;
  return {
    userId: me.id,
    userType: "bot",
    name: me.name,
    // A workspace-owned bot is an internal connection; user-owned bots are OAuth or PAT-style tokens.
    tokenKind: bot?.owner.type === "workspace" ? "internal" : "unknown",
    workspaceId: bot?.workspace_id,
    workspaceName: bot?.workspace_name ?? undefined,
    maxUploadBytes: bot?.workspace_limits.max_file_upload_size_in_bytes,
    workspaceKey: bot?.workspace_id ?? `bot-${me.id}`,
  };
}

/** Best-effort plan hint from upload limits; capability probes and the profile override are authoritative. */
export function planHint(identity: Identity): "free" | "paid" | undefined {
  if (identity.maxUploadBytes === undefined) return undefined;
  return identity.maxUploadBytes <= FREE_UPLOAD_LIMIT ? "free" : "paid";
}
