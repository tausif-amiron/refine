import axios from "axios";
import nock from "nock";

import JsonServer from "../../src/index";
import { API, mockDelete, mockDeleteFailure } from "./index.mock";

const provider = () => JsonServer(API, axios);

// Ids 11 and 12 avoid the global deleteOne mock registered for /posts/1.
describe("deleteMany", () => {
  afterEach(() => {
    nock.cleanAll();
  });

  it("sends one DELETE per id and resolves in id order", async () => {
    mockDelete(11);
    mockDelete(12);

    const { data } = await provider().deleteMany({
      resource: "posts",
      ids: [11, 12],
    });

    expect(data).toEqual([{ id: 11 }, { id: 12 }]);
  });

  it("sends variables as the request body", async () => {
    mockDelete(11, "delete", { body: { reason: "spam" } });
    mockDelete(12, "delete", { body: { reason: "spam" } });

    const { data } = await provider().deleteMany({
      resource: "posts",
      ids: [11, 12],
      variables: { reason: "spam" },
    });

    expect(data).toHaveLength(2);
  });

  it("sends meta.headers on every request", async () => {
    const reqheaders = { "x-test": "yes" };
    mockDelete(11, "delete", { reqheaders });
    mockDelete(12, "delete", { reqheaders });

    const { data } = await provider().deleteMany({
      resource: "posts",
      ids: [11, 12],
      meta: { headers: reqheaders },
    });

    expect(data).toHaveLength(2);
  });

  it("uses meta.method for every request", async () => {
    mockDelete(11, "post");
    mockDelete(12, "post");

    const { data } = await provider().deleteMany({
      resource: "posts",
      ids: [11, 12],
      meta: { method: "post" },
    });

    expect(data).toEqual([{ id: 11 }, { id: 12 }]);
  });

  it("rejects when one id fails", async () => {
    mockDelete(11);
    mockDeleteFailure(12, 500);

    await expect(
      provider().deleteMany({ resource: "posts", ids: [11, 12] }),
    ).rejects.toMatchObject({ response: { status: 500 } });
  });

  it("resolves to empty data and sends no request for empty ids", async () => {
    const result = await provider().deleteMany({
      resource: "posts",
      ids: [],
    });

    expect(result).toEqual({ data: [] });
  });
});
