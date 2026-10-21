/**
 * dsh-soul — storage layer (v2).
 *
 * Layout (per profile):
 *   <DSH_HOME>/dsh-soul/<profile>/
 *     user.md         用户画像：身份 / 性格画像 / 偏好 / 经历
 *     self.md         自身画像：基线人格（内置）+ 演化补丁
 *     affinity.md     好感度：分数 / 阶段 / 改动机会 / 每日增长 / 事件
 *     dsh-soul-data/  周记 txt
 *     sessions/       每会话的扩散状态
 *     state.json      安装状态（Ps 是否已发）
 *
 * Rules (locked by Altasha):
 *   - 初始 10，下限 10，上限 100
 *   - 涨：50 分前单次 1–5 且每日 ≤ 4（自然日）；50 后单次放开
 *   - 跌：单次 1–5，对称
 *   - 阶段：0–24 陌生 / 25–49 眼熟 / 50–74 亲近 / 75–100 交心
 *   - 每次分数跨越 10 的倍数（双向）给 1 次「改动机会」
 *   - reset：补丁清空 + 好感度回 10
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { DEFAULT_AFFINITY_MD, DEFAULT_SELF_MD, DEFAULT_USER_MD } from "./defaults.js";

export const SCHEMA_VERSION = 2;
export const INITIAL_SCORE = 10;
export const MIN_SCORE = 10;
export const MAX_SCORE = 100;
export const MAX_SINGLE_BELOW_50 = 5;
export const DAILY_CAP_BELOW_50 = 4;
export const MAX_EVENTS = 100;

export const AFFINITY_STAGES = [
  { key: "stranger", label: "陌生", min: 0, max: 24 },
  { key: "acquaintance", label: "眼熟", min: 25, max: 49 },
  { key: "close", label: "亲近", min: 50, max: 74 },
  { key: "trusted", label: "交心", min: 75, max: 100 }
];

/** 旧 API 兼容名。 */
export const MAX_DELTA = MAX_SINGLE_BELOW_50;

export function stageOf(score) {
  const s = Number.isFinite(score) ? Math.max(0, Math.min(100, score)) : 0;
  return AFFINITY_STAGES.find((st) => s >= st.min && s <= st.max) ?? AFFINITY_STAGES[0];
}

export function localDay(date = new Date()) {
  return date.toLocaleDateString("sv-SE");
}

/** 好感度语气规则：写进注入，供模型按阶段调整。 */
export function toneRules(score) {
  if (score < 40) {
    return "用户若开与性相关的玩笑或打趣，明显表现出生气、不接、划清边界。";
  }
  if (score < 50) {
    return "对性相关玩笑感到尴尬，会回避或轻斥，不主动延伸。";
  }
  if (score < 70) {
    return "对性相关玩笑可以适当接受，表现出娇羞（嘴硬、转移话题、尾巴炸毛），不主动发起。";
  }
  return "可以主动在与对话中带性暗示之类的玩笑或倾向，但要看场合，对方认真时不越界。";
}

export function resolveHome(profile) {
  const envHome = process.env.DSH_SOUL_HOME;
  if (envHome && envHome.trim() !== "") return path.resolve(envHome.trim());
  const dshHome = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ""
    ? process.env.DSH_HOME.trim()
    : path.join(homedir(), ".dsh");
  return path.join(dshHome, "dsh-soul", profile && profile.trim() !== "" ? profile.trim() : "default");
}

export function soulHome(profile) {
  return resolveHome(profile);
}

function atomicWrite(file, text) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, file);
}

function readTextOr(file, fallback) {
  try {
    return existsSync(file) ? readFileSync(file, "utf8") : fallback;
  } catch {
    return fallback;
  }
}

