import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generateFilter } from "../../src/utils/generateFilter";

describe("walk: generateFilter (RT-3)", () => {
  it("AC-1: undefined filters returns {}", () => {
    expect(generateFilter()).toEqual({});
  });

  it("AC-1: eq and gte filters", () => {
    expect(
      generateFilter([
        { field: "name", operator: "eq", value: "John" },
        { field: "age", operator: "gte", value: 25 },
      ]),
    ).toEqual({ name: "John", age_gte: 25 });
  });

  it("AC-1: q field has no suffix and later filters still processed", () => {
    expect(
      generateFilter([
        { field: "q", operator: "contains", value: "searchValue" },
        { field: "name", operator: "eq", value: "John" },
      ]),
    ).toEqual({ q: "searchValue", name: "John" });
  });

  it.each(["or", "and"] as const)("AC-1: %s throws unchanged message", (op) => {
    expect(() => generateFilter([{ operator: op, value: [] } as any])).toThrow(
      `[@refinedev/simple-rest]: \`operator: ${op}\` is not supported.`,
    );
  });

  it("AC-1: conditional filters without field are ignored", () => {
    expect(generateFilter([{ operator: "eq", value: 1 } as any])).toEqual({});
  });

  it("source no longer uses map for side effects", () => {
    const src = readFileSync(
      join(__dirname, "../../src/utils/generateFilter.ts"),
      "utf8",
    );
    expect(src).not.toMatch(/filters\.map\(/);
  });
});
