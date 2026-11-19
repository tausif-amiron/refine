import axios from "axios";
import nock from "nock";

import JsonServer from "../../src/index";
import { API, mockUpdate, mockUpdateFailure } from "./index.mock";

const provider = () => JsonServer(API, axios);

describe("updateMany", () => {
  afterEach(() => {
    nock.cleanAll();
  });

  it("sends one PATCH per id and resolves in id order", async () => {
    mockUpdate(1, { title: "x" });
    mockUpdate(2, { title: "x" });

    const { data } = await provider().updateMany({
      resource: "posts",
      ids: [1, 2],
      variables: { title: "x" },
    });

    expect(data).toEqual([
      { id: 1, title: "x" },
      { id: 2, title: "x" },
    ]);
  });

  it("sends meta.headers on every request", async () => {
    const reqheaders = { "x-test": "yes" };
    mockUpdate(1, { title: "x" }, "patch", { reqheaders });
    mockUpdate(2, { title: "x" }, "patch", { reqheaders });

    const { data } = await provider().updateMany({
      resource: "posts",
      ids: [1, 2],
      variables: { title: "x" },
      meta: { headers: reqheaders },
    });

    expect(data).toHaveLength(2);
  });

  it("uses meta.method for every request", async () => {
    mockUpdate(1, { title: "x" }, "put");
    mockUpdate(2, { title: "x" }, "put");

    const { data } = await provider().updateMany({
      resource: "posts",
      ids: [1, 2],
      variables: { title: "x" },
      meta: { method: "put" },
    });

    expect(data).toEqual([
      { id: 1, title: "x" },
      { id: 2, title: "x" },
    ]);
  });

  it("rejects when one id fails", async () => {
    mockUpdate(1, { title: "x" });
    mockUpdateFailure(2, 404);

    await expect(
      provider().updateMany({
        resource: "posts",
        ids: [1, 2],
        variables: { title: "x" },
      }),
    ).rejects.toMatchObject({ response: { status: 404 } });
  });

  it("resolves to empty data and sends no request for empty ids", async () => {
    const result = await provider().updateMany({
      resource: "posts",
      ids: [],
      variables: { title: "x" },
    });

    expect(result).toEqual({ data: [] });
  });
});
