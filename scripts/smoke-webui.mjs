/**
 * 冒烟测试：用 mock webServer 起一个本地 HTTP 服务，验证管理页路由。
 * 用法：node scripts/smoke-webui.mjs
 */
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SoulStore } from "../lib/store.js";
import { registerWebUi } from "../lib/webui.js";

const home = mkdtempSync(path.join(tmpdir(), "dsh-soul-webui-"));
const store = new SoulStore({ home, profile: "dev" });
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

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
let failures = 0;
const check = (name, ok) => {
  console.log(`${ok ? "ok" : "FAIL"} - ${name}`);
  if (!ok) failures += 1;
};

try {
  const page = await (await fetch(`${base}/dsh-soul/`)).text();
  check("page renders", page.includes("dsh-soul") && page.includes("用户画像"));

  const snap = await (await fetch(`${base}/dsh-soul/api/snapshot`)).json();
  check("snapshot ok", snap.ok && snap.affinity.score === 10 && snap.profile === "dev");
  check("journals empty", Array.isArray(snap.journals) && snap.journals.length === 0);

  const save = await (await fetch(`${base}/dsh-soul/api/save`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "user", content: "# 用户画像\n\n## 用户身份\n\n测试用户\n" })
  })).json();
  check("save user", save.ok);

  const snap2 = await (await fetch(`${base}/dsh-soul/api/snapshot`)).json();
  check("saved content visible", snap2.user.includes("测试用户"));

  store.writeJournal({ date: "2026-10-25", content: "测试周记" });
  const list = await (await fetch(`${base}/dsh-soul/api/snapshot`)).json();
  check("journal listed", list.journals.includes("2026-10-25.txt"));
  const journal = await (await fetch(`${base}/dsh-soul/api/journal?date=2026-10-25`)).json();
  check("journal read", journal.ok && journal.content.includes("测试周记"));

  const reset = await (await fetch(`${base}/dsh-soul/api/reset`, { method: "POST" })).json();
  check("reset works", reset.ok && reset.score === 10);

  const bad = await fetch(`${base}/dsh-soul/api/journal?date=../x`);
  check("bad date rejected", bad.status === 400);
} finally {
  server.close();
  rmSync(home, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nwebui smoke passed" : `\n${failures} failures`);
process.exit(failures === 0 ? 0 : 1);

