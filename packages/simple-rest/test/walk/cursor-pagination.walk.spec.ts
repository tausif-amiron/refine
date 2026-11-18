import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { vi } from "vitest";

import dataProvider from "../../src/index";

const root = resolve(__dirname, "../../../..");

const run = async (
  pagination: Record<string, unknown>,
  headers: Record<string, unknown> = {},
  options?: any,
) => {
  const get = vi.fn().mockResolvedValue({
    data: [{ id: 1 }, { id: 2 }],
    headers,
  });
  const provider = dataProvider(
    "https://api.example.test",
    { get } as any,
    options,
  );
  const result = await provider.getList({
    resource: "posts",
    pagination: pagination as any,
  });
  return { result, url: new URL(get.mock.calls[0][0]), get };
};

describe("walk RT-6: simple-rest cursor mode (public API, mocked HTTP)", () => {
  it("AC-3: cursor mode sends cursor and limit, no _start/_end, returns cursor", async () => {
    const { result, url } = await run(
      { mode: "cursor", cursor: "abc", pageSize: 5 },
      { "x-next-cursor": "n1", "x-prev-cursor": "p1" },
    );
    expect(url.searchParams.get("cursor")).toBe("abc");
    expect(url.searchParams.get("limit")).toBe("5");
    expect(url.searchParams.has("_start")).toBe(false);
    expect(url.searchParams.has("_end")).toBe(false);
    expect(result.cursor).toEqual({ next: "n1", prev: "p1" });
  });

  it("AC-3: first page sends no cursor param", async () => {
    const { url } = await run({ mode: "cursor", pageSize: 5 });
    expect(url.searchParams.has("cursor")).toBe(false);
    expect(url.searchParams.get("limit")).toBe("5");
  });

  it("AC-3: param names and cursor reader are configurable", async () => {
    const { url, result } = await run(
      { mode: "cursor", cursor: "abc", pageSize: 5 },
      {},
      {
        cursor: {
          cursorParam: "after",
          limitParam: "take",
          getCursor: () => ({ next: "z" }),
        },
      },
    );
    expect(url.searchParams.get("after")).toBe("abc");
    expect(url.searchParams.get("take")).toBe("5");
    expect(url.searchParams.has("cursor")).toBe(false);
    expect(result.cursor).toEqual({ next: "z" });
  });

  it("pin: offset mode still sends _start/_end", async () => {
    const { url } = await run({ currentPage: 3, pageSize: 5 });
    expect(url.searchParams.get("_start")).toBe("10");
    expect(url.searchParams.get("_end")).toBe("15");
    expect(url.searchParams.has("cursor")).toBe(false);
  });

  it("AC-3/5/6: example, docs and changesets exist", () => {
    const pkg = resolve(
      root,
      "examples/table-antd-cursor-pagination/package.json",
    );
    expect(existsSync(pkg)).toBe(true);
    const scripts = JSON.parse(readFileSync(pkg, "utf8")).scripts;
    for (const s of ["dev", "build", "start"]) expect(scripts[s]).toBeTruthy();
    for (const f of [
      "core-cursor-pagination",
      "simple-rest-cursor-pagination",
      "antd-cursor-pagination",
    ]) {
      const text = readFileSync(resolve(root, `.changeset/${f}.md`), "utf8");
      expect(text).toMatch(/"@refinedev\/[a-z-]+": minor/);
    }
    const docs = readFileSync(
      resolve(root, "documentation/docs/data/packages/simple-rest/index.md"),
      "utf8",
    );
    expect(docs).toMatch(/cursor/i);
  });
});
