import nock from "nock";
import { API_URL, createDataProvider } from "..";

const getManyOptions = {
  getMany: {
    buildQueryParams: async (params: any) => ({ ids: params.ids.join(",") }),
    mapResponse: async (response: Response): Promise<any[]> =>
      await response.json(),
  },
};

// Replies after a delay; aborts the controller once the request reaches nock.
const delayedGet = (path: string, controller?: AbortController, host = API_URL) => {
  nock.cleanAll();
  const scope = nock(host)
    .get(path)
    .query(true)
    .delay(200)
    .reply(200, [{ id: 1 }]);
  if (controller) {
    scope.on("request", () => controller.abort());
  }
  return scope;
};

describe("meta.signal forwarding", () => {
  const { dataProvider } = createDataProvider(API_URL, getManyOptions);

  describe("aborting an in-flight request", () => {
    it("getList rejects when the signal is aborted", async () => {
      const controller = new AbortController();
      delayedGet("/posts", controller);

      await expect(
        dataProvider.getList({
          resource: "posts",
          meta: { signal: controller.signal },
        }),
      ).rejects.toBeDefined();
    });

    it("getOne rejects when the signal is aborted", async () => {
      const controller = new AbortController();
      delayedGet("/posts/1", controller);

      await expect(
        dataProvider.getOne({
          resource: "posts",
          id: 1,
          meta: { signal: controller.signal },
        }),
      ).rejects.toBeDefined();
    });

    it("getMany rejects when the signal is aborted", async () => {
      const controller = new AbortController();
      delayedGet("/posts", controller);

      await expect(
        dataProvider.getMany!({
          resource: "posts",
          ids: [1, 2],
          meta: { signal: controller.signal },
        }),
      ).rejects.toBeDefined();
    });

    it("custom GET rejects when the signal is aborted", async () => {
      const controller = new AbortController();
      delayedGet("/custom", controller, "https://custom.com");

      await expect(
        dataProvider.custom!({
          method: "get",
          url: "https://custom.com/custom",
          meta: { signal: controller.signal },
        }),
      ).rejects.toBeDefined();
    });

    it("custom POST ignores the signal and completes", async () => {
      nock.cleanAll();
      nock("https://custom.com")
        .post("/custom-write")
        .delay(50)
        .reply(201, { ok: true });
      const controller = new AbortController();
      const promise = dataProvider.custom!({
        method: "post",
        url: "https://custom.com/custom-write",
        payload: { a: 1 },
        meta: { signal: controller.signal },
      });
      controller.abort();

      await expect(promise).resolves.toEqual({ data: { ok: true } });
    });

    it("deleteOne ignores the signal and completes", async () => {
      nock.cleanAll();
      nock(API_URL).delete("/posts/1").query(true).delay(50).reply(200, {});
      const controller = new AbortController();
      const promise = dataProvider.deleteOne({
        resource: "posts",
        id: 1,
        meta: { signal: controller.signal },
      });
      controller.abort();

      await expect(promise).resolves.toBeDefined();
    });
  });

  describe("without a signal", () => {
    it("pin: getList works when meta is undefined", async () => {
      nock.cleanAll();
      nock(API_URL).get("/posts").query(true).reply(200, [{ id: 1 }]);

      const result = await dataProvider.getList({ resource: "posts" });

      expect(result.data).toEqual([{ id: 1 }]);
    });

    it("pin: getOne works when meta has no signal", async () => {
      nock.cleanAll();
      nock(API_URL).get("/posts/1").query(true).reply(200, { id: 1 });

      const result = await dataProvider.getOne({
        resource: "posts",
        id: 1,
        meta: {},
      });

      expect(result.data).toEqual({ id: 1 });
    });

    it("pin: getMany works when meta has no signal", async () => {
      nock.cleanAll();
      nock(API_URL).get("/posts").query({ ids: "1,2" }).reply(200, [{ id: 1 }]);

      const result = await dataProvider.getMany!({
        resource: "posts",
        ids: [1, 2],
      });

      expect(result.data).toEqual([{ id: 1 }]);
    });

    it("pin: custom GET works when meta has no signal", async () => {
      nock.cleanAll();
      nock("https://custom.com").get("/c").reply(200, { id: 1 });

      const result = await dataProvider.custom!({
        method: "get",
        url: "https://custom.com/c",
      });

      expect(result.data).toEqual({ id: 1 });
    });
  });

  describe("createDataProvider shape", () => {
    it("pin: returns kyInstance and dataProvider", () => {
      const result = createDataProvider(API_URL);

      expect(Object.keys(result).sort()).toEqual(["dataProvider", "kyInstance"]);
    });
  });
});
