import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import axios from "axios";
import nock from "nock";
import { vi } from "vitest";

import dataProvider from "../../src/index";

const root = resolve(__dirname, "../../../..");

let server: Server;
let base = "";
let hits = 0;
let closed = 0;

beforeAll(async () => {
  nock.enableNetConnect("127.0.0.1");
  server = createServer((req, res) => {
    hits += 1;
    res.on("close", () => {
      if (!res.writableFinished) closed += 1;
    });
    setTimeout(() => {
      res.setHeader("content-type", "application/json");
      res.setHeader("x-total-count", "1");
      res.end(JSON.stringify(req.url?.includes("?") ? [{ id: 1 }] : { id: 1 }));
    }, 300);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  nock.disableNetConnect();
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
});

const provider = () => dataProvider(base, axios.create());

const calls: Record<string, (meta?: any) => Promise<unknown>> = {
  getList: (meta) => provider().getList({ resource: "posts", meta }),
  getMany: (meta) =>
    provider().getMany!({ resource: "posts", ids: [1, 2], meta }),
  getOne: (meta) => provider().getOne({ resource: "posts", id: 1, meta }),
  "custom GET": (meta) =>
    provider().custom!({ url: `${base}/posts`, method: "get", meta }),
};

describe("walk RT-7: simple-rest signal forwarding (real axios, local server)", () => {
  describe.each(Object.keys(calls))("%s", (name) => {
    it("AC-1: aborting in flight rejects and cancels the request", async () => {
      const before = closed;
      const hitsBefore = hits;
      const ac = new AbortController();
      const p = calls[name]({ signal: ac.signal });
      const settled = p.then(
        () => "resolved",
        () => "rejected",
      );
      // abort only once the server has received the request
      await vi.waitFor(() => expect(hits).toBeGreaterThan(hitsBefore), {
        timeout: 2000,
      });
      ac.abort();
      expect(await settled).toBe("rejected");
      await vi.waitFor(() => expect(closed).toBeGreaterThan(before), {
        timeout: 2000,
      });
    });

    it("already-aborted signal rejects", async () => {
      const ac = new AbortController();
      ac.abort();
      await expect(calls[name]({ signal: ac.signal })).rejects.toBeDefined();
    });

    it("AC-3: without a signal the request completes", async () => {
      await expect(calls[name]({})).resolves.toBeDefined();
      await expect(calls[name](undefined)).resolves.toBeDefined();
    });
  });

  it("pin: no signal key in config when meta is missing", async () => {
    const get = vi.fn().mockResolvedValue({ data: [], headers: {} });
    await dataProvider("http://x", { get } as any).getList({
      resource: "posts",
      pagination: { mode: "off" } as any,
    });
    expect(get).toHaveBeenCalledWith("http://x/posts", { headers: undefined });
    expect(Object.keys(get.mock.calls[0][1])).not.toContain("signal");
  });

  it("signal is forwarded as the axios `signal` option", async () => {
    const ac = new AbortController();
    const get = vi.fn().mockResolvedValue({ data: [], headers: {} });
    await dataProvider("http://x", { get } as any).getOne({
      resource: "posts",
      id: 1,
      meta: { signal: ac.signal, headers: { a: "b" } },
    });
    expect(get.mock.calls[0][1]).toEqual({
      headers: { a: "b" },
      signal: ac.signal,
    });
  });

  it("pin: writes and non-GET custom do not forward the signal", async () => {
    const ac = new AbortController();
    const c = {
      post: vi.fn().mockResolvedValue({ data: {} }),
      patch: vi.fn().mockResolvedValue({ data: {} }),
      delete: vi.fn().mockResolvedValue({ data: {} }),
      put: vi.fn().mockResolvedValue({ data: {} }),
    };
    const p = dataProvider("http://x", c as any);
    const meta = { signal: ac.signal };
    await p.create({ resource: "a", variables: {}, meta });
    await p.update({ resource: "a", id: 1, variables: {}, meta });
    await p.deleteOne({ resource: "a", id: 1, meta });
    for (const method of ["post", "put", "patch", "delete"] as const) {
      await p.custom!({ url: "http://x/a", method, meta });
    }
    for (const fn of Object.values(c)) {
      for (const call of fn.mock.calls) {
        for (const arg of call) {
          expect(arg && typeof arg === "object" ? "signal" in arg : false).toBe(
            false,
          );
        }
      }
    }
  });

  it("AC-4: docs mention meta.signal", () => {
    const doc = readFileSync(
      resolve(root, "documentation/docs/data/packages/simple-rest/index.md"),
      "utf8",
    );
    expect(doc).toMatch(/meta\.signal/);
  });

  it("AC-5: minor changesets for simple-rest and rest", () => {
    const a = readFileSync(
      resolve(root, ".changeset/simple-rest-abort-signal.md"),
      "utf8",
    );
    const b = readFileSync(
      resolve(root, ".changeset/rest-abort-signal.md"),
      "utf8",
    );
    expect(a).toMatch(/"@refinedev\/simple-rest":\s*minor/);
    expect(b).toMatch(/"@refinedev\/rest":\s*minor/);
    expect(a).toMatch(/signal/);
    expect(b).toMatch(/signal/);
  });
});
