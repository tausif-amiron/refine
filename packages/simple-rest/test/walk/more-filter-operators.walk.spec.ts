import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

import dataProvider, { generateFilter } from "../../src/index";

const root = resolve(__dirname, "../../../..");

const msg = (op: string) =>
  `[@refinedev/simple-rest]: \`operator: ${op}\` is not supported. You can create custom data provider. https://refine.dev/docs/api-reference/core/providers/data-provider/#creating-a-data-provider`;

const makeProvider = () => {
  const get = vi.fn().mockResolvedValue({ data: [], headers: {} });
  return {
    get,
    provider: dataProvider("https://api.example.test", { get } as any),
  };
};

describe("walk RT-5: more simple-rest filter operators (public API)", () => {
  it("AC-2: in maps to the repeated-value array", () => {
    expect(
      generateFilter([{ field: "id", operator: "in", value: [1, 2] }]),
    ).toEqual({ id: [1, 2] });
  });

  it("AC-2: getList with in sends repeated params, no _in, no comma", async () => {
    const { get, provider } = makeProvider();
    await provider.getList({
      resource: "posts",
      filters: [{ field: "id", operator: "in", value: [1, 2] }],
    });
    const url = get.mock.calls[0][0] as string;
    expect(url).toContain("id=1&id=2");
    expect(url).not.toContain("id_in");
    expect(url).not.toContain("1%2C2");
    expect(url).not.toContain("1,2");
  });

  it("AC-2: empty in sends no param; scalar in sends field=value", async () => {
    const empty = makeProvider();
    await empty.provider.getList({
      resource: "posts",
      filters: [{ field: "id", operator: "in", value: [] }],
    });
    expect(empty.get.mock.calls[0][0] as string).not.toContain("id=");

    const scalar = makeProvider();
    await scalar.provider.getList({
      resource: "posts",
      filters: [{ field: "id", operator: "in", value: 5 }],
    });
    expect(scalar.get.mock.calls[0][0] as string).toContain("id=5");
  });

  it.each([
    ["startswith", "^foo"],
    ["endswith", "foo$"],
    ["ncontains", "^(?!.*foo).*$"],
  ])("AC-2: %s produces title_like=%s", (op, value) => {
    expect(
      generateFilter([{ field: "title", operator: op as any, value: "foo" }]),
    ).toEqual({ title_like: value });
  });

  it.each([
    ["startswith", "a.b", "^a\\.b"],
    ["endswith", "c++", "c\\+\\+$"],
    ["ncontains", "(draft)", "^(?!.*\\(draft\\)).*$"],
  ])("AC-2: %s escapes regex characters in %s", (op, input, expected) => {
    expect(
      generateFilter([{ field: "title", operator: op as any, value: input }]),
    ).toEqual({ title_like: expected });
  });

  it("AC-2: startswith/endswith regexes match only the intended values", () => {
    const sw = generateFilter([
      { field: "t", operator: "startswith", value: "a.b" },
    ]).t_like;
    expect(new RegExp(sw, "i").test("a.bc")).toBe(true);
    expect(new RegExp(sw, "i").test("axbc")).toBe(false);
    expect(new RegExp(sw, "i").test("xa.b")).toBe(false);
    const ew = generateFilter([
      { field: "t", operator: "endswith", value: "foo" },
    ]).t_like;
    expect(new RegExp(ew, "i").test("barfoo")).toBe(true);
    expect(new RegExp(ew, "i").test("foobar")).toBe(false);
    const nc = generateFilter([
      { field: "t", operator: "ncontains", value: "foo" },
    ]).t_like;
    expect(new RegExp(nc, "i").test("bar")).toBe(true);
    expect(new RegExp(nc, "i").test("xfoox")).toBe(false);
  });

  it("AC-2: getList sends the new operators as _like params", async () => {
    const { get, provider } = makeProvider();
    await provider.getList({
      resource: "posts",
      filters: [{ field: "title", operator: "startswith", value: "foo" }],
    });
    expect(get.mock.calls[0][0] as string).toContain("title_like=%5Efoo");
  });

  it.each(["null", "nnull"])("AC-2: %s throws the unsupported error", (op) => {
    expect(() =>
      generateFilter([{ field: "a", operator: op as any, value: null }]),
    ).toThrow(msg(op));
  });

  it.each([
    ["startswith", "endswith"],
    ["ncontains", "startswith"],
    ["endswith", "endswith"],
  ])("a %s after a %s filter on the same field throws", (second, first) => {
    expect(() =>
      generateFilter([
        { field: "t", operator: first as any, value: "a" },
        { field: "t", operator: second as any, value: "b" },
      ]),
    ).toThrow(/cannot be combined/);
  });

  it("startswith after contains on the same field throws; different fields are fine", () => {
    expect(() =>
      generateFilter([
        { field: "t", operator: "contains", value: "a" },
        { field: "t", operator: "startswith", value: "b" },
      ]),
    ).toThrow(/cannot be combined/);
    expect(
      generateFilter([
        { field: "t", operator: "startswith", value: "a" },
        { field: "u", operator: "endswith", value: "b" },
      ]),
    ).toEqual({ t_like: "^a", u_like: "b$" });
  });

  it("pin: repeated contains on one field is last-wins", () => {
    expect(
      generateFilter([
        { field: "t", operator: "contains", value: "a" },
        { field: "t", operator: "contains", value: "b" },
      ]),
    ).toEqual({ t_like: "b" });
  });

  it("pin: gte maps to _gte and empty filters give {}", () => {
    expect(
      generateFilter([{ field: "age", operator: "gte", value: 25 }]),
    ).toEqual({ age_gte: 25 });
    expect(generateFilter()).toEqual({});
  });

  it.each(["gt", "lt", "between", "nbetween", "nin", "containss"])(
    "pin: %s still throws",
    (op) => {
      expect(() =>
        generateFilter([{ field: "a", operator: op as any, value: 1 }]),
      ).toThrow(msg(op));
    },
  );

  it("AC-1: docs operator table lists every CrudOperators value", () => {
    const docs = readFileSync(
      resolve(root, "documentation/docs/data/packages/simple-rest/index.md"),
      "utf8",
    );
    const section = docs.slice(docs.indexOf("## Filter operators"));
    expect(docs.indexOf("## URL design")).toBeLessThan(
      docs.indexOf("## Filter operators"),
    );
    const ops = [
      "eq",
      "ne",
      "lt",
      "gt",
      "lte",
      "gte",
      "in",
      "nin",
      "ina",
      "nina",
      "contains",
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
      "or",
      "and",
      "eqs",
      "nes",
    ];
    for (const op of ops) {
      expect(section).toContain(`\`${op}\``);
    }
    expect(section).toContain("json-server 0.x");
  });

  it("AC-3: changeset marks simple-rest as minor", () => {
    const text = readFileSync(
      resolve(root, ".changeset/simple-rest-more-filter-operators.md"),
      "utf8",
    );
    expect(text).toMatch(/"@refinedev\/simple-rest":\s*minor/);
    expect(text).toMatch(/startswith/);
  });
});
