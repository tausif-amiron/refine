import axios from "axios";
import { vi } from "vitest";

import JsonServer from "../../src/index";

describe("getList", () => {
  it("correct response", async () => {
    const response = await JsonServer(
      "https://api.fake-rest.refine.dev",
      axios,
    ).getList({ resource: "posts" });

    expect(response.data[0]["id"]).toBe(1);
    expect(response.data[0]["title"]).toBe(
      "Mollitia ipsam nisi in porro velit asperiores et quaerat dolorem.",
    );
    expect(response.total).toBe(1000);
  });

  it("correct sorting response", async () => {
    const response = await JsonServer(
      "https://api.fake-rest.refine.dev",
      axios,
    ).getList({
      resource: "posts",
      sorters: [
        {
          field: "id",
          order: "asc",
        },
      ],
    });

    expect(response.data[0]["id"]).toBe(1);
    expect(response.data[0]["title"]).toBe(
      "Mollitia ipsam nisi in porro velit asperiores et quaerat dolorem.",
    );
    expect(response.total).toBe(1000);
  });

  it("correct filter response", async () => {
    const response = await JsonServer(
      "https://api.fake-rest.refine.dev",
      axios,
    ).getList({
      resource: "posts",
      filters: [
        {
          field: "category.id",
          operator: "eq",
          value: ["1"],
        },
      ],
    });

    expect(response.data[0]["category"]["id"]).toBe(1);
    expect(response.total).toBe(17);
  });

  it("correct filter and sort response", async () => {
    const response = await JsonServer(
      "https://api.fake-rest.refine.dev",
      axios,
    ).getList({
      resource: "posts",
      filters: [
        {
          field: "category.id",
          operator: "eq",
          value: ["1"],
        },
      ],
      sorters: [
        {
          field: "id",
          order: "asc",
        },
      ],
    });

    expect(response.data[0]["id"]).toBe(44);
    expect(response.total).toBe(17);
  });

  it("shouldn't have '?' on request url when filters, sorters and pagination is empty", async () => {
    const mockAxios = vi.spyOn(axios, "get");

    await JsonServer("https://api.fake-rest.refine.dev", axios).getList({
      resource: "categories",
      filters: [],
      sorters: [],
      pagination: {
        mode: "off",
      },
    });

    expect(mockAxios).toHaveBeenCalledWith(
      "https://api.fake-rest.refine.dev/categories",
      {
        headers: undefined,
      },
    );

    mockAxios.mockRestore();
    mockAxios.mockClear();
  });
});

describe("getList filter operators", () => {
  const run = async (filters: any[]) => {
    const get = vi.fn().mockResolvedValue({ data: [], headers: {} });
    const provider = JsonServer("https://api.example.test", { get } as any);
    await provider.getList({ resource: "posts", filters });
    return get.mock.calls[0][0] as string;
  };

  it("pin: in sends repeated params without _in suffix or commas", async () => {
    const url = await run([{ field: "id", operator: "in", value: [1, 2] }]);
    expect(url).toContain("id=1&id=2");
    expect(url).not.toContain("id_in");
    expect(url).not.toContain("id=1,2");
    expect(url).not.toContain("id=1%2C2");
  });

  it("pin: in with an empty array sends no param", async () => {
    const url = await run([{ field: "id", operator: "in", value: [] }]);
    expect(url).not.toContain("id=");
  });

  it("pin: in with a scalar sends field=value", async () => {
    const url = await run([{ field: "id", operator: "in", value: 3 }]);
    expect(url).toContain("id=3");
  });

  it("startswith requests title_like=^foo", async () => {
    const url = await run([
      { field: "title", operator: "startswith", value: "foo" },
    ]);
    expect(url).toContain("title_like=%5Efoo");
  });

  it("endswith requests title_like=foo$", async () => {
    const url = await run([
      { field: "title", operator: "endswith", value: "foo" },
    ]);
    expect(url).toContain("title_like=foo%24");
  });

  it("ncontains requests the negative-lookahead regex", async () => {
    const url = await run([
      { field: "title", operator: "ncontains", value: "foo" },
    ]);
    expect(decodeURIComponent(url)).toContain("title_like=^(?!.*foo).*$");
  });
});

