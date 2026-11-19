import axios from "axios";
import nock from "nock";

import JsonServer from "../../src/index";

const API = "https://api.fake-rest.refine.dev";

type Opts = { reqheaders?: Record<string, string> };

/** json-server style: POST /posts echoes the body with an id. */
const mockCreate = (
  body: Record<string, unknown>,
  id: number,
  method: "post" | "patch" | "put" = "post",
  opts: Opts = {},
) =>
  nock(API, opts.reqheaders ? { reqheaders: opts.reqheaders } : {})
    [method]("/posts", body as any)
    .reply(201, { id, ...body });

const mockCreateFailure = (body: Record<string, unknown>) =>
  nock(API)
    .post("/posts", body as any)
    .reply(500, { message: "boom" });

const provider = () => JsonServer(API, axios);

describe("createMany", () => {
  afterEach(() => {
    nock.cleanAll();
  });

  it("sends one POST per item and resolves in input order", async () => {
    mockCreate({ title: "a" }, 1);
    mockCreate({ title: "b" }, 2);

    const { data } = await provider().createMany({
      resource: "posts",
      variables: [{ title: "a" }, { title: "b" }],
    });

    expect(data).toEqual([
      { id: 1, title: "a" },
      { id: 2, title: "b" },
    ]);
  });

  it("sends meta.headers on every request", async () => {
    mockCreate({ title: "a" }, 1, "post", { reqheaders: { "x-test": "yes" } });
    mockCreate({ title: "b" }, 2, "post", { reqheaders: { "x-test": "yes" } });

    const { data } = await provider().createMany({
      resource: "posts",
      variables: [{ title: "a" }, { title: "b" }],
      meta: { headers: { "x-test": "yes" } },
    });

    expect(data).toHaveLength(2);
  });

  it("uses meta.method for every request", async () => {
    mockCreate({ title: "a" }, 1, "patch");
    mockCreate({ title: "b" }, 2, "patch");

    const { data } = await provider().createMany({
      resource: "posts",
      variables: [{ title: "a" }, { title: "b" }],
      meta: { method: "patch" },
    });

    expect(data).toEqual([
      { id: 1, title: "a" },
      { id: 2, title: "b" },
    ]);
  });

  it("rejects when one request fails", async () => {
    mockCreate({ title: "a" }, 1);
    mockCreateFailure({ title: "b" });

    await expect(
      provider().createMany({
        resource: "posts",
        variables: [{ title: "a" }, { title: "b" }],
      }),
    ).rejects.toMatchObject({ response: { status: 500 } });
  });

  it("resolves to empty data and sends no request for empty variables", async () => {
    const result = await provider().createMany({
      resource: "posts",
      variables: [],
    });

    expect(result).toEqual({ data: [] });
  });
});
