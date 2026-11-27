// 商品主档：所有 skill 的商品事件都写到 商品/<店铺>/<商品ID>/。
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const SCHEMA_VERSION = 1;
const DEFAULT_SKILL = "pdd-ego-listing";
const STALE_HOURS = 24;
const PENDING_BLOCK_MIN = 30;
const WRITE_ACTIONS = new Set(["platform-enroll", "platform-cancel", "delist", "coupon-create", "relist"]);
export function resolveLedgerRoot(cfg = {}) {
  return String(cfg.ledgerRoot || process.env.PDD_LEDGER_ROOT || path.join(process.env.USERPROFILE || os.homedir(), "店铺运营日志")).replace(/\\/g, "/").replace(/\/$/, "");
}
function safeName(s) { return String(s || "unknown").replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, "_"); }
function pad(n) { return String(n).padStart(2, "0"); }
function localTime(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; }
export function productDir(root, shop, goodsId) { return path.join(root, "商品", safeName(shop), safeName(goodsId)); }
export function statePath(root, shop, goodsId) { return path.join(productDir(root, shop, goodsId), "商品档案.json"); }
export function eventsPath(root, shop, goodsId) { return path.join(productDir(root, shop, goodsId), "操作记录.jsonl"); }
function defaultState(shop, goodsId) { return { schemaVersion: SCHEMA_VERSION, shop, goodsId, goodsName: "", lifecycleStatus: "未知", activeActivities: [], skus: [], lastPrice: null, stock: null, lastVerifiedAt: null, stale: true, lastAction: null, lastTime: null, lastEventId: null }; }
function staleOf(state) {
  if (!state.lastVerifiedAt) return true;
  const t = Date.parse(String(state.lastVerifiedAt).replace(" ", "T"));
  return !Number.isFinite(t) || Date.now() - t > STALE_HOURS * 3600000;
}

export async function readState(root, shop, goodsId) {
  try {
    const st = JSON.parse(await fs.readFile(statePath(root, shop, goodsId), "utf8"));
    st.stale = staleOf(st);
    return st;
  } catch { return defaultState(shop, goodsId); }
}
async function atomicWrite(file, text) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp-" + process.pid + "-" + Date.now();
  await fs.writeFile(tmp, text, "utf8");
  await fs.rename(tmp, file);
}
async function writeState(root, state) {
  state.schemaVersion = SCHEMA_VERSION;
  state.stale = staleOf(state);
  state.updatedAt = new Date().toISOString();
  await atomicWrite(statePath(root, state.shop, state.goodsId), JSON.stringify(state, null, 1));
}
export async function readEvents(root, shop, goodsId) {
  let text = ""; try { text = await fs.readFile(eventsPath(root, shop, goodsId), "utf8"); } catch { return []; }
  return text.split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
function applyResult(state, event) {
  const a = event.action, after = event.after || {};
  if (event.goodsName) state.goodsName = event.goodsName;
  if (after.price != null) state.lastPrice = after.price;
  if (after.stock != null) state.stock = after.stock;
  if (after.skus) state.skus = after.skus;
  if (after.lifecycleStatus) state.lifecycleStatus = after.lifecycleStatus;
  if (a === "delist" && event.result === "success") state.lifecycleStatus = after.lifecycleStatus || "已下架";
  if ((a === "listing" || a === "ego-listing" || a === "listing-new" || a === "relist") && event.result === "success") state.lifecycleStatus = after.lifecycleStatus || "审核中";
  if (a === "platform-enroll" && event.result === "success") {
    state.activeActivities = Array.isArray(state.activeActivities) ? state.activeActivities : [];
    const hit = state.activeActivities.find((x) => String(x.activityId) === String(event.targetId));
    const item = { type: "platform", activityId: String(event.targetId), name: event.target || "", status: after.status || "审核中", expireAt: after.expireAt || null };
    if (hit) Object.assign(hit, item); else state.activeActivities.push(item);
  }
  if (a === "platform-cancel" && event.result === "success") {
    state.activeActivities = (state.activeActivities || []).map((x) => String(x.activityId) === String(event.targetId) ? { ...x, status: "已取消" } : x);
  }
  if (after.verified) { state.lastVerifiedAt = event.timeLocal; state.stale = false; }
  state.lastAction = a; state.lastTime = event.timeLocal; state.lastEventId = event.eventId;
}
async function updateIndex(root, state, event) {
  const dir = path.join(root, "索引"); await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, "商品索引.json");
  let index = { updatedAt: "", entries: [] };
  try { index = JSON.parse(await fs.readFile(file, "utf8")); } catch {}
  if (!Array.isArray(index.entries)) index.entries = [];
  const hit = index.entries.find((x) => x.shop === state.shop && String(x.goodsId) === String(state.goodsId));
  const entry = { shop: state.shop, goodsId: String(state.goodsId), goodsName: state.goodsName || "", lifecycleStatus: state.lifecycleStatus, lastAction: event.action, lastTime: event.timeLocal, activeActivities: (state.activeActivities || []).length, lastEventId: state.lastEventId };
  if (hit) Object.assign(hit, entry); else index.entries.push(entry);
  index.updatedAt = new Date().toISOString();
  await atomicWrite(file, JSON.stringify(index, null, 1));
}
async function appendEvent(root, event) {
  const dir = productDir(root, event.shop, event.goodsId);
  await fs.mkdir(dir, { recursive: true });
  await fs.appendFile(eventsPath(root, event.shop, event.goodsId), JSON.stringify(event) + "\n", "utf8");
  const md = path.join(dir, "商品历史.md");
  const exists = await fs.access(md).then(() => true).catch(() => false);
  if (!exists) await fs.writeFile(md, `# ${event.goodsName || event.goodsId}\n\n商品 ID：${event.goodsId}\n\n| 时间 | 来源 | 动作 | 对象 | 结果 |\n|---|---|---|---|---|\n`, "utf8");
  await fs.appendFile(md, `| ${event.timeLocal} | ${event.skill} | ${event.action} | ${event.target || event.targetId || ""} | ${event.phase}/${event.result} |\n`, "utf8");
  return event;
}

