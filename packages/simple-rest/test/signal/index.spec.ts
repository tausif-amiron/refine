import axios from "axios";
import type { AxiosInstance, InternalAxiosRequestConfig } from "axios";

import dataProvider from "../../src/index";

const API_URL = "https://api.fake-rest.refine.dev";

const makeClient = () => {
  const configs: InternalAxiosRequestConfig[] = [];
  const finished: string[] = [];

  // Fake adapter: rejects when config.signal aborts, otherwise replies after a short delay.
  const client: AxiosInstance = axios.create({
    adapter: (config) =>
      new Promise((resolve, reject) => {
        configs.push(config);
        if (config.signal?.aborted) {
          reject(new axios.CanceledError("canceled", config));
          return;
        }
        const timer = setTimeout(() => {
          finished.push(String(config.url));
          resolve({
            data: [],
            status: 200,
            statusText: "OK",
            headers: {},
            config,
          });
        }, 30);
        config.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new axios.CanceledError("canceled", config));
        });
      }),
  });

  return { client, configs, finished };
};

type Call = (
  provider: ReturnType<typeof dataProvider>,
  meta?: Record<string, any>,
) => Promise<unknown>;

const calls: Record<string, Call> = {
  getList: (p, meta) => p.getList({ resource: "posts", meta }),
  getMany: (p, meta) => p.getMany({ resource: "posts", ids: [1, 2], meta }),
  getOne: (p, meta) => p.getOne({ resource: "posts", id: 1, meta }),
  "custom GET": (p, meta) =>
    p.custom({ url: `${API_URL}/posts`, method: "get", meta } as any),
};

describe("meta.signal forwarding", () => {
  describe.each(Object.keys(calls))("%s", (name) => {
    const call = calls[name];

    it("passes meta.signal as the signal option in the axios config", async () => {
      const { client, configs } = makeClient();
      const controller = new AbortController();

      await call(dataProvider(API_URL, client), { signal: controller.signal });

      expect(configs).toHaveLength(1);
      expect(configs[0].signal).toBe(controller.signal);
    });

    it("rejects and cancels the request when the signal aborts in flight", async () => {
      const { client, finished } = makeClient();
      const controller = new AbortController();

      const promise = call(dataProvider(API_URL, client), {
        signal: controller.signal,
      });
      controller.abort();

      await expect(promise).rejects.toBeDefined();
      await new Promise((r) => setTimeout(r, 60));
      expect(finished).toHaveLength(0);
    });

    it("rejects without finishing when the signal is already aborted", async () => {
      const { client, finished } = makeClient();
      const controller = new AbortController();
      controller.abort();

      await expect(
        call(dataProvider(API_URL, client), { signal: controller.signal }),
      ).rejects.toBeDefined();
      await new Promise((r) => setTimeout(r, 60));
      expect(finished).toHaveLength(0);
    });

    it("pin: has no signal key in the axios config when meta has no signal", async () => {
      const { client, configs } = makeClient();

      await call(dataProvider(API_URL, client), { headers: { "x-a": "1" } });
      await call(dataProvider(API_URL, client), undefined);

      expect(configs).toHaveLength(2);
      for (const config of configs) {
        expect(config.signal).toBeUndefined();
      }
    });
  });

  it("getList passes the signal together with the headers option", async () => {
    const { client, configs } = makeClient();
    const controller = new AbortController();

    await dataProvider(API_URL, client).getList({
      resource: "posts",
      meta: { headers: { "x-a": "1" }, signal: controller.signal },
    });

    expect(configs[0].signal).toBe(controller.signal);
    expect(configs[0].headers.get("x-a")).toBe("1");
  });

  it("pin: getList without signal calls httpClient.get(url, { headers: undefined })", async () => {
    const get = vi.fn().mockResolvedValue({ data: [], headers: {} });
    const client = { get } as unknown as AxiosInstance;

    await dataProvider(API_URL, client).getList({
      resource: "posts",
      pagination: { mode: "off" },
    });

    expect(get).toHaveBeenCalledWith(`${API_URL}/posts`, {
      headers: undefined,
    });
    expect(Object.keys(get.mock.calls[0][1])).not.toContain("signal");
  });

  it("pin: create, update and deleteOne do not forward meta.signal", async () => {
    const post = vi.fn().mockResolvedValue({ data: {} });
    const patch = vi.fn().mockResolvedValue({ data: {} });
    const del = vi.fn().mockResolvedValue({ data: {} });
    const client = { post, patch, delete: del } as unknown as AxiosInstance;
    const provider = dataProvider(API_URL, client);
    const meta = { signal: new AbortController().signal };

    await provider.create({ resource: "posts", variables: { a: 1 }, meta });
    await provider.update({
      resource: "posts",
      id: 1,
      variables: { a: 1 },
      meta,
    });
    await provider.deleteOne({ resource: "posts", id: 1, meta });

    expect(post).toHaveBeenCalledWith(
      `${API_URL}/posts`,
      { a: 1 },
      {
        headers: undefined,
      },
    );
    expect(patch).toHaveBeenCalledWith(
      `${API_URL}/posts/1`,
      { a: 1 },
      {
        headers: undefined,
      },
    );
    expect(del).toHaveBeenCalledWith(`${API_URL}/posts/1`, {
      data: undefined,
      headers: undefined,
    });
  });

  it("pin: custom with post, put, patch and delete sends the same config", async () => {
    const fn = vi.fn().mockResolvedValue({ data: {} });
    const client = {
      post: fn,
      put: fn,
      patch: fn,
      delete: fn,
    } as unknown as AxiosInstance;
    const provider = dataProvider(API_URL, client);
    const meta = { signal: new AbortController().signal };

    for (const method of ["post", "put", "patch"] as const) {
      fn.mockClear();
      await provider.custom({
        url: `${API_URL}/x`,
        method,
        payload: { a: 1 },
        meta,
      } as any);
      expect(fn).toHaveBeenCalledWith(
        `${API_URL}/x`,
        { a: 1 },
        {
          headers: undefined,
        },
      );
    }

    fn.mockClear();
    await provider.custom({
      url: `${API_URL}/x`,
      method: "delete",
      payload: { a: 1 },
      meta,
    } as any);
    expect(fn).toHaveBeenCalledWith(`${API_URL}/x`, {
      data: { a: 1 },
      headers: undefined,
    });
  });
});
