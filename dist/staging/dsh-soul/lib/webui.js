/**
 * dsh-soul — 管理页（纯 webServer 路由 + 内嵌 HTML，不依赖客户端构建）。
 *   GET  /dsh-soul/              页面
 *   GET  /dsh-soul/api/snapshot  三份文档 + 好感度 + 周记 + 状态
 *   POST /dsh-soul/api/save      { name: "user"|"self"|"affinity", content }
 *   POST /dsh-soul/api/reset     重置
 *   GET  /dsh-soul/api/journal?date=YYYY-MM-DD
 */
import { readFileSync } from "node:fs";
import path from "node:path";

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(body);
}

function guardLoopback(req) {
  if (process.env.DSH_SOUL_ALLOW_REMOTE === "1") return true;
  const addr = req.socket?.remoteAddress ?? "";
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) {
        reject(new Error("body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

const PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>dsh-soul · 人格管理</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.6 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
         background: #0f141b; color: #dbe4ee; }
  header { padding: 18px 22px; border-bottom: 1px solid #223; display: flex; gap: 14px; align-items: baseline; flex-wrap: wrap; }
  h1 { font-size: 18px; margin: 0; }
  .muted { color: #7f8ea3; font-size: 12px; }
  nav { display: flex; gap: 8px; padding: 12px 22px; }
  nav button { background: #16202b; color: #b9c7d8; border: 1px solid #263748; padding: 6px 14px; border-radius: 7px; cursor: pointer; }
  nav button.on { background: #1f6feb; color: #fff; border-color: #1f6feb; }
  main { padding: 0 22px 40px; }
  section { display: none; }
  section.on { display: block; }
  textarea { width: 100%; min-height: 62vh; background: #111923; color: #dbe4ee; border: 1px solid #263748;
             border-radius: 8px; padding: 12px; font: 13px/1.7 ui-monospace, Consolas, monospace; resize: vertical; }
  .row { display: flex; gap: 10px; align-items: center; margin: 10px 0; flex-wrap: wrap; }
  .btn { background: #1f6feb; color: #fff; border: 0; padding: 7px 16px; border-radius: 7px; cursor: pointer; }
  .btn.ghost { background: #16202b; color: #b9c7d8; border: 1px solid #263748; }
  .btn.danger { background: #7a2b2b; }
  .tag { display: inline-block; padding: 2px 9px; border-radius: 999px; background: #16202b; border: 1px solid #263748; font-size: 12px; }
  .stage { color: #ffb86b; }
  ul.journals { list-style: none; padding: 0; }
  ul.journals li { padding: 6px 0; border-bottom: 1px solid #1a2430; cursor: pointer; color: #9fd0ff; }
  pre.journal { white-space: pre-wrap; background: #111923; border: 1px solid #263748; border-radius: 8px; padding: 12px; }
  .status { font-size: 12px; color: #6fbf8f; min-height: 18px; }
</style>
</head>
<body>
<header>
  <h1>dsh-soul · 人格管理</h1>
  <span class="muted" id="meta"></span>
  <span class="tag" id="affinityTag"></span>
  <span class="status" id="status"></span>
</header>
<nav>
  <button data-tab="user" class="on">用户画像</button>
  <button data-tab="self">自身画像</button>
  <button data-tab="affinity">好感度</button>
  <button data-tab="journal">周记</button>
</nav>
<main>
  <section id="tab-user" class="on">
    <div class="row"><span class="muted">user.md · 模型在对话中自行观察填写</span></div>
    <textarea id="user"></textarea>
    <div class="row"><button class="btn" onclick="save('user')">保存</button></div>
  </section>
  <section id="tab-self">
    <div class="row"><span class="muted">self.md · 基线优先，补丁只追加；改基线会提示改动机会</span></div>
    <textarea id="self"></textarea>
    <div class="row"><button class="btn" onclick="save('self')">保存</button></div>
  </section>
  <section id="tab-affinity">
    <div class="row"><span class="muted">affinity.md · 分数/阶段/事件，可手动修正</span></div>
    <textarea id="affinity"></textarea>
    <div class="row">
      <button class="btn" onclick="save('affinity')">保存</button>
      <button class="btn danger" onclick="reset()">重置（补丁清空 + 好感度回 10）</button>
    </div>
  </section>
  <section id="tab-journal">
    <div class="row"><span class="muted">dsh-soul-data/ · 每周一份 txt</span></div>
    <ul class="journals" id="journals"></ul>
    <pre class="journal" id="journalView">点一个日期看内容</pre>
  </section>
</main>
<script>
let snap = null;
const $ = (id) => document.getElementById(id);

function setStatus(text) { $("status").textContent = text; }

async function load() {
  const r = await fetch("/dsh-soul/api/snapshot");
  snap = await r.json();
  if (!snap.ok) { setStatus("加载失败：" + (snap.error || r.status)); return; }
  $("user").value = snap.user;
  $("self").value = snap.self;
  $("affinity").value = snap.affinityDoc;
  $("meta").textContent = snap.profile + " · " + snap.home;
  $("affinityTag").innerHTML = '好感度 <b class="stage">' + snap.affinity.score + '</b>/100 · ' + snap.stage.label;
  const ul = $("journals");
  ul.innerHTML = "";
  (snap.journals || []).slice().reverse().forEach(function (f) {
    const li = document.createElement("li");
    li.textContent = f;
    li.onclick = function () { viewJournal(f.slice(0, 10)); };
    ul.appendChild(li);
  });
  if (!snap.journals || snap.journals.length === 0) ul.innerHTML = '<li class="muted">还没有周记</li>';
}

async function save(name) {
  const content = $(name).value;
  const r = await fetch("/dsh-soul/api/save", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, content })
  });
  const out = await r.json();
  setStatus(out.ok ? "已保存" : ("保存失败：" + out.error));
  if (out.ok) load();
}

async function reset() {
  if (!confirm("确定重置？补丁会清空、好感度回到 10，基线保留。")) return;
  const r = await fetch("/dsh-soul/api/reset", { method: "POST" });
  const out = await r.json();
  setStatus(out.ok ? "已重置" : ("重置失败：" + out.error));
  if (out.ok) load();
}

async function viewJournal(date) {
  const r = await fetch("/dsh-soul/api/journal?date=" + encodeURIComponent(date));
  const out = await r.json();
  $("journalView").textContent = out.ok ? out.content : ("读取失败：" + out.error);
}

document.querySelectorAll("nav button").forEach(function (b) {
  b.onclick = function () {
    document.querySelectorAll("nav button").forEach(function (x) { x.classList.remove("on"); });
    document.querySelectorAll("section").forEach(function (s) { s.classList.remove("on"); });
    b.classList.add("on");
    $("tab-" + b.dataset.tab).classList.add("on");
  };
});

load();
</script>
</body>
</html>`;

export function registerWebUi(ctx, store) {
  const disposers = [];
  const guard = (req, res) => {
    if (!guardLoopback(req)) {
      json(res, 403, { ok: false, error: "dsh-soul 管理页仅限本机访问" });
      return false;
    }
    return true;
  };

  disposers.push(ctx.webServer.register({
    kind: "exact",
    path: "/dsh-soul/",
    handler: (req, res) => {
      if (!guard(req, res)) return;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(PAGE);
    }
  }));

  disposers.push(ctx.webServer.register({
    kind: "exact",
    path: "/dsh-soul/api/snapshot",
    handler: (req, res) => {
      if (!guard(req, res)) return;
      const affinity = store.readAffinity();
      const stage = store.view().stage;
      json(res, 200, {
        ok: true,
        home: store.home,
        profile: store.profile,
        user: store.readUser(),
        self: store.readSelf(),
        affinityDoc: store.readAffinityDoc(),
        affinity,
        stage,
        journals: store.listJournals(),
        state: store.readState()
      });
    }
  }));

  disposers.push(ctx.webServer.register({
    kind: "exact",
    path: "/dsh-soul/api/save",
    handler: async (req, res) => {
      if (!guard(req, res)) return;
      try {
        if (req.method !== "POST") return json(res, 405, { ok: false, error: "POST only" });
        const body = JSON.parse(await readBody(req));
        const name = String(body.name ?? "");
        const content = String(body.content ?? "");
        if (name === "user") {
          // 直接覆盖并保留结构：只替换整个文件内容
          const { writeFileSync } = await import("node:fs");
          writeFileSync(path.join(store.home, "user.md"), content, "utf8");
        } else if (name === "self") {
          const { writeFileSync } = await import("node:fs");
          writeFileSync(path.join(store.home, "self.md"), content, "utf8");
        } else if (name === "affinity") {
          const { writeFileSync } = await import("node:fs");
          writeFileSync(path.join(store.home, "affinity.md"), content, "utf8");
        } else {
          return json(res, 400, { ok: false, error: "unknown document (user|self|affinity)" });
        }
        json(res, 200, { ok: true });
      } catch (error) {
        json(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }));

  disposers.push(ctx.webServer.register({
    kind: "exact",
    path: "/dsh-soul/api/reset",
    handler: async (req, res) => {
      if (!guard(req, res)) return;
      try {
        if (req.method !== "POST") return json(res, 405, { ok: false, error: "POST only" });
        json(res, 200, store.reset());
      } catch (error) {
        json(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }));

  disposers.push(ctx.webServer.register({
    kind: "exact",
    path: "/dsh-soul/api/journal",
    handler: (req, res) => {
      if (!guard(req, res)) return;
      try {
        const url = new URL(req.url ?? "/", "http://localhost");
        const date = url.searchParams.get("date") ?? "";
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json(res, 400, { ok: false, error: "date must be YYYY-MM-DD" });
        const file = path.join(store.dataDir, `${date}.txt`);
        json(res, 200, { ok: true, content: readFileSync(file, "utf8") });
      } catch (error) {
        json(res, 404, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }));

  return () => {
    for (const d of disposers) {
      try {
        d();
      } catch {
        // ignore
      }
    }
  };
}