export async function rebuildState(root, shop, goodsId) {
  const state = defaultState(shop, goodsId);
  for (const e of await readEvents(root, shop, goodsId)) if (e.phase === "result") applyResult(state, e);
  await writeState(root, state);
  return state;
}

export async function acquireLock({ root, shop, goodsId, owner = "agent", ttlMs = 10 * 60 * 1000 }) {
  const dir = productDir(root, shop, goodsId); await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, ".lock");
  try {
    const fh = await fs.open(file, "wx");
    await fh.writeFile(JSON.stringify({ owner, time: new Date().toISOString(), ttlMs }), "utf8");
    await fh.close();
    return { ok: true, file };
  } catch {
    const st = await fs.stat(file).catch(() => null);
    if (st && Date.now() - st.mtimeMs > ttlMs) { await fs.rm(file, { force: true }); return acquireLock({ root, shop, goodsId, owner, ttlMs }); }
    let held = null; try { held = JSON.parse(await fs.readFile(file, "utf8")); } catch {}
    return { ok: false, file, held };
  }
}
export async function releaseLock(lock) { if (lock && lock.ok) await fs.rm(lock.file, { force: true }).catch(() => {}); }

export async function pendingIntents({ root, shop, goodsId, olderThanMin = PENDING_BLOCK_MIN }) {
  const events = await readEvents(root, shop, goodsId);
  const results = new Set(events.filter((e) => e.phase === "result").map((e) => `${e.runId}|${e.action}|${e.targetId}`));
  return events.filter((e) => e.phase === "intent" && !results.has(`${e.runId}|${e.action}|${e.targetId}`) && Date.now() - Date.parse(e.time) > olderThanMin * 60000);
}

export async function recordIntent({ root, skill = DEFAULT_SKILL, shop, goodsId, goodsName, action, targetId, target, before, confirmation, runId, evidence }) {
  const now = new Date();
  const event = { schemaVersion: SCHEMA_VERSION, eventId: `${runId || "run"}-${goodsId}-${Date.now()}-intent`, phase: "intent", time: now.toISOString(), timeLocal: localTime(now), skill, shop, goodsId: String(goodsId), goodsName: goodsName || "", action, targetId: targetId ? String(targetId) : "", target: target || "", before: before ?? null, after: null, result: "pending", confirmation: confirmation || {}, runId: runId || "", evidence: evidence || "" };
  return appendEvent(root, event);
}

export async function recordResult({ root, skill = DEFAULT_SKILL, shop, goodsId, goodsName, action, targetId, target, before, after, result, confirmation, runId, evidence }) {
  const now = new Date();
  const event = { schemaVersion: SCHEMA_VERSION, eventId: `${runId || "run"}-${goodsId}-${Date.now()}-result`, phase: "result", time: now.toISOString(), timeLocal: localTime(now), skill, shop, goodsId: String(goodsId), goodsName: goodsName || "", action, targetId: targetId ? String(targetId) : "", target: target || "", before: before ?? null, after: after ?? null, result: result || "unknown", confirmation: confirmation || {}, runId: runId || "", evidence: evidence || "" };
  let state = await readState(root, shop, goodsId);
  if (state.lifecycleStatus === "未知") state = await rebuildState(root, shop, goodsId);
  applyResult(state, event);
  await writeState(root, state);
  await appendEvent(root, event);
  await updateIndex(root, state, event);
  return { event, state };
}

export async function assertCan({ root, skill = DEFAULT_SKILL, shop, goodsId, action, targetId, allowUnknown = false }) {
  const state = await readState(root, shop, goodsId);
  const events = await readEvents(root, shop, goodsId);
  const warnings = [];
  let blocked = null;
  if (state.lifecycleStatus === "未知" && WRITE_ACTIONS.has(action) && !allowUnknown) blocked = "state_unknown";
  if (state.lifecycleStatus === "已下架" && (action === "platform-enroll" || action.startsWith("edit-goods") || action === "coupon-create")) blocked = "product_delisted";
  if (action === "delist" && state.lifecycleStatus === "已下架") blocked = "already_delisted";
  if (action === "platform-enroll" && targetId) {
    const enroll = events.filter((e) => e.phase === "result" && e.action === "platform-enroll" && e.result === "success" && String(e.targetId) === String(targetId)).pop();
    const cancel = events.filter((e) => e.phase === "result" && e.action === "platform-cancel" && e.result === "success" && String(e.targetId) === String(targetId)).pop();
    if (enroll && (!cancel || String(cancel.time) < String(enroll.time))) blocked = "duplicate_operation";
  }
  const pending = await pendingIntents({ root, shop, goodsId, olderThanMin: 0 });
  if (pending.some((e) => e.action === action && (!targetId || String(e.targetId) === String(targetId)))) blocked = "operation_pending";
  if (state.stale) warnings.push("state_stale");
  if (action === "delist" && Array.isArray(state.activeActivities) && state.activeActivities.some((x) => !["已取消", "已结束"].includes(x.status))) warnings.push("activity_active");
  return { allowed: !blocked, blocked, warnings, state, pending };
}
