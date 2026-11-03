const SERVICE = "notion-cli";

export type TokenSource = "env" | "keyring";

export interface ResolvedToken {
  token: string;
  source: TokenSource;
}

/** Loaded lazily so commands that never touch credentials don't pay for the native module. */
async function entry(profile: string) {
  const { AsyncEntry } = await import("@napi-rs/keyring");
  return new AsyncEntry(SERVICE, profile);
}

/** NOTION_TOKEN wins over the keychain so CI and one-off runs need no stored secret. */
export async function resolveToken(profile: string): Promise<ResolvedToken | null> {
  const fromEnv = process.env.NOTION_TOKEN?.trim();
  if (fromEnv) return { token: fromEnv, source: "env" };
  const stored = await (await entry(profile)).getPassword();
  return stored ? { token: stored, source: "keyring" } : null;
}

export async function saveToken(profile: string, token: string): Promise<void> {
  await (await entry(profile)).setPassword(token);
}

export async function deleteToken(profile: string): Promise<boolean> {
  return (await entry(profile)).deletePassword();
}

/** For display only: keeps the prefix and last 4 characters. */
export function maskToken(token: string): string {
  if (token.length <= 12) return "****";
  const prefix = token.match(/^[a-z]+_/i)?.[0] ?? "";
  return `${prefix}****${token.slice(-4)}`;
}
