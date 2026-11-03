import { describe, expect, it } from "vitest";
import { parseNotionRef } from "../../src/notion/ids";

const HEX = "0123456789abcdef0123456789abcdef";
const UUID = "01234567-89ab-cdef-0123-456789abcdef";
const OTHER = "fedcba9876543210fedcba9876543210";
const OTHER_UUID = "fedcba98-7654-3210-fedc-ba9876543210";

describe("parseNotionRef", () => {
  it.each([
    [HEX, UUID],
    [UUID, UUID],
    [UUID.toUpperCase(), UUID],
    [`https://www.notion.so/myws/Sandbox-${HEX}`, UUID],
    [`https://www.notion.so/${HEX}`, UUID],
    [`https://app.notion.com/p/Expense-Tracker-${HEX}`, UUID],
    [`notion.so/myws/Page-${HEX}?pvs=4`, UUID],
  ])("parses %s", (input, expected) => {
    expect(parseNotionRef(input)).toEqual({ id: expected });
  });

  it("uses the peeked page from ?p= rather than the database in the path", () => {
    expect(parseNotionRef(`https://www.notion.so/myws/${HEX}?v=${HEX}&p=${OTHER}&pm=s`)).toEqual({ id: OTHER_UUID });
  });

  it("flags database view URLs", () => {
    expect(parseNotionRef(`https://www.notion.so/myws/${HEX}?v=${OTHER}`)).toEqual({ id: UUID, viewId: OTHER_UUID });
  });

  it("returns null for things that are not Notion ids", () => {
    expect(parseNotionRef("hello")).toBeNull();
    expect(parseNotionRef("")).toBeNull();
  });
});
