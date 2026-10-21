/**
 * 临时预览：用真实 desktop profile 数据目录起一个独立的管理页服务。
 * 仅用于重启 DSH 之前先看 UI；正式入口是 DSH 自己注册的 /dsh-soul/。
 * 用法：node scripts/preview-webui.mjs
 */
import http from "node:http";
import { SoulStore } from "../lib/store.js";
import { registerWebUi } from "../lib/webui.js";

const store = new SoulStore({ profile: process.env.DSH_PROFILE || "desktop" });
const routes = new Map();
const ctx = {
  webServer: {
    register: (r) => {
      routes.set(r.path, r.handler);
      return () => routes.delete(r.path);
    }
  }
};
registerWebUi(ctx, store);

const port = Number(process.env.PORT || 5730);
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    const handler = routes.get(url.pathname);
    if (handler === undefined) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    await handler(req, res);
  } catch (error) {
    res.writeHead(500);
    res.end(String(error));
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`dsh-soul preview: http://127.0.0.1:${port}/dsh-soul/`);
  console.log(`data home: ${store.home}`);
});
