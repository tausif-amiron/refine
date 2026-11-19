import type { CrudFilters } from "@refinedev/core";
import { generateFilter } from "../../src/utils/generateFilter";

describe("generateFilter", () => {
  it("returns an empty object when no filters are provided", () => {
    const result = generateFilter();
    expect(result).toEqual({});
  });

  it("creates a filter object based on the provided filters", () => {
    const filters: CrudFilters = [
      { field: "name", operator: "eq", value: "John" },
      { field: "age", operator: "gte", value: 25 },
    ];
    const result = generateFilter(filters);
    expect(result).toEqual({
      name: "John",
      age_gte: 25,
    });
  });

  it.each(["or", "and"])(
    "throws an error for unsupported '%s' operator",
    (operator) => {
      const filters: CrudFilters = [
        { operator: operator as "or" | "and", value: [] },
      ];
      expect(() => generateFilter(filters)).toThrow();
    },
  );

  it("does not call filters.map to loop over the filters", () => {
    const filters: CrudFilters = [
      { field: "name", operator: "eq", value: "John" },
    ];
    const mapSpy = vi.spyOn(filters, "map");
    const result = generateFilter(filters);
    expect(mapSpy).not.toHaveBeenCalled();
    expect(result).toEqual({ name: "John" });
  });

  it("pin: keeps the 'q' filter in the middle and processes filters after it", () => {
    const filters: CrudFilters = [
      { field: "name", operator: "eq", value: "John" },
      { field: "q", operator: "contains", value: "searchValue" },
      { field: "age", operator: "gte", value: 25 },
    ];
    expect(generateFilter(filters)).toEqual({
      name: "John",
      q: "searchValue",
      age_gte: 25,
    });
  });

  it.each(["or", "and"])(
    "pin: throws the unchanged error message for '%s' operator",
    (operator) => {
      const filters: CrudFilters = [
        { operator: operator as "or" | "and", value: [] },
      ];
      expect(() => generateFilter(filters)).toThrow(
        `[@refinedev/simple-rest]: \`operator: ${operator}\` is not supported.`,
      );
    },
  );

  it("pin: ignores conditional filters without a field", () => {
    const filters = [
      { operator: "eq", value: "x" },
      { field: "name", operator: "eq", value: "John" },
    ] as unknown as CrudFilters;
    expect(generateFilter(filters)).toEqual({ name: "John" });
  });

  it("throws for gt instead of returning an equality filter", () => {
    const filters: CrudFilters = [
      { field: "price", operator: "gt", value: 10 },
    ];
    expect(() => generateFilter(filters)).toThrow(
      "[@refinedev/simple-rest]: `operator: gt` is not supported. You can create custom data provider. https://refine.dev/docs/api-reference/core/providers/data-provider/#creating-a-data-provider",
    );
  });

  it.each([
    "eqs",
    "nes",
    "lt",
    "gt",
    "nin",
    "ina",
    "nina",
    "containss",
    "ncontainss",
    "between",
    "nbetween",
    "null",
    "nnull",
    "nstartswith",
    "startswiths",
    "nstartswiths",
    "nendswith",
    "endswiths",
    "nendswiths",
    "unsupported",
    "",
  ])("throws a descriptive error for '%s' operator", (operator) => {
    const filters = [
      { field: "price", operator, value: 10 },
    ] as unknown as CrudFilters;
    expect(() => generateFilter(filters)).toThrow(
      `[@refinedev/simple-rest]: \`operator: ${operator}\` is not supported.`,
    );
  });

  it.each([
    ["eq", "price"],
    ["in", "price"],
    ["ne", "price_ne"],
    ["gte", "price_gte"],
    ["lte", "price_lte"],
    ["contains", "price_like"],
  ])("maps '%s' operator to key '%s'", (operator, key) => {
    const filters = [
      { field: "price", operator, value: 10 },
    ] as unknown as CrudFilters;
    expect(generateFilter(filters)).toEqual({ [key]: 10 });
  });

  it("pin: in keeps the array value under the plain field key", () => {
    expect(
      generateFilter([{ field: "id", operator: "in", value: [1, 2] }]),
    ).toEqual({ id: [1, 2] });
  });

  it("startswith produces a _like regex anchored at the start", () => {
    expect(
      generateFilter([
        { field: "title", operator: "startswith", value: "foo" },
      ]),
    ).toEqual({ title_like: "^foo" });
  });

  it("endswith produces a _like regex anchored at the end", () => {
    expect(
      generateFilter([{ field: "title", operator: "endswith", value: "foo" }]),
    ).toEqual({ title_like: "foo$" });
  });

  it("ncontains produces a _like negative-lookahead regex", () => {
    expect(
      generateFilter([{ field: "title", operator: "ncontains", value: "foo" }]),
    ).toEqual({ title_like: "^(?!.*foo).*$" });
  });

  it("escapes regex characters for startswith, endswith and ncontains", () => {
    expect(
      generateFilter([{ field: "t", operator: "startswith", value: "a.b" }]),
    ).toEqual({ t_like: "^a\\.b" });
    expect(
      generateFilter([{ field: "t", operator: "endswith", value: "c++" }]),
    ).toEqual({ t_like: "c\\+\\+$" });
    expect(
      generateFilter([{ field: "t", operator: "ncontains", value: "(x)" }]),
    ).toEqual({ t_like: "^(?!.*\\(x\\)).*$" });
  });

  it("pin: contains keeps the raw value without escaping", () => {
    expect(
      generateFilter([{ field: "t", operator: "contains", value: "a.b" }]),
    ).toEqual({ t_like: "a.b" });
  });

  it("pin: repeated contains on one field is last-wins", () => {
    expect(
      generateFilter([
        { field: "t", operator: "contains", value: "a" },
        { field: "t", operator: "contains", value: "b" },
      ]),
    ).toEqual({ t_like: "b" });
  });

  it.each(["startswith", "endswith", "ncontains"])(
    "throws when %s would overwrite an existing _like key on the same field",
    (operator) => {
      const first = [
        { field: "t", operator: "contains", value: "a" },
        { field: "t", operator, value: "b" },
      ] as unknown as CrudFilters;
      expect(() => generateFilter(first)).toThrow(/_like/);
      const second = [
        { field: "t", operator, value: "b" },
        { field: "t", operator: "contains", value: "a" },
      ] as unknown as CrudFilters;
      expect(generateFilter(second)).toEqual({ t_like: "a" });
    },
  );

  it("pin: treats a missing operator as eq", () => {
    const filters = [
      { field: "name", value: "John" },
      { field: "age", operator: null, value: 3 },
    ] as unknown as CrudFilters;
    expect(generateFilter(filters)).toEqual({ name: "John", age: 3 });
  });

  it("pin: keeps 'q' exempt from the operator check", () => {
    const filters: CrudFilters = [{ field: "q", operator: "gt", value: "x" }];
    expect(generateFilter(filters)).toEqual({ q: "x" });
  });

  it("creates a filter object with the 'q' field", () => {
    const filters: CrudFilters = [
      { field: "q", operator: "eq", value: "searchValue" },
      { field: "name", operator: "eq", value: "John" },
    ];
    const result = generateFilter(filters);
    expect(result).toEqual({
      q: "searchValue",
      name: "John",
    });
  });
});
