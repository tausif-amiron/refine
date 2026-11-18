import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const TOTAL = 25;
const posts = Array.from({ length: TOTAL }, (_, i) => ({
  id: i + 1,
  title: `Post ${i + 1}`,
  status: i % 2 === 0 ? "published" : "draft",
}));

// Local cursor-aware mock API. The cursor is the offset of the first item of
// a page; cursors travel in the x-next-cursor / x-prev-cursor headers, which
// are the defaults of the simple-rest data provider in cursor mode.
const mockApi = (): Plugin => {
  const handler = (req: any, res: any, next: () => void) => {
    const url = new URL(req.url ?? "", "http://localhost");
    if (url.pathname !== "/api/posts") return next();

    const limit = Number(url.searchParams.get("limit") ?? 5);
    const cursor = url.searchParams.get("cursor");
    const start = cursor ? Number(cursor) : 0;
    const items = posts.slice(start, start + limit);

    res.setHeader("Content-Type", "application/json");
    res.setHeader(
      "Access-Control-Expose-Headers",
      "x-next-cursor, x-prev-cursor",
    );
    if (start + limit < TOTAL) {
      res.setHeader("x-next-cursor", String(start + limit));
    }
    if (start > 0) {
      res.setHeader("x-prev-cursor", String(Math.max(0, start - limit)));
    }
    res.end(JSON.stringify(items));
  };

  return {
    name: "cursor-mock-api",
    configureServer: (server) => {
      server.middlewares.use(handler);
    },
    configurePreviewServer: (server) => {
      server.middlewares.use(handler);
    },
  };
};

export default defineConfig({
  plugins: [react(), mockApi()],
});
