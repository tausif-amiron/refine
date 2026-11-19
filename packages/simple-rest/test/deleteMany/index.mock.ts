import nock from "nock";

export const API = "https://api.fake-rest.refine.dev";

type Opts = { reqheaders?: Record<string, string>; body?: unknown };

export const mockDelete = (
  id: number,
  method: "delete" | "post" | "put" | "patch" = "delete",
  opts: Opts = {},
) => {
  const scope = nock(
    API,
    opts.reqheaders ? { reqheaders: opts.reqheaders } : {},
  );
  const path = `/posts/${id}`;
  const interceptor =
    opts.body !== undefined
      ? scope[method](path, opts.body as any)
      : scope[method](path);
  return interceptor.reply(200, { id });
};

export const mockDeleteFailure = (id: number, status = 500) =>
  nock(API).delete(`/posts/${id}`).reply(status, { message: "fail" });
