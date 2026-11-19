import nock from "nock";

export const API = "https://api.fake-rest.refine.dev";

type Opts = { reqheaders?: Record<string, string> };

export const mockUpdate = (
  id: number,
  body: Record<string, unknown>,
  method: "patch" | "put" | "post" = "patch",
  opts: Opts = {},
) =>
  nock(API, opts.reqheaders ? { reqheaders: opts.reqheaders } : {})
    [method](`/posts/${id}`, body as any)
    .reply(200, { id, ...body });

export const mockUpdateFailure = (id: number, status = 404) =>
  nock(API).patch(`/posts/${id}`).reply(status, { message: "fail" });
