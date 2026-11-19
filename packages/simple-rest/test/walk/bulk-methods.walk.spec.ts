import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import axios from "axios";
import nock from "nock";

import dataProvider from "../../src/index";

const root = resolve(__dirname, "../../../..");

type Hit = { method: string; url: string; body: string; headers: any };

let server: Server;
let base = "";
let hits: Hit[] = [];

beforeAll(async () => {
  nock.enableNetConnect("127.0.0.1");
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      hits.push({
        method: req.method!,
        url: req.url!,
        body,
        headers: req.headers,
      });
      const id = req.url!.split("/").pop();
      // id 404 / 500 fail; stagger responses so order is not arrival order
      const delay = id === "1" ? 80 : 0;
      setTimeout(() => {
        if (id === "404" || id === "500" || body.includes('"fail"')) {
          res.statusCode = id === "404" ? 404 : 500;
          res.end("{}");
          return;
        }
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ id, echo: body ? JSON.parse(body) : null }));
      }, delay);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  nock.disableNetConnect();
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
});

beforeEach(() => {
  hits = [];
});

const provider = () => dataProvider(base, axios.create());

describe("walk: bulk methods through the public provider", () => {
  it("AC-1: provider exposes createMany, updateMany and deleteMany", () => {
    const p = provider();
    expect(typeof p.createMany).toBe("function");
    expect(typeof p.updateMany).toBe("function");
    expect(typeof p.deleteMany).toBe("function");
    const src = readFileSync(
      resolve(root, "packages/simple-rest/src/provider.ts"),
      "utf8",
    );
    expect(src).toContain("Required<DataProvider>");
    expect(src).not.toMatch(/Omit<\s*Required<DataProvider>/);
  });

  it("createMany posts one request per item and keeps input order", async () => {
    const res = await provider().createMany!({
      resource: "posts",
      variables: [{ t: "a" }, { t: "b" }],
    });
    expect(hits).toHaveLength(2);
    expect(hits.every((h) => h.method === "POST" && h.url === "/posts")).toBe(
      true,
    );
    expect(res.data.map((d: any) => d.echo.t)).toEqual(["a", "b"]);
  });

  it("updateMany patches each id with variables, in id order", async () => {
    const res = await provider().updateMany!({
      resource: "posts",
      ids: [1, 2],
      variables: { s: "x" },
    });
    expect(hits.map((h) => `${h.method} ${h.url}`).sort()).toEqual([
      "PATCH /posts/1",
      "PATCH /posts/2",
    ]);
    expect(res.data.map((d: any) => d.id)).toEqual(["1", "2"]);
    expect(res.data[0].echo).toEqual({ s: "x" });
  });

  it("deleteMany deletes each id with variables as data, in id order", async () => {
    const res = await provider().deleteMany!({
      resource: "posts",
      ids: [1, 2],
      variables: { why: "r" },
    });
    expect(hits.every((h) => h.method === "DELETE")).toBe(true);
    expect(hits.map((h) => h.url).sort()).toEqual(["/posts/1", "/posts/2"]);
    expect(hits[0].body).toBe(JSON.stringify({ why: "r" }));
    expect(res.data.map((d: any) => d.id)).toEqual(["1", "2"]);
  });

  it("all bulk methods send meta.headers on every request", async () => {
    const meta = { headers: { "x-walk": "yes" } };
    const p = provider();
    await p.createMany!({ resource: "posts", variables: [{}, {}], meta });
    await p.updateMany!({
      resource: "posts",
      ids: [1, 2],
      variables: {},
      meta,
    });
    await p.deleteMany!({
      resource: "posts",
      ids: [1, 2],
      variables: {},
      meta,
    });
    expect(hits).toHaveLength(6);
    expect(hits.every((h) => h.headers["x-walk"] === "yes")).toBe(true);
  });

  it("meta.method overrides the HTTP method for updateMany and createMany", async () => {
    const p = provider();
    await p.updateMany!({
      resource: "posts",
      ids: [1, 2],
      variables: {},
      meta: { method: "put" },
    });
    await p.createMany!({
      resource: "posts",
      variables: [{}, {}],
      meta: { method: "patch" },
    });
    expect(hits.slice(0, 2).every((h) => h.method === "PUT")).toBe(true);
    expect(hits.slice(2).every((h) => h.method === "PATCH")).toBe(true);
  });

  it("rejects on partial failure instead of resolving partial data", async () => {
    const p = provider();
    await expect(
      p.updateMany!({ resource: "posts", ids: [1, 404], variables: {} }),
    ).rejects.toMatchObject({ response: { status: 404 } });
    await expect(
      p.deleteMany!({ resource: "posts", ids: [1, 500], variables: {} }),
    ).rejects.toMatchObject({ response: { status: 500 } });
    await expect(
      p.createMany!({
        resource: "posts",
        variables: [{ a: 1 }, { fail: true }],
      }),
    ).rejects.toBeDefined();
  });

  it("empty input sends no requests and resolves to { data: [] }", async () => {
    const p = provider();
    expect(await p.createMany!({ resource: "posts", variables: [] })).toEqual({
      data: [],
    });
    expect(
      await p.updateMany!({ resource: "posts", ids: [], variables: {} }),
    ).toEqual({ data: [] });
    expect(
      await p.deleteMany!({ resource: "posts", ids: [], variables: {} }),
    ).toEqual({ data: [] });
    expect(hits).toHaveLength(0);
  });

  it("AC-4/AC-5: docs and minor changeset exist", () => {
    const doc = readFileSync(
      resolve(root, "documentation/docs/data/packages/simple-rest/index.md"),
      "utf8",
    );
    for (const m of ["createMany", "updateMany", "deleteMany", "Promise.all"]) {
      expect(doc).toContain(m);
    }
    const cs = readFileSync(
      resolve(root, ".changeset/simple-rest-bulk-methods.md"),
      "utf8",
    );
    expect(cs).toMatch(/"@refinedev\/simple-rest":\s*minor/);
  });
});