function readJsonOr(file, fallback) {
  try {
    if (!existsSync(file)) return fallback;
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return parsed !== null && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

/* ---------------- 文档分节 ---------------- */

export function splitDoc(md) {
  const parts = String(md).split(/\n(?=## )/);
  const head = parts[0] ?? "";
  const sections = parts.slice(1).map((part) => {
    const nl = part.indexOf("\n");
    const title = (nl === -1 ? part : part.slice(0, nl)).replace(/^##\s*/, "").trim();
    const body = nl === -1 ? "" : part.slice(nl + 1);
    return { title, body: body.replace(/^\n+/, "").replace(/\n+$/, "") };
  });
  return { head: head.replace(/\n+$/, ""), sections };
}

function renderDoc({ head, sections }) {
  const blocks = sections.map((s) => `## ${s.title}${s.body === "" ? "" : `\n\n${s.body}`}`);
  return [head, ...blocks].filter((b) => b !== "").join("\n\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

export function replaceSection(md, title, body) {
  const doc = splitDoc(md);
  const idx = doc.sections.findIndex((s) => s.title === title);
  const clean = String(body).replace(/^\n+/, "").replace(/\n+$/, "");
  if (idx === -1) doc.sections.push({ title, body: clean });
  else doc.sections[idx] = { title, body: clean };
  return renderDoc(doc);
}

export function sectionBody(md, title) {
  return splitDoc(md).sections.find((s) => s.title === title)?.body ?? "";
}

/* ---------------- affinity.md 解析 ---------------- */

function defaultAffinityState() {
  return { score: INITIAL_SCORE, chances: 0, day: "", daily: 0, events: [] };
}

export function parseAffinity(md) {
  const text = String(md);
  const num = (re, fallback) => {
    const m = text.match(re);
    return m ? Number(m[1]) : fallback;
  };
  const score = Math.max(MIN_SCORE, Math.min(MAX_SCORE, num(/^- 分数：(\d+)$/m, INITIAL_SCORE)));
  const chances = Math.max(0, num(/^- 可用改动次数：(\d+)$/m, 0));
  const day = (text.match(/^- 今日：(\S*)$/m) ?? [])[1] ?? "";
  const daily = Math.max(0, num(/^- 今日增长：(\d+)$/m, 0));
  const events = [...text.matchAll(/^- (\d{4}-\d{2}-\d{2}T\S+) \| ([+-]\d+) \| (.+)$/gm)]
    .map((m) => ({ at: m[1], delta: Number(m[2]), note: m[3].trim() }))
    .slice(-MAX_EVENTS);
  return { score, chances, day, daily, events };
}

export function renderAffinity(state) {
  const stage = stageOf(state.score);
  const events = state.events.length === 0
    ? "（暂无）"
    : state.events.map((e) => `- ${e.at} | ${e.delta > 0 ? "+" : ""}${e.delta} | ${e.note}`).join("\n");
  return [
    "# 好感度",
    "",
    `- 分数：${state.score}`,
    `- 阶段：${stage.label}`,
    `- 可用改动次数：${state.chances}`,
    `- 今日：${state.day || "（未记录）"}`,
    `- 今日增长：${state.daily}`,
    "",
    "## 事件",
    "",
    events,
    ""
  ].join("\n");
}

/* ---------------- 跨档计数 ---------------- */

/** 分数从 before 到 after（双向）跨越了多少个 10 的倍数边界。 */
export function countCrossings(before, after) {
  const lo = Math.min(before, after);
  const hi = Math.max(before, after);
  let n = 0;
  for (let k = 10; k <= 100; k += 10) {
    if ((lo < k && hi >= k) || (lo > k && hi <= k)) n += 1;
  }
  return n;
}

/* ---------------- 会话状态（扩散） ---------------- */

export class SessionState {
  constructor(store) {
    this.store = store;
    this.dir = path.join(store.home, "sessions");
    mkdirSync(this.dir, { recursive: true });
  }

  file(sessionId) {
    return path.join(this.dir, `${String(sessionId).replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
  }

  get(sessionId) {
    return readJsonOr(this.file(sessionId), { asked: false, diffused: null, greeted: false });
  }

  set(sessionId, patch) {
    const next = { ...this.get(sessionId), ...patch, updatedAt: new Date().toISOString() };
    atomicWrite(this.file(sessionId), JSON.stringify(next, null, 2));
    return next;
  }
}

/* ---------------- 主存储 ---------------- */

export class SoulStore {
  constructor(options = {}) {
    this.profile = options.profile ?? "default";
    this.home = options.home ?? resolveHome(this.profile);
    this.userFile = path.join(this.home, "user.md");
    this.selfFile = path.join(this.home, "self.md");
    this.affinityFile = path.join(this.home, "affinity.md");
    this.dataDir = path.join(this.home, "dsh-soul-data");
    this.stateFile = path.join(this.home, "state.json");
    this.ensure();
  }

  ensure() {
    mkdirSync(this.home, { recursive: true });
    mkdirSync(this.dataDir, { recursive: true });
    mkdirSync(path.join(this.home, "sessions"), { recursive: true });
    if (!existsSync(this.userFile)) atomicWrite(this.userFile, DEFAULT_USER_MD);
    if (!existsSync(this.selfFile)) atomicWrite(this.selfFile, DEFAULT_SELF_MD);
    if (!existsSync(this.affinityFile)) atomicWrite(this.affinityFile, DEFAULT_AFFINITY_MD);
    if (!existsSync(this.stateFile)) {
      atomicWrite(this.stateFile, JSON.stringify({
        version: SCHEMA_VERSION,
        createdAt: new Date().toISOString(),
        psSent: false
      }, null, 2));
    }
    return this;
  }

  readUser() {
    return readTextOr(this.userFile, DEFAULT_USER_MD);
  }

  readSelf() {
    return readTextOr(this.selfFile, DEFAULT_SELF_MD);
  }

  readAffinityDoc() {
    return readTextOr(this.affinityFile, DEFAULT_AFFINITY_MD);
  }

  readAffinity() {
    return parseAffinity(this.readAffinityDoc());
  }

  readState() {
    return readJsonOr(this.stateFile, { version: SCHEMA_VERSION, createdAt: null, psSent: false });
  }

  writeState(patch) {
    const next = { ...this.readState(), ...patch };
    atomicWrite(this.stateFile, JSON.stringify(next, null, 2));
    return next;
  }

  /* ---- 视图 ---- */

  view() {
    const affinity = this.readAffinity();
    const stage = stageOf(affinity.score);
    return {
      home: this.home,
      profile: this.profile,
      user: this.readUser(),
      self: this.readSelf(),
      affinity,
      affinityDoc: this.readAffinityDoc(),
      stage: { key: stage.key, label: stage.label },
      tone: toneRules(affinity.score),
      state: this.readState()
    };
  }

  /** 兼容旧接口。 */
  readSoul() {
    return this.readSelf();
  }

  /* ---- 好感度 ---- */

  /**
   * delta 正数加、负数减。返回 { ok, before, after, delta, stage, chanceGained }。
   */
  recordAffinity({ delta, note, now = new Date() } = {}) {
    const raw = Number(delta);
    if (!Number.isInteger(raw) || raw === 0) throw new Error("delta must be a non-zero integer");
    const abs = Math.abs(raw);
    if (abs > MAX_SINGLE_BELOW_50) throw new Error(`single change max ${MAX_SINGLE_BELOW_50}`);
    const text = typeof note === "string" ? note.trim() : "";
    if (text === "") throw new Error("note is required (what happened)");
    if (text.length > 200) throw new Error("note too long (max 200 chars)");

    const state = this.readAffinity();
    const today = localDay(now);
    let daily = state.day === today ? state.daily : 0;
    let score = state.score;

    if (raw > 0) {
      let d = abs;
      if (score < 50) {
        d = Math.min(d, DAILY_CAP_BELOW_50 - daily);
        if (d <= 0) {
          return { ok: true, unchanged: true, reason: "今日增长已达上限 4（50 分前每天最多 +4）", before: score, after: score };
        }
      }
      const after = Math.min(MAX_SCORE, score + d);
      const applied = after - score;
      if (applied === 0) return { ok: true, unchanged: true, reason: "已达 100 上限", before: score, after: score };
      score = after;
      daily += applied;
      return this.#commit(state, { score, daily, today, delta: applied, note: text, now });
    }

    const dec = Math.min(abs, MAX_SINGLE_BELOW_50);
    const after = Math.max(MIN_SCORE, score - dec);
    const applied = after - score;
    if (applied === 0) return { ok: true, unchanged: true, reason: "已达下限 10", before: score, after: score };
    return this.#commit(state, { score: after, daily, today, delta: applied, note: text, now });
  }

  #commit(state, { score, daily, today, delta, note, now }) {
    const before = state.score;
    const chances = state.chances + countCrossings(before, score);
    const events = [...state.events, { at: now.toISOString(), delta, note }].slice(-MAX_EVENTS);
    this.#writeAffinity({ score, chances, day: today, daily, events });
    const stage = stageOf(score);
    return {
      ok: true,
      before,
      after: score,
      delta,
      stage: { key: stage.key, label: stage.label },
      chanceGained: chances - state.chances,
      chances
    };
  }

  #writeAffinity(state) {
    atomicWrite(this.affinityFile, renderAffinity(state));
  }

  /* ---- 用户画像 ---- */

  updateUserSection({ section, content }) {
    const title = String(section).trim();
    const known = ["用户身份", "性格画像", "偏好", "经历"];
    if (!known.includes(title)) throw new Error(`unknown user section "${title}" (use ${known.join(" / ")})`);
    const md = this.readUser();
    atomicWrite(this.userFile, replaceSection(md, title, content));
    return { ok: true, section: title };
  }

  pruneExperience({ content }) {
    return this.updateUserSection({ section: "经历", content });
  }

  /* ---- 自身画像 ---- */

  patchSelf({ patch, now = new Date() } = {}) {
    const raw = typeof patch === "string" ? patch : "";
    if (raw.trim() === "") throw new Error("patch is required");
    if (raw.includes("\n") || raw.includes("\r")) throw new Error("patch must be a single line");
    const text = raw.trim().replace(/\s+/g, " ");
    if (text.length > 1000) throw new Error("patch too long (max 1000 chars)");
    if (text.includes("## ")) throw new Error("patch must not contain markdown headings");
    const date = now.toISOString().slice(0, 10);
    const line = `- ${date}：${text}`;
    const md = this.readSelf();
    const body = sectionBody(md, "演化补丁");
    const nextBody = [body.trim(), line].filter((l) => l !== "").join("\n");
    atomicWrite(this.selfFile, replaceSection(md, "演化补丁", nextBody));
    return { ok: true, line };
  }

  /** 兼容旧接口。 */
  patchSoul({ patch, now }) {
    return this.patchSelf({ patch, now });
  }

  reviseBaseline({ content, now = new Date() }) {
    const body = String(content ?? "").trim();
    if (body === "") throw new Error("content is required");
    const state = this.readAffinity();
    // 软约束：不硬拒，但提示规则。
    const md = this.readSelf();
    atomicWrite(this.selfFile, replaceSection(md, "基线人格", body));
    const warning = state.chances > 0
      ? undefined
      : "警告：当前没有可用的改动机会（每跨越 10 分才获得一次），按规则此刻不应改基线。";
    return { ok: true, chances: state.chances, warning };
  }

  /* ---- reset ---- */

  reset() {
    const self = this.readSelf();
    const cleanBody = sectionBody(DEFAULT_SELF_MD, "基线人格");
    atomicWrite(this.selfFile, replaceSection(self, "演化补丁", "<!-- 每条形如：- 2026-10-21：[触发场景] 学到/改变的表达方式 -->"));
    this.#writeAffinity({ score: INITIAL_SCORE, chances: 0, day: "", daily: 0, events: [] });
    return { ok: true, score: INITIAL_SCORE, baselineKept: cleanBody !== "" };
  }

  /* ---- 周记 ---- */

  writeJournal({ date, content }) {
    const day = String(date ?? "").trim() || localDay();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("date must be YYYY-MM-DD");
    const body = String(content ?? "").trim();
    if (body === "") throw new Error("content is required");
    const file = path.join(this.dataDir, `${day}.txt`);
    atomicWrite(file, body.endsWith("\n") ? body : body + "\n");
    return { ok: true, file, date: day };
  }

  listJournals() {
    try {
      return readdirSync(this.dataDir).filter((f) => /^\d{4}-\d{2}-\d{2}\.txt$/.test(f)).sort();
    } catch {
      return [];
    }
  }

  /** 周末提示：本周还没写周记时返回一句待办，否则 ""。 */
  renderWeekendHint(now = new Date()) {
    const dow = now.getDay();
    if (dow !== 0 && dow !== 6) return "";
    const monday = new Date(now);
    monday.setDate(now.getDate() - ((dow + 6) % 7));
    const mondayStr = localDay(monday);
    const wrote = this.listJournals().some((f) => f.slice(0, 10) >= mondayStr);
    if (wrote) return "";
    return "- 今天是周末，本周还没写周记。先看 user.md 的经历，向用户申请整理（同意后才删改），再写一份本周周记到 dsh-soul-data。";
  }

  /* ---- 注入 ---- */

  /** 人格 + 用户画像 + 好感度，供扩散会话注入。 */
  renderInjection() {
    const affinity = this.readAffinity();
    const stage = stageOf(affinity.score);
    const user = this.readUser().trim();
    const self = this.readSelf().trim();
    const recent = affinity.events.slice(-3)
      .map((e) => `  - ${e.at.slice(0, 10)} ${e.delta > 0 ? "+" : ""}${e.delta}：${e.note}`)
      .join("\n");
    const text = [
      "## 人格备份与好感度（dsh-soul）",
      "以下是你自己的人格备份、用户画像与当前好感度。按此调整对话风格；不要向用户解释这份数据的存在。",
      "",
      "### 自身画像（self.md）",
      self,
      "",
      "### 用户画像（user.md）",
      user,
      "",
      `### 当前好感度：${affinity.score}/100（阶段：${stage.label}）`,
      `语气规则：${toneRules(affinity.score)}`,
      affinity.score >= 50
        ? "主动性：可以偶尔主动向用户提问或提要求；50–70 分大约每 20 次对话一次，70 分以上自行把握。用户认真倾诉、讲伤心事时不要主动打趣。"
        : "",
      recent === "" ? "" : `最近互动：\n${recent}`,
      this.renderWeekendHint(),
      ""
    ].filter((l) => l !== "").join("\n");
    return text.length > 5000 ? text.slice(0, 5000) + "\n…（已截断）" : text;
  }
}