describe("getList total from x-total-count", () => {
  const apiUrl = "https://api.fake-rest.refine.dev";
  const rows = [{ id: 1 }, { id: 2 }, { id: 3 }];

  const clientReplying = (response: { data: unknown; headers?: unknown }) => {
    const get = vi.fn().mockResolvedValue(response);
    const post = vi.fn().mockResolvedValue(response);
    return { client: { get, post } as any, get, post };
  };

  it("pin: returns the header value as total when x-total-count is 1000", async () => {
    const { client } = clientReplying({
      data: rows,
      headers: { "x-total-count": "1000" },
    });

    const response = await JsonServer(apiUrl, client).getList({
      resource: "posts",
    });

    expect(response.total).toBe(1000);
    expect(response.data).toEqual(rows);
  });

  it("pin: returns the header value as total when x-total-count is 1", async () => {
    const { client } = clientReplying({
      data: rows,
      headers: { "x-total-count": "1" },
    });

    const response = await JsonServer(apiUrl, client).getList({
      resource: "posts",
    });

    expect(response.total).toBe(1);
  });

  it('returns total 0 when x-total-count is "0" and does not fall back to data.length', async () => {
    const { client } = clientReplying({
      data: rows,
      headers: { "x-total-count": "0" },
    });

    const response = await JsonServer(apiUrl, client).getList({
      resource: "posts",
    });

    expect(response.total).toBe(0);
  });

  it("pin: falls back to data.length when the x-total-count header is missing", async () => {
    const { client } = clientReplying({ data: rows, headers: {} });

    const response = await JsonServer(apiUrl, client).getList({
      resource: "posts",
    });

    expect(response.total).toBe(rows.length);
    expect(Number.isNaN(response.total)).toBe(false);
  });

  it("falls back to data.length when the response has no headers object", async () => {
    const { client } = clientReplying({ data: rows });

    const response = await JsonServer(apiUrl, client).getList({
      resource: "posts",
    });

    expect(response.total).toBe(rows.length);
  });

  it("pin: falls back to data.length when x-total-count is not a number", async () => {
    const { client } = clientReplying({
      data: rows,
      headers: { "x-total-count": "abc" },
    });

    const response = await JsonServer(apiUrl, client).getList({
      resource: "posts",
    });

    expect(response.total).toBe(rows.length);
  });

  it("pin: falls back to data.length when x-total-count is an empty string", async () => {
    const { client } = clientReplying({
      data: rows,
      headers: { "x-total-count": "" },
    });

    const response = await JsonServer(apiUrl, client).getList({
      resource: "posts",
    });

    expect(response.total).toBe(rows.length);
  });

  it("falls back to data.length when x-total-count is negative (-1)", async () => {
    const { client } = clientReplying({
      data: rows,
      headers: { "x-total-count": "-1" },
    });

    const response = await JsonServer(apiUrl, client).getList({
      resource: "posts",
    });

    expect(response.total).toBe(rows.length);
  });

  it("falls back to data.length when x-total-count is not finite", async () => {
    const { client } = clientReplying({
      data: rows,
      headers: { "x-total-count": "Infinity" },
    });

    const response = await JsonServer(apiUrl, client).getList({
      resource: "posts",
    });

    expect(response.total).toBe(rows.length);
  });

  it("pin: keeps the request URL, query parameters, method and meta headers unchanged", async () => {
    const { client, get, post } = clientReplying({
      data: rows,
      headers: { "x-total-count": "3" },
    });

    await JsonServer(apiUrl, client).getList({
      resource: "posts",
      pagination: { currentPage: 2, pageSize: 5 },
      sorters: [{ field: "id", order: "desc" }],
      filters: [{ field: "status", operator: "eq", value: "draft" }],
      meta: { headers: { "x-custom": "yes" } },
    });

    expect(get).toHaveBeenCalledWith(
      `${apiUrl}/posts?_end=10&_order=desc&_sort=id&_start=5&status=draft`,
      { headers: { "x-custom": "yes" } },
    );

    await JsonServer(apiUrl, client).getList({
      resource: "posts",
      meta: { method: "post" },
    });

    expect(post).toHaveBeenCalledWith(`${apiUrl}/posts?_end=10&_start=0`, {
      headers: undefined,
    });
  });
});

