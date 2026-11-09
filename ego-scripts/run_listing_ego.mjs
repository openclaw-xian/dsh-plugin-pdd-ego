// run_listing_ego.mjs —— 上架编排（ego 版），步骤顺序与 run_listing.js 完全一致
// ⓪查重 ①类目页 ②类目 ③主图/标题 ④详情图 ⑤品牌+属性 ⑥规格表 ⑦填值 ⑧预览图 ⑨参考价 ⑨b详情复核 ⑩终校验
// **全程不提交**，跑完打印 validateForm。默认不存草稿（saveDraft:true 才存）。
// ★上架前必须先问用户：店铺、素材包、运费模板（默认模板 or 指定）、是否存草稿、是否允许提交。
import { readFile } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import {
  log, sleep, connectShop, dismissOverlays, detectCategoryPage, openManualCategoryPicker, searchCategory,
  goNextToForm, uploadMainImages, fillTitle, uploadZoneFast, readDetailZone, fillBrand,
  applyAttributesByCandidates, fillDirectAttrs, ensureSpecTable, fillSkuRowsAndVerify,
  uploadMissingPreviews, countPreviewCells, setRefPrice, validateForm, readImageCounters, uploadVideo, uploadWhiteBg,
  packagingLabelState, mainImagesState, clearZone, readAllSkuRows, makeStickyMapRow, getScrollMeta,
  checkDuplicate, validateSpecValues, repairSpecMatrix, cleanExtraDetails, openPublishPage, pathSuffixMatch,
  validateListingPayload, commitSpecTail, probeRequiredAttributes, fillSkuRowsCDP, evalLong,
  setFreightTemplate, listFreightTemplates, readFreightTemplate, shotPage,
  submitProduct, verifyListed,
} from "./pdd_flow_ego.mjs";
import { mkdirSync } from "node:fs";

// 配置优先读 D:/egoscripts/run-config.json（便于多轮批量测试）
let CFG = { spaceId: 2, product: "D:/assets/GE-格栅吸音-店1-链2/work/product.json", saveDraft: true };
try {
  const raw = (await readFile("D:/egoscripts/run-config.json", "utf8")).replace(/^\uFEFF/, "");
  CFG = { ...CFG, ...JSON.parse(raw) };
} catch (e) {}
const SPACE_ID = CFG.spaceId;
const PRODUCT = CFG.product;
const SAVE_DRAFT = CFG.saveDraft === true; // 只有显式 saveDraft:true 才存草稿（默认不存）

// ── 按素材包自动解析白底图 / 视频（找不到就跳过，不再写死路径）──
function resolveAssets(productPath) {
  const workDir = String(productPath).replace(/\\/g, "/").replace(/\/work\/product\.json$/, "");
  const base = workDir.split("/").pop() || "";
  const stripped = base.replace(/^[A-Za-z0-9]+-/, "");
  const ROOTS = ["D:/assets/", "D:/assets/", "D:/图片/"];
  let packName = stripped, packDir = null;
  for (const root of ROOTS) {
    for (const c of [base, stripped]) {
      if (!c) continue;
      if (!packDir && existsSync(root + c)) { packDir = root + c; packName = c; }
    }
    if (packDir) break;
  }
  if (!packDir) packDir = ROOTS[0] + stripped;
  const out = { packName, packDir, exists: existsSync(packDir), whiteBg: null, video: null };
  if (!out.exists) return out;
  const walk = (dir, depth) => {
    if (depth > 3) return;
    let ents = [];
    try { ents = readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const ent of ents) {
      const full = dir + "/" + ent.name;
      if (ent.isDirectory()) { if (!/^_/.test(ent.name)) walk(full, depth + 1); }
      else {
        if (!out.whiteBg && /白底图/.test(ent.name) && /\.(png|jpe?g)$/i.test(ent.name)) out.whiteBg = full;
        if (!out.video && /\.mp4$/i.test(ent.name) && /视频/.test(full)) out.video = full;
      }
    }
  };
  walk(packDir, 0);
  return out;
}

const ASSETS = resolveAssets(PRODUCT);
if (CFG.whiteBg) ASSETS.whiteBg = String(CFG.whiteBg).replace(/\\/g, "/");
if (CFG.video) ASSETS.video = String(CFG.video).replace(/\\/g, "/");


const T0 = Date.now();
const stamp = () => `[+${((Date.now() - T0) / 1000).toFixed(1)}s]`;

