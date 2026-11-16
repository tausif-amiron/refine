import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { vi } from "vitest";

import dataProvider from "../../src/index";

const root = resolve(__dirname, "../../../..");

const walk = async (headers: Record<string, unknown>, rows = 3) => {
  const get = vi.fn().mockResolvedValue({
    data: Array.from({ length: rows }, (_, i) => ({ id: i + 1 })),
    headers,
  });
  const provider = dataProvider("https://api.example.test", { get } as any);
  const result = await provider.getList({
    resource: "posts",
    pagination: { currentPage: 2, pageSize: 5 } as any,
    sorters: [{ field: "id", order: "desc" }],
    meta: { headers: { "x-test": "1" } },
  });
  return { result, get };
};

describe("walk RT-2: getList total (public API, mocked HTTP)", () => {
  it("AC-3: header present gives the header value", async () => {
    const { result } = await walk({ "x-total-count": "1000" });
    expect(result.total).toBe(1000);
  });

  it('AC-2: header "0" gives total 0', async () => {
    const { result } = await walk({ "x-total-count": "0" });
    expect(result.total).toBe(0);
  });

  it("AC-1: missing header falls back to data.length, never NaN", async () => {
    const { result } = await walk({});
    expect(result.total).toBe(3);
    expect(Number.isNaN(result.total)).toBe(false);
  });

  it.each(["", "abc", "-1", "Infinity"])(
    "invalid header %j falls back to data.length",
    async (value) => {
      const { result } = await walk({ "x-total-count": value });
      expect(result.total).toBe(3);
    },
  );

  it("pin: request URL, method and meta headers are unchanged", async () => {
    const { get } = await walk({ "x-total-count": "9" });
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith(
      "https://api.example.test/posts?_end=10&_order=desc&_sort=id&_start=5",
      { headers: { "x-test": "1" } },
    );
  });

  it("AC-1: fallback is documented in README and JSDoc", () => {
    const readme = readFileSync(
      resolve(root, "packages/simple-rest/README.md"),
      "utf8",
    );
    const src = readFileSync(
      resolve(root, "packages/simple-rest/src/provider.ts"),
      "utf8",
    );
    expect(readme).toMatch(/x-total-count[\s\S]*data\.length/);
    expect(src).toMatch(/\*[^\n]*x-total-count[\s\S]*data\.length/);
  });

  it("AC-4: patch changeset for @refinedev/simple-rest exists", () => {
    const cs = readFileSync(
      resolve(root, ".changeset/simple-rest-get-list-total.md"),
      "utf8",
    );
    expect(cs).toMatch(/"@refinedev\/simple-rest":\s*patch/);
    expect(cs).toMatch(/x-total-count/);
  });
});
