# refine antd cursor pagination example

Shows an antd table driven by `useTable` from `@refinedev/antd` with `pagination: { mode: "cursor" }` and the
`@refinedev/simple-rest` data provider.

In cursor mode the table renders only prev / next buttons. Prev is disabled on the first page and next is
disabled when the API returns no next cursor.

The example calls a small local mock API (served by the Vite dev and preview server, see `vite.config.ts`). It
implements the simple-rest cursor defaults: query params `cursor` and `limit`, and the response headers
`x-next-cursor` and `x-prev-cursor`.

## Usage

```bash
npm install
npm run dev
```
