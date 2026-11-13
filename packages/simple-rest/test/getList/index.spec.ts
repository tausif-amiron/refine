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
