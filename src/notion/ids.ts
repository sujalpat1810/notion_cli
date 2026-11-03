import { extractNotionId } from "@notionhq/client";

export interface ParsedNotionRef {
  id: string;
  /** Set when the URL pointed at a database view (`?v=`), so `id` is a database, not a page. */
  viewId?: string;
}

/**
 * Parses a raw id or Notion URL. Extends the SDK's `extractNotionId` with peek
 * links (`…/Database-<db>?p=<page>` refers to the peeked page, not the database)
 * and flags database-view URLs.
 */
export function parseNotionRef(input: string): ParsedNotionRef | null {
  const peek = input.match(/[?&]p=([0-9a-f]{32})\b/i);
  if (peek) return { id: extractNotionId(peek[1]!)! };

  const id = extractNotionId(input);
  if (!id) return null;
  const view = input.match(/[?&]v=([0-9a-f]{32})\b/i);
  return view ? { id, viewId: extractNotionId(view[1]!)! } : { id };
}