const D = JSON.parse(await readFile(PRODUCT, "utf8"));
const P = D.product;
if (!P.brand) P.brand = "祺讯"; // 数据缺品牌时用默认品牌（与 builder 默认一致）
const DIMS = P.dimensions;
const SKUS = P.skus;
const V0 = [...new Set(SKUS.map((s) => String(s[DIMS[0]] ?? "")))];
const V1 = [...new Set(SKUS.map((s) => String(s[DIMS[1]] ?? "")))];
const posix = (p) => String(p || "").replace(/\\/g, "/");
const colorToFile = {};
for (const sk of SKUS) if (!colorToFile[sk[DIMS[0]]]) colorToFile[sk[DIMS[0]]] = posix(sk.preview);
for (const sk of SKUS) sk.preview = posix(sk.preview);
D.main_images = (D.main_images || []).map(posix);
D.detail_images = (D.detail_images || []).map(posix);

const conn = await connectShop(SPACE_ID);
const SHOT_DIR = String(CFG.shotDir || ((PRODUCT || "").replace(/\\/g, "/").replace(/\/work\/product\.json$/, "") + "/shots"));
try { mkdirSync(SHOT_DIR, { recursive: true }); } catch (e) {}
const SHOT_ON = CFG.shot === true; // 每步截图：显式 shot:true 才开（原版只在末尾拍可选 final.png）
const stepRetry = async (label, fn, times = 2, delayMs = 3000) => {
  let lastErr = null;
  for (let i = 1; i <= times; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      console.log("[上架]", stamp(), label, "失败(" + i + "/" + times + "):", String(e && e.message).slice(0, 140));
      if (i < times) {
        await sleep(delayMs);
        console.log("[上架]", stamp(), label, "→ 重试（页面渲染卡顿时 evaluate 会 15s 超时，等它恢复）");
      }
    }
  }
  throw lastErr;
};

const shot = async (name) => {
  if (!SHOT_ON) return null;
  const r = await shotPage(page, SHOT_DIR, name, { fullPage: false }).catch(() => null);
  if (r && r.ok) console.log("[上架]", stamp(), "\ud83d\udcf7", name, "->", r.path);
  else if (r && !r.ok) console.log("[上架]", stamp(), "\ud83d\udcf7", name, "失败:", String(r.reason || "").slice(0, 80));
  return r;
};
let page = conn.page;
console.log("[上架]", stamp(), "产品 =", P.title, "| 目标类目 =", P.category, "| 期望 SKU =", SKUS.length);
  console.log("[上架]", stamp(), "素材包 =", JSON.stringify({ pack: ASSETS.packName, exists: ASSETS.exists, 白底图: ASSETS.whiteBg ? "有" : "无", 视频: ASSETS.video ? "有" : "无" }));

