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
