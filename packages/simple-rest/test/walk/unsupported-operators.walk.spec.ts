import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

import dataProvider, { generateFilter, mapOperator } from "../../src/index";

const root = resolve(__dirname, "../../../..");

const msg = (op: string) =>
  `[@refinedev/simple-rest]: \`operator: ${op}\` is not supported. You can create custom data provider. https://refine.dev/docs/api-reference/core/providers/data-provider/#creating-a-data-provider`;

const mapped: Record<string, string> = {
  eq: "price",
  in: "price",
  ne: "price_ne",
  gte: "price_gte",
  lte: "price_lte",
  contains: "price_like",
};

const unsupported = [
  "eqs",
  "nes",
  "lt",
  "gt",
  "nin",
  "ina",
  "nina",
  "ncontains",
  "containss",
  "ncontainss",
  "between",
  "nbetween",
  "null",
  "nnull",
  "startswith",
  "nstartswith",
  "startswiths",
  "nstartswiths",
  "endswith",
  "nendswith",
  "endswiths",
  "nendswiths",
];

describe("walk RT-1: unsupported filter operators (public API)", () => {
  it.each(Object.entries(mapped))("AC-1: %s maps to key %s", (op, key) => {
    expect(
      generateFilter([{ field: "price", operator: op as any, value: 10 }]),
    ).toEqual({ [key]: 10 });
  });

  it.each(unsupported)("AC-1/AC-3: %s throws the descriptive error", (op) => {
    expect(() =>
      generateFilter([{ field: "price", operator: op as any, value: 10 }]),
    ).toThrow(msg(op));
  });

  it.each(["or", "and"])("AC-3: %s throws the existing error", (op) => {
    expect(() => generateFilter([{ operator: op, value: [] } as any])).toThrow(
      msg(op),
    );
  });

  it("AC-1: gt never becomes an equality filter", () => {
    let out: unknown;
    try {
      out = generateFilter([{ field: "price", operator: "gt", value: 10 }]);
    } catch {
      out = undefined;
    }
    expect(out).not.toEqual({ price: 10 });
  });

  it("AC-2: eq maps to field=value and mapOperator(eq) is empty", () => {
    expect(
      generateFilter([{ field: "name", operator: "eq", value: "John" }]),
    ).toEqual({ name: "John" });
    expect(mapOperator("eq")).toBe("");
  });

  it("pin: q field is exempt from the operator check", () => {
    expect(
      generateFilter([{ field: "q", operator: "gt", value: "x" } as any]),
    ).toEqual({ q: "x" });
  });

  it("pin: missing operator acts as eq, unknown or empty string throws", () => {
    expect(generateFilter([{ field: "a", value: 1 } as any])).toEqual({ a: 1 });
    expect(() =>
      generateFilter([{ field: "a", operator: "", value: 1 } as any]),
    ).toThrow(msg(""));
    expect(() =>
      generateFilter([
        { field: "a", operator: "unsupported", value: 1 } as any,
      ]),
    ).toThrow(msg("unsupported"));
  });

  it("pin: mapOperator still returns strings for odd input", () => {
    expect(mapOperator("unsupported" as any)).toBe("");
  });

  it("pin: getList URL unchanged for supported operators", async () => {
    const get = vi.fn().mockResolvedValue({ data: [], headers: {} });
    const provider = dataProvider("https://api.example.test", { get } as any);
    await provider.getList({
      resource: "posts",
      filters: [
        { field: "age", operator: "gte", value: 25 },
        { field: "title", operator: "contains", value: "x" },
      ],
    });
    const url = get.mock.calls[0][0] as string;
    expect(url).toContain("age_gte=25");
    expect(url).toContain("title_like=x");
  });

  it("getList rejects unsupported operator instead of sending equality", async () => {
    const get = vi.fn().mockResolvedValue({ data: [], headers: {} });
    const provider = dataProvider("https://api.example.test", { get } as any);
    await expect(
      provider.getList({
        resource: "posts",
        filters: [{ field: "price", operator: "gt", value: 10 }],
      }),
    ).rejects.toThrow(msg("gt"));
    expect(get).not.toHaveBeenCalled();
  });

  it("AC-4: changeset marks simple-rest as patch", () => {
    const text = readFileSync(
      resolve(root, ".changeset/simple-rest-unsupported-filter-operators.md"),
      "utf8",
    );
    expect(text).toMatch(/"@refinedev\/simple-rest":\s*patch/);
  });
});
