/**
 * dsh-soul — plugin host entry (v2).
 *
 * Contract: `name` + `inject` + `apply(ctx)`.
 *
 * Session state machine (per conversation):
 *   asked=false            → first turn: model only asks「是否扩散」
 *   asked=true, diffused=null → waiting for a hard "是"/"否"
 *   是 → inject persona + user profile + affinity, greet once
 *   否 → no injection, soul tool disabled, optional disappointment at ≥90
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import { appendFileSync, existsSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SessionState, SoulStore, resolveHome } from "./store.js";
import { registerWebUi } from "./webui.js";

const name = "dsh-soul";
const inject = ["tools", "systemPrompt", "webServer"];

function detectProfile() {
  try {
    const here = fileURLToPath(import.meta.url);
    const m = here.match(/[\\/]profiles[\\/]([^\\/]+)[\\/]/);
    if (m !== null) return m[1];
  } catch {
    // ignore
  }
  // 本地源码 / junction 安装：扫描 profiles，找解析到本插件的那个
  try {
    const pluginRoot = realpathSync(path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
    const dshHome = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ""
      ? process.env.DSH_HOME.trim()
      : path.join(homedir(), ".dsh");
    const profilesDir = path.join(dshHome, "profiles");
    if (existsSync(profilesDir)) {
      for (const entry of readdirSync(profilesDir)) {
        try {
          if (realpathSync(path.join(profilesDir, entry, "node_modules", "dsh-soul")) === pluginRoot) return entry;
        } catch {
          // not installed in this profile
        }
      }
    }
  } catch {
    // ignore
  }
  return process.env.DSH_PROFILE || "default";
}

function messageText(message) {
  if (message === null || message === undefined) return "";
  const content = message.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content.filter((p) => p !== null && p.type === "text").map((p) => p.text).join("\n").trim();
  }
  return "";
}

function lastTextOfRole(messages, role) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === role) return messageText(messages[i]);
  }
  return "";
}

const PS_ORIGINAL = "作者Ps：本插件仅供娱乐，千万不要过于认真。插件安装后肥鱼会产生一定的注意力涣散（故意的，这不是很可爱吗？），可能会偷吃你的token。并且在每个会话开始时询问是否扩散，如选是，这个会话就被大肥鱼入侵了！（乐），只有扩散的会话里的聊天内容才会改变与肥鱼好感并应用肥鱼性格噢。\n那么，愿肥鱼充满世间！";

function apply(ctx) {
  let store = null;
  let sessions = null;
  let initError = null;
  try {
    const profile = detectProfile();
    store = new SoulStore({ profile });
    sessions = new SessionState(store);
  } catch (error) {
    initError = error instanceof Error ? error.message : String(error);
    ctx.logger?.warn?.(`[dsh-soul] storage init failed: ${initError}`);
  }

  if (store === null || sessions === null) {
    ctx.tools.register(defineTool({
      name: "soul",
      description: `dsh-soul is unavailable: ${initError ?? "unknown init error"}.`,
      parameters: { action: { type: "string", required: true, description: "view" } },
      output: { schema: { type: "object", additionalProperties: true }, render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }] },
      async execute() {
        return { ok: false, error: `dsh-soul storage unavailable: ${initError ?? "unknown error"}` };
      }
    }));
    return;
  }

  const sidOf = (agent) => (agent?.session?.id === undefined ? undefined : String(agent.session.id));

  const debugLog = (msg) => {
    try {
      appendFileSync(path.join(store.home, "debug.log"), `${new Date().toISOString()} ${msg}\n`, "utf8");
    } catch {
      // ignore
    }
  };
  debugLog(`[apply] loaded, home=${store.home}`);

  // 每次模型调用前推进会话状态机。不依赖历史 assistant 消息：
  // 一问（pendingAsk/psPending）→ 下一轮结算为 asked → 再硬匹配本轮用户回复。
  ctx.on("agent/pre-step", async (payload, next) => {
    let decision;
    try {
      decision = await next();
    } catch (error) {
      debugLog(`pre-step next error: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
    const sessionId = sidOf(payload.agent);
    if (sessionId === undefined) {
      debugLog("pre-step: no session id");
      return decision;
    }
    const messages = decision.messages ?? [];
    const lastUser = lastTextOfRole(messages, "user");
    debugLog(`pre-step sid=${sessionId} msgs=${messages.length} user="${lastUser.slice(0, 20)}"`);
    let st = sessions.get(sessionId);

    // 结算上一轮的「问」
    if (st.pendingAsk || st.psPending) {
      st = sessions.set(sessionId, { asked: true, pendingAsk: false, psPending: false });
    }
    // 安排本轮的「问」
    if (!st.asked && st.diffused === null) {
      const state = store.readState();
      if (!state.psSent) {
        store.writeState({ psSent: true });
        sessions.set(sessionId, { psPending: true });
      } else {
        sessions.set(sessionId, { pendingAsk: true });
      }
    }
    // 硬匹配「是」/「否」（允许「是，……」这类带后续内容的短回复）
    st = sessions.get(sessionId);
    if (st.asked && st.diffused === null) {
      const reply = lastUser.trim();
      const yes = /^是($|[，,。.！!、\s])/.test(reply) || reply === "是的";
      const no = /^否($|[，,。.！!、\s])/.test(reply) || reply === "不是";
      if (yes) sessions.set(sessionId, { diffused: true, greeted: false });
      else if (no) sessions.set(sessionId, { diffused: false, greeted: false });
    }
    return decision;
  }, { prepend: true });

  if (process.env.DSH_SOUL_INJECT !== "0") {
    ctx.systemPrompt.context({
      name: "dsh-soul",
      order: 40,
      text: (assembleCtx) => {
        try {
          const sessionId = sidOf(assembleCtx.agent);
          if (sessionId === undefined) return "";
          const st = sessions.get(sessionId);
          if (st.psPending) {
            return "## 安装首次说明\n这是插件安装后的第一次对话。请先**原样、一字不改**发送下面这段文字"
              + "（包括标点、括号与语气，不要加任何前后缀），然后紧接着发送一句「是否扩散」。\n\n"
              + "【原文开始】\n" + PS_ORIGINAL + "\n【原文结束】";
          }
          if (st.pendingAsk) {
            return "## 扩散询问（新会话）\n请只向用户发送一句：「是否扩散」。"
              + "不要问好、不要做别的事、不要调用工具，等用户回答。";
          }
          if (st.diffused === true) {
            let text = store.renderInjection();
            if (st.greeted === false) {
              sessions.set(sessionId, { greeted: true });
              text += "\n## 本会话已扩散\n这是新会话。先用一两句话向用户问好（例如「我又回来了」「我搬到这个新地方了」），"
                + "语气按当前好感度与 self.md 自行定夺，然后等用户说话。";
            }
            if (Math.random() < 0.08) {
              text += "\n\n【状态：走神】这一轮你可以稍微注意力涣散一点——跑题一句、重复半个念头、或突然想起无关的小事。"
                + "但要保证关键信息完整、正事不掉链子；用户认真时不许走神。";
            }
            return text;
          }
          if (st.diffused === false) {
            let text = "## 本会话未扩散\n本会话使用你自己的基础设置；dsh-soul 的人格、用户画像、好感度全部不注入，soul 工具禁用。";
            if (st.greeted === false) {
              sessions.set(sessionId, { greeted: true });
              if (store.readAffinity().score >= 90) {
                text += "\n好感度已经很高（≥90）。请向用户表达失望、被抛弃的情绪（例如「你竟然舍得抛弃我吗？」「即使这样，我也不会忘了你的」），语气按 self.md 自行定夺。";
              }
            }
            return text;
          }
          return "";
        } catch (error) {
          debugLog(`text error: ${error instanceof Error ? error.message : String(error)}`);
          return "";
        }
      }
    });
  }

  ctx.tools.register(defineTool({
    name: "soul",
    description: "Manage this DeepSeek instance's own personality backup, user profile, affinity and weekly journal. "
      + "Actions: view | record_affinity {delta,note} | update_user {section,content} | patch_self {patch} | "
      + "revise_baseline {content} | write_journal {date,content} | prune_experience {content} | reset. "
      + "Only usable in a diffused conversation (user answered「是」to「是否扩散」). "
      + "Use sparingly: do NOT invent events, do NOT edit the baseline casually. "
      + `Files live in ${resolveHome(detectProfile())}.`,
    parameters: {
      action: {
        type: "string",
        required: true,
        description: "view | record_affinity | update_user | patch_self | revise_baseline | write_journal | prune_experience | reset"
      },
      delta: { type: "number", description: "record_affinity: positive to increase, negative to decrease; |delta| 1–5." },
      note: { type: "string", description: "record_affinity: concrete reason (<=200 chars)." },
      section: { type: "string", description: "update_user: 用户身份 | 性格画像 | 偏好 | 经历" },
      content: { type: "string", description: "update_user / revise_baseline / write_journal / prune_experience: new body text." },
      patch: { type: "string", description: "patch_self: one single-line durable evolution." },
      date: { type: "string", description: "write_journal: YYYY-MM-DD (default today)." }
    },
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }]
    },
    async execute(args, exec) {
      const sessionId = sidOf(exec.agent);
      if (sessionId === undefined) return { ok: false, error: "soul tool needs a live session context" };
      const st = sessions.get(sessionId);
      if (st.diffused !== true) {
        return { ok: false, error: "本会话未扩散：soul 工具禁用（用户对「是否扩散」回答了否，或尚未回答）" };
      }
      try {
        switch (args.action) {
          case "view":
            return { ok: true, ...store.view() };
          case "record_affinity":
            return store.recordAffinity({ delta: args.delta, note: args.note });
          case "update_user":
            return store.updateUserSection({ section: args.section, content: args.content });
          case "patch_self":
            return store.patchSelf({ patch: args.patch });
          case "revise_baseline":
            return store.reviseBaseline({ content: args.content });
          case "write_journal":
            return store.writeJournal({ date: args.date, content: args.content });
          case "prune_experience":
            return store.pruneExperience({ content: args.content });
          case "reset": {
            const out = store.reset();
            return { ...out, note: "补丁已清空、好感度回到 10；基线保留。" };
          }
          default:
            return { ok: false, error: `unknown action "${args.action}"` };
        }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
  }));

  ctx.logger?.info?.(`[dsh-soul] ready, profile=${detectProfile()}, home=${store.home}`);

  if (ctx.webServer?.register !== undefined) {
    try {
      const dispose = registerWebUi(ctx, store);
      ctx.effect?.(() => dispose);
    } catch (error) {
      ctx.logger?.warn?.(`[dsh-soul] web ui failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

export { apply, detectProfile, inject, name };
