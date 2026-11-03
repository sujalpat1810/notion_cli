import type { GetSelfResponse } from "@notionhq/client";
import { describe, expect, it } from "vitest";
import { planHint, toIdentity } from "../../src/auth/identity";

const bot = (owner: "workspace" | "user", maxUpload: number) =>
  ({
    object: "user",
    id: "bot-1",
    name: "My connection",
    avatar_url: null,
    type: "bot",
    bot: {
      owner: owner === "workspace" ? { type: "workspace", workspace: true } : { type: "user", user: { id: "u", object: "user" } },
      workspace_id: "ws-1",
      workspace_name: "Acme",
      workspace_limits: { max_file_upload_size_in_bytes: maxUpload },
    },
  }) as unknown as GetSelfResponse;

describe("toIdentity", () => {
  it("recognises an internal connection and keys state by workspace id", () => {
    const id = toIdentity(bot("workspace", 5 * 1024 * 1024));
    expect(id).toMatchObject({ tokenKind: "internal", workspaceId: "ws-1", workspaceName: "Acme", workspaceKey: "ws-1" });
    expect(planHint(id)).toBe("free");
  });

  it("does not guess the kind of a user-owned bot", () => {
    const id = toIdentity(bot("user", 5 * 1024 ** 3));
    expect(id.tokenKind).toBe("unknown");
    expect(planHint(id)).toBe("paid");
  });

  it("treats a person identity as a personal access token", () => {
    const id = toIdentity({ object: "user", id: "u-1", name: "Sujal", avatar_url: null, type: "person", person: {} } as unknown as GetSelfResponse);
    expect(id).toMatchObject({ tokenKind: "pat", workspaceKey: "user-u-1" });
    expect(planHint(id)).toBeUndefined();
  });
});