try {
  // ⓪a 数据预检（在动浏览器之前拦坏数据；照插件 validateListingPayload）
  {
    const pl = await validateListingPayload(P, D).catch((e) => ({ ok: false, blocking: ["precheck_error:" + String(e.message).slice(0, 80)], warnings: [] }));
    console.log("[上架]", stamp(), "⓪a 数据预检 =", JSON.stringify({ ok: pl.ok, blocking: pl.blocking, warnings: pl.warnings }).slice(0, 300));
    if (!pl.ok) throw new Error("payload_precheck_failed:" + pl.blocking.join(","));
  }

  // ⓪ 查重（填表前门禁；命中同标题就停，交人工决定）
  const SKIP_DUP = CFG.skipDup === true; // 测试可跳过查重（插件等价 PDD_SKIP_DUP=1）
  if (!SKIP_DUP) {
    const dup = await checkDuplicate(page, P.title, SKUS).catch(() => "search_failed");
    console.log("[上架]", stamp(), "⓪ 查重 =", dup);
    if (dup !== "not_found") throw new Error("duplicate_check_failed:" + dup);
  } else {
    console.log("[上架]", stamp(), "⓪ 查重 = (跳过)");
  }

  // ① 打开发布页（直接访问 → 兜底「商品列表 → 发布新商品」；已进表单时走「已在表单」路径）
  const opened = await openPublishPage(conn.task, page);
  page = opened.page;
  console.log("[上架]", stamp(), "① 打开发布页 =", JSON.stringify({ how: opened.how, state: opened.state }).slice(0, 220));
  await dismissOverlays(page);

  let kind = await detectCategoryPage(page);
  console.log("[上架]", stamp(), "① 类目页 =", kind.kind, "|", JSON.stringify(kind.evidence).slice(0, 160));
  let onForm = String((kind.evidence || {}).url || "").includes("goods_add") || String(opened.how || "") === "already_on_form";

  // 已在表单 → **不点「修改分类」**，直接重开一张全新类目页重跑（用户口径）
  if (onForm) {
    console.log("[上架]", stamp(), "②b 已在表单 → 直接重开类目页重跑（不点修改分类）");
    await gotoUrl(page, "https://mms.pinduoduo.com/goods/category");
    await sleep(4500);
    kind = await detectCategoryPage(page);
    onForm = String((kind.evidence || {}).url || "").includes("goods_add");
    console.log("[上架]", stamp(), "① 类目页(重开) =", kind.kind);
    if (onForm) throw new Error("reopen_still_on_form");
  }
  if (!onForm && kind.kind === "unknown") throw new Error("category_page_unknown");

  if (onForm && kind.kind === "unknown") {
    // 已在表单且类目已核对通过 → 只补主图与标题
    const upF = await uploadZoneFast(page, "商品轮播图", 10, D.main_images.slice(0, 10), { timeoutMs: 240000 });
    console.log("[上架]", stamp(), "②b 主图 =", JSON.stringify(upF));
    const tiF = await fillTitle(page, P.title);
    console.log("[上架]", stamp(), "②b 标题 =", JSON.stringify(tiF));
  } else if (kind.kind === "old") {
    // ② 旧版页：先在类目页选类目，再进表单补主图/标题
    const scOld = await searchCategory(page, P.category, { confirm: true });
    console.log("[上架]", stamp(), "② 旧版-类目 =", JSON.stringify(scOld).slice(0, 200));
    if (!scOld.ok) throw new Error("category_failed_old:" + scOld.reason);
    await sleep(2500);
    const hasNext = await page.evaluate(() => [...document.querySelectorAll("button")].some((b) => b.offsetParent && /下一步/.test(b.innerText || "")));
    if (hasNext) {
      await clickText(page, "下一步", { exact: false, timeoutMs: 15000 }).catch(() => {});
      await sleep(6000);
    }
    const up2 = await uploadZoneFast(page, "商品轮播图", 10, D.main_images.slice(0, 10), { timeoutMs: 240000 });
    console.log("[上架]", stamp(), "③ 旧版-主图 =", JSON.stringify(up2));
    const ti2 = await fillTitle(page, P.title);
    console.log("[上架]", stamp(), "③ 旧版-标题 =", JSON.stringify(ti2));
    const urlOld = await page.url();
    console.log("[上架]", stamp(), "③ 旧版-URL =", urlOld.slice(0, 100));
    if (!urlOld.includes("goods_add")) throw new Error("not_on_form_old");
  } else {
    // ② 新版页：主图 + 标题 → 手动选类目 → 下一步
    const mu = await uploadMainImages(page, D.main_images, { capacity: 10 });
    console.log("[上架]", stamp(), "② 主图 =", JSON.stringify(mu));
    const ti = await fillTitle(page, P.title);
    console.log("[上架]", stamp(), "② 标题 =", JSON.stringify(ti));
    const om = await openManualCategoryPicker(page);
    console.log("[上架]", stamp(), "② 手动选类目入口 =", JSON.stringify(om));
    const sc = await searchCategory(page, P.category, { confirm: true });
    console.log("[上架]", stamp(), "② 类目 =", JSON.stringify(sc));
    if (!sc.ok) throw new Error("category_failed");
    const nx = await goNextToForm(page);
    console.log("[上架]", stamp(), "② 进表单 =", JSON.stringify(nx).slice(0, 220));
  await shot("② 表单");
    if (!nx.ok) throw new Error("not_on_form");
    const catNow = nx.category || nx.categoryRaw || "";
    if (!pathSuffixMatch(catNow, P.category)) throw new Error("category_mismatch_on_form:" + catNow);
    console.log("[上架]", stamp(), "② 表单类目回读 ok =", String(nx.category || "").slice(0, 40));
  }
  const gid = (page.url && (await page.url()).match(/goods_id=(\d+)/) || [])[1];
  await dismissOverlays(page);

  // ④ 详情图
  const dz = await uploadZoneFast(page, "商品详情", 50, D.detail_images, { timeoutMs: 420000, waitMs: 240000 });
  console.log("[上架]", stamp(), "④ 详情图 =", JSON.stringify(dz));
  if (dz && dz.failedCount > 0) {
    console.log("[上架]", stamp(), "④ ⚠️ 详情图有上传失败项（平台偶发，计数器会虚高）=", JSON.stringify(dz.failedImgs));
    console.log("[上架]", stamp(), "④ ⚠️ 建议：这一轮跑完后若 ⑩ 的 detail_images 判 fail，直接重跑该店（顺序不会错）");
  }
  await shot("④ 详情图");

  // ④a 包装标签图：必须为 0（有残留就清空）；主图计数用两套文案独立核对
  {
    const mi = await mainImagesState(page).catch(() => null);
    let pl = await packagingLabelState(page).catch(() => null);
    console.log("[上架]", stamp(), "④a 主图计数 =", JSON.stringify(mi), "| 包装标签图 =", JSON.stringify(pl));
    if (pl && pl.uploaded > 0) {
      const cl = await clearZone(page, "包装标签图", pl.total || 10);
      pl = cl.state || (await packagingLabelState(page).catch(() => null));
      console.log("[上架]", stamp(), "④a 已清空包装标签图 =", JSON.stringify(cl), "→", JSON.stringify(pl));
    }
  }

  // ④b 商品视频（自动解析：素材包里没有视频就跳过）
  const VIDEO_ZONES = ASSETS.video ? [{ zone: "商品视频", file: ASSETS.video }] : [];
  for (const vz of VIDEO_ZONES) {
    const t0 = Date.now();
    const r = await uploadVideo(page, vz.zone, vz.file, { timeoutMs: 420000 });
    console.log(
      "[上架]",
      stamp(),
      "④b " + vz.zone + " =",
      JSON.stringify({ ok: r.ok, already: r.already, how: r.how, reason: r.reason, secs: Math.round((Date.now() - t0) / 1000), state: r.state })
    );
  }
  if (!VIDEO_ZONES.length) console.log("[上架]", stamp(), "④b 商品视频 = (素材包无视频，跳过)");

  // ④c 白底图（自动解析：素材包里没有白底图就跳过）
  {
    if (!ASSETS.whiteBg) {
      console.log("[上架]", stamp(), "④c 白底图 = (素材包无白底图，跳过)");
    } else {
      const t0 = Date.now();
      const r = await uploadWhiteBg(page, ASSETS.whiteBg, { timeoutMs: 180000 });
      console.log("[上架]", stamp(), "④c 白底图 =", JSON.stringify({ ok: r.ok, already: r.already, reason: r.reason, secs: Math.round((Date.now() - t0) / 1000), state: r.state }));
      await shot("④c 白底图");
    }
  }

  // ⑤ 品牌 + 属性
  const br = await fillBrand(page, P.brand);
  console.log("[上架]", stamp(), "⑤ 品牌 =", JSON.stringify(br));

  const DIRECT = new Set(["厚度", "平方克重", "重量"]);
  const drop = {};
  const direct = {};
  for (const [k, arr] of Object.entries(P.attributes || {})) (DIRECT.has(k) ? direct : drop)[k] = arr;
  const ar = await applyAttributesByCandidates(page, drop);
  console.log("[上架]", stamp(), "⑤ 下拉属性 =", JSON.stringify({ ok: ar.ok, needReview: ar.needReview.map((x) => x.label) }));
  const df = await fillDirectAttrs(page, Object.entries(direct).map(([label, arr]) => ({ label, value: String((arr && arr[0]) || "") })));
  {
    const pr = await probeRequiredAttributes(page).catch(() => ({ requiredCount: 0, missing: [] }));
    console.log("[上架]", stamp(), "⑤ 必填属性探测 =", JSON.stringify({ requiredCount: pr.requiredCount, missing: pr.missing }).slice(0, 240));
  }
  console.log("[上架]", stamp(), "⑤ 直填属性 =", JSON.stringify(df));
  await shot("⑤ 属性");

  // ⑤c 运费模板（★上架前必须先问用户：用店铺默认模板，还是指定某个模板）
  {
    const FREIGHT = String(CFG.freightTemplate ?? "").trim();
    if (FREIGHT === "__ASK__") {
      const L = await listFreightTemplates(page).catch(() => ({ options: [] }));
      console.log("[上架]", stamp(), "⑤c ⏸ 上架前待确认：本店可用运费模板 =", JSON.stringify(L.options || []).slice(0, 500));
      throw new Error("ask_user_before_listing:freight_template");
    }
    if (!FREIGHT) {
      const cur = await readFreightTemplate(page).catch(() => null);
      console.log("[上架]", stamp(), "⑤c 运费模板 = (未指定 → 保持店铺当前/默认)", JSON.stringify(cur));
    } else {
      const ft = await setFreightTemplate(page, FREIGHT);
      console.log("[上架]", stamp(), "⑤c 运费模板 =", JSON.stringify({ want: FREIGHT, ok: ft.ok, got: ft.got, mode: ft.mode, attempt: ft.attempt }).slice(0, 240));
      if (!ft.ok) {
        console.log("[上架]", stamp(), "⑤c 该店可用模板 =", JSON.stringify(ft.options || []).slice(0, 400));
        throw new Error("freight_template_failed:" + String(ft.got || "unknown"));
      }
      await shot("⑤c 运费模板");
    }
  }

  // ⑥ 规格表
  const spec = await stepRetry("⑥ 规格表", () => ensureSpecTable(page, DIMS, [V0, V1]).then((r) => { if (!r || !r.ok) throw new Error("spec_table_not_ok:" + JSON.stringify(r && r.reason || "")); return r; }));
  console.log("[上架]", stamp(), "⑥ 规格表 ok =", spec.ok, "| matrix =", JSON.stringify(spec.matrix), "| rounds =", spec.rounds);
      await shot("⑥ 规格表");
  if (!spec.ok) throw new Error("spec_table_failed");

  // ⑦ 填 12 行
  // 默认走 CDP 一次性（插件同算法、速度快 ~2-4 倍）；失败自动退回 Node 逐行
  const USE_CDP_FILL = CFG.cdpFill !== false;
  const t7 = Date.now();
  let fr;
  if (USE_CDP_FILL) {
    const cdp = await fillSkuRowsCDP(page, P, { timeoutMs: Number(CFG.cdpFillTimeoutMs || 180000) }).catch((e) => ({ ok: false, err: e.message }));
    if (cdp && cdp.ok) {
      fr = { ...cdp, method: "cdp_one_shot" };
    } else {
      console.log("[上架]", stamp(), "⑦ ⚠️ CDP 填值未通过（", String((cdp && (cdp.err || cdp.bad)) || "").slice(0, 60), "）→ 退回逐行填值");
      fr = await fillSkuRowsAndVerify(page, P);
      fr.method = "node_stepping_fallback";
    }
  } else {
    fr = await fillSkuRowsAndVerify(page, P);
    fr.method = "node_stepping";
  }
  fr.wallMs = Date.now() - t7;
  console.log("[上架]", stamp(), "⑦ 填值 =", JSON.stringify(fr), "| 库存合计=" + fr.stockSum + "/" + fr.expected);
  await shot("⑦ 填值");

  // ⑧ 预览图 + ⑧b 正向核验
  const pv = await stepRetry("⑧ 预览图", () => uploadMissingPreviews(page, P, { colorToFile }));
  console.log("[上架]", stamp(), "⑧ 预览图 =", JSON.stringify(pv));
  await shot("⑧ 预览图");
  const cp = await countPreviewCells(page, P);
  console.log("[上架]", stamp(), "⑧b 正向核验 =", JSON.stringify({ total: cp.total, withImg: cp.withImg, missing: cp.missing.length, sample: cp.missing.slice(0, 3) }));

  // ⑨ 参考价
  const rp = await setRefPrice(page, P.ref_price);
  console.log("[上架]", stamp(), "⑨ 参考价 =", JSON.stringify(rp));
  await shot("⑨ 参考价");

  // ⑨b 详情区复核/补传
  let z = await readDetailZone(page);
  console.log("[上架]", stamp(), "⑨b 详情区 =", `计数器 ${z.counter} / 容器 ${z.containers} / 期望 ${D.detail_images.length}`);
  if ((z.counter || 0) < D.detail_images.length) {
    const re = await uploadZoneFast(page, "商品详情", 50, D.detail_images, { timeoutMs: 300000, waitMs: 180000 });
    console.log("[上架]", stamp(), "⑨b 补传 =", JSON.stringify(re));
    z = await readDetailZone(page);
    console.log("[上架]", stamp(), "⑨b 复核后 =", `计数器 ${z.counter} / 容器 ${z.containers}`);
  }
  // 多出来的图：逐张删残留（插件 ⑨b 下半段）
  if (z.containers > D.detail_images.length) {
    const cl = await cleanExtraDetails(page, D.detail_images.length).catch((e) => ({ removed: 0, err: String(e.message).slice(0, 80) }));
    z = cl.state || (await readDetailZone(page));
    console.log("[上架]", stamp(), "⑨b 删残留 =", JSON.stringify(cl).slice(0, 160), "→", `计数器 ${z.counter} / 容器 ${z.containers}`);
  }

  // ⑩ 终校验
  const vf = await validateForm(page, { ...P, main_images: D.main_images || [], detail_images: D.detail_images || [], _assets: { whiteBgExpected: !!ASSETS.whiteBg, videoExpected: !!ASSETS.video } });
  console.log("[上架]", stamp(), "⑩ validateForm allPass =", vf.allPass, "| anyFail =", vf.anyFail);
  await shot("⑩ 终校验");
  for (const c of vf.checks) console.log("     [" + (c.status === "pass" ? "pass" : "FAIL") + "] " + c.name + ": " + String(c.value).slice(0, 64));

  // ⑪ 可选提交（仅在用户当轮明确授权；CFG.submitAfterPass === true 才执行）
  if (CFG.submitAfterPass === true) {
    if (!vf.allPass) throw new Error("submit_blocked_validation_failed");
    console.log("[上架]", stamp(), "⑪ 提交授权已确认（allPass=true）→ 点「提交并上架」");
    const sub = await submitProduct(page, vf);
    console.log("[上架]", stamp(), "⑪ 提交结果 =", JSON.stringify(sub).slice(0, 260));
    if (!sub || !sub.success) throw new Error("submit_failed:" + JSON.stringify(sub || {}).slice(0, 120));
    const gid2 = (sub && sub.goodsId) || gid;
    if (gid2) {
      const st = await verifyListed(page, gid2).catch((e) => ({ status: "unknown", error: String(e.message).slice(0, 80) }));
      console.log("[上架]", stamp(), "⑪b 后台状态 =", JSON.stringify(st).slice(0, 260));
    }
  }

  // 保存草稿（不提交）
  if (SAVE_DRAFT) {
    const saved = await page.evaluate(() => {
      const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
      const el = [...document.querySelectorAll("button, [role=button], span, div, a")].find(
        (e) => e.offsetParent && !e.children.length && norm(e.textContent) === "保存草稿"
      );
      if (!el) return null;
      el.scrollIntoView({ block: "center" });
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    });
    if (saved) {
      await page.mouse.click(saved.x, saved.y, { label: "save draft" });
      await sleep(6000);
      const toast = await page.evaluate(() => {
        const t = (document.body.innerText || "").replace(/\s+/g, " ");
        return (t.match(/(保存成功|草稿保存成功|保存失败)/) || [])[1] || null;
      });
      console.log("[上架]", stamp(), "★ 已保存草稿 =", toast);

      // 关掉「保存成功」弹窗（按 button 角色找，并验证消失），否则会挡住后续所有点击
      for (let k = 0; k < 3; k++) {
        const alive = await page.evaluate(() => (document.body.innerText || "").includes("保存成功"));
        if (!alive) break;
        const b = await page.evaluate(() => {
          const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
          const btns = [...document.querySelectorAll("button, [role=button]")].filter(
            (x) => x.offsetParent && /确定|知道了/.test(norm(x.innerText))
          );
          if (!btns.length) return null;
          const el = btns[btns.length - 1];
          el.scrollIntoView({ block: "center" });
          const r = el.getBoundingClientRect();
          return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
        });
        if (!b) break;
        await page.mouse.click(b.x, b.y, { label: "dismiss save toast" });
        await sleep(1500);
      }
      console.log("[上架]", stamp(), "★ 保存弹窗已关闭 =", !(await page.evaluate(() => (document.body.innerText || "").includes("保存成功"))));
    }
  }

  console.log("[上架]", stamp(), "★ 未提交 · 草稿 goods_id =", gid || "(见 URL)");
  console.log("[上架]", stamp(), "URL =", await page.url());
  if (CFG.shotDir || CFG.shot === true) {
    const fp = await shotPage(page, SHOT_DIR, "final", { fullPage: true }).catch(() => null);
    if (fp && fp.ok) console.log("[上架]", stamp(), "\ud83d\udcf7 final(fullPage) ->", fp.path);
    else console.log("[上架]", stamp(), "\ud83d\udcf7 final 截图失败:", String((fp && fp.reason) || "unknown").slice(0, 90), "（ego 截图要求窗口不最小化）");
  }
} catch (e) {
  console.log("[上架] FAIL:", String(e.message).slice(0, 300));
}
