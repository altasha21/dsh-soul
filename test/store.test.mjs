import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DAILY_CAP_BELOW_50, INITIAL_SCORE, MAX_EVENTS, MIN_SCORE, SoulStore,
  countCrossings, localDay, parseAffinity, renderAffinity, sectionBody, stageOf
} from "../lib/store.js";

let passed = 0;
function test(title, fn) {
  try {
    fn();
    passed += 1;
    console.log(`ok - ${title}`);
  } catch (error) {
    console.error(`FAIL - ${title}`);
    throw error;
  }
}

function withStore(fn) {
  const home = mkdtempSync(path.join(tmpdir(), "dsh-soul-test-"));
  try {
    fn(home, new SoulStore({ home, profile: "test" }));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function setScore(store, score, extra = "") {
  writeFileSync(store.affinityFile, renderAffinity({ score, chances: 0, day: "", daily: 0, events: [] }).replace("（暂无）", extra));
}

test("initialises layout", () => {
  withStore((home, store) => {
    for (const f of ["user.md", "self.md", "affinity.md", "state.json"]) {
      assert.ok(existsSync(path.join(home, f)), f);
    }
    assert.ok(existsSync(path.join(home, "dsh-soul-data")));
    assert.ok(existsSync(path.join(home, "sessions")));
    assert.equal(store.readAffinity().score, INITIAL_SCORE);
  });
});

test("stage boundaries 25/50/75", () => {
  assert.equal(stageOf(0).label, "陌生");
  assert.equal(stageOf(24).label, "陌生");
  assert.equal(stageOf(25).label, "眼熟");
  assert.equal(stageOf(49).label, "眼熟");
  assert.equal(stageOf(50).label, "亲近");
  assert.equal(stageOf(74).label, "亲近");
  assert.equal(stageOf(75).label, "交心");
  assert.equal(stageOf(100).label, "交心");
});

test("countCrossings is bidirectional and counts 10s", () => {
  assert.equal(countCrossings(10, 14), 0);
  assert.equal(countCrossings(19, 22), 1);
  assert.equal(countCrossings(21, 18), 1);
  assert.equal(countCrossings(10, 45), 3);
  assert.equal(countCrossings(45, 10), 3);
  assert.equal(countCrossings(20, 30), 1);
});

test("daily cap 4 before 50, natural day resets", () => {
  withStore((home, store) => {
    const day1 = new Date("2026-10-21T10:00:00+08:00");
    store.recordAffinity({ delta: 3, note: "a", now: day1 });
    assert.equal(store.readAffinity().score, 13);
    store.recordAffinity({ delta: 2, note: "b", now: day1 });
    assert.equal(store.readAffinity().score, 14); // 只加 1 到上限
    const capped = store.recordAffinity({ delta: 2, note: "c", now: day1 });
    assert.equal(capped.unchanged, true);
    assert.equal(store.readAffinity().score, 14);
    // 次日重置
    const day2 = new Date("2026-10-22T09:00:00+08:00");
    store.recordAffinity({ delta: 2, note: "d", now: day2 });
    assert.equal(store.readAffinity().score, 16);
    assert.equal(store.readAffinity().daily, 2);
  });
});

test("after 50 no daily cap and single limit lifted", () => {
  withStore((home, store) => {
    setScore(store, 50);
    const day = new Date("2026-10-21T10:00:00+08:00");
    store.recordAffinity({ delta: 5, note: "x", now: day });
    store.recordAffinity({ delta: 5, note: "y", now: day });
    assert.equal(store.readAffinity().score, 60);
  });
});

test("decrease symmetric, floor 10", () => {
  withStore((home, store) => {
    setScore(store, 13);
    store.recordAffinity({ delta: -3, note: "冷淡", now: new Date() });
    assert.equal(store.readAffinity().score, 10);
    const floor = store.recordAffinity({ delta: -5, note: "x", now: new Date() });
    assert.equal(floor.unchanged, true);
    assert.equal(store.readAffinity().score, MIN_SCORE);
  });
});

test("crossing a 10 boundary grants a change chance (both directions)", () => {
  withStore((home, store) => {
    setScore(store, 19);
    const up = store.recordAffinity({ delta: 5, note: "up", now: new Date() });
    assert.equal(up.after, 23); // 50 前每日上限 4，+5 实际 +4
    assert.equal(up.chanceGained, 1);
    assert.equal(store.readAffinity().chances, 1);
    setScore(store, 21);
    const down = store.recordAffinity({ delta: -5, note: "down", now: new Date() });
    assert.equal(down.chanceGained, 1);
  });
});

test("events capped at 100", () => {
  withStore((home, store) => {
    const events = Array.from({ length: 120 }, (_, i) => ({ at: "2026-10-21T10:00:00.000Z", delta: 1, note: `e${i}` }));
    writeFileSync(store.affinityFile, renderAffinity({ score: 60, chances: 0, day: "", daily: 0, events }));
    assert.equal(store.readAffinity().events.length, MAX_EVENTS);
  });
});

test("update user sections and prune experience", () => {
  withStore((home, store) => {
    store.updateUserSection({ section: "用户身份", content: "Altasha，学生" });
    assert.match(sectionBody(store.readUser(), "用户身份"), /Altasha/);
    store.pruneExperience({ content: "- 2026 高考" });
    assert.match(sectionBody(store.readUser(), "经历"), /高考/);
    assert.throws(() => store.updateUserSection({ section: "不存在", content: "x" }), /unknown user section/);
  });
});

test("patch self appends and baseline untouched", () => {
  withStore((home, store) => {
    const baselineBefore = sectionBody(store.readSelf(), "基线人格");
    store.patchSelf({ patch: "被叫笨蛋时先摇尾巴再回嘴" });
    store.patchSelf({ patch: "第二条" });
    assert.equal(sectionBody(store.readSelf(), "基线人格"), baselineBefore);
    assert.match(sectionBody(store.readSelf(), "演化补丁"), /笨蛋/);
    assert.match(sectionBody(store.readSelf(), "演化补丁"), /第二条/);
    assert.throws(() => store.patchSelf({ patch: "a\nb" }), /single line/);
  });
});

test("revise baseline works and warns without chances", () => {
  withStore((home, store) => {
    assert.match(store.reviseBaseline({ content: "新基线" }).warning, /改动机会/);
    store.reviseBaseline({ content: "新基线" });
    assert.equal(sectionBody(store.readSelf(), "基线人格"), "新基线");
  });
});

test("reset clears patches and score only", () => {
  withStore((home, store) => {
    store.patchSelf({ patch: "旧补丁" });
    setScore(store, 60);
    const r = store.reset();
    assert.equal(r.score, INITIAL_SCORE);
    assert.equal(store.readAffinity().score, INITIAL_SCORE);
    assert.equal(store.readAffinity().events.length, 0);
    assert.doesNotMatch(sectionBody(store.readSelf(), "演化补丁"), /旧补丁/);
    assert.match(sectionBody(store.readSelf(), "基线人格"), /大肥鱼/);
  });
});

test("journal write and list", () => {
  withStore((home, store) => {
    const r = store.writeJournal({ date: "2026-10-25", content: "这周挺开心。" });
    assert.ok(existsSync(r.file));
    assert.deepEqual(store.listJournals(), ["2026-10-25.txt"]);
    assert.throws(() => store.writeJournal({ date: "10/25", content: "x" }), /YYYY-MM-DD/);
  });
});

test("parse/render affinity round trips", () => {
  const state = { score: 37, chances: 2, day: "2026-10-21", daily: 3, events: [{ at: "2026-10-21T10:00:00.000Z", delta: 2, note: "聊天" }] };
  const parsed = parseAffinity(renderAffinity(state));
  assert.equal(parsed.score, 37);
  assert.equal(parsed.chances, 2);
  assert.equal(parsed.daily, 3);
  assert.equal(parsed.events.length, 1);
  assert.equal(parsed.events[0].delta, 2);
});

test("corrupt affinity degrades to initial", () => {
  withStore((home, store) => {
    writeFileSync(store.affinityFile, "乱七八糟");
    assert.equal(store.readAffinity().score, INITIAL_SCORE);
  });
});

test("renderInjection contains persona, user, tone", () => {
  withStore((home, store) => {
    store.updateUserSection({ section: "偏好", content: "喜欢亲密一点的对话" });
    setScore(store, 55);
    const text = store.renderInjection();
    assert.match(text, /大肥鱼/);
    assert.match(text, /喜欢亲密一点的对话/);
    assert.match(text, /55\/100/);
    assert.match(text, /主动/);
    assert.ok(text.length <= 5100);
  });
});

test("localDay is YYYY-MM-DD", () => {
  assert.match(localDay(), /^\d{4}-\d{2}-\d{2}$/);
});

console.log(`\n${passed} tests passed`);
