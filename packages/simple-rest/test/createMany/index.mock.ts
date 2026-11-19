import nock from "nock";

export const API = "https://api.fake-rest.refine.dev";

type Opts = { reqheaders?: Record<string, string> };

/** json-server style: POST /posts echoes the body with an id. */
export const mockCreate = (
  body: Record<string, unknown>,
  id: number,
  method: "post" | "patch" | "put" = "post",
  opts: Opts = {},
) =>
  nock(API, opts.reqheaders ? { reqheaders: opts.reqheaders } : {})
    [method]("/posts", body as any)
    .reply(201, { id, ...body });

export const mockCreateFailure = (body: Record<string, unknown>) =>
  nock(API)
    .post("/posts", body as any)
    .reply(500, { message: "boom" });