describe("getList cursor mode", () => {
  const apiUrl = "https://api.fake-rest.refine.dev";
  const rows = [{ id: 1 }, { id: 2 }];

  const clientReplying = (headers?: Record<string, string>) => {
    const get = vi.fn().mockResolvedValue({ data: rows, headers });
    return { client: { get } as any, get };
  };

  it("sends the default cursor and limit params and no _start / _end", async () => {
    const { client, get } = clientReplying();

    await JsonServer(apiUrl, client).getList({
      resource: "posts",
      pagination: { mode: "cursor", cursor: "abc", pageSize: 5 },
    });

    expect(get).toHaveBeenCalledWith(`${apiUrl}/posts?cursor=abc&limit=5`, {
      headers: undefined,
    });
  });

  it("omits the cursor param on the first page", async () => {
    const { client, get } = clientReplying();

    await JsonServer(apiUrl, client).getList({
      resource: "posts",
      pagination: { mode: "cursor", pageSize: 5 },
    });

    expect(get).toHaveBeenCalledWith(`${apiUrl}/posts?limit=5`, {
      headers: undefined,
    });
  });

  it("defaults the page size to 10", async () => {
    const { client, get } = clientReplying();

    await JsonServer(apiUrl, client).getList({
      resource: "posts",
      pagination: { mode: "cursor" },
    });

    expect(get.mock.calls[0][0]).toBe(`${apiUrl}/posts?limit=10`);
  });

  it("returns cursor.next and cursor.prev from the default response headers", async () => {
    const { client } = clientReplying({
      "x-next-cursor": "n1",
      "x-prev-cursor": "p1",
    });

    const response = await JsonServer(apiUrl, client).getList({
      resource: "posts",
      pagination: { mode: "cursor" },
    });

    expect(response.cursor).toEqual({ next: "n1", prev: "p1" });
    expect(response.data).toEqual(rows);
  });

  it("returns undefined cursors when the headers are absent", async () => {
    const { client } = clientReplying({});

    const response = await JsonServer(apiUrl, client).getList({
      resource: "posts",
      pagination: { mode: "cursor" },
    });

    expect(response.cursor).toEqual({ next: undefined, prev: undefined });
  });

  it("returns the x-total-count total in cursor mode when present", async () => {
    const { client } = clientReplying({ "x-total-count": "42" });

    const response = await JsonServer(apiUrl, client).getList({
      resource: "posts",
      pagination: { mode: "cursor" },
    });

    expect(response.total).toBe(42);
  });

  it("returns total undefined in cursor mode when x-total-count is absent", async () => {
    const { client } = clientReplying({});

    const response = await JsonServer(apiUrl, client).getList({
      resource: "posts",
      pagination: { mode: "cursor" },
    });

    expect(response.total).toBeUndefined();
  });

  it("uses configured param names and getCursor", async () => {
    const { client, get } = clientReplying({ link: "x" });
    const getCursor = vi.fn().mockReturnValue({ next: "N", prev: "P" });

    const response = await JsonServer(apiUrl, client, {
      cursor: { cursorParam: "after", limitParam: "per_page", getCursor },
    }).getList({
      resource: "posts",
      pagination: { mode: "cursor", cursor: "c1", pageSize: 3 },
    });

    expect(get.mock.calls[0][0]).toBe(`${apiUrl}/posts?after=c1&per_page=3`);
    expect(getCursor).toHaveBeenCalledWith(
      expect.objectContaining({ data: rows, headers: { link: "x" } }),
    );
    expect(response.cursor).toEqual({ next: "N", prev: "P" });
  });

  it("keeps default names for options that are not configured", async () => {
    const { client, get } = clientReplying();

    await JsonServer(apiUrl, client, {
      cursor: { cursorParam: "after" },
    }).getList({
      resource: "posts",
      pagination: { mode: "cursor", cursor: "c1", pageSize: 3 },
    });

    expect(get.mock.calls[0][0]).toBe(`${apiUrl}/posts?after=c1&limit=3`);
  });

  it("pin: offset mode ignores the cursor options and sends _start / _end", async () => {
    const { client, get } = clientReplying({ "x-next-cursor": "n" });

    const response = await JsonServer(apiUrl, client, {
      cursor: { cursorParam: "after", limitParam: "per_page" },
    } as any).getList({
      resource: "posts",
      pagination: { mode: "server", currentPage: 3, pageSize: 4 },
    });

    expect(get.mock.calls[0][0]).toBe(`${apiUrl}/posts?_end=12&_start=8`);
    expect(response.cursor).toBeUndefined();
  });
});
