// pdd_flow_ego.mjs —— 拼多多上架流程的 ego 移植版
// 设计原则：**函数名、步骤顺序、校验语义与 pdd_flow.js / run_listing.js 保持一致**，
// 只把执行层从 Playwright 换成 ego（taskSpace / page / mouse / keyboard / setInputFiles）。
// 绝不提交；只填空 + 校验。

export const log = (...a) => console.log("[上架]", ...a);

let __mk = 0;
/** 生成唯一 data-ego 标记（避免多次调用时同一标记匹配到多个 input）*/
const mk = (prefix) => `ego-${prefix}-${++__mk}`;

// ─────────────────────────── 基础工具
/**
 * 容错跳转：ego 的 goto 默认只等 load（15s），重 SPA 会抛 PageNavigationTimeoutError；
 * 且 ego 的 goto 选项只认 waitUntil（传 timeoutMs 会报 Invalid parameters）。
 * 策略：先带 waitUntil 试 → 失败再不带选项试 → 仍失败也继续（导航通常已提交）。
 */
export async function gotoUrl(page, url) {
  const u = String(url);
  try {
    await page.goto(u, { waitUntil: "domcontentloaded" });
  } catch (e1) {
    try {
      await page.goto(u);
    } catch (e2) {
      // 导航可能已提交，继续
    }
  }
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await sleep(1500);
  return await page.url().catch(() => u);
}

// _restore_block.js —— 重建被误删的基础/页面函数（插入到 pdd_flow_ego.mjs 的 gotoUrl 之后）

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 页面上是否出现某段文本 */
export async function hasText(page, text) {
  return page.evaluate((t) => (document.body.innerText || "").replace(/\s+/g, " ").includes(t), text);
}

/** 点某个文本元素（可信鼠标） */
export async function clickText(page, text, { exact = true, timeoutMs = 15000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pos = await page.evaluate(
      ({ t, ex }) => {
        const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
        const vis = (e) => !!(e && e.offsetParent);
        const hits = [...document.querySelectorAll("button, [role=button], a, span, div")]
          .filter((el) => vis(el) && !el.children.length)
          .filter((el) => (ex ? norm(el.textContent) === t : norm(el.textContent).includes(t)));
        if (!hits.length) return null;
        const el = hits[hits.length - 1];
        el.scrollIntoView({ block: "center" });
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      },
      { t: text, ex: exact }
    );
    if (pos) {
      await page.mouse.click(pos.x, pos.y, { label: "click " + String(text).slice(0, 12) });
      return true;
    }
    await sleep(500);
  }
  return false;
}

/** 按坐标点某选择器（先滚进视口；ego 的 page.click 不会自动滚动） */
export async function clickSelector(page, sel) {
  const pos = await page.evaluate((s) => {
    const el = [...document.querySelectorAll(s)].find((e) => e.offsetParent);
    if (!el) return null;
    el.scrollIntoView({ block: "center" });
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  }, sel);
  if (!pos) return false;
  await page.mouse.click(pos.x, pos.y, { label: "click sel" });
  return true;
}

/** 读图区计数器 */
export async function readImageCounters(page) {
  return page.evaluate(() => {
    const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
    const t = norm(document.body.innerText);
    const out = [];
    const re = /([^\n]{0,20}?)(?:已上传\s*(\d+)\s*\/\s*(\d+)\s*张?|上传图片\s*\(\s*(\d+)\s*\/\s*(\d+)\s*\))/g;
    let m;
    while ((m = re.exec(t))) out.push({ ctx: norm(m[1]).slice(-20), up: Number(m[2] ?? m[4]), total: Number(m[3] ?? m[5]) });
    return out;
  });
}

/** 识别类目页形态：old=有搜索框；new=有商品主图+下一步 */
export async function detectCategoryPage(page) {
  const ev = await page.evaluate(() => {
    const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
    const t = norm(document.body.innerText);
    return {
      title: document.title,
      url: location.href.slice(0, 120),
      searchBox: !!document.querySelector('input[placeholder*="关键词搜索分类"]'),
      hasMainImage: t.includes("商品主图"),
      hasNext: t.includes("下一步"),
      hasManualEntry: t.includes("手动选择商品分类"),
      bodyLen: t.length,
    };
  });
  let kind = "unknown";
  if (ev.searchBox) kind = "old";
  else if (ev.hasMainImage && ev.hasNext) kind = "new";
  return { kind, evidence: ev };
}

/** 分段后缀匹配（与插件 pathSuffixMatch 同义） */
export function pathSuffixMatch(cand, target) {
  const seg = (x) => String(x || "").split(">").map((v) => v.replace(/\s+/g, " ").trim()).filter(Boolean);
  const a = seg(cand);
  const b = seg(target);
  if (!a.length || !b.length || a.length > b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[a.length - 1 - i] !== b[b.length - 1 - i]) return false;
  return true;
}

/** 打开「手动选择商品分类」弹窗（插件 openManualCategoryPicker 同义） */
export async function openManualCategoryPicker(page, { timeoutMs = 25000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = { ok: false, how: "button_not_found" };
  while (Date.now() < deadline) {
    const r = await page.evaluate(() => {
      const vis = [...document.querySelectorAll("*")].filter((e) => e.offsetParent);
      if (vis.some((e) => e.tagName === "INPUT" && /关键词搜索分类/.test(e.placeholder || ""))) {
        return { ok: true, how: "already_open" };
      }
      const btns = vis.filter((e) => e.tagName === "BUTTON" && /手动选择商品分类/.test(e.innerText || ""));
      if (btns.length) {
        btns[0].scrollIntoView({ block: "center" });
        btns[0].click();
        return { ok: true, how: "clicked" };
      }
      const t = (document.body.innerText || "").replace(/\s+/g, " ");
      if (/暂无推荐的分类|点击手动选择分类/.test(t)) {
        const pickBtn = vis.filter((e) => e.tagName === "BUTTON" && /^\s*选择分类\s*$/.test((e.innerText || "").trim()));
        if (pickBtn.length) {
          pickBtn[0].scrollIntoView({ block: "center" });
          pickBtn[0].click();
          return { ok: true, how: "clicked_pick_category" };
        }
      }
      const more = vis.filter((e) => {
        const t2 = (e.innerText || "").replace(/\s+/g, " ").trim();
        return /查看更多推荐/.test(t2) && t2.length < 30;
      });
      if (more.length) {
        more[more.length - 1].scrollIntoView({ block: "center" });
        more[more.length - 1].click();
        return { ok: false, how: "expanded_more" };
      }
      return { ok: false, how: "nothing_to_click" };
    });
    if (r.ok) {
      if (r.how === "clicked") await sleep(3500);
      return r;
    }
    last = r;
    await sleep(2000);
  }
  return last;
}

/** 选类目（插件 searchCategory 同义）：真实输入 → li[class*=searchItem] → 分段后缀匹配 → 已选分类复核 → 确认 */
export async function searchCategory(page, categoryText, { keyword = "", timeoutMs = 25000, confirm = false } = {}) {
  const target = String(categoryText || "").replace(/\s*>\s*/g, " > ").trim();
  if (!target) return { ok: false, reason: "empty_category" };
  const leaf = target.split(">").pop().trim();
  const kw = keyword || leaf;

  let box = null;
  {
    const dl = Date.now() + 12000;
    while (Date.now() < dl) {
      box = await page.evaluate(() => {
        const el = [...document.querySelectorAll("input")].find((i) => i.offsetParent && /关键词搜索分类/.test(i.placeholder || ""));
        if (!el) return null;
        el.scrollIntoView({ block: "center" });
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      });
      if (box) break;
      await sleep(600);
    }
  }
  if (!box) return { ok: false, reason: "search_box_not_found" };

  let typedOk = false;
  for (let attempt = 1; attempt <= 3 && !typedOk; attempt++) {
    await page.mouse.click(box.x, box.y, { label: "focus category search" });
    await sleep(300);
    await page.keyboard.press("Control+a").catch(() => {});
    await page.keyboard.press("Backspace").catch(() => {});
    await sleep(150);
    await page.keyboard.insertText(kw);
    await sleep(900);
    typedOk = await page.evaluate((v) => {
      const el = [...document.querySelectorAll("input")].find((i) => i.offsetParent && /关键词搜索分类/.test(i.placeholder || ""));
      return !!(el && (el.value || "").includes(v));
    }, kw);
    if (!typedOk) {
      box = await page.evaluate(() => {
        const el = [...document.querySelectorAll("input")].find((i) => i.offsetParent && /关键词搜索分类/.test(i.placeholder || ""));
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      });
      if (!box) break;
    }
  }
  if (!typedOk) return { ok: false, reason: "search_input_not_applied", keyword: kw };

  const deadline = Date.now() + timeoutMs;
  let strict = [];
  let seen = [];
  while (Date.now() < deadline) {
    await sleep(700);
    const r = await page.evaluate((t) => {
      const items = [...document.querySelectorAll("li[class*=searchItem], li[class*=SearchItem]")].filter((e) => e.offsetParent);
      const seg = (x) => String(x || "").split(">").map((v) => v.replace(/\s+/g, " ").trim()).filter(Boolean);
      const ts = seg(t);
      const texts = items.map((e) => (e.textContent || "").replace(/\s+/g, " ").trim());
      const isHit = (x) => {
        const a = seg(x);
        if (!a.length || a.length > ts.length) return false;
        for (let i = 0; i < a.length; i++) if (a[a.length - 1 - i] !== ts[ts.length - 1 - i]) return false;
        return true;
      };
      return { exact: texts.filter(isHit), all: [...new Set(texts)] };
    }, target);
    strict = r.exact;
    seen = r.all;
    if (strict.length) break;
  }
  if (!strict.length) return { ok: false, reason: "no_exact_match", seen };
  if (strict.length > 1) return { ok: false, reason: "ambiguous_exact_match(" + strict.length + ")", seen };

  const clicked = await page.evaluate((t) => {
    const seg = (x) => String(x || "").split(">").map((v) => v.replace(/\s+/g, " ").trim()).filter(Boolean);
    const el = [...document.querySelectorAll("li[class*=searchItem], li[class*=SearchItem]")]
      .filter((e) => e.offsetParent)
      .find((e) => {
        const a = seg((e.textContent || "").replace(/\s+/g, " ").trim());
        const b = seg(t);
        if (!a.length || a.length > b.length) return false;
        for (let i = 0; i < a.length; i++) if (a[a.length - 1 - i] !== b[b.length - 1 - i]) return false;
        return true;
      });
    if (!el) return false;
    el.scrollIntoView({ block: "center" });
    el.click();
    return true;
  }, target);
  if (!clicked) return { ok: false, reason: "click_failed", seen };
  await sleep(1800);

  const readback = await page.evaluate(() => {
    const t = document.body.innerText || "";
    const m = t.match(/已选分类\s*([^\n]{0,80})/);
    return m ? m[1].replace(/\s+/g, " ").trim() : null;
  });
  const chosenNorm = readback ? readback.replace(/\s*>\s*/g, " > ").trim() : null;
  if (!pathSuffixMatch(chosenNorm, target)) return { ok: false, reason: "selected_mismatch", chosen: chosenNorm, seen };

  let confirmed = null;
  if (confirm) {
    const pos = await page.evaluate(() => {
      const vis = (e) => !!(e && e.offsetParent);
      const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
      let btns = [...document.querySelectorAll("button")].filter((b) => vis(b) && /^\s*确认\s*$/.test(norm(b.innerText)));
      if (!btns.length) btns = [...document.querySelectorAll("button")].filter((b) => vis(b) && norm(b.innerText).includes("确认发布该类商品"));
      if (!btns.length) return null;
      const el = btns[btns.length - 1];
      el.scrollIntoView({ block: "center" });
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), text: norm(el.innerText) };
    });
    if (pos) {
      await page.mouse.click(pos.x, pos.y, { label: "confirm category" });
      confirmed = pos.text;
    }
    await sleep(2000);
  }
  return { ok: true, chosen: chosenNorm, leaf, seen, confirmed };
}

/** 点「下一步」进表单并等表单骨架就绪 */
export async function goNextToForm(page, { timeoutMs = 30000 } = {}) {
  const clicked = await clickText(page, "下一步", { exact: false, timeoutMs });
  const deadline = Date.now() + 45000;
  let last = null;
  while (Date.now() < deadline) {
    const ready = await page.evaluate(() => {
      const norm = (x) => (x || "").replace(/\s+/g, " ").trim();
      const t = (document.body.innerText || "").replace(/\s+/g, " ");
      let categoryRaw = null;
      const i = t.indexOf("商品分类");
      if (i >= 0) {
        const tail = t.slice(i + 4);
        const j = tail.indexOf("修改分类");
        categoryRaw = norm(j > 0 && j < 120 ? tail.slice(0, j) : tail.slice(0, 80));
      }
      const m = t.match(/商品分类\s*([\u4e00-\u9fa5A-Za-z0-9/]+(?:\s*>\s*[\u4e00-\u9fa5A-Za-z0-9/]+)+)/);
      return {
        onForm: location.href.includes("goods_add"),
        hasBrand: t.includes("品牌"),
        hasCarousel: t.includes("商品轮播图"),
        hasModify: t.includes("修改分类"),
        category: m ? m[1] : categoryRaw,
        categoryRaw,
      };
    });
    last = ready;
    if (ready.onForm && ready.hasCarousel && ready.hasModify) return { ok: true, clicked, ...ready };
    await sleep(1000);
  }
  return { ok: false, clicked, ...(last || {}) };
}

/** 主图上传（新版页：第一个可见 file input；旧版页：逐个图片 input 试 + 主图计数验证） */
export async function uploadMainImages(page, files, { capacity = 10, timeoutMs = 180000 } = {}) {
  const n = Math.min(files.length, capacity);
  const marker = "ego-main-" + Date.now();
  const sel = await page.evaluate((mkv) => {
    const el = [...document.querySelectorAll("input[type=file]")].find((i) => i.offsetParent) || document.querySelector("input[type=file]");
    if (!el) return null;
    el.setAttribute("data-ego", mkv);
    return 'css:input[data-ego="' + mkv + '"]';
  }, marker);

  if (sel) {
    // ★主图必须逐张上传：一次性塞 n 张会让平台并发上传、完成顺序不定 → 轮播图顺序随机（首图错位的根因）
    const want = files.slice(0, n);
    for (const f of want) {
      const before = await readImageCounters(page)
        .then((c) => ((c.find((x) => x.total === capacity) || c[0] || {}).up || 0))
        .catch(() => 0);
      await page.setInputFiles(sel, [f]).catch(() => {});
      const dl = Date.now() + 30000;
      let grew = false;
      while (Date.now() < dl) {
        await sleep(900);
        const c = await readImageCounters(page).catch(() => []);
        const nowUp = (c.find((x) => x.total === capacity) || c[0] || {}).up || 0;
        const thumbs = await page
          .evaluate(() => [...document.querySelectorAll("img")].filter((i) => i.offsetParent && /pddpic|pfs\.pinduoduo/.test(i.src || "")).length)
          .catch(() => 0);
        if (nowUp > before || thumbs > before) {
          grew = true;
          break;
        }
      }
      if (!grew) {
        await sleep(1500);
        await page.setInputFiles(sel, [f]).catch(() => {});
        await sleep(6000);
      }
      await sleep(1100);
    }
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      await sleep(1200);
      const thumb = await page.evaluate(() => {
        const norm = (x) => (x || "").replace(/\s+/g, " ").trim();
        const imgs = [...document.querySelectorAll("img")].filter((i) => i.offsetParent && /pddpic|pfs\\.pinduoduo/.test(i.src || "")).length;
        const swaps = [...document.querySelectorAll("*")].filter((e) => e.offsetParent && !e.children.length && norm(e.textContent) === "更换").length;
        return Math.max(imgs, swaps);
      }).catch(() => 0);
      const c = await readImageCounters(page);
      last = c.find((x) => x.total === capacity) || c[0] || null;
      if (thumb >= n || (last && last.up >= n)) return { ok: true, thumbs: thumb, uploaded: last ? last.up : thumb };
    }
    if (last && last.up > 0) return { ok: true, thumbs: last.up, uploaded: last.up };
  }

  // 旧版页兜底：逐个图片 input 试（一次只能传 1 张，靠计数验证）
  const imgIdx = await page.evaluate(() =>
    [...document.querySelectorAll("input[type=file]")].map((f, i) => ({ i, accept: f.accept || "" })).filter((x) => /image/i.test(x.accept)).map((x) => x.i)
  );
  for (const idx of imgIdx) {
    const mk2 = "ego-mainx-" + Date.now() + "-" + idx;
    const s2 = await page.evaluate(({ i, mm }) => {
      const f = document.querySelectorAll("input[type=file]")[i];
      if (!f) return null;
      f.setAttribute("data-ego", mm);
      return 'css:input[data-ego="' + mm + '"]';
    }, { i: idx, mm: mk2 }).catch(() => null);
    if (!s2) continue;
    for (const f of files.slice(0, n)) {
      const before = (await mainImagesState(page).catch(() => null) || {}).uploaded || 0;
      if (before >= n) break;
      await page.setInputFiles(s2, [f]).catch(() => {});
      const dl = Date.now() + 30000;
      while (Date.now() < dl) {
        await sleep(1200);
        const st = await mainImagesState(page).catch(() => null);
        if (st && st.uploaded > before) break;
      }
    }
    const st2 = await mainImagesState(page).catch(() => null);
    if (st2 && st2.uploaded >= n) return { ok: true, how: "old_page_index_" + idx, uploaded: st2.uploaded, total: st2.total };
  }
  return { ok: false, reason: "main_upload_failed", state: await mainImagesState(page).catch(() => null) };
}

/** 填标题（聚焦 → 输入 → 失焦，读回校验） */
export async function fillTitle(page, title) {
  const sel = 'input[placeholder*="商品标题"]';
  const ok = await clickSelector(page, sel);
  if (!ok) return { ok: false, reason: "no_input" };
  await sleep(200);
  await page.keyboard.press("Control+a").catch(() => {});
  await page.keyboard.press("Backspace").catch(() => {});
  await page.keyboard.insertText(String(title));
  await sleep(300);
  await page.evaluate(() => {
    const a = document.activeElement;
    if (a && typeof a.blur === "function") a.blur();
  });
  await clickText(page, "商品标题", { exact: false, timeoutMs: 3000 }).catch(() => {});
  await sleep(1200);
  const back = await page.evaluate(() => {
    const i = [...document.querySelectorAll("input")].find((x) => /商品标题/.test(x.placeholder || ""));
    return i ? i.value : null;
  });
  return { ok: back === String(title), value: back };
}

/** 图区上传（逐张 + 逐张核对计数） */
export async function uploadZoneFast(page, zoneName, capacity, files, { timeoutMs = 300000, waitMs = 60000 } = {}) {
  const marker = "ego-zone-" + Date.now();
  const sel = await page.evaluate(
    ({ zone, mkv }) => {
      const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
      const vis = (e) => !!(e && e.offsetParent);
      const isVideoZone = /商品视频|商详视频|讲解视频/.test(zone);
      const blocks = [...document.querySelectorAll("div, section")].filter((e) => {
        if (!vis(e)) return false;
        const t = norm(e.textContent);
        if (!t.includes(zone) || t.length >= 9000) return false;
        if (!/已上传\s*\d+\s*\/\s*\d+|上传图片\s*\(\s*\d+\s*\/\s*\d+\s*\)/.test(t)) return false;
        const ins = [...e.querySelectorAll("input[type=file]")];
        return ins.some((f) => (isVideoZone ? /video/i : /image/i).test(f.accept || ""));
      });
      const block = blocks.sort((a, b) => norm(a.textContent).length - norm(b.textContent).length)[0];
      if (!block) return null;
      const isV = isVideoZone;
      const f = [...block.querySelectorAll('input[type=file]')].find((x) => (isV ? /video/i : /image/i).test(x.accept || "")) || block.querySelector('input[type=file]');
      if (!f) return null;
      f.setAttribute("data-ego", mkv);
      return 'css:input[data-ego="' + mkv + '"]';
    },
    { zone: zoneName, mkv: marker }
  );
  if (!sel) return { ok: false, reason: "zone_not_found", zone: zoneName };

  const isDetail = /商品详情/.test(zoneName);
  const readCount = async () => {
    if (isDetail) {
      const z = await readDetailZone(page).catch(() => null);
      return z && z.counter !== null ? z.counter : null;
    }
    const viaRegex = await page.evaluate((zone) => {
      const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
      const t = norm(document.body.innerText);
      const re = new RegExp(zone + "[\\s\\S]{0,220}?已上传\\s*(\\d+)\\s*/\\s*\\d+");
      const m = t.match(re);
      return m ? Number(m[1]) : null;
    }, zoneName).catch(() => null);
    if (viaRegex !== null) return viaRegex;
    if (/轮播图|主图/.test(zoneName)) {
      const st = await mainImagesState(page).catch(() => null);
      return st ? st.uploaded : null;
    }
    return null;
  };

  const want = Math.min(files.length, capacity);
  const skipped = [];
  const list = files.slice(0, want);

  // ── 详情区：逐张严格上传（计数器会把失败占位也算进 N/50，所以必须核对真实 pfs 图）──
  if (isDetail) {
    const failedImgs = [];
    let okCount = 0;
    let retries = 0;
    for (const f of list) {
      let done = false;
      for (let att = 1; att <= 3 && !done; att++) {
        const z0 = await readDetailZone(page).catch(() => null);
        const baseCnt = z0 ? z0.containers || 0 : 0;
        await page.setInputFiles(sel, [f]).catch(() => {});
        const deadline = Date.now() + 26000;
        let okNow = false;
        while (Date.now() < deadline) {
          await sleep(700);
          const z = await readDetailZone(page).catch(() => null);
          if (!z || (z.containers || 0) <= baseCnt) continue;
          const realNow = await page
            .evaluate((i) => {
              const vis = (e) => !!(e && e.offsetParent);
              const cs = [...document.querySelectorAll("[class*=ImageWithRemark_v2_imageContainer]")].filter(vis);
              const n = cs[i];
              if (!n) return false;
              const im = n.querySelector("img");
              return !!(im && /pfs\.pinduoduo\.com/i.test(im.getAttribute("src") || ""));
            }, (z.containers || 1) - 1)
            .catch(() => false);
          if (realNow) {
            okNow = true;
            break;
          }
        }
        if (okNow) {
          done = true;
          okCount += 1;
          await sleep(1100); // 放慢节奏，降低平台侧偶发失败
        } else {
          // 失败：删掉刚产生的占位，再重试同一张（此时后续图还没传，顺序不会错）
          retries += 1;
          const z2 = await readDetailZone(page).catch(() => null);
          if (z2 && (z2.containers || 0) > baseCnt) {
            await deleteDetailAt(page, (z2.containers || 1) - 1).catch(() => null);
          }
          await sleep(2400);
        }
      }
      if (!done) failedImgs.push(String(f).split("/").pop());
    }
    const fin = await readDetailZone(page).catch(() => null);
    return {
      ok: failedImgs.length === 0 && okCount === want,
      uploaded: fin ? fin.containers : null,
      want,
      okCount,
      failedImgs,
      failedCount: failedImgs.length,
      retries,
      realImgs: fin ? fin.realImgs : null,
      containers: fin ? fin.containers : null,
      zone: zoneName,
      how: "detail_strict",
    };
  }

  let up = (await readCount()) ?? 0;
  for (const f of list) {
    if ((up ?? 0) >= want) break;
    const before = up ?? 0;
    await page.setInputFiles(sel, [f]).catch(() => {});
    const deadline = Date.now() + 30000;
    let grew = false;
    while (Date.now() < deadline) {
      await sleep(800);
      const now = await readCount();
      if (now !== null && now > before) { up = now; grew = true; break; }
      if (now !== null) up = now;
    }
    if (!grew) skipped.push(String(f).split("/").pop());
  }
  let final = await readCount();

  // 兜底：隐藏 input 塞不进去时，点区块内「本地上传」走 filechooser（也逐张）
  if ((final ?? 0) < want) {
    const upBtn = await page.evaluate((zone) => {
      const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
      const vis = (e) => !!(e && e.offsetParent);
      const blocks = [...document.querySelectorAll("div, section")].filter((e) => {
        if (!vis(e)) return false;
        const t = norm(e.textContent);
        if (!t.includes(zone) || t.length >= 9000) return false;
        if (!/已上传\s*\d+\s*\/\s*\d+|上传图片\s*\(\s*\d+/.test(t)) return false;
        return [...e.querySelectorAll('input[type=file]')].some((f2) => /image/i.test(f2.accept || ""));
      });
      const block = blocks.sort((a, b) => norm(a.textContent).length - norm(b.textContent).length)[0];
      if (!block) return null;
      const hits = [...block.querySelectorAll("*")].filter((e) => vis(e) && !e.children.length && norm(e.textContent) === "本地上传");
      if (!hits.length) return null;
      const el = hits[hits.length - 1];
      el.scrollIntoView({ block: "center" });
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    }, zoneName).catch(() => null);

    if (upBtn) {
      for (const f of list) {
        if ((final ?? 0) >= want) break;
        try {
          const cp = page.waitForFileChooser({ timeout: 9000 });
          await page.mouse.click(upBtn.x, upBtn.y, { label: "zone local upload" });
          const ch = await cp;
          await ch.setFiles([f]);
        } catch (e) {
          break;
        }
        const dl = Date.now() + 25000;
        while (Date.now() < dl) {
          await sleep(1500);
          final = await readCount();
          if ((final ?? 0) >= want) break;
        }
      }
      if ((final ?? 0) >= want) return { ok: true, how: "zone_local_upload_button", uploaded: final, want, skipped: [], zone: zoneName };
    }
  }

  // 详情区：计数器会把「上传失败」的占位也算进 N/50，这里单独核对并把失败项映射回文件名
  let failedImgs = [];
  if (isDetail) {
    const z = await readDetailZone(page).catch(() => null);
    if (z && (z.failed || 0) > 0) {
      failedImgs = (z.failedIdx || []).map((i) => String(list[i] || "").split("/").pop()).filter(Boolean);
    }
  }
  return {
    ok: final !== null && final >= want && failedImgs.length === 0,
    uploaded: final,
    want,
    skipped,
    failedImgs,
    failedCount: failedImgs.length,
    zone: zoneName,
  };
}

/**
 * 删除详情区第 index 张（0-based）。用于「上传失败占位」的原地清理。
 * hover 后容器内会出现 DeleteIcon_v2_delete，点它即可删除。
 */
export async function deleteDetailAt(page, index) {
  const pos = await page.evaluate((i) => {
    const vis = (e) => !!(e && e.offsetParent);
    const cs = [...document.querySelectorAll("[class*=ImageWithRemark_v2_imageContainer]")].filter(vis);
    const n = cs[i];
    if (!n) return null;
    n.scrollIntoView({ block: "center" });
    const r = n.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), total: cs.length };
  }, index);
  if (!pos) return { ok: false, reason: "container_not_found", index };
  await page.mouse.move(pos.x, pos.y);
  await sleep(900);
  const del = await page.evaluate((i) => {
    const vis = (e) => !!(e && e.offsetParent);
    const cs = [...document.querySelectorAll("[class*=ImageWithRemark_v2_imageContainer]")].filter(vis);
    const n = cs[i];
    if (!n) return null;
    const ico =
      [...n.querySelectorAll("i, span, div, svg")].filter(vis).find((e) => /DeleteIcon|delete/i.test(String(e.className || "") + (e.getAttribute("data-testid") || ""))) || null;
    if (!ico) return null;
    const r = ico.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), cls: String(ico.className).slice(0, 40) };
  }, index);
  if (!del) return { ok: false, reason: "delete_icon_not_found", index };
  await page.mouse.click(del.x, del.y, { label: "delete detail" });
  await sleep(1600);
  const after = await readDetailZone(page).catch(() => null);
  return { ok: !!after && (after.containers || 0) < (pos.total || 0), index, before: pos.total, after: after ? after.containers : null, icon: del.cls };
}

/** 详情区读数（计数 + 缩略图容器） */
export async function readDetailZone(page) {
  return page.evaluate(() => {
    const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
    const vis = (e) => !!(e && e.offsetParent);
    const t = norm(document.body.innerText);
    const m = t.match(/已上传\s*(\d+)\s*\/\s*50/);
    const counter = m ? Number(m[1]) : null;
    const containers = [...document.querySelectorAll('[class*=ImageWithRemark_v2_imageContainer]')].filter(vis);
    const srcs = containers.map((n) => {
      const im = n.querySelector("img");
      return im ? im.getAttribute("src") || "" : "";
    }).filter(Boolean);
    // 「上传失败」占位也算容器，计数器也会把它算进 N/50 —— 必须单独检测
    const failedIdx = [];
    containers.forEach((n, i) => {
      if (/上传失败|重试/.test(norm(n.innerText))) failedIdx.push(i);
    });
    const noImgIdx = [];
    containers.forEach((n, i) => {
      const im = n.querySelector("img");
      if (!im || !(im.getAttribute("src") || "")) noImgIdx.push(i);
    });
    const realImgs = containers.filter((n) => {
      const im = n.querySelector("img");
      return !!(im && /pfs\.pinduoduo\.com/i.test(im.getAttribute("src") || ""));
    }).length;
    return {
      counter,
      containers: containers.length,
      imgs: [...new Set(srcs)],
      failed: failedIdx.length,
      failedIdx,
      noImg: noImgIdx.length,
      noImgIdx,
      realImgs,
    };
  });
}

/** 品牌输入（搜索 + 选中选项 + 读回） */
export async function fillBrand(page, brand) {
  const has = await clickSelector(page, 'input[placeholder*="品牌名称"]');
  if (!has) return { ok: false, reason: "no_brand_input" };
  await sleep(200);
  await page.keyboard.insertText(String(brand));
  await sleep(2200);
  const pos = await page.evaluate((b) => {
    const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
    const els = [...document.querySelectorAll("*")].filter((el) => el.offsetParent && norm(el.textContent) === b);
    if (!els.length) return null;
    const el = els[els.length - 1];
    el.scrollIntoView({ block: "center" });
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  }, brand);
  if (pos) await page.mouse.click(pos.x, pos.y, { label: "choose brand" });
  await sleep(1200);
  const back = await page.evaluate(() => {
    const i = [...document.querySelectorAll("input")].find((x) => /品牌名称/.test(x.placeholder || ""));
    return i ? i.value : null;
  });
  return { ok: back === String(brand), value: back };
}

/** 读某属性当前值（form-item → input / chip 文本） */
export async function readAttr(page, label) {
  return page.evaluate((lab) => {
    const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
    const nodes = [...document.querySelectorAll('[data-testid="beast-core-form-item"][id^="basic.propertys."]')].filter((e) => e.offsetParent);
    for (const n of nodes) {
      const l = norm(n.querySelector("label")?.innerText || "").replace(/^重要/, "");
      if (l !== lab) continue;
      const inp = n.querySelector("input");
      const sv = norm([...n.querySelectorAll('[class*="selectValue"]')].map((e) => e.innerText).join(" "));
      return (inp && inp.value) || sv || "";
    }
    return null;
  }, label);
}

/** 属性批量填写（候选数组取第一个；必须真点中选项才算成功） */
export async function applyAttributesByCandidates(page, attrs) {
  const results = [];
  const needReview = [];
  for (const [label, arr] of Object.entries(attrs || {})) {
    const value = String((arr && arr[0]) ?? "");
    if (!value) continue;
    let ok = false;
    let how = "datapack";
    let lastGot = null;
    let clicked = { ok: false };

    for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
      const pos = await page.evaluate((lab) => {
        const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
        const nodes = [...document.querySelectorAll('[data-testid="beast-core-form-item"][id^="basic.propertys."]')].filter((e) => e.offsetParent);
        for (const n of nodes) {
          if (norm(n.querySelector("label")?.innerText || "").replace(/^重要/, "") !== lab) continue;
          const inp = n.querySelector("input");
          if (!inp || !inp.offsetParent) return null;
          inp.scrollIntoView({ block: "center" });
          const r = inp.getBoundingClientRect();
          return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
        }
        return null;
      }, label);
      if (!pos) { lastGot = null; break; }
      await page.mouse.click(pos.x, pos.y, { label: "open " + label });
      await sleep(800);
      await dismissOverlays(page);

      clicked = await page.evaluate((val) => {
        const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
        const els = [...document.querySelectorAll("*")].filter(
          (el) => el.offsetParent && norm(el.textContent) === norm(val) && !/立即体验|换背景/.test(norm(el.textContent))
        );
        if (!els.length) return { ok: false };
        els[els.length - 1].click();
        return { ok: true, how: "direct" };
      }, value);
      if (clicked.ok) how = clicked.how;

      if (!clicked.ok) {
        await page.keyboard.insertText(value).catch(() => {});
        await sleep(1300);
        clicked = await page.evaluate((val) => {
          const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
          const panels = [...document.querySelectorAll("[class*=dropdownPanel], [class*=dropdownMain], [class*=PP_outerWrapper]")]
            .filter((e) => e.offsetParent && !/立即体验|换背景/.test(e.innerText || ""));
          const scope = panels.sort((a, b) => (b.innerText || "").length - (a.innerText || "").length)[0] || document.body;
          const els = [...scope.querySelectorAll("*")].filter((el) => el.offsetParent && norm(el.textContent) === norm(val));
          if (!els.length) return { ok: false };
          els[els.length - 1].click();
          return { ok: true, how: "typed_filter" };
        }, value);
        if (clicked.ok) how = clicked.how;
      }
      await sleep(900);

      if (clicked.ok) {
        lastGot = await readAttr(page, label);
        ok = (lastGot || "").includes(value);
      } else {
        ok = false;
        lastGot = null;
        await page.evaluate((lab) => {
          const norm = (x) => (x || "").replace(/\s+/g, " ").trim();
          const nodes = [...document.querySelectorAll('[data-testid="beast-core-form-item"][id^="basic.propertys."]')].filter((e) => e.offsetParent);
          for (const n of nodes) {
            if (norm(n.querySelector("label")?.innerText || "").replace(/^重要/, "") !== lab) continue;
            const inp = n.querySelector("input");
            if (inp && inp.offsetParent) {
              const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
              setter.call(inp, "");
              inp.dispatchEvent(new Event("input", { bubbles: true }));
            }
            return;
          }
        }, label).catch(() => {});
      }
      if (!ok) { await page.keyboard.press("Escape").catch(() => {}); await sleep(500); }
    }

    const r = { label, value, got: lastGot, ok, how: ok ? how : "failed" };
    if (!ok) r.options = await readDropdownOptions(page).catch(() => []);
    results.push(r);
    if (!ok) needReview.push(r);
    log("⑤ 属性 " + label + " =", JSON.stringify(r));
  }
  return { ok: needReview.length === 0, results, needReview };
}

/** 数字直填属性（厚度等）：定位 label 的 form-item → input 写值 */
export async function fillDirectAttrs(page, pairs) {
  return page.evaluate((arr) => {
    const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    const out = [];
    for (const { label, value } of arr) {
      let done = false;
      const nodes = [...document.querySelectorAll('[data-testid="beast-core-form-item"][id^="basic.propertys."]')].filter((e) => e.offsetParent);
      for (const n of nodes) {
        if (norm(n.querySelector("label")?.innerText || "").replace(/^重要/, "") !== label) continue;
        const inp = [...n.querySelectorAll("input")].find((e) => e.offsetParent && e.type !== "file" && !/请选择/.test(e.placeholder || ""));
        if (!inp) { out.push({ label, value: null, how: "skip_dropdown" }); done = true; break; }
        if (String(inp.value) !== String(value)) {
          setter.call(inp, String(value));
          inp.dispatchEvent(new Event("input", { bubbles: true }));
          inp.dispatchEvent(new Event("change", { bubbles: true }));
          inp.dispatchEvent(new Event("blur", { bubbles: true }));
        }
        out.push({ label, value: inp.value, how: "direct_input" });
        done = true;
        break;
      }
      if (!done) out.push({ label, value: null, how: "not_found" });
    }
    return out;
  }, pairs);
}

/** 打开发布页（直接访问 → 列表入口兜底 → 已进表单识别） */
export async function openPublishPage(task, page, { timeoutMs = 60000 } = {}) {
  const readyCheck = async (pg) =>
    pg.evaluate(() => {
      const t = (document.body.innerText || "").replace(/\s+/g, " ");
      return {
        url: location.href,
        hasMain: t.includes("商品主图"),
        hasNext: t.includes("下一步"),
        hasSearch: !!document.querySelector('input[placeholder*="关键词搜索分类"]'),
        bodyLen: t.length,
      };
    }).catch(() => ({ url: "", hasMain: false, hasNext: false, hasSearch: false, bodyLen: 0 }));

  await gotoUrl(page, "https://mms.pinduoduo.com/goods/category");
  await sleep(3500);
  let st = await readyCheck(page);
  if (String(st.url || "").includes("goods_add")) return { task, page, how: "already_on_form", state: st };
  if (st.hasMain || st.hasNext || st.hasSearch) return { task, page, how: "direct", state: st };

  await gotoUrl(page, LIST_URL);
  await sleep(5000);
  const btn = await page.evaluate(() => {
    const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
    const vis = (e) => !!(e && e.offsetParent);
    const cands = [...document.querySelectorAll("button, [role=button], a, span, div")]
      .filter((e) => vis(e) && !e.children.length && norm(e.textContent) === "发布新商品")
      .map((e) => {
        e.scrollIntoView({ block: "center" });
        const r = e.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      });
    return cands.sort((a, b) => b.y - a.y || b.x - a.x)[0] || null;
  });
  if (!btn) return { task, page, how: "entry_not_found", state: st };

  await page.mouse.click(btn.x, btn.y, { label: "open publish entry" });
  await sleep(7000);

  const tabs = await task.tabs();
  const hit = tabs.find((t) => /goods\/(category|goods_add)/.test(t.url || ""));
  let target = page;
  if (hit) {
    target = hit.label ? task.page(hit.label) : await task.adopt(hit.page);
    await target.waitForLoadState().catch(() => {});
    await sleep(4000);
  } else {
    await gotoUrl(page, "https://mms.pinduoduo.com/goods/category");
    await sleep(4000);
  }
  st = await readyCheck(target);
  return { task, page: target, how: "list_entry", state: st, tabCount: tabs.length };
}

/** 读表单里的商品分类行 */
export async function readFormCategory(page) {
  return page.evaluate(() => {
    const norm = (x) => (x || "").replace(/\s+/g, " ").trim();
    const t = norm(document.body.innerText);
    const i = t.indexOf("商品分类");
    if (i < 0) return null;
    const tail = t.slice(i + 4);
    const j = tail.indexOf("修改分类");
    return norm(j > 0 && j < 120 ? tail.slice(0, j) : tail.slice(0, 80));
  }).catch(() => null);
}

/** 视频上传（商品视频区）：local upload 按钮 → filechooser；识别「上传错误」并清空重试 */
export async function uploadVideo(page, zoneName, file, { timeoutMs = 420000 } = {}) {
  const ZONE_SCOPE = `((zone) => {
    const norm = (s) => (s || "").replace(/\\s+/g, " ").trim();
    const vis = (e) => !!(e && e.offsetParent);
    const inSidePanel = (el) => {
      let n = el;
      for (let i = 0; i < 12 && n; i++) {
        if (/fix-nav|发布助手|guide|SidePanel|sidePanel/.test(String(n.className || ""))) return true;
        n = n.parentElement;
      }
      return false;
    };
    const labels = [...document.querySelectorAll("*")].filter(
      (e) => vis(e) && !e.children.length && norm(e.textContent) === zone && !inSidePanel(e)
    );
    for (const lab of labels) {
      let node = lab, box = null;
      for (let i = 0; i < 5 && node; i++) {
        node = node.parentElement;
        if (!node) break;
        if (node.querySelector('input[type=file]')) { box = node; break; }
      }
      if (box) return { label: lab, box };
    }
    return null;
  })`;

  const readState = () =>
    page.evaluate(({ zone, scopeSrc }) => {
      const norm = (s) => (s || "").replace(/\\s+/g, " ").trim();
      const vis = (e) => !!(e && e.offsetParent);
      const found = eval(scopeSrc)(zone);
      if (!found) return { found: false };
      const box = found.box;
      const t = norm(box.textContent);
      const imgs = [...box.querySelectorAll("img")].filter(vis).length;
      const hasError = /上传错误|上传失败/.test(t);
      const hasSwap = /更换|重新上传|删除视频/.test(t);
      const placeholder = [...box.querySelectorAll("*")].some((e) => vis(e) && !e.children.length && norm(e.textContent) === "上传视频");
      return { found: true, text: t.slice(0, 140), imgs, hasError, hasSwap, placeholder, done: hasSwap && !hasError };
    }, { zone: zoneName, scopeSrc: ZONE_SCOPE });

  const before = await readState();
  if (!before.found) return { ok: false, reason: "zone_not_found", zone: zoneName };
  if (before.done) return { ok: true, zone: zoneName, already: true, state: before };

  const clickLocalUpload = async () => {
    const upBtn = await page.evaluate(({ zone, scopeSrc }) => {
      const norm = (s) => (s || "").replace(/\\s+/g, " ").trim();
      const vis = (e) => !!(e && e.offsetParent);
      const found = eval(scopeSrc)(zone);
      if (!found) return null;
      const hits = [...found.box.querySelectorAll("*")].filter((e) => vis(e) && !e.children.length && norm(e.textContent) === "本地上传");
      if (!hits.length) return null;
      const el = hits[hits.length - 1];
      el.scrollIntoView({ block: "center" });
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    }, { zone: zoneName, scopeSrc: ZONE_SCOPE }).catch(() => null);
    if (!upBtn) return false;
    try {
      const cp = page.waitForFileChooser({ timeout: 10000 });
      await page.mouse.click(upBtn.x, upBtn.y, { label: "video local upload" });
      const ch = await cp;
      await ch.setFiles([file]);
      return true;
    } catch (e) {
      return false;
    }
  };

  let how = "local_upload_button";
  if (!(await clickLocalUpload())) {
    how = "setInputFiles";
    const sel = await page.evaluate(({ zone, scopeSrc }) => {
      const found = eval(scopeSrc)(zone);
      if (!found) return null;
      const f = [...found.box.querySelectorAll('input[type=file]')].find((x) => /video/i.test(x.accept || ""));
      if (!f) return null;
      const mk2 = "vid-" + Date.now();
      f.setAttribute("data-ego", mk2);
      return 'css:input[data-ego="' + mk2 + '"]';
    }, { zone: zoneName, scopeSrc: ZONE_SCOPE });
    if (sel) await page.setInputFiles(sel, [file]).catch(() => {});
  }

  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    await sleep(2500);
    last = await readState();
    if (last.hasError) return { ok: false, skipped: true, zone: zoneName, reason: "platform_error", state: last };
    if (last.done) return { ok: true, zone: zoneName, file: String(file).split("/").pop(), how, state: last };
  }
  return { ok: false, skipped: true, zone: zoneName, reason: "timeout", how, state: last };
}

/** 清空视频区（含错误态） */
export async function clearVideoZone(page, zoneName = "商品视频", { max = 6 } = {}) {
  let removed = 0;
  for (let i = 0; i < max; i++) {
    const st = await page.evaluate((zone) => {
      const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
      const vis = (e) => !!(e && e.offsetParent);
      const inSide = (el) => {
        let n = el;
        for (let k = 0; k < 12 && n; k++) {
          if (/fix-nav|发布助手|guide/.test(String(n.className || ""))) return true;
          n = n.parentElement;
        }
        return false;
      };
      const labs = [...document.querySelectorAll("*")].filter((e) => vis(e) && !e.children.length && norm(e.textContent) === zone && !inSide(e));
      for (const lab of labs) {
        let node = lab, box = null;
        for (let k = 0; k < 6 && node; k++) {
          node = node.parentElement;
          if (!node) break;
          if (node.querySelector('input[type=file]')) { box = node; break; }
        }
        if (!box) continue;
        const t = norm(box.textContent);
        const d = [...box.querySelectorAll("*")].find((e) => /delete|close/i.test(String(e.className || "")) && (e.offsetParent || e.getBoundingClientRect().width > 0));
        if (!d) return { hasSwap: /更换|重新上传/.test(t), pos: null };
        d.scrollIntoView({ block: "center" });
        const r = d.getBoundingClientRect();
        return { hasSwap: /更换|重新上传/.test(t), pos: { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } };
      }
      return { hasSwap: false, pos: null };
    }, zoneName).catch(() => ({ hasSwap: false, pos: null }));
    if (!st.hasSwap) break;
    if (!st.pos) break;
    await page.mouse.click(st.pos.x, st.pos.y, { label: "delete video" });
    await sleep(2000);
    await page.evaluate(() => {
      const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
      const btns = [...document.querySelectorAll("button, [role=button]")].filter((b) => b.offsetParent && /确定|删除|确认/.test(norm(b.innerText)));
      if (btns.length) btns[btns.length - 1].click();
    }).catch(() => {});
    await sleep(1500);
    removed++;
  }
  return { removed };
}

/** 白底图上传（空态直接 input；已有图则走「更换→图片空间」） */
export async function uploadWhiteBg(page, file, { timeoutMs = 180000 } = {}) {
  const SCOPESRC = `(() => {
    const norm = (s) => (s || "").replace(/\\s+/g, " ").trim();
    const vis = (e) => !!(e && e.offsetParent);
    const w = [...document.querySelectorAll(".goods-basic-materials-wrapper-v2")].find(vis);
    if (w) return w;
    const lab = [...document.querySelectorAll("*")].find((e) => vis(e) && !e.children.length && norm(e.textContent) === "白底图");
    if (!lab) return null;
    let n = lab;
    for (let i = 0; i < 5 && n; i++) {
      n = n.parentElement;
      if (!n) break;
      if (/goods-basic-materials-wrapper|activity-materials-pic/.test(String(n.className || ""))) return n;
    }
    return null;
  })()`;

  const readCell = () =>
    page.evaluate((js) => {
      const norm = (s) => (s || "").replace(/\\s+/g, " ").trim();
      const vis = (e) => !!(e && e.offsetParent);
      const w = eval(js);
      if (!w) return { found: false };
      const placeholder = [...w.querySelectorAll("*")].some((e) => vis(e) && !e.children.length && norm(e.textContent) === "上传图片");
      const has = !!(w.querySelector("img") || w.querySelector('[style*="background-image"]'));
      return { found: true, hasThumb: has && !placeholder, placeholder, hasInput: !!w.querySelector('input[type=file]') };
    }, SCOPESRC);

  const before = await readCell();
  if (!before.found) return { ok: false, reason: "cell_not_found" };
  if (before.hasThumb) return { ok: true, already: true, state: before };

  if (before.hasInput) {
    const mk2 = "wb-" + Date.now();
    const sel = await page.evaluate(({ js, mm }) => {
      const w = eval(js);
      if (!w) return null;
      const f = [...w.querySelectorAll('input[type=file]')].find((x) => /image/i.test(x.accept || "")) || w.querySelector("input[type=file]");
      if (!f) return null;
      f.setAttribute("data-ego", mm);
      return 'css:input[data-ego="' + mm + '"]';
    }, { js: SCOPESRC, mm: mk2 });
    if (sel) {
      await page.setInputFiles(sel, [file]).catch(() => {});
      const dl = Date.now() + 45000;
      while (Date.now() < dl) {
        await sleep(1800);
        const st = await readCell();
        if (st.hasThumb) return { ok: true, how: "direct_input", state: st };
      }
    }
  }
  return { ok: false, reason: "white_bg_not_applied", state: await readCell() };
}

/** 连店：接管 ego space（若归用户所有则 takeOver），返回 {task, page} */
export async function connectShop(spaceId) {
  let task;
  try {
    task = await claimTaskSpace(spaceId);
  } catch (e) {
    // ownership=user 的 space 不能直接 claim，需要 takeOver
    task = await takeOverTaskSpace(spaceId);
  }
  const tabs = await task.tabs();
  const active = tabs.find((t) => t.active) || tabs[0];
  if (!active) throw new Error("no_tab_in_space_" + spaceId);
  const page = active.label ? task.page(active.label) : await task.adopt(active.page);
  return { task, page };
}

/** 关掉遮挡弹窗（AI 制图 / 引导 / 公告）—— ego 实测它会吞点击 */
export async function dismissOverlays(page) {
  const closed = [];
  for (let round = 0; round < 4; round++) {
    const r = await page.evaluate(() => {
      const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
      const labels = ["稍后再说", "以后再说", "我知道了", "跳过", "暂不需要", "关闭"];
      const hits = [...document.querySelectorAll("button, [role=button], span, div, a")].filter(
        (el) => el.offsetParent && !el.children.length && labels.includes(norm(el.textContent))
      );
      if (!hits.length) return null;
      const el = hits[hits.length - 1];
      const t = norm(el.textContent);
      el.click();
      return t;
    }).catch(() => null);
    if (!r) break;
    closed.push(r);
    await sleep(600);
  }
  return { closed };
}

// ─────────────────────────── ⓪a 数据预检 / 规格收尾 / 必填属性探测（插件同实现）───────────────────────────

/**
 * 上架数据预检（**照抄插件 validateListingPayload**）：在动浏览器之前就把坏数据拦下来。
 * blocking = 直接停；warnings = 记日志继续。
 */
export async function validateListingPayload(P, D = {}, { checkFiles = true } = {}) {
  const warnings = [];
  const blocking = [];
  const skus = P.skus || [];
  const title = String(P.title || "");
  const han = (title.match(/[\u4e00-\u9fff]/g) || []).length;
  if (!title) blocking.push("no_title");
  else if (han > 30) blocking.push("title_han_over_30:" + han);

  if (!skus.length) blocking.push("sku_count_zero");

  const singles = skus.map((x) => Number(x.single_price)).filter((n) => !Number.isNaN(n));
  const maxSingle = singles.length ? Math.max(...singles) : 0;
  const ref = Number(P.ref_price);
  if (!(ref > 0)) blocking.push("missing_ref_price");
  else if (maxSingle && !(ref > maxSingle)) blocking.push("ref_price_not_greater:max_single=" + maxSingle);

  const emptyCodes = skus.filter((x) => !String(x.code || "").trim()).length;
  if (emptyCodes) blocking.push("empty_codes:" + emptyCodes);

  if (checkFiles) {
    let fs = null;
    try { fs = await import("node:fs"); } catch (e) { fs = null; }
    if (fs) {
      const missPrev = skus.map((x) => String(x.preview || "").trim()).filter(Boolean).filter((pp) => !fs.existsSync(pp));
      if (missPrev.length) blocking.push("preview_missing:" + missPrev.length + ":" + missPrev[0]);
      const mainMiss = (D.main_images || []).filter((pp) => !fs.existsSync(pp));
      if (mainMiss.length) blocking.push("main_image_missing:" + mainMiss.length + ":" + mainMiss[0]);
      const detMiss = (D.detail_images || []).filter((pp) => !fs.existsSync(pp));
      if (detMiss.length) warnings.push("detail_image_missing:" + detMiss.length);
    } else {
      warnings.push("fs_unavailable_skip_file_check");
    }
  }

  const dims = P.dimensions || [];
  if (dims.length) {
    const combos = new Set(skus.map((x) => dims.map((d) => String(x[d] ?? "")).join("|")));
    if (combos.size !== skus.length) warnings.push("duplicate_dimension_combos:" + (skus.length - combos.size));
  }

  return { ok: blocking.length === 0, warnings, blocking };
}

/** 规格值收尾（**照抄插件 commitSpecTail**）：失焦 + 点「商品标题」这类中性文本，确保最后一个值被提交 */
export async function commitSpecTail(page) {
  await page.evaluate(() => {
    const a = document.activeElement;
    if (a && typeof a.blur === "function") a.blur();
  }).catch(() => {});
  const pos = await page.evaluate(() => {
    const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
    const el = [...document.querySelectorAll("*")].find(
      (e) => e.offsetParent && !e.children.length && /商品标题/.test(norm(e.textContent))
    );
    if (!el) return null;
    el.scrollIntoView({ block: "center" });
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + 2), y: Math.round(r.y + 2) };
  }).catch(() => null);
  if (pos) await page.mouse.click(pos.x, pos.y, { label: "neutral blur" }).catch(() => {});
  await sleep(800);
  return { ok: true };
}

/** 必填属性探测（**照抄插件 probeRequiredAttributes**）：找出标「重要」但为空的下拉 */
export async function probeRequiredAttributes(page) {
  return page.evaluate(() => {
    const NOISE = [/填写率/i, /%\s*$/, /^%/, /点击反馈/, /没有合适属性/, /请准确填写属性/, /利于商品在搜索/, /错误填写可能/, /品牌请输入/, /未找到需要的品牌/, /^重要$/, /^$/];
    const norm = (x) => (x || "").replace(/\s+/g, " ").trim();
    const isNoise = (x) => NOISE.some((re) => re.test(x));
    const required = [];
    const missing = [];
    const labels = [...document.querySelectorAll("*")].filter((el) => {
      if (!el.offsetParent || el.children.length > 2) return false;
      const t = norm(el.textContent);
      if (!t || t.length > 24) return false;
      if (isNoise(t)) return false;
      return /[\u4e00-\u9fff]/.test(t);
    });
    for (const node of labels) {
      const labelText = norm(node.textContent);
      if (isNoise(labelText)) continue;
      let row = node;
      for (let i = 0; i < 6 && row; i++) {
        row = row.parentElement;
        if (!row) break;
        const rowText = norm(row.innerText).slice(0, 80);
        if (isNoise(rowText)) break;
        const inp = row.querySelector('input[placeholder="请选择"], input[placeholder*="请选择"]');
        if (!inp || !inp.offsetParent || inp.type === "file") continue;
        const fieldIsImportant = /^重要/.test(labelText) || new RegExp("重要" + labelText.replace(/重要/, "")).test(rowText.slice(0, 40)) || /重要/.test(rowText.slice(0, 30));
        if (!fieldIsImportant) break;
        const name = labelText.replace(/^重要/, "").replace(/请选择.*/, "").trim();
        if (!name || isNoise(name) || name.length > 12) break;
        const empty = !inp.value || inp.value === "请选择";
        required.push({ label: name, value: inp.value || "" });
        if (empty) missing.push({ label: name, row: rowText.slice(0, 60) });
        break;
      }
    }
    return { requiredCount: required.length, required, missing };
  }).catch(() => ({ requiredCount: 0, required: [], missing: [] }));
}

// ─────────────────────────── ⓪ 查重 / 规格值预检 / 矩阵自愈 / 详情删残留 ───────────────────────────

export const LIST_URL = "https://mms.pinduoduo.com/goods/goods_list";

/**
 * 规格值预检（插件 validateSpecValues）：40 字上限 + 非法字符（× ✕ → 等会让平台报「数据错误，请刷新页面」并把矩阵建成 0 行）
 * @returns {{ok:boolean, bad:Array<{dim:string,value:string,problems:string[]}>}}
 */
export function validateSpecValues(dimNames, dimValues) {
  const OK = /[\u4e00-\u9fa5A-Za-z0-9 #:%()'+*/.\-（）【】]/;
  const bad = [];
  (dimValues || []).forEach((vals, di) => {
    (vals || []).forEach((v) => {
      const str = String(v == null ? "" : v);
      const problems = [];
      if (str.length > 40) problems.push(`超过40字(${str.length})`);
      const illegal = [...new Set([...str].filter((ch) => !OK.test(ch)))];
      if (illegal.length) problems.push("含非法字符:" + illegal.join(" "));
      if (problems.length) bad.push({ dim: (dimNames && dimNames[di]) || `dim${di}`, value: str, problems });
    });
  });
  return { ok: bad.length === 0, bad };
}

/** 查重（插件 checkDuplicate）：商品列表搜索标题 → 标题命中再比编码 */
export async function checkDuplicate(page, title, skus = []) {
  try {
    await gotoUrl(page, LIST_URL);
    await page.waitForLoadState().catch(() => {});
    await sleep(3500);
    const box = await page.evaluate(() => {
      const el = [...document.querySelectorAll("input")].find(
        (i) => i.offsetParent && /商品名称|商品标题/.test(i.placeholder || "")
      );
      if (!el) return null;
      el.scrollIntoView({ block: "center" });
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    });
    if (!box) return "search_failed";
    await page.mouse.click(box.x, box.y, { label: "focus goods search" });
    await sleep(200);
    await page.keyboard.press("Control+a").catch(() => {});
    await page.keyboard.press("Backspace").catch(() => {});
    await page.keyboard.insertText(String(title));
    await page.keyboard.press("Enter");
    await sleep(3500);

    const bodyHasTitle = await page.evaluate((t) => (document.body.innerText || "").includes(t), String(title));
    if (!bodyHasTitle) return "not_found";

    const codes = [...new Set(skus.map((x) => String(x.code || "").trim()).filter(Boolean))];
    const pageText = await page.evaluate(() => document.body.innerText || "");
    const codeHits = codes.filter((c) => pageText.includes(c));
    if (codes.length && codeHits.length === codes.length) return "exact_duplicate";
    if (codes.length && codeHits.length > 0) return "same_title_different_sku";
    return codes.length ? "same_title_different_sku" : "exact_duplicate";
  } catch (e) {
    return "search_failed";
  }
}

/** 矩阵自愈（插件 repairSpecMatrix）：跨窗口数组合 → 找出「真凶维度值」→ 删值重提交 */
export async function repairSpecMatrix(page, dimNames, dimValues, { maxRound = 3 } = {}) {
  const D0 = (dimValues[0] || []).map(String);
  const D1 = (dimValues[1] || []).map(String);
  const expect = D0.length * D1.length;
  const logArr = [];
  const badAll = [];
  for (let round = 1; round <= maxRound; round++) {
    const keysArr = (await countMatrixKeys(page, dimNames, dimValues)).keys || [];
    const keys = new Set(keysArr);
    if (keys.size === expect) return { ok: true, expected: expect, count: keys.size, rounds: round, bad: [...new Set(badAll)], log: logArr };
    const short0 = D0.filter((v) => D1.filter((w) => keys.has(v + "|" + w)).length < D1.length);
    const short1 = D1.filter((v) => D0.filter((w) => keys.has(w + "|" + v)).length < D0.length);
    const culprits = [];
    if (short0.length && short0.length < D0.length) culprits.push([0, short0]);
    if (short1.length && short1.length < D1.length) culprits.push([1, short1]);
    logArr.push({ round, count: keys.size, short0, short1, repaired: culprits.map(([g, l]) => `${dimNames[g]} x${l.length}`) });
    if (!culprits.length) break;
    for (const [gi, list] of culprits) {
      for (const v of list) {
        badAll.push(`${dimNames[gi]}:${v}`);
        await removeSpecValue(page, gi + 1, v);
        await sleep(900);
        await robustCommitSpecValue(page, gi + 1, v);
        await sleep(1000);
      }
    }
  }
  const keysArr = (await countMatrixKeys(page, dimNames, dimValues)).keys || [];
  return { ok: keysArr.length === expect, expected: expect, count: keysArr.length, rounds: maxRound, bad: [...new Set(badAll)], log: logArr };
}

/** 详情区删残留（插件 ⑨b 的下半段）：多出来的图逐张 hover→点删除，直到等于期望 */
export async function cleanExtraDetails(page, expectCount, { max = 40 } = {}) {
  let removed = 0;
  for (let i = 0; i < max; i++) {
    const z = await readDetailZone(page);
    if (!z || z.containers <= expectCount) break;
    const pos = await page.evaluate(() => {
      const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
      let root = null;
      for (const e of [...document.querySelectorAll("div,section")]) {
        if (!e.offsetParent) continue;
        const t = e.textContent || "";
        if (/快捷编辑/.test(t) && /已上传\s*\d+\s*\/\s*50/.test(t) && t.length < 9000) { root = e; break; }
      }
      if (!root) return null;
      const nodes = [...root.querySelectorAll("[class*=ImageWithRemark_v2_imageContainer]")];
      const n = nodes[nodes.length - 1];
      if (!n) return null;
      n.scrollIntoView({ block: "center" });
      const r = n.getBoundingClientRect();
      return { cx: Math.round(r.x + r.width / 2), cy: Math.round(r.y + r.height / 2) };
    });
    if (!pos) break;
    await page.mouse.move(pos.cx, pos.cy, { label: "hover detail thumb" });
    await sleep(650);
    const del = await page.evaluate(() => {
      const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
      let root = null;
      for (const e of [...document.querySelectorAll("div,section")]) {
        if (!e.offsetParent) continue;
        const t = e.textContent || "";
        if (/快捷编辑/.test(t) && /已上传\s*\d+\s*\/\s*50/.test(t) && t.length < 9000) { root = e; break; }
      }
      if (!root) return null;
      const nodes = [...root.querySelectorAll("[class*=ImageWithRemark_v2_imageContainer]")];
      const n = nodes[nodes.length - 1];
      if (!n) return null;
      const c = [...n.querySelectorAll("*")].filter((e) => /delete|close/i.test(String(e.className || ""))).pop();
      if (!c) return null;
      const r = c.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    });
    if (!del) break;
    await page.mouse.click(del.x, del.y, { label: "delete extra detail" });
    await sleep(1500);
    // 关掉可能的确认/提示
    const ok = await page.evaluate(() => {
      const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
      const btns = [...document.querySelectorAll("button, [role=button]")].filter((b) => b.offsetParent && /确定|知道了/.test(norm(b.innerText)));
      if (!btns.length) return null;
      const r = btns[btns.length - 1].getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    });
    if (ok) { await page.mouse.click(ok.x, ok.y, { label: "ok" }); await sleep(1200); }
    removed++;
  }
  const fin = await readDetailZone(page);
  return { removed, state: fin };
}

/** 读当前已展开下拉里的可选项（**照抄插件 readDropdownOptions**）：属性填不上时回报候选，便于人工判断 */
export async function readDropdownOptions(page) {
  return page
    .evaluate(() => {
      const out = [];
      document.querySelectorAll('li, [class*=option], [class*=Option], [role=option]').forEach((e) => {
        if (!e.offsetParent) return;
        const t = (e.textContent || "").replace(/\s+/g, " ").trim();
        if (t && t.length < 24) out.push(t);
      });
      return [...new Set(out)].slice(0, 60);
    })
    .catch(() => []);
}

/**
 * 点「添加规格类型」（**插件 clickAddSpecType 同义**）：
 *  · 文本须以「添加规格类型」开头，排除 AI/智能生成
 *  · **优先点 button 元素**（内层 span 点了不生效），点完轮询等新的「规格类型N」输入出现
 */
export async function clickAddSpecType(page, { expectN = null, timeoutMs = 12000 } = {}) {
  const before = await page.evaluate(() => document.querySelectorAll('input[placeholder="规格类型1"], input[placeholder="规格类型2"]').length);
  const pos = await page.evaluate(() => {
    const norm = (x) => (x || "").replace(/\s+/g, " ").trim();
    const vis = (e) => !!(e && e.offsetParent);
    const okText = (e) => /^添加规格类型/.test(norm(e.textContent)) && !/AI|智能生成/.test(norm(e.textContent)) && norm(e.textContent).length < 30;
    // ① 先找 button
    const btns = [...document.querySelectorAll("button, [role=button]")].filter((e) => vis(e) && okText(e));
    const btnsLeaf = btns.map((b) => b).sort((a, b2) => a.getBoundingClientRect().width - b2.getBoundingClientRect().width);
    let el = null;
    if (btnsLeaf.length) el = btnsLeaf[0];
    else {
      const any = [...document.querySelectorAll("span, div, a")].filter((e) => vis(e) && okText(e));
      el = any.length ? any[0] : null;
    }
    if (!el) return null;
    el.scrollIntoView({ block: "center" });
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), tag: el.tagName, text: norm(el.textContent) };
  }).catch(() => null);
  if (!pos) return { ok: false, reason: "add_button_not_found" };

  await page.mouse.click(pos.x, pos.y, { label: "add spec type" });
  // 轮询：新的类型行是否出现（或者计数增加）
  const deadline = Date.now() + timeoutMs;
  let after = before;
  while (Date.now() < deadline) {
    await sleep(900);
    after = await page.evaluate(() => document.querySelectorAll('input[placeholder="规格类型1"], input[placeholder="规格类型2"]').length);
    if (after > before) return { ok: true, tag: pos.tag, text: pos.text, before, after };
    if (expectN && after >= expectN) return { ok: true, tag: pos.tag, text: pos.text, before, after };
  }
  return { ok: false, reason: "no_new_type_row", tag: pos.tag, text: pos.text, before, after };
}

// ─────────────────────────── ⑥ 规格表 ───────────────────────────

/** 读规格分组：返回 {type1,type2,groups:[[...],[...]], rows} */
export async function readSpecGroups(page) {
  return page.evaluate(() => {
    const all = [
      ...document.querySelectorAll(
        'input[placeholder="规格类型1"], input[placeholder="规格类型2"], input[placeholder="请输入规格名称"]'
      ),
    ];
    const t1 = all.find((e) => e.placeholder === "规格类型1");
    const t2 = all.find((e) => e.placeholder === "规格类型2");
    const t2i = t2 ? all.indexOf(t2) : -1;
    const chips = [...document.querySelectorAll('input[placeholder="请输入规格名称"]')];
    const g1 = [];
    const g2 = [];
    for (const c of chips) {
      if (!c.offsetParent) continue;
      const idx = all.indexOf(c);
      const v = (c.value || "").trim();
      if (!v) continue;
      (t2i >= 0 && idx > t2i ? g2 : g1).push(v);
    }
    return {
      type1: t1 ? t1.value : null,
      type2: t2 ? t2.value : null,
      groups: [g1, g2],
      rows: [...document.querySelectorAll("tbody tr")].filter((t) => t.offsetParent).length,
    };
  });
}

/** 删除一个规格值（chip 即 input.value；Ctrl+A / Backspace / Tab） */
export async function removeSpecValue(page, group, value) {
  const ci = await page.evaluate(
    ({ g, val }) => {
      const all = [
        ...document.querySelectorAll(
          'input[placeholder="规格类型1"], input[placeholder="规格类型2"], input[placeholder="请输入规格名称"]'
        ),
      ];
      const t2 = all.find((e) => e.placeholder === "规格类型2");
      const t2i = t2 ? all.indexOf(t2) : -1;
      const chips = [...document.querySelectorAll('input[placeholder="请输入规格名称"]')];
      const pool = chips
        .map((c) => ({ ci: chips.indexOf(c), c }))
        .filter(({ c }) => c.offsetParent && (g === 2 ? t2i >= 0 && all.indexOf(c) > t2i : t2i < 0 || all.indexOf(c) < t2i));
      const hit = pool.find(({ c }) => (c.value || "").trim() === String(val).trim());
      return hit ? hit.ci : -1;
    },
    { g: group, val: value }
  );
  if (ci < 0) return { ok: false, reason: "not_found" };
  await page.click(`css:input[placeholder="请输入规格名称"] >> nth=${ci}`).catch(async () => {
    await page.evaluate((i) => {
      const c = document.querySelectorAll('input[placeholder="请输入规格名称"]')[i];
      if (c) { c.scrollIntoView({ block: "center" }); c.click(); c.focus(); }
    }, ci);
  });
  await sleep(200);
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Backspace");
  await sleep(150);
  await page.keyboard.press("Tab");
  await sleep(650);
  return { ok: true };
}

/** 提交一个规格值（点空槽 → insertText → Tab；与插件 robustCommitSpecValue 同法） */
export async function robustCommitSpecValue(page, group, value) {
  const ci = await page.evaluate((g) => {
    const all = [
      ...document.querySelectorAll(
        'input[placeholder="规格类型1"], input[placeholder="规格类型2"], input[placeholder="请输入规格名称"]'
      ),
    ];
    const t2 = all.find((e) => e.placeholder === "规格类型2");
    const t2i = t2 ? all.indexOf(t2) : -1;
    const chips = [...document.querySelectorAll('input[placeholder="请输入规格名称"]')];
    const pool = chips
      .map((c) => ({ ci: chips.indexOf(c), c }))
      .filter(({ c }) => c.offsetParent && (g === 2 ? t2i >= 0 && all.indexOf(c) > t2i : t2i < 0 || all.indexOf(c) < t2i));
    if (!pool.length) return -1;
    const empty = pool.find(({ c }) => !c.value);
    return (empty || pool[pool.length - 1]).ci;
  }, group);
  if (ci < 0) return { ok: false, reason: "no_slot" };

  const pos = await page.evaluate((i) => {
    const c = document.querySelectorAll('input[placeholder="请输入规格名称"]')[i];
    if (!c) return null;
    c.scrollIntoView({ block: "center" });
    const r = c.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  }, ci);
  if (!pos) return { ok: false, reason: "no_pos" };
  await page.mouse.click(pos.x, pos.y, { label: "spec slot" });
  await sleep(150);
  const cur = await page.evaluate((i) => (document.querySelectorAll('input[placeholder="请输入规格名称"]')[i] || {}).value || "", ci);
  if (cur) {
    await page.keyboard.press("Control+a");
    await page.keyboard.press("Backspace");
    await sleep(120);
  }
  await page.keyboard.insertText(String(value));
  await sleep(150);
  await page.keyboard.press("Tab");
  await sleep(450);
  return { ok: true };
}

/** 规格矩阵：按维度值补齐/清理，校验行数 = 笛卡尔积（自愈，最多 3 轮） */
export async function ensureSpecTable(page, dimNames, dimValues, { maxRound = 3, precheck = true } = {}) {
  const expect = (dimValues[0] || []).length * (dimValues[1] || []).length;
  // 预检：值里带非法字符会让平台把矩阵建成 0 行，必须在点任何东西之前拦下来
  if (precheck) {
    const sv = validateSpecValues(dimNames, dimValues);
    if (!sv.ok) {
      return { ok: false, reason: "spec_value_precheck_failed", specValueProblems: sv.bad, expect, matrix: null, rounds: 0, logLines: [] };
    }
  }
  const logLines = [];

  // ★ 规格类型：逐行创建并立即命名（PDD 要先给上一行命名，才允许「添加规格类型」加下一行）
  {
    const hasType = async (i) =>
      page.evaluate((ph) => !!document.querySelector('input[placeholder="' + ph + '"]'), i === 0 ? "规格类型1" : "规格类型2").catch(() => false);

    for (let i = 0; i < Math.min(2, (dimNames || []).length); i++) {
      for (let attempt = 1; attempt <= 3; attempt++) {
        if (await hasType(i)) break;
        const r = await clickAddSpecType(page, { expectN: i + 1 }).catch((e) => ({ ok: false, reason: e.message }));
        log("⑥ 添加规格类型" + (i + 1) + "（第" + attempt + "次）=", JSON.stringify(r).slice(0, 140));
        await sleep(1200);
        if (await hasType(i)) break;
      }
      const want = String(dimNames[i]);
      const cur = await readSpecGroups(page);
      const now = i === 0 ? cur.type1 : cur.type2;
      if (now !== want) {
        const r = await setSpecType(page, i, want).catch((e) => ({ ok: false, err: String(e.message).slice(0, 80) }));
        log("⑥ 规格类型" + (i + 1) + " 设为 " + want + " =", JSON.stringify(r).slice(0, 120));
        for (let k = 0; k < 3; k++) {
          await sleep(800);
          const chk = await readSpecGroups(page);
          const v = i === 0 ? chk.type1 : chk.type2;
          if (v === want) break;
        }
      }
    }
  }

  // ★ 值：多删少补，然后跨窗口校验组合数
  for (let round = 1; round <= maxRound; round++) {
    const st = await readSpecGroups(page);
    // 清理多余
    for (let g = 0; g < 2; g++) {
      const want = (dimValues[g] || []).map(String);
      for (const v of st.groups[g] || []) {
        if (!want.includes(v)) {
          const r = await removeSpecValue(page, g + 1, v).catch(() => ({ ok: false }));
          logLines.push({ round, action: "remove", dim: g + 1, value: v, r });
        }
      }
    }
    // 补齐缺失
    for (let g = 0; g < 2; g++) {
      const want = (dimValues[g] || []).map(String);
      for (const v of want) {
        const now = await readSpecGroups(page);
        if ((now.groups[g] || []).includes(v)) continue;
        const r = await robustCommitSpecValue(page, g + 1, v).catch(() => ({ ok: false }));
        logLines.push({ round, action: "add", dim: g + 1, value: v, r });
      }
    }
    await commitSpecTail(page).catch(() => {});
    await sleep(600);
    const fin = await readSpecGroups(page);
    const domRows = fin.rows;
    const cnt = domRows >= expect ? { count: domRows } : await countMatrixKeys(page, dimNames, dimValues).catch(() => ({ count: domRows }));
    if (cnt.count === expect) {
      return {
        ok: true,
        expect,
        matrix: { rows: cnt.count, domRows, type1: fin.type1, type2: fin.type2, groups: fin.groups },
        rounds: round,
        logLines,
      };
    }
  }

  // 走到这里仍不齐 → 用插件同款「真凶维度值删值重提交」自愈
  const rep = await repairSpecMatrix(page, dimNames, dimValues).catch((e) => ({ ok: false, reason: String(e.message).slice(0, 120) }));
  const fin = await readSpecGroups(page);
  const cnt2 = await countMatrixKeys(page, dimNames, dimValues).catch(() => ({ count: fin.rows }));
  return {
    ok: rep.ok === true || cnt2.count === expect,
    expect,
    matrix: { rows: cnt2.count, domRows: fin.rows, type1: fin.type1, type2: fin.type2, groups: fin.groups },
    repaired: rep,
    logLines,
  };
}

/** 矩阵自愈（插件 repairSpecMatrix 同义）：跨窗口数组合 → 找「真凶维度值」→ 删值重提交 */
export async function countMatrixKeys(page, dimNames, dimValues) {
  const D0 = (dimValues[0] || []).map(String);
  const D1 = (dimValues[1] || []).map(String);
  const tok = (v) => { const x = String(v ?? ""); const i = x.search(/[*（(【\[]/); return i > 0 ? x.slice(0, i) : x; };
  const T1 = D1.map(tok);
  const meta = await getScrollMeta(page);
  const seen = new Set();
  const maxSh = (meta.scrollHeight || 4000) + 400;
  const adapt = Math.max(150, Math.ceil(maxSh / 40));
  let sticky0 = "";
  for (let st = 0; st <= maxSh; st += adapt) {
    await scrollTopTo(page, st, meta.depth);
    await sleep(140);
    const r = await page.evaluate(
      ({ D0, D1, T1, stickyIn }) => {
        let sticky = stickyIn;
        const out = [];
        for (const tr of [...document.querySelectorAll("tbody tr")]) {
          const text = (tr.textContent || "").replace(/\s+/g, " ").trim();
          for (const v of D0) if (text.includes(v)) { sticky = v; break; }
          let d1 = "";
          for (let i = 0; i < D1.length; i++) if (text.includes(D1[i])) { d1 = D1[i]; break; }
          if (!d1) for (let i = 0; i < D1.length; i++) {
            const tk = T1[i];
            if (!tk || tk === D1[i]) continue;
            if (T1.filter((x) => x === tk).length > 1) continue;
            if (text.includes(tk)) { d1 = D1[i]; break; }
          }
          if (sticky && d1) out.push(sticky + "|" + d1);
        }
        return { sticky, keys: out };
      },
      { D0, D1, T1, stickyIn: sticky0 }
    );
    sticky0 = r.sticky;
    for (const k of r.keys) seen.add(k);
    if (seen.size >= D0.length * D1.length) break;
  }
  return { count: seen.size, expect: D0.length * D1.length, keys: [...seen] };
}

/**
 * 设置规格类型的名称（**照抄插件 setSpecType**）：
 *  ① 打开该输入框的 ST_select 包装节点（裸 input 点击会点到表头）；
 *  ② 在弹出的 portal 里找 [role=option]，按「全等 → 前缀 → 包含」匹配；
 *  ③ 读回 input[placeholder=规格类型N].value 校验。
 */
export async function setSpecType(page, typeIndex, name) {
  const ph = typeIndex === 0 ? "规格类型1" : "规格类型2";

  await page.evaluate((ph2) => {
    const inp = document.querySelector('input[placeholder="' + ph2 + '"]');
    if (!inp) return;
    let n = inp;
    for (let i = 0; i < 8 && n; i++) {
      const cls = String(n.className || "");
      if (/ST_selectValueSingle|selectValue|ST_select/i.test(cls)) {
        n.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        n.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        n.click();
        return;
      }
      n = n.parentElement;
    }
    inp.click();
  }, ph).catch(() => {});
  await sleep(600);

  const picked = await page.evaluate((n) => {
    const opts = [...document.querySelectorAll('[role="option"]')].filter((el) => el.offsetParent);
    if (!opts.length) return "no_options";
    let target = opts.find((el) => (el.textContent || "").trim() === n);
    if (!target) {
      target = opts.find((el) => {
        const t = (el.textContent || "").trim();
        return t === n || t.startsWith(n) || t.includes(n);
      });
    }
    if (!target) return "no_match:" + opts.map((el) => (el.textContent || "").trim()).slice(0, 8).join(",");
    target.click();
    return "ok:" + (target.textContent || "").trim();
  }, name).catch(() => "eval_failed");
  await sleep(600);

  const val = await page.evaluate((ph2) => {
    const el = document.querySelector('input[placeholder="' + ph2 + '"]');
    return el ? el.value : "";
  }, ph).catch(() => "");

  return { ok: val === name || String(picked).startsWith("ok:"), picked, val, want: name };
}

/**
 * 长时页内执行（**关键加速器**）：ego 的 page.evaluate 有 15s 硬上限，
 * 但 page.cdp('Runtime.evaluate', params, { timeout }) 可以放宽 —— 这样插件那种
 * 「整个滚动+填值循环塞进一次调用」的写法才可用。
 */
export async function evalLong(page, fnSource, arg, { timeoutMs = 120000 } = {}) {
  const expression = "(" + fnSource + ")(" + JSON.stringify(arg === undefined ? null : arg) + ")";
  const res = await page.cdp(
    "Runtime.evaluate",
    { expression, awaitPromise: true, returnByValue: true },
    { timeout: timeoutMs }
  );
  if (!res) return null;
  if (res.exceptionDetails) {
    return { __error: String((res.exceptionDetails.exception && res.exceptionDetails.exception.description) || res.exceptionDetails.text).slice(0, 300) };
  }
  const r = res.result || {};
  return r.value === undefined ? r : r.value;
}

/**
 * 快速填 SKU 行（**插件 fillSkuRowsAndVerify 的 in-page 算法，用 evalLong 一次跑完**）。
 * 结构、判据与插件逐行一致：sticky 维度推导 → native setter 写 4 列 → 逐行读回比对。
 */
export async function fillSkuRowsCDP(page, P, { rounds = 2, step = 120, pauseMs = 70, timeoutMs = 180000 } = {}) {
  const dimNames = P.dimensions || [];
  const skus = P.skus || [];
  const want = skus.map((s2) => [`${s2[dimNames[0]]}|${s2[dimNames[1]]}`, s2]);
  const D0 = [...new Set(skus.map((s2) => String(s2[dimNames[0]] ?? "")))];
  const D1 = [...new Set(skus.map((s2) => String(s2[dimNames[1]] ?? "")))];
  const tok = (v) => { const x = String(v ?? ""); const i = x.search(/[*（(【\[]/); return i > 0 ? x.slice(0, i) : x; };
  const T1 = D1.map(tok);
  const expected = skus.reduce((a, s2) => a + (Number(s2.stock) || 0), 0);
  const args = { D0, D1, T1, want, step, pauseMs };

  const FN = `async (a) => {
    const { D0, D1, T1, want, step, pauseMs } = a;
    const wmap = new Map(want);
    const norm = (x) => { const y = Number(String(x ?? "").trim()); return Number.isFinite(y) ? y.toFixed(4) : String(x ?? "").trim(); };
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    const setVal = (el, v) => {
      if (String(el.value) === String(v)) return false;
      setter.call(el, v);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    };
    const sc = (() => {
      let c = [...document.querySelectorAll("*")].filter((e) => e.querySelector && e.querySelector("tbody tr") && e.scrollHeight > e.clientHeight + 20 && /^(scroll|auto)$/.test(getComputedStyle(e).overflowY));
      if (!c.length) c = [...document.querySelectorAll("*")].filter((e) => e.tagName !== "HTML" && e.tagName !== "BODY" && e.scrollHeight > e.clientHeight + 40 && e.querySelector && e.querySelector("tbody tr"));
      return c;
    })();
    let n = document.querySelector("tbody tr")?.parentElement;
    while (n && n !== document.body) { if (n.scrollHeight > n.clientHeight + 20) sc.push(n); n = n.parentElement; }
    const all = [...new Set(sc)];
    const maxSh = Math.max(3000, ...all.map((e) => e.scrollHeight));
    const seen = new Map();
    let writes = 0;
    let sticky = "";
    const stepFn = () => {
      for (const tr of [...document.querySelectorAll("tbody tr")]) {
        const text = (tr.textContent || "").replace(/\s+/g, " ").trim();
        for (const v of D0) if (text.includes(v)) { sticky = v; break; }
        let d1 = "";
        for (let i = 0; i < D1.length; i++) if (text.includes(D1[i])) { d1 = D1[i]; break; }
        if (!d1) for (let i = 0; i < D1.length; i++) {
          const tk = T1[i];
          if (!tk || tk === D1[i]) continue;
          if (T1.filter((x) => x === tk).length > 1) continue;
          if (text.includes(tk)) { d1 = D1[i]; break; }
        }
        if (!sticky || !d1) continue;
        const key = sticky + "|" + d1;
        const w = wmap.get(key);
        if (!w) continue;
        const inputs = [...tr.querySelectorAll('input[placeholder="请输入"]')].filter((e) => e.offsetParent);
        if (inputs.length !== 4) continue;
        const t = [String(w.stock), String(w.group_price), String(w.single_price), String(w.code)];
        for (let k = 0; k < 4; k++) if (setVal(inputs[k], t[k])) writes++;
        const cell = tr.querySelector("td.sku-preview-cell");
        const hasImg = !!(cell && (cell.querySelector("img") || cell.querySelector('[style*="background-image"]')));
        seen.set(key, { vals: inputs.map((e) => e.value), img: hasImg });
      }
    };
    all.forEach((e) => { e.scrollTop = 0; });
    window.scrollTo(0, 0);
    await new Promise((r2) => setTimeout(r2, 200));
    stepFn();
    for (let st = 0; st <= maxSh + 600; st += step) {
      all.forEach((e) => { e.scrollTop = st; });
      window.scrollTo(0, st);
      await new Promise((r2) => setTimeout(r2, pauseMs));
      stepFn();
    }
    let ok = 0, img = 0;
    const bad = [];
    for (const [k, g] of seen) {
      const w = wmap.get(k);
      if (!w) { bad.push(k); continue; }
      const same = norm(g.vals[0]) === norm(w.stock) && norm(g.vals[1]) === norm(w.group_price) && norm(g.vals[2]) === norm(w.single_price) && String(g.vals[3]) === String(w.code);
      if (same) ok++; else bad.push(k);
      if (g.img) img++;
    }
    const stockSum = [...seen.values()].reduce((x, y) => x + (Number(y.vals[0]) || 0), 0);
    return { writes, covered: seen.size, ok, img, bad: bad.slice(0, 6), stockSum };
  }`;

  const t0 = Date.now();
  let last = await evalLong(page, FN, args, { timeoutMs }).catch((e) => ({ __error: String(e.message).slice(0, 200) }));
  if (last && last.__error) return { ok: false, err: last.__error, elapsedMs: Date.now() - t0 };
  last = { ...(last || {}), rounds: 1 };
  return { ...last, expected, elapsedMs: Date.now() - t0, method: "cdp_one_shot" };
}

/** 清空 SKU 行的库存（用于测速对比；仅测试用） */
export async function clearSkuStocksCDP(page) {
  const FN = `() => {
    let n = 0;
    for (const tr of [...document.querySelectorAll("tbody tr")]) {
      const inputs = [...tr.querySelectorAll('input[placeholder="请输入"]')].filter((e) => e.offsetParent);
      if (inputs.length !== 4) continue;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(inputs[0], "");
      inputs[0].dispatchEvent(new Event("input", { bubbles: true }));
      n++;
    }
    return n;
  }`;
  return evalLong(page, FN, null, { timeoutMs: 30000 });
}

// ─────────────────────────── ⑦ 填 SKU 行 ───────────────────────────

// ── 滚动机制（移植插件 getScrollMeta / scrollTopTo / makeStickyMapRow）──

/** 找 SKU 表的真实虚拟滚动容器 */
export async function getScrollMeta(page) {
  return page.evaluate(() => {
    let node = document.querySelector("tbody tr");
    let best = null;
    for (let i = 0; i < 15 && node; i++) {
      node = node.parentElement;
      if (!node) break;
      const sh = node.scrollHeight;
      const ch = node.clientHeight;
      if (sh > ch + 50 && ch > 200) {
        if (!best || sh > best.scrollHeight) best = { kind: "ancestor", depth: i, scrollHeight: sh, clientHeight: ch };
      }
    }
    if (best) return best;
    const sl = document.querySelector(".sku-list");
    if (sl && sl.scrollHeight > sl.clientHeight + 50) {
      return { kind: "sku-list", depth: -1, scrollHeight: sl.scrollHeight, clientHeight: sl.clientHeight };
    }
    return { kind: "none", depth: 3, scrollHeight: 4000, clientHeight: 0 };
  });
}

export async function scrollTopTo(page, st, depth = null) {
  await page.evaluate(
    ({ scrollTop, d }) => {
      const tr = document.querySelector("tbody tr");
      if (!tr) { window.scrollTo(0, Math.max(0, scrollTop)); return; }
      let node = tr;
      let target = null;
      let byDepth = null;
      for (let k = 0; k < 15 && node; k++) {
        node = node.parentElement;
        if (!node) break;
        const cs = getComputedStyle(node);
        const scrollable = node.scrollHeight > node.clientHeight + 20 && /auto|scroll/.test(cs.overflowY);
        if (d != null && d >= 0 && k === d) byDepth = node;
        if (!target && scrollable) target = node;
      }
      const el = byDepth || target;
      if (el) { try { el.scrollTop = scrollTop; } catch (_) {} return; }
      window.scrollTo(0, Math.max(0, scrollTop));
    },
    { scrollTop: st, d: depth }
  );
}

/** sticky 映射：行文本 → 该行的 sku（维度值可能被 rowspan 折叠，用 sticky 继承） */
export function makeStickyMapRow(dimNames, skuByKey) {
  const dimValues = dimNames.map((d) => [...new Set(Object.values(skuByKey).map((s2) => String(s2[d] ?? "").trim()).filter(Boolean))]);
  const sticky = dimNames.map(() => "");
  return {
    map(text, inputs) {
      dimValues.forEach((vals, di) => {
        for (const v of vals) if (text.includes(v)) { sticky[di] = v; break; }
      });
      let best = null;
      let bestScore = -1;
      for (const [key, sku] of Object.entries(skuByKey)) {
        const parts = key.split("|");
        let score = 0;
        let all = true;
        parts.forEach((pp, i) => {
          if (pp && text.includes(pp)) score += pp.length + 10;
          else if (sticky[i] && sticky[i] === pp) score += pp.length;
          else all = false;
        });
        if (all && score > bestScore) { bestScore = score; best = { key, sku }; }
      }
      if (!best) {
        const key = sticky.join("|");
        if (skuByKey[key]) best = { key, sku: skuByKey[key] };
      }
      if (!best) return null;
      return {
        key: best.key,
        sku: best.sku,
        text,
        stock: inputs[0] ?? "",
        group: inputs[1] ?? "",
        single: inputs[2] ?? "",
        code: inputs.length >= 4 ? inputs[inputs.length - 1] : inputs[3] ?? "",
        inputs,
      };
    },
    reset() { sticky.fill(""); },
    sticky: () => [...sticky],
  };
}

/** 跨滚动窗口读全表（插件互等价实现；Node 侧循环更稳） */
export async function readAllSkuRows(page, { rowFilter = null, mapRow = null, step = 220, pauseMs = 200, expectedRows = 0 } = {}) {
  const domRows = await page.evaluate(() => [...document.querySelectorAll("tbody tr")].filter((t) => t.offsetParent).length);
  const plainTable = expectedRows > 0 && domRows >= expectedRows;
  const meta = await getScrollMeta(page);
  const seen = new Map();
  const maxScroll = plainTable ? 0 : (meta.scrollHeight || 4000) + 400;
  const maxStepCount = 40;
  const adaptStep = Math.max(step, Math.ceil(maxScroll / maxStepCount));
  // 先把表滚回顶部并等待渲染，否则「上一次留在底部」会让首窗口漏读
  await scrollTopTo(page, 0, meta.depth);
  await sleep(400);
  const passes = expectedRows > 0 ? 2 : 1;
  for (let pass = 0; pass < passes; pass++) {
    if (pass > 0) { await scrollTopTo(page, 0, meta.depth); await sleep(300); }
    for (let st = 0; st <= maxScroll; st += adaptStep) {
    await scrollTopTo(page, st, meta.depth);
    await sleep(pauseMs);
    const rows = await page.evaluate(() => {
      return [...document.querySelectorAll("tbody tr")]
        .filter((tr) => tr.offsetParent)
        .map((tr) => {
          const vals = [...tr.querySelectorAll('input[placeholder="请输入"]')].filter((e) => e.offsetParent).map((e) => e.value);
          const cell = tr.querySelector("td.sku-preview-cell");
          const img = !!(cell && (cell.querySelector("img") || cell.querySelector('[style*="background-image"]')));
          return { text: (tr.textContent || "").replace(/\s+/g, " ").trim(), vals, img };
        });
    }).catch(() => []);
    for (const r of rows) {
      if (rowFilter && !rowFilter(r.text)) continue;
      const mapped = mapRow ? mapRow(r.text, r.vals) : { text: r.text, inputs: r.vals };
      if (!mapped) continue;
      mapped.hasImg = r.img;
      const key = mapped.key || r.text.slice(0, 80);
      if (!seen.has(key)) seen.set(key, mapped);
      else {
        const prev = seen.get(key);
        seen.set(key, { ...prev, ...mapped, inputs: mapped.inputs?.length ? mapped.inputs : prev.inputs, hasImg: r.img == null ? prev.hasImg : r.img });
      }
    }
    }
    if (expectedRows > 0 && seen.size >= expectedRows) break;
  }
  return { meta, rows: [...seen.values()], count: seen.size };
}

/**
 * 填 SKU 行（插件同算法：滚动窗口 + sticky 映射 + native setter 写值 + 逐行读回比对）
 * 返回 { writes, covered, ok, img, stockSum, bad, expected }
 */
export async function fillSkuRowsAndVerify(page, P, { rounds = 2, step = 160, pauseMs = 120 } = {}) {
  const dimNames = P.dimensions || [];
  const skus = P.skus || [];
  const wantMap = new Map(skus.map((s2) => [`${s2[dimNames[0]]}|${s2[dimNames[1]]}`, s2]));
  const D0 = [...new Set(skus.map((s2) => String(s2[dimNames[0]] ?? "")))];
  const D1 = [...new Set(skus.map((s2) => String(s2[dimNames[1]] ?? "")))];
  const tok = (v) => { const x = String(v ?? ""); const i = x.search(/[*（(【\[]/); return i > 0 ? x.slice(0, i) : x; };
  const T1 = D1.map(tok);
  const expected = skus.reduce((a, s2) => a + (Number(s2.stock) || 0), 0);
  const norm = (x) => { const y = Number(String(x ?? "").trim()); return Number.isFinite(y) ? y.toFixed(4) : String(x ?? "").trim(); };

  const meta = await page.evaluate(() => {
    const sc = (() => {
      let c = [...document.querySelectorAll("*")].filter((e) => e.querySelector && e.querySelector("tbody tr") && e.scrollHeight > e.clientHeight + 20 && /^(scroll|auto)$/.test(getComputedStyle(e).overflowY));
      if (!c.length) c = [...document.querySelectorAll("*")].filter((e) => e.tagName !== "HTML" && e.tagName !== "BODY" && e.scrollHeight > e.clientHeight + 40 && e.querySelector && e.querySelector("tbody tr"));
      return c;
    })();
    let n = document.querySelector("tbody tr")?.parentElement;
    while (n && n !== document.body) { if (n.scrollHeight > n.clientHeight + 20) sc.push(n); n = n.parentElement; }
    const all = [...new Set(sc)];
    return { maxSh: Math.max(3000, ...all.map((e) => e.scrollHeight)) };
  });

  const scrollAll = async (st) => {
    await page.evaluate((pos) => {
      const sc = (() => {
        let c = [...document.querySelectorAll("*")].filter((e) => e.querySelector && e.querySelector("tbody tr") && e.scrollHeight > e.clientHeight + 20 && /^(scroll|auto)$/.test(getComputedStyle(e).overflowY));
        if (!c.length) c = [...document.querySelectorAll("*")].filter((e) => e.tagName !== "HTML" && e.tagName !== "BODY" && e.scrollHeight > e.clientHeight + 40 && e.querySelector && e.querySelector("tbody tr"));
        return c;
      })();
      let n = document.querySelector("tbody tr")?.parentElement;
      while (n && n !== document.body) { if (n.scrollHeight > n.clientHeight + 20) sc.push(n); n = n.parentElement; }
      [...new Set(sc)].forEach((e) => { try { e.scrollTop = pos; } catch (_) {} });
      window.scrollTo(0, pos);
    }, st).catch(() => {});
  };

  // 读当前窗口内所有行的文本 + 4 个输入框的「当前值」（不写，避免压死渲染器）
  const readWindow = async () =>
    page.evaluate(() => {
      return [...document.querySelectorAll("tbody tr")].map((tr, i) => {
        const inputs = [...tr.querySelectorAll('input[placeholder="请输入"]')].filter((e) => e.offsetParent).slice(0, 4);
        return {
          i,
          text: (tr.textContent || "").replace(/\s+/g, " ").trim(),
          has4: inputs.length === 4,
          vals: inputs.map((e) => e.value),
        };
      });
    }).catch(() => []);

  // 只写一行的 4 个值（单个短 evaluate，失败不影响其他行）
  const writeRow = async (rowIndex, values) =>
    page.evaluate(
      ({ ri, vals }) => {
        const tr = document.querySelectorAll("tbody tr")[ri];
        if (!tr) return 0;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
        const inputs = [...tr.querySelectorAll('input[placeholder="请输入"]')].filter((e) => e.offsetParent).slice(0, 4);
        if (inputs.length !== 4) return 0;
        let w = 0;
        for (let k = 0; k < 4; k++) {
          if (String(inputs[k].value) === String(vals[k])) continue;
          setter.call(inputs[k], String(vals[k]));
          inputs[k].dispatchEvent(new Event("input", { bubbles: true }));
          inputs[k].dispatchEvent(new Event("change", { bubbles: true }));
          w++;
        }
        return w;
      },
      { ri: rowIndex, vals: values }
    ).catch(() => 0);

  let last = { writes: 0, covered: 0, ok: 0, img: 0, stockSum: 0, bad: [] };

  for (let round = 1; round <= rounds; round++) {
    const seen = new Map();
    let writes = 0;
    let sticky = "";
    const domRows = await page.evaluate(() => [...document.querySelectorAll("tbody tr")].filter((t) => t.offsetParent).length);
    const plain = domRows >= skus.length;
    const maxSh = plain ? 0 : meta.maxSh + 600;
    const adapt = Math.max(step, Math.ceil(maxSh / 36));

    for (let st = 0; st <= maxSh; st += adapt) {
      if (!plain) { await scrollAll(st); await sleep(pauseMs); }
      const rows = await readWindow();
      for (const r of rows) {
        if (!r.has4) continue;
        // sticky 推导维度
        for (const v of D0) if (r.text.includes(v)) { sticky = v; break; }
        let d1 = "";
        for (let i = 0; i < D1.length; i++) if (r.text.includes(D1[i])) { d1 = D1[i]; break; }
        if (!d1) for (let i = 0; i < D1.length; i++) {
          const tk = T1[i];
          if (!tk || tk === D1[i]) continue;
          if (T1.filter((x) => x === tk).length > 1) continue;
          if (r.text.includes(tk)) { d1 = D1[i]; break; }
        }
        if (!sticky || !d1) continue;
        const key = sticky + "|" + d1;
        const w = wantMap.get(key);
        if (!w) continue;
        const vals = [String(w.stock), String(w.group_price), String(w.single_price), String(w.code)];
        // 值已正确则跳过写
        const same = norm(r.vals[0]) === norm(vals[0]) && norm(r.vals[1]) === norm(vals[1]) && norm(r.vals[2]) === norm(vals[2]) && String(r.vals[3]) === String(vals[3]);
        let valsNow = r.vals;
        if (!same) {
          const n = await writeRow(r.i, vals);
          writes += n || 0;
          if (!n) {
            await sleep(300);
            writes += (await writeRow(r.i, vals)) || 0;
          }
          await sleep(250); // 留出渲染间隙
          // 写后立刻重新读该行真实值，避免用旧快照做核对（否则会误报少一行）
          valsNow = await page.evaluate((ri) => {
            const tr = document.querySelectorAll("tbody tr")[ri];
            if (!tr) return [];
            return [...tr.querySelectorAll('input[placeholder="请输入"]')].filter((e) => e.offsetParent).slice(0, 4).map((e) => e.value);
          }, r.i).catch(() => r.vals);
        }
        const cell = await page.evaluate((ri) => {
          const tr = document.querySelectorAll("tbody tr")[ri];
          if (!tr) return false;
          const td = tr.querySelector("td.sku-preview-cell");
          return !!(tr.querySelector("img") || (td && [...td.querySelectorAll("*")].some((e) => /pfs\.pinduoduo|pddpic/.test(getComputedStyle(e).backgroundImage))));
        }, r.i).catch(() => false);
        const prev = seen.get(key);
        seen.set(key, { vals: valsNow && valsNow.length === 4 ? valsNow : r.vals, img: cell || (prev ? prev.img : false) });
      }
      if (plain) break;
    }

    let ok = 0;
    let img = 0;
    const bad = [];
    for (const [k, g] of seen) {
      const w = wantMap.get(k);
      if (!w) { bad.push(k); continue; }
      const same = norm(g.vals[0]) === norm(w.stock) && norm(g.vals[1]) === norm(w.group_price) && norm(g.vals[2]) === norm(w.single_price) && String(g.vals[3]) === String(w.code);
      if (same) ok++; else bad.push(k);
      if (g.img) img++;
    }
    const stockSum = [...seen.values()].reduce((x, y) => x + (Number(y.vals[0]) || 0), 0);
    last = { writes, covered: seen.size, ok, img, bad: bad.slice(0, 6), stockSum, rounds: round };
    // 仍有没写对的行 → 再扫一遍（最多 rounds 遍），直到整轮零写入
    if (writes === 0 && ok === wantMap.size) break;
    if (writes === 0 && round >= rounds) break;
  }
  return { ...last, expected };
}

// ─────────────────────────── ⑧ 预览图 ───────────────────────────

/** 跨滚动窗口正向核验预览图（与插件 countPreviewCells 同语义，缩略图可能是 background-image） */
export async function countPreviewCells(page, P) {
  const DIMS = (P && P.dimensions) || [];
  const SKUS = (P && P.skus) || [];
  const skuByKey = {};
  for (const s2 of SKUS) skuByKey[`${s2[DIMS[0]]}|${s2[DIMS[1]]}`] = s2;
  const map = SKUS.length ? makeStickyMapRow(DIMS, skuByKey) : null;
  const scanned = await readAllSkuRows(page, {
    mapRow: map ? (t, v) => map.map(t, v) : null,
    step: 200,
    pauseMs: 160,
    expectedRows: SKUS.length,
  });
  const withImg = scanned.rows.filter((r) => r.hasImg).length;
  const missing = scanned.rows.filter((r) => !r.hasImg).map((r) => r.key || r.text.slice(0, 40));
  return { total: scanned.count, withImg, missing };
}

/**
 * 补缺的 SKU 预览图（插件同算法）：跨滚动窗口 → 行文本 sticky 映射 → 行内隐藏 file input 直接上传
 * → 轮询该行出现缩略图；失败行回报（不再打开图片空间）。
 */
/**
 * 补 SKU 预览图 —— **严格照抄插件 pdd_flow.js uploadMissingPreviews 的结构**：
 *  · 3 遍 × 步长 110 滚动窗口；每遍 sticky.reset()
 *  · 每行「现取」DOM 元素（用 data-row 标记，模拟 Playwright locator 的每次重解析）
 *  · hasImg 判据 = tr.querySelector('img') || tr.querySelector('[style*="background-image"]')（属性法，不读 computedStyle）
 *  · 上传：行内 input[type=file] 直接 setInputFiles；失败退回点「本地上传」走 filechooser
 */
export async function uploadMissingPreviews(page, P, { colorToFile = {}, previewByCode = {} } = {}) {
  const dimNames = P.dimensions || [];
  const skus = P.skus || [];
  const byDim = {};
  for (const s2 of skus) {
    for (const d of dimNames) {
      const v = String(s2[d] ?? "");
      if (v && !byDim[v] && s2.preview) byDim[v] = s2.preview;
    }
  }
  const skuByKey = {};
  for (const s2 of skus) skuByKey[`${s2[dimNames[0]]}|${s2[dimNames[1]]}`] = s2;
  const sticky = makeStickyMapRow(dimNames, skuByKey);
  const dimVals = skus.flatMap((s2) => dimNames.map((d) => String(s2[d] ?? ""))).filter(Boolean);
  const rowFilter = (text) => dimVals.some((v) => text.includes(v));

  let touched = 0;
  const failed = [];
  const meta = await getScrollMeta(page);

  for (let pass = 0; pass < 3; pass++) {
    let touchedThisPass = 0;
    sticky.reset();
    const m2 = pass === 0 ? meta : await getScrollMeta(page).catch(() => meta);
    const maxSh = (m2.scrollHeight || 4000) + 500;
    for (let st = 0; st <= maxSh; st += 110) {
      await scrollTopTo(page, st, m2.depth);
      await sleep(50);

      const n = await page.evaluate(() => [...document.querySelectorAll("tbody tr")].filter((t) => t.offsetParent).length);
      for (let i = 0; i < n; i++) {
        // ① 现取该行（打标记，等价于 Playwright locator.nth(i)）
        const row = await page.evaluate((idx) => {
          const trs = [...document.querySelectorAll("tbody tr")].filter((t) => t.offsetParent);
          const tr = trs[idx];
          if (!tr) return null;
          tr.setAttribute("data-row", "r" + idx);
          const text = (tr.textContent || "").replace(/\s+/g, " ").trim();
          const hasImg = !!(tr.querySelector("img") || tr.querySelector('[style*="background-image"]'));
          const f = tr.querySelector('input[type=file]');
          if (f) f.setAttribute("data-ego", "in" + idx);
          return { text, hasImg, hasInput: !!f, sel: f ? 'css:input[data-ego="in' + idx + '"]' : null };
        }, i).catch(() => null);
        if (!row) continue;
        if (!rowFilter(row.text)) continue;
        const mapped = sticky.map(row.text, []);
        if (!mapped) continue;
        if (row.hasImg) continue;

        const sku = mapped.sku;
        const key0 = String((sku && sku[dimNames[0]]) ?? "");
        const file = (sku && (previewByCode[sku.code] || sku.preview)) ||
          byDim[key0] ||
          colorToFile[key0] || null;
        if (!file) { failed.push({ key: mapped.key, reason: "no_file" }); continue; }

        let uploaded = false;
        if (row.hasInput) {
          await page.setInputFiles(row.sel, [file]).catch(() => {});
          // ② 用刚打的 data-row 标记校验（同一节点；被重渲染则标记消失 → 退回按文本重新定位）
          for (let k = 0; k < 10; k++) {
            await sleep(160);
            const st2 = await page.evaluate((idx) => {
              const tr = document.querySelector('[data-row="r' + idx + '"]');
              if (!tr) return null;
              return !!(tr.querySelector("img") || tr.querySelector('[style*="background-image"]'));
            }, i).catch(() => null);
            if (st2 === true) { uploaded = true; break; }
            if (st2 === null) break; // 节点被替换，交给下一遍
          }
        }

        // ③ 兜底：点该行「本地上传」走 filechooser（插件同款 fallback）
        if (!uploaded) {
          const upPos = await page.evaluate((idx) => {
            const trs = [...document.querySelectorAll("tbody tr")].filter((t) => t.offsetParent);
            const tr = trs[idx];
            if (!tr) return null;
            const hit = [...tr.querySelectorAll("*")].find(
              (e) => e.offsetParent && !e.children.length && (e.textContent || "").trim() === "本地上传"
            );
            if (!hit) return null;
            hit.scrollIntoView({ block: "center" });
            const r = hit.getBoundingClientRect();
            return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
          }, i).catch(() => null);
          if (upPos) {
            try {
              const cp = page.waitForFileChooser({ timeout: 6000 });
              await page.mouse.click(upPos.x, upPos.y, { label: "preview local upload" });
              const ch = await cp;
              await ch.setFiles([file]);
              await sleep(600);
              const ok = await page.evaluate((idx) => {
                const trs = [...document.querySelectorAll("tbody tr")].filter((t) => t.offsetParent);
                const tr = trs[idx];
                return !!(tr && (tr.querySelector("img") || tr.querySelector('[style*="background-image"]')));
              }, i).catch(() => false);
              if (ok) uploaded = true;
            } catch (e) {}
          }
        }

        if (uploaded) { touched++; touchedThisPass++; }
        else failed.push({ key: mapped.key, reason: "upload_no_effect", pass: pass + 1, st });
      }
      if (touched >= skus.length) break;
    }
    if (touchedThisPass === 0) break;
  }

  const fin = await countPreviewCells(page, P);
  return { ok: fin.missing.length === 0, touched, total: fin.total, withImg: fin.withImg, missing: fin.missing.length, failed: failed.slice(0, 8) };
}

// ─────────────────────────── 图区状态/清空（插件同实现）───────────────────────────

/** 包装标签图计数（先把左侧发布助手面板从副本剔除，否则会误匹配到轮播图的 10/10） */
export async function packagingLabelState(page) {
  return page.evaluate(() => {
    const clone = document.body.cloneNode(true);
    clone.querySelectorAll("[class*=guide], [class*=fix-nav]").forEach((e) => e.remove());
    const t = (clone.innerText || "").replace(/\s+/g, " ");
    const m = t.match(/包装标签图[\s\S]{0,200}?已上传\s*(\d+)\s*\/\s*(\d+)\s*张?/);
    return m ? { uploaded: Number(m[1]), total: Number(m[2]) } : null;
  });
}

/** 主图/轮播区计数（认旧版「已上传N/10张」与新版「上传图片 (N/10)」两套文案） */
export async function mainImagesState(page) {
  return page.evaluate(() => {
    const t = document.body.innerText || "";
    const m = t.match(/(?:商品轮播图|商品主图)[\s\S]{0,240}?(?:已上传\s*(\d+)\s*\/\s*(\d+)\s*张?|上传图片\s*\(\s*(\d+)\s*\/\s*(\d+)\s*\))/);
    if (!m) return null;
    return m[1] != null ? { uploaded: Number(m[1]), total: Number(m[2]) } : { uploaded: Number(m[3]), total: Number(m[4]) };
  });
}

/** 清空某个图区（包装标签图等）：hover 每张缩略图 → 点删除图标，直到计数为 0 */
export async function clearZone(page, zoneName, capacity = 10) {
  let guard = 0;
  let removed = 0;
  while (guard++ < capacity + 4) {
    const st = await page.evaluate((zone) => {
      const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
      const vis = (e) => !!(e && e.offsetParent);
      const clone = document.body.cloneNode(true);
      clone.querySelectorAll("[class*=guide], [class*=fix-nav]").forEach((e) => e.remove());
      const t = (clone.innerText || "").replace(/\s+/g, " ");
      const m = t.match(new RegExp(zone + "[\\s\\S]{0,200}?已上传\\s*(\\d+)\\s*/\\s*\\d+"));
      const uploaded = m ? Number(m[1]) : null;
      // 找到该区的删除图标坐标
      const lab = [...document.querySelectorAll("*")].find((e) => vis(e) && !e.children.length && norm(e.textContent) === zone);
      let pos = null;
      if (lab) {
        let node = lab, box = null;
        for (let i = 0; i < 6 && node; i++) {
          node = node.parentElement;
          if (!node) break;
          if (node.querySelector('input[type=file]')) { box = node; break; }
        }
        if (box) {
          const del = [...box.querySelectorAll("*")].find(
            (e) => /delete|close/i.test(String(e.className || "")) && (e.offsetParent || e.getBoundingClientRect().width > 0)
          );
          if (del) {
            del.scrollIntoView({ block: "center" });
            const r = del.getBoundingClientRect();
            pos = { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
          }
        }
      }
      return { uploaded, pos };
    }, zoneName);
    if (st.uploaded === null || st.uploaded === 0) break;
    if (!st.pos) {
      // 兜底：hover 第一张再找删除
      const hover = await page.evaluate((zone) => {
        const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
        const vis = (e) => !!(e && e.offsetParent);
        const lab = [...document.querySelectorAll("*")].find((e) => vis(e) && !e.children.length && norm(e.textContent) === zone);
        if (!lab) return null;
        let node = lab, box = null;
        for (let i = 0; i < 6 && node; i++) {
          node = node.parentElement;
          if (!node) break;
          if (node.querySelector('input[type=file]')) { box = node; break; }
        }
        if (!box) return null;
        const thumb = [...box.querySelectorAll("img")].find(vis);
        if (!thumb) return null;
        const r = thumb.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      }, zoneName);
      if (!hover) break;
      await page.mouse.move(hover.x, hover.y, { label: "hover zone thumb" });
      await sleep(700);
      const del2 = await page.evaluate((zone) => {
        const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
        const vis = (e) => !!(e && e.offsetParent);
        const lab = [...document.querySelectorAll("*")].find((e) => vis(e) && !e.children.length && norm(e.textContent) === zone);
        if (!lab) return null;
        let node = lab, box = null;
        for (let i = 0; i < 6 && node; i++) {
          node = node.parentElement;
          if (!node) break;
          if (node.querySelector('input[type=file]')) { box = node; break; }
        }
        if (!box) return null;
        const d = [...box.querySelectorAll("*")].find((e) => /delete|close/i.test(String(e.className || "")) && (e.offsetParent || e.getBoundingClientRect().width > 0));
        if (!d) return null;
        const r = d.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      }, zoneName);
      if (!del2) break;
      await page.mouse.click(del2.x, del2.y, { label: "delete zone img" });
    } else {
      await page.mouse.click(st.pos.x, st.pos.y, { label: "delete zone img" });
    }
    await sleep(1400);
    removed++;
  }
  const fin = await packagingLabelState(page);
  return { removed, state: fin };
}

// ─────────────────────────── ⑨ 参考价 ───────────────────────────

export async function setRefPrice(page, val) {
  // 该表单的参考价输入框没有可用的「商品参考价」文本叶子（实测 label 命中 0），
  // 稳定特征是 placeholder「应大于商品最大单买价」→ 写与读都用它。
  const locate = () =>
    page.evaluate(() => {
      const vis = (e) => !!(e && e.offsetParent);
      const inp = [...document.querySelectorAll("input")].find((i) => vis(i) && /应大于商品最大单买价/.test(i.placeholder || ""));
      if (!inp) return null;
      inp.scrollIntoView({ block: "center" });
      const r = inp.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    });

  const pos = await locate();
  if (!pos) return { ok: false, reason: "input_not_found" };
  await page.mouse.click(pos.x, pos.y, { label: "ref price" });
  await sleep(200);
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Backspace");
  await page.keyboard.insertText(String(val));
  await page.keyboard.press("Tab");
  await sleep(1000);

  const back = await page.evaluate(() => {
    const vis = (e) => !!(e && e.offsetParent);
    const inp = [...document.querySelectorAll("input")].find((i) => vis(i) && /应大于商品最大单买价/.test(i.placeholder || ""));
    return inp ? inp.value : null;
  });
  return { ok: back === String(val), value: back };
}

export async function validateForm(page, P) {
  // ── 先跨滚动窗口读全表（虚拟列表必须这样读，否则只有可见行）──
  const DIMS0 = P.dimensions || [];
  const SKUS0 = P.skus || [];
  const skuByKey0 = {};
  for (const s2 of SKUS0) skuByKey0[`${s2[DIMS0[0]]}|${s2[DIMS0[1]]}`] = s2;
  let scanned = { rows: [], count: 0 };
  if (SKUS0.length) {
    const stickyMap = makeStickyMapRow(DIMS0, skuByKey0);
    scanned = await readAllSkuRows(page, { mapRow: (t, v) => stickyMap.map(t, v), step: 200, pauseMs: 150, expectedRows: SKUS0.length }).catch(() => scanned);
  }
  const pkg = await packagingLabelState(page).catch(() => null);

  const raw = await page.evaluate(() => {
    const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
    const vis = (e) => !!(e && e.offsetParent);
    const t = norm(document.body.innerText);
    const inp = [...document.querySelectorAll("input")];

    const props = {};
    for (const n of [...document.querySelectorAll('[data-testid="beast-core-form-item"][id^="basic.propertys."]')].filter(vis)) {
      const lab = norm(n.querySelector("label")?.innerText || "").replace(/^重要/, "");
      const input = n.querySelector("input");
      const sv = norm([...n.querySelectorAll('[class*="selectValue"]')].map((e) => e.innerText).join(" "));
      props[lab] = (input && input.value) || sv || "";
    }

    const all = [...document.querySelectorAll('input[placeholder="规格类型1"], input[placeholder="规格类型2"], input[placeholder="请输入规格名称"]')];
    const t2 = all.find((e) => e.placeholder === "规格类型2");
    const t2i = t2 ? all.indexOf(t2) : -1;
    const chips = [...document.querySelectorAll('input[placeholder="请输入规格名称"]')];
    const dim1 = chips.filter((c) => !(t2i >= 0 && all.indexOf(c) > t2i)).map((c) => c.value).filter(Boolean);
    const dim2 = chips.filter((c) => t2i >= 0 && all.indexOf(c) > t2i).map((c) => c.value).filter(Boolean);

    const trs = [...document.querySelectorAll("tbody tr")].filter(vis);
    const rows = trs.map((tr) => {
      const vals = [...tr.querySelectorAll("input")].filter((i) => i.type !== "file").map((i) => i.value);
      const td = [...tr.querySelectorAll("td")].find((x) => /sku-preview-cell/.test(String(x.className)));
      const thumb = td ? [...td.querySelectorAll("*")].some((e) => /(pfs\.pinduoduo\.com|pddpic|mms-goods-image)/.test(getComputedStyle(e).backgroundImage)) : false;
      return { vals: vals.slice(0, 4), thumb };
    });

    // 商品视频：排除左侧发布助手，找有 file input 的那个区；有封面/删除即视为已上传
    const inSidePanel = (el) => {
      let n = el;
      for (let i = 0; i < 12 && n; i++) {
        if (/fix-nav|发布助手|guide/.test(String(n.className || ""))) return true;
        n = n.parentElement;
      }
      return false;
    };
    let videoDone = false;
    let videoInfo = null;
    {
      const labs = [...document.querySelectorAll("*")].filter(
        (e) => vis(e) && !e.children.length && norm(e.textContent) === "商品视频" && !inSidePanel(e)
      );
      for (const lab of labs) {
        let node = lab, box = null;
        for (let i = 0; i < 5 && node; i++) {
          node = node.parentElement;
          if (!node) break;
          if (node.querySelector('input[type=file]')) { box = node; break; }
        }
        if (!box) continue;
        const t2 = norm(box.textContent);
        const imgs = [...box.querySelectorAll("img")].filter(vis).length;
        const del = [...box.querySelectorAll("*")].filter(
          (e) => /delete|close/i.test(String(e.className || "")) && (e.offsetParent || e.getBoundingClientRect().width > 0)
        ).length;
        const placeholder = [...box.querySelectorAll("*")].some(
          (e) => vis(e) && !e.children.length && norm(e.textContent) === "上传视频"
        );
        const hasError = /上传错误|上传失败/.test(t2);
        // 已上传 或 （占位且无错误 → 未上传但可选）都算 pass；有上传错误才算 fail
        videoDone = (del > 0 || (imgs > 0 && !placeholder)) || (placeholder && !hasError);
        videoInfo = { imgs, del, placeholder, hasError, text: t2.slice(0, 60) };
        break;
      }
    }

    // 白底图：素材格（goods-basic-materials-wrapper-v2）出现 pfs/pddpic 缩略图即视为已上传
    let whiteBgDone = false;
    let whiteBgInfo = null;
    {
      const wrapper = [...document.querySelectorAll(".goods-basic-materials-wrapper-v2")].find(vis);
      if (wrapper) {
        const imgs = [...wrapper.querySelectorAll("img")].filter(vis).length;
        const bgs = [...wrapper.querySelectorAll("*")]
          .map((e) => getComputedStyle(e).backgroundImage)
          .filter((x) => x && x !== "none" && /pfs\.pinduoduo|pddpic/.test(x)).length;
        whiteBgDone = imgs + bgs > 0;
        whiteBgInfo = { imgs, bgs };
      }
    }

    const counters = [];
    const re = /([^\n]{0,18}?)(?:已上传\s*(\d+)\s*\/\s*(\d+)\s*张?|上传图片\s*\(\s*(\d+)\s*\/\s*(\d+)\s*\))/g;
    let m;
    while ((m = re.exec(t))) counters.push({ ctx: norm(m[1]).slice(-16), up: Number(m[2] ?? m[4]), total: Number(m[3] ?? m[5]) });

    return {
      title: (inp.find((i) => /商品标题/.test(i.placeholder || "")) || {}).value || null,
      category: (t.match(/商品分类\s*([\s\S]{0,50})/) || [])[1] || null,
      brand: (inp.find((i) => /品牌名称/.test(i.placeholder || "")) || {}).value || null,
      props,
      type1: (all.find((e) => e.placeholder === "规格类型1") || {}).value || null,
      type2: t2 ? t2.value : null,
      dim1,
      dim2,
      rows: rows.length,
      rowFilled: rows.filter((r) => r.vals.every((x) => (x || "").trim())).length,
      rowThumbs: rows.filter((r) => r.thumb).length,
      ref: (inp.find((i) => /应大于商品最大单买价/.test(i.placeholder || "")) || {}).value || null,
      counters,
      price: (t.match(/拼单价\s*([\d.]+(?:\s*～\s*[\d.]+)?\s*元)/) || [])[1] || null,
      videoDone,
      videoInfo,
      whiteBgDone,
      whiteBgInfo,
      errs: (t.match(/错误（(\d+)）/) || [])[1] || null,
    };
  });

  const checks = [];
  const add = (name, status, value) => checks.push({ name, status, value });
  const DIMS = P.dimensions || [];
  const SKUS = P.skus || [];

  add("title", raw.title === P.title ? "pass" : "fail", raw.title);
  add("category", (raw.category || "").includes(String(P.category || "").split(">").pop().trim()) ? "pass" : "fail", raw.category);
  add("brand", raw.brand === String(P.brand || "") ? "pass" : "fail", raw.brand);
  for (const [k, arr] of Object.entries(P.attributes || {})) {
    const want = String((arr && arr[0]) ?? "");
    const got = raw.props[k] || "";
    add("attr_" + k, got.includes(want) ? "pass" : "fail", got || "(空)");
  }
  const V0 = [...new Set(SKUS.map((s) => String(s[DIMS[0]] ?? "")))];
  const V1 = [...new Set(SKUS.map((s) => String(s[DIMS[1]] ?? "")))];
  add("spec_types", raw.type1 === DIMS[0] && raw.type2 === DIMS[1] ? "pass" : "fail", raw.type1 + "/" + raw.type2);
  add("spec_values_dim1", raw.dim1.length === V0.length ? "pass" : "fail", JSON.stringify(raw.dim1));
  add("spec_values_dim2", raw.dim2.length === V1.length ? "pass" : "fail", JSON.stringify(raw.dim2));
  // 虚拟列表下 raw.rows 只是可见行（如 72 行只渲染 18 行）→ 用跨窗口扫描结果
  const scannedCount = scanned.count || raw.rows;
  const scannedFilled = scanned.rows.filter((r) => (r.inputs || []).slice(0, 4).every((x) => String(x || "").trim())).length;
  const scannedThumbs = scanned.rows.filter((r) => r.hasImg).length;
  add("sku_rows", scannedCount === SKUS.length ? "pass" : "fail", `${scannedCount}/${SKUS.length}` + (raw.rows !== scannedCount ? ` (可见 ${raw.rows})` : ""));
  add("sku_rows_filled", scannedFilled === SKUS.length ? "pass" : "fail", `${scannedFilled}/${SKUS.length}`);
  add("sku_previews", scannedThumbs === SKUS.length ? "pass" : "fail", `${scannedThumbs}/${SKUS.length}`);
  add("ref_price", raw.ref === String(P.ref_price) ? "pass" : "fail", raw.ref);
  const mainN = (P.main_images || []).length;
  add("main_images", raw.counters.some((c) => c.up === mainN) ? "pass" : "fail", JSON.stringify(raw.counters.slice(0, 2)));
  const detN = (P.detail_images || []).length;
  {
    // 计数器会虚高（上传失败的占位也计入 N/50），必须同时核对容器数与失败标记
    const dz = await readDetailZone(page).catch(() => ({ counter: null, containers: 0, failed: 0, noImg: 0 }));
    const counterOk = raw.counters.some((c) => c.total === 50 && c.up === detN);
    const structOk = (dz.containers || 0) === detN && (dz.failed || 0) === 0 && (dz.noImg || 0) === 0 && (dz.realImgs || 0) === detN;
    add(
      "detail_images",
      counterOk && structOk ? "pass" : "fail",
      JSON.stringify({ counterUp: dz.counter, containers: dz.containers, failed: dz.failed, noImg: dz.noImg, realImgs: dz.realImgs ?? null, want: detN })
    );
  }
  const A = P._assets || {};
  if (raw.videoDone) add("product_video", "pass", raw.videoInfo ? JSON.stringify(raw.videoInfo).slice(0, 60) : "");
  else if (A.videoExpected === false) add("product_video", "pass", "素材包无视频(跳过)");
  else add("product_video", "fail", raw.videoInfo ? JSON.stringify(raw.videoInfo).slice(0, 60) : "(未找到商品视频区)");
  if (raw.whiteBgDone) add("white_bg_image", "pass", raw.whiteBgInfo ? JSON.stringify(raw.whiteBgInfo) : "");
  else if (A.whiteBgExpected === false) add("white_bg_image", "pass", "素材包无白底图(跳过)");
  else add("white_bg_image", "fail", raw.whiteBgInfo ? JSON.stringify(raw.whiteBgInfo) : "(未找到白底图区)");
  add("errors", raw.errs === "0" ? "pass" : "fail", "错误（" + raw.errs + "）");

  // ── 数值级校验（移植插件的 11 项）──
  const numv = (x) => Number(String(x ?? "").replace(/[^\d.-]/g, ""));
  const expectKeys = SKUS0.map((s2) => `${s2[DIMS0[0]]}|${s2[DIMS0[1]]}`);
  const gotKeys = scanned.rows.map((r) => r.key);
  const missKeys = expectKeys.filter((k) => !gotKeys.includes(k));
  add("scroll_coverage", missKeys.length === 0 ? "pass" : "fail", `读回 ${gotKeys.length}/${expectKeys.length}` + (missKeys.length ? ` 缺:${missKeys.slice(0, 3).join(",")}` : ""));
  add("sku_count", scanned.count === SKUS0.length ? "pass" : "fail", `${scanned.count}/${SKUS0.length}`);

  const empties = scanned.rows.filter((r) => !String(r.inputs?.[0] ?? "").trim());
  add("no_empty_stock", empties.length === 0 ? "pass" : "fail", `${empties.length} 行空库存`);

  const expStock = SKUS0.reduce((a, s2) => a + (Number(s2.stock) || 0), 0);
  const gotStock = scanned.rows.reduce((a, r) => a + (Number(r.inputs?.[0]) || 0), 0);
  add("total_stock", gotStock === expStock ? "pass" : "fail", `${gotStock}/${expStock}`);

  const stockBad = scanned.rows.filter((r) => numv(r.inputs?.[0]) !== Number(r.sku?.stock));
  add("stock_match", stockBad.length === 0 ? "pass" : "fail", `${stockBad.length} 行库存不符`);

  const priceBad = scanned.rows.filter(
    (r) => numv(r.inputs?.[1]) !== Number(r.sku?.group_price) || numv(r.inputs?.[2]) !== Number(r.sku?.single_price)
  );
  add("price_match", priceBad.length === 0 ? "pass" : "fail", `${priceBad.length} 行价格不符`);
  add("price_displayed", raw.price ? "pass" : "fail", raw.price || "(页面无拼单价区间)");

  const codes = scanned.rows.map((r) => String(r.inputs?.[3] ?? "").trim());
  add("codes_nonempty", codes.every((c) => c) ? "pass" : "fail", `${codes.filter((c) => !c).length} 个空编码`);

  const expCodes = new Set(SKUS0.map((s2) => String(s2.code)));
  const gotCodes = new Set(codes.filter(Boolean));
  const missCodes = [...expCodes].filter((c) => !gotCodes.has(c));
  add("codes_exact", missCodes.length === 0 && gotCodes.size === expCodes.size ? "pass" : "fail", `缺 ${missCodes.length} 个 / 多 ${[...gotCodes].filter((c) => !expCodes.has(c)).length} 个`);

  const rowCodeBad = scanned.rows.filter((r) => String(r.inputs?.[3] ?? "").trim() !== String(r.sku?.code));
  add("code_per_row", rowCodeBad.length === 0 ? "pass" : "fail", `${rowCodeBad.length} 行编码不符`);

  add("packaging_label", (pkg?.uploaded ?? 0) === 0 ? "pass" : "fail", pkg ? `已上传 ${pkg.uploaded}/${pkg.total}` : "无包装标签图区");

  const anyFail = checks.some((c) => c.status !== "pass");
  return { allPass: !anyFail, anyFail, checks, raw };
}

// ═══════════════════════════════════════════════════════════════════════════
// 插件 API 对齐层：把 pdd_flow.js 的**全部导出**在 ego 下补齐（同名同义）
// 纯函数（normalizeTitle/codeSet/fingerprint/...）在文件头部的 _vendor 区块，
// 行为与插件逐字一致；页面相关的在此实现 ego 版本。
// ═══════════════════════════════════════════════════════════════════════════

/** ego 无 Playwright；保留同名函数以保持 API 完整（用于兼容调用方） */
export function resolvePlaywrightCore() {
  throw new Error("ego_backend_has_no_playwright：本端口用 ego API 驱动，不使用 playwright-core");
}

/** ego 的浏览器不需要断开（space 由 ego 管理）；保留同名空实现 */
export async function disconnectPage(_browser) {
  return { ok: true, note: "ego space 由 ego-lite 管理，无需断连" };
}

/** 单个属性填写（插件 pickAttr 语义）：打开该属性下拉 → 精确点值 → 读回 */
export async function pickAttr(page, label, value) {
  const r = await applyAttributesByCandidates(page, { [label]: [value] }).catch((e) => ({ needReview: [{ why: e.message }] }));
  const hit = (r.results || [])[0] || {};
  return { label, value, ok: !!hit.ok, how: hit.how || null, got: hit.got ?? null, options: hit.options };
}

/** 插件 applyAttributes 语义：逐个属性填；候选数组取第一个 */
export async function applyAttributes(page, attrs) {
  return applyAttributesByCandidates(page, attrs);
}

/** 插件 pickAttrByCandidates 语义：按候选顺序试，直到某个值填成功 */
export async function pickAttrByCandidates(page, label, candidates) {
  const list = (candidates || []).map((x) => String(x ?? "")).filter(Boolean);
  const tried = [];
  for (const v of list) {
    const r = await pickAttr(page, label, v);
    tried.push({ value: v, ok: r.ok, got: r.got });
    if (r.ok) return { label, ok: true, value: v, got: r.got, tried };
  }
  const options = await readDropdownOptions(page);
  return { label, ok: false, tried, options, reason: "no_candidate_matched" };
}

/** 插件 readZoneCounter / zoneByCounter 语义：按区域关键词读「已上传 N/M」 */
export async function zoneByCounter(page, keyword, total) {
  const counters = await readImageCounters(page).catch(() => []);
  const hit = counters.find((c) => (total ? c.total === total : true) && new RegExp(keyword).test(c.ctx || ""))
    || counters.find((c) => (total ? c.total === total : true));
  return hit ? { keyword, uploaded: hit.up, total: hit.total, ctx: hit.ctx } : null;
}

export async function readZoneCounter(page, keyword, total) {
  const z = await zoneByCounter(page, keyword, total);
  return z ? { uploaded: z.uploaded, total: z.total } : null;
}

export async function waitForZoneCounter(page, keyword, total, { expectMin = 1, timeoutMs = 60000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await readZoneCounter(page, keyword, total);
    if (last && last.uploaded >= expectMin) return { ok: true, ...last, waitedMs: timeoutMs - (deadline - Date.now()) };
    await sleep(1200);
  }
  return { ok: false, last };
}

/** 插件 waitForUploadProgress 语义：轮询某区域计数达到 expectMin */
export async function waitForUploadProgress(page, { expectMin = 1, expectTotal = null, timeoutMs = 30000, keyword = null } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const counters = await readImageCounters(page).catch(() => []);
    const pool = counters.filter((c) => (expectTotal == null || c.total === expectTotal) && (!keyword || new RegExp(keyword).test(c.ctx || "")));
    last = pool.sort((a, b) => b.up - a.up)[0] || last;
    if (last && last.up >= expectMin) return { ok: true, uploaded: last.up, total: last.total, ctx: last.ctx };
    await sleep(1000);
  }
  return { ok: false, last };
}

/** 插件 quickZoneCount 语义：一次性快读（计数 + 缩略图数量） */
export async function quickZoneCount(page, keyword, capacity = 10) {
  return page.evaluate(({ kw, cap }) => {
    const norm = (x) => (x || "").replace(/\s+/g, " ").trim();
    const b = norm(document.body.innerText);
    const re = new RegExp(kw + "[\\s\\S]{0,240}?(?:已上传\\s*(\\d+)\\s*/\\s*" + cap + "|上传图片\\s*\\(\\s*(\\d+)\\s*/\\s*" + cap + ")");
    const m = b.match(re);
    const counter = m ? Number(m[1] != null ? m[1] : m[2]) : null;
    let thumbs = 0;
    for (const el of [...document.querySelectorAll("input[type=file]")]) {
      let p2 = el.parentElement;
      for (let k = 0; k < 8 && p2; k++) {
        const t = norm(p2.innerText);
        if (new RegExp(kw).test(t) && /(?:已上传\s*\d+\s*\/\s*\d+|上传图片\s*\()/.test(t)) {
          thumbs = p2.querySelectorAll("[class*=uploadItem], [class*=imageWrapper], [class*=UploadItem], img").length;
          return { counter, thumbs, how: thumbs >= cap ? "zone_thumb_quick" : "zone_counter_quick" };
        }
        p2 = p2.parentElement;
      }
    }
    return { counter, thumbs, how: "page_thumb_quick" };
  }, { kw: keyword, cap: capacity }).catch(() => ({ counter: null, thumbs: 0, how: "quick_failed" }));
}

/** 插件 uploadZone 语义：往某图区一次上传（内部复用 ego 的逐张实现） */
export async function uploadZone(page, keyword, total, files, opts = {}) {
  return uploadZoneFast(page, keyword, total, files, opts);
}

/** 插件 readDropdownFieldValue 语义：读某属性当前值（form-item → input / chip 文本） */
export async function readDropdownFieldValue(page, label) {
  return readAttr(page, label);
}

/** 插件 specGroups 语义：返回 {t1,t2,g0,g1} */
export async function specGroups(page) {
  const st = await readSpecGroups(page);
  return { t1: st.type1, t2: st.type2, g0: st.groups[0], g1: st.groups[1] };
}

/** 插件 scanSkuKeys 语义：跨窗口读矩阵组合 */
export async function scanSkuKeys(page, dimNames, dimValues) {
  const r = await countMatrixKeys(page, dimNames, dimValues);
  return r.keys;
}

/** 插件 addSpecValues 语义：向某维度追加值（逐个 robustCommit） */
export async function addSpecValues(page, typeIndex, values) {
  const out = [];
  for (const v of values || []) {
    const r = await robustCommitSpecValue(page, typeIndex + 1, v).catch((e) => ({ ok: false, reason: e.message }));
    out.push({ v, ...r });
    await sleep(200);
  }
  return out;
}

export async function addSpecValuesRobust(page, typeIndex, values) {
  return addSpecValues(page, typeIndex, values);
}

/** 插件 clearSpecValues 语义：清空某维度的所有值 */
export async function clearSpecValues(page, typeIndex) {
  const before = await readSpecGroups(page);
  const list = (typeIndex === 1 ? before.groups[1] : before.groups[0]) || [];
  const removed = [];
  for (const v of list) {
    const r = await removeSpecValue(page, typeIndex + 1, v).catch(() => ({ ok: false }));
    removed.push({ v, ok: r.ok });
  }
  return { removed };
}

/** 插件 ensureSpecValuesRobust 语义：确保某维度值齐全（缺的补、多的删） */
export async function ensureSpecValuesRobust(page, dimNames, dimValues, { maxRetry = 3 } = {}) {
  const res = await ensureSpecTable(page, dimNames, dimValues, { maxRound: maxRetry });
  return { ok: res.ok, matrix: res.matrix, rounds: res.rounds };
}

/** 插件 fillEmptySkuRows 语义：把库存为空的行按数据补齐 */
export async function fillEmptySkuRows(page, P) {
  const r = await fillSkuRowsAndVerify(page, P, { rounds: 2 }).catch((e) => ({ ok: false, err: e.message }));
  return { ok: r.ok, covered: r.covered, okRows: r.ok, expected: r.expected };
}

/** 插件 waitForFormReady 语义：等表单骨架就绪 */
export async function waitForFormReady(page, { timeoutMs = 40000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await page.evaluate(() => {
      const t = (document.body.innerText || "").replace(/\s+/g, " ");
      return {
        onForm: location.href.includes("goods_add"),
        hasCarousel: t.includes("商品轮播图"),
        hasBrand: t.includes("品牌"),
        hasModify: t.includes("修改分类"),
      };
    }).catch(() => null);
    if (last && last.onForm && last.hasCarousel && last.hasModify) return { ok: true, ...last };
    await sleep(1000);
  }
  return { ok: false, last };
}

/** 插件 waitForUploads 语义：等某数量的图片上传完成 */
export async function waitForUploads(page, expect, { capacity = 10, timeoutMs = 120000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await waitForUploadProgress(page, { expectMin: expect, expectTotal: capacity, timeoutMs: 3000 }).catch(() => null);
    if (last && (last.ok || (last.last && last.last.up >= expect))) return { ok: true, ...(last.last || last) };
    await sleep(1000);
  }
  return { ok: false, last };
}

/** 插件 waitForImageInput 语义：等某个图区的 file input 出现 */
export async function waitForImageInput(page, { timeoutMs = 30000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await page.evaluate(() => {
      const vis = (e) => !!(e && e.offsetParent);
      return [...document.querySelectorAll("input[type=file]")].some(vis) || document.querySelectorAll("input[type=file]").length > 0;
    }).catch(() => false);
    if (ok) return { ok: true };
    await sleep(800);
  }
  return { ok: false };
}

/** 插件 pickCategoryExact 语义：精确选类目并确认 */
export async function pickCategoryExact(page, catPath, opts = {}) {
  return searchCategory(page, catPath, { confirm: true, ...opts });
}

/** 插件 probeShop 语义：读当前店铺/登录态 */
export async function probeShop(page) {
  return page.evaluate(() => {
    const norm = (x) => (x || "").replace(/\s+/g, " ").trim();
    const t = norm(document.body.innerText);
    return {
      loggedOut: /\/login/i.test(location.href),
      url: location.href.slice(0, 90),
      title: document.title,
      shopName: (t.match(/([\u4e00-\u9fa5]{2,10})(家居|百货|优品|旗舰|专营|商贸)/) || [])[0] || null,
      bodyLen: t.length,
    };
  }).catch(() => ({ loggedOut: true, url: "", title: "", shopName: null, bodyLen: 0 }));
}

/** 插件 probePagesAlive 语义：报告存活标签 */
export async function probePagesAlive(task) {
  const tabs = await (task ? task.tabs() : []).catch(() => []);
  return { count: tabs.length, tabs: tabs.map((t2) => ({ label: t2.label, url: (t2.url || "").slice(0, 70), title: t2.title })) };
}

/** 插件 cleanupShopTabs 语义：ego 下**只报告不关闭**（用户标签不可擅动） */
export async function cleanupShopTabs(task) {
  const info = await probePagesAlive(task);
  return { closed: [], reported: info, note: "ego 下不自动关闭用户的标签" };
}

/** 插件 closeTarget 语义：关闭指定 page */
export async function closeTarget(page) {
  try {
    await page.close();
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: String(e.message).slice(0, 80) };
  }
}

/** 插件 submitProduct 语义：点「提交并上架」并处理确认弹窗（默认流程不调用） */
export async function submitProduct(page, vf, { timeoutMs = 45000 } = {}) {
  // allPass=false 一律禁止提交（fail / unknown 都不行）
  if (vf && vf.allPass === false) return { success: false, reason: "validation_not_pass" };

  const pos = await page
    .evaluate(() => {
      const norm = (x) => (x || "").replace(/\s+/g, " ").trim();
      const vis = (e) => !!(e && e.offsetParent);
      const btns = [...document.querySelectorAll("button, [role=button]")].filter(
        (b) => vis(b) && /^(提交并上架|提交)$/.test(norm(b.innerText)) && !b.disabled
      );
      if (!btns.length) return null;
      const el = btns[btns.length - 1];
      el.scrollIntoView({ block: "center" });
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), text: norm(el.innerText) };
    })
    .catch(() => null);
  if (!pos) return { success: false, reason: "submit_button_not_found" };

  await page.mouse.click(pos.x, pos.y, { label: "submit listing" });

  // 真正判据：URL 跳到 goods_add/success；中间可能出现「确定/确认」低价提醒弹窗
  const deadline = Date.now() + timeoutMs;
  let confirmed = null;
  let sawSubmitting = false;
  let lastUrl = "";
  while (Date.now() < deadline) {
    await sleep(700);
    const st = await page
      .evaluate(() => {
        const norm = (x) => (x || "").replace(/\s+/g, " ").trim();
        const vis = (e) => !!(e && e.offsetParent);
        const btns = [...document.querySelectorAll("button, [role=button]")].filter(vis);
        const dlgs = btns.filter((b) => /^(确定|确认|确认提交|提交)$/.test(norm(b.innerText)) && !b.disabled);
        let dpos = null;
        if (dlgs.length) {
          const b = dlgs[dlgs.length - 1];
          b.scrollIntoView({ block: "center" });
          const r = b.getBoundingClientRect();
          dpos = { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), txt: norm(b.innerText) };
        }
        const subBtn = btns.find((b) => /提交中/.test(norm(b.innerText)));
        return { url: location.href, dialogPos: dpos, submitting: !!subBtn };
      })
      .catch(() => null);
    if (!st) continue;
    lastUrl = st.url || "";
    if (st.submitting) sawSubmitting = true;
    if (/goods_add\/success|success\?goods_id/.test(lastUrl)) break;
    if (st.dialogPos) {
      confirmed = st.dialogPos.txt;
      await page.mouse.click(st.dialogPos.x, st.dialogPos.y, { label: "confirm submit" });
      await sleep(1500);
    }
  }

  const ok = /goods_add\/success|success\?goods_id/.test(lastUrl);
  const goodsId = (lastUrl.match(/goods_id=(\d+)/) || [])[1] || null;
  return {
    success: ok,
    url: String(lastUrl).slice(0, 160),
    confirmed,
    sawSubmitting,
    goodsId,
    reason: ok ? null : "no_success_url_after_" + timeoutMs + "ms",
  };
}

/** 插件 verifyListed 语义：到商品列表查该商品状态 */
export async function verifyListed(page, goodsId) {
  const deadline = Date.now() + 60000;
  let last = null;
  while (Date.now() < deadline) {
    await gotoUrl(page, "https://mms.pinduoduo.com/goods/goods_list");
    await page.waitForLoadState().catch(() => {});
    await sleep(3000);
    last = await page.evaluate((gid) => {
      const t = (document.body.innerText || "").replace(/\s+/g, " ");
      const has = t.includes(String(gid));
      const statuses = ["销售中", "审核中", "已下架", "待审核", "在售", "仓库中"].filter((x) => t.includes(x));
      return { found: has, statuses, url: location.href.slice(0, 90) };
    }, goodsId).catch(() => null);
    if (last && last.found) return { status: last.statuses[0] || "found", ...last };
    await sleep(2000);
  }
  return { status: last ? "not_on_sale" : "unknown", ...(last || {}) };
}

/** 插件 listProductSafe 语义：在商品列表按标题搜索 */
export async function listProductSafe(page, title) {
  await gotoUrl(page, LIST_URL);
  await page.waitForLoadState().catch(() => {});
  await sleep(3000);
  const box = await page.evaluate(() => {
    const el = [...document.querySelectorAll("input")].find((i) => i.offsetParent && /商品名称|商品标题/.test(i.placeholder || ""));
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  }).catch(() => null);
  if (!box) return { ok: false, reason: "search_not_found" };
  await page.mouse.click(box.x, box.y, { label: "goods search" });
  await sleep(200);
  await page.keyboard.press("Control+a").catch(() => {});
  await page.keyboard.press("Backspace").catch(() => {});
  await page.keyboard.insertText(String(title));
  await page.keyboard.press("Enter");
  await sleep(3500);
  const found = await page.evaluate((t2) => (document.body.innerText || "").includes(t2), String(title)).catch(() => false);
  return { ok: true, found };
}

/** 插件 enforceCriticalOnForm 语义：表单上把主图/详情/预览图补齐到期望数量 */
export async function enforceCriticalOnForm(page, P, { mainFiles = [], colorToFile = {}, previewByCode = {} } = {}) {
  const out = {};
  if (mainFiles.length) out.main = await uploadZoneFast(page, "商品轮播图", 10, mainFiles, { timeoutMs: 180000 }).catch((e) => ({ ok: false, err: e.message }));
  out.previews = await uploadMissingPreviews(page, P, { colorToFile, previewByCode }).catch((e) => ({ ok: false, err: e.message }));
  out.previewsAfter = await countPreviewCells(page, P).catch(() => null);
  return out;
}

/** 插件 fillProductForm 语义（旧的一体化入口）：按 ③→⑩ 填完整表单（不含类目/主图上传） */
export async function fillProductForm(page, P, opts = {}) {
  const {
    D = {},
    task = null,
    shotsDir = null,
    shots = false,
    capacity = 10,
    timeoutMs = 240000,
    freightTemplate = "",
    skipDuplicate = false,
    log = () => {},
  } = opts;

  const out = { ok: false, phase: "start", steps: {}, order: [] };
  const t0 = Date.now();
  const mark = (k, v) => {
    out.steps[k] = v;
    out.order.push(k);
    log(k, v);
  };
  const snap = async (name) => {
    if (!shots || !shotsDir) return null;
    const r = await shotPage(page, shotsDir, name).catch(() => null);
    return r && r.ok ? r.path : null;
  };
  const fail = (phase, msg) => {
    out.phase = phase;
    out.error = String(msg || "").slice(0, 240);
    out.ms = Date.now() - t0;
    throw new Error(String(msg || phase));
  };

  try {
    // ⓪ 数据预检（不动浏览器先拦坏数据）
    const pl = await validateListingPayload(P, D).catch((e) => ({ ok: false, blocking: ["precheck_error:" + String(e.message).slice(0, 80)], warnings: [] }));
    mark("precheck", { ok: pl.ok, blocking: pl.blocking, warnings: pl.warnings });
    if (!pl.ok) fail("precheck", "payload_precheck_failed:" + (pl.blocking || []).join(","));

    // ⓪ 查重（默认关；正式入口由 runner 单独把关）
    if (skipDuplicate === false && opts.dupCheck === true) {
      const dup = await checkDuplicate(page, P.title, P.skus || []).catch(() => "search_failed");
      mark("duplicate", dup);
      if (dup !== "not_found") fail("duplicate", "duplicate_check_failed:" + dup);
    }

    // ① 打开发布页
    let url = await page.url();
    if (task) {
      const opened = await openPublishPage(task, page);
      page = opened.page;
      mark("open_publish", { how: opened.how, url: (await page.url()).slice(0, 120) });
    } else {
      await gotoUrl(page, "https://mms.pinduoduo.com/goods/category");
      await sleep(3500);
      mark("open_publish", { how: "goto_category", url: (await page.url()).slice(0, 120) });
    }
    await dismissOverlays(page);
    url = await page.url();

    // ② 类目页分流（旧版 / 新版 / 已在表单）
    const kind = await detectCategoryPage(page);
    mark("category_page", { kind: kind.kind, url: ((kind.evidence || {}).url || url).slice(0, 120) });
    await snap("① 类目页");

    const onForm = url.includes("goods_add");
    if (!onForm) {
      if (kind.kind === "old") {
        const sc = await searchCategory(page, P.category, { confirm: true });
        mark("search_category", { ok: sc.ok, reason: sc.reason, chosen: sc.chosen });
        if (!sc.ok) fail("category", "category_failed_old:" + sc.reason);
        await sleep(2500);
        const hasNext = await page.evaluate(() => [...document.querySelectorAll("button")].some((b) => b.offsetParent && /下一步/.test(b.innerText || "")));
        if (hasNext) {
          await clickText(page, "下一步", { exact: false, timeoutMs: 15000 }).catch(() => {});
          await sleep(6000);
        }
        const mu = await uploadMainImages(page, D.main_images || [], { capacity });
        mark("main_images", mu);
        if (!mu.ok) fail("main_images", "main_upload_failed");
        mark("title", await fillTitle(page, P.title));
      } else {
        // 新版：先主图 + 标题，才会出现「手动选择商品分类」入口
        const mu = await uploadMainImages(page, (D.main_images || []).slice(0, capacity), { capacity });
        mark("main_images", mu);
        if (!mu.ok) fail("main_images", "main_upload_failed");
        mark("title", await fillTitle(page, P.title));
        mark("picker", await openManualCategoryPicker(page));
        const sc = await searchCategory(page, P.category, { confirm: true });
        mark("search_category", { ok: sc.ok, reason: sc.reason, chosen: sc.chosen });
        if (!sc.ok) fail("category", "category_failed:" + sc.reason);
        const nx = await goNextToForm(page);
        mark("next_to_form", { ok: nx.ok, category: nx.category });
        if (!nx.ok) fail("category", "not_on_form");
        const catNow = nx.category || nx.categoryRaw || "";
        if (!pathSuffixMatch(catNow, P.category)) fail("category", "category_mismatch_on_form:" + catNow);
      }
      if (!(await page.url()).includes("goods_add")) fail("category", "not_on_form_after_category");
    } else {
      mark("on_form", true);
    }
    await snap("② 表单");
    out.url = (await page.url()).slice(0, 140);
    out.goodsId = (out.url.match(/goods_id=(\d+)/) || [])[1] || null;

    // ③ 详情图 + ④a 包装标签图清零
    const dz = await uploadZoneFast(page, "商品详情", 50, D.detail_images || [], { timeoutMs: timeoutMs, waitMs: Math.round(timeoutMs * 0.6) });
    mark("detail_images", dz);
    const mi = await mainImagesState(page).catch(() => null);
    let plz = await packagingLabelState(page).catch(() => null);
    if (plz && plz.uploaded > 0) {
      const cl = await clearZone(page, "包装标签图", plz.total || 10);
      plz = cl.state || (await packagingLabelState(page).catch(() => null));
    }
    mark("main_packaging", { main: mi, packaging: plz });

    // ④b 商品视频（有就给）
    const videoFile = opts.video || null;
    if (videoFile) {
      const vr = await uploadVideo(page, "商品视频", videoFile, { timeoutMs: timeoutMs });
      mark("product_video", { ok: vr.ok, already: vr.already, how: vr.how, reason: vr.reason, state: vr.state });
    }

    // ④c 白底图（有就给）
    const whiteBg = opts.whiteBg || null;
    if (whiteBg) {
      const wr = await uploadWhiteBg(page, whiteBg, { timeoutMs: Math.round(timeoutMs * 0.75) });
      mark("white_bg_image", { ok: wr.ok, already: wr.already, reason: wr.reason, state: wr.state });
    }
    await snap("④ 图片完成");

    // ⑤ 品牌 + 属性
    mark("brand", await fillBrand(page, P.brand || "祺讯"));
    const DIRECT = new Set(["厚度", "平方克重", "重量"]);
    const drop = {};
    const direct = {};
    for (const [k, arr] of Object.entries(P.attributes || {})) (DIRECT.has(k) ? direct : drop)[k] = arr;
    const ar = await applyAttributesByCandidates(page, drop);
    mark("attributes", { ok: ar.ok, needReview: (ar.needReview || []).map((x) => x.label) });
    mark("direct_attrs", await fillDirectAttrs(page, Object.entries(direct).map(([label, arr]) => ({ label, value: String((arr && arr[0]) || "") }))));
    mark("required_probe", await probeRequiredAttributes(page).catch(() => ({ requiredCount: 0, missing: [] })));

    // ⑤c 运费模板（可选）
    if (freightTemplate) {
      const ft = await setFreightTemplate(page, freightTemplate);
      mark("freight_template", { want: freightTemplate, ok: ft.ok, got: ft.got, options: ft.options });
      if (!ft.ok) fail("freight_template", "freight_template_failed:" + String(ft.got || "unknown"));
    }
    await snap("⑤ 属性");

    // ⑥ 规格表
    const DIMS = P.dimensions || [];
    const V0 = [...new Set((P.skus || []).map((x) => String(x[DIMS[0]] ?? "")))];
    const V1 = [...new Set((P.skus || []).map((x) => String(x[DIMS[1]] ?? "")))];
    const spec = await ensureSpecTable(page, DIMS, [V0, V1]);
    mark("spec_table", { ok: spec.ok, matrix: spec.matrix, rounds: spec.rounds });
    if (!spec.ok) fail("spec_table", "spec_table_failed");

    // ⑦ SKU 填值（CDP 一次优先，失败退 Node 逐行）
    const t7 = Date.now();
    let fr;
    try {
      const cdp = await fillSkuRowsCDP(page, P, { timeoutMs: Math.max(60000, Math.round(timeoutMs * 0.75)) });
      if (cdp && cdp.ok) fr = { ...cdp, method: "cdp_one_shot" };
    } catch (e) {
      fr = null;
    }
    if (!fr) {
      fr = await fillSkuRowsAndVerify(page, P);
      fr.method = "node_stepping";
    }
    fr.wallMs = Date.now() - t7;
    mark("sku_rows", fr);
    await snap("⑦ SKU");

    // ⑧ 预览图
    const colorToFile = {};
    for (const sk of P.skus || []) {
      if (sk[DIMS[0]] && !colorToFile[sk[DIMS[0]]]) colorToFile[sk[DIMS[0]]] = String(sk.preview || "").replace(/\\/g, "/");
    }
    mark("previews", await uploadMissingPreviews(page, P, { colorToFile }));
    mark("previews_verify", await countPreviewCells(page, P).then((c) => ({ total: c.total, withImg: c.withImg, missing: (c.missing || []).length })));

    // ⑨ 参考价
    mark("ref_price", await setRefPrice(page, P.ref_price));

    // ⑨b 详情区复核 / 补传 / 删残留
    let z = await readDetailZone(page);
    const wantDetails = (D.detail_images || []).length;
    if ((z.counter || 0) < wantDetails) {
      await uploadZoneFast(page, "商品详情", 50, D.detail_images || [], { timeoutMs: timeoutMs, waitMs: Math.round(timeoutMs * 0.6) });
      z = await readDetailZone(page);
    }
    if (z.containers > wantDetails) {
      await cleanExtraDetails(page, wantDetails).catch(() => null);
      z = await readDetailZone(page);
    }
    mark("detail_recheck", { counter: z.counter, containers: z.containers, want: wantDetails });
    await snap("⑨ 参考价");

    // ⑩ 终校验
    const vf = await validateForm(page, {
      ...P,
      main_images: D.main_images || [],
      detail_images: D.detail_images || [],
      _assets: { whiteBgExpected: !!whiteBg, videoExpected: !!videoFile },
    });
    mark("validate", { allPass: vf.allPass, anyFail: vf.anyFail, checks: (vf.checks || []).map((c) => c.name + ":" + c.status) });
    await snap("⑩ 终校验");

    out.ok = !!vf.allPass;
    out.phase = "done";
    out.ms = Date.now() - t0;
    out.url = (await page.url()).slice(0, 140);
    return out;
  } catch (e) {
    out.ok = false;
    out.ms = Date.now() - t0;
    out.error = String(e.message || e).slice(0, 240);
    throw Object.assign(new Error(out.error), { fillProductForm: out });
  }
}

// ── 以下纯函数**原样取自插件** pdd_flow.js（无 Playwright 依赖，行为逐字一致）──
export function normalizeTitle(t) {
  return String(t || '').replace(/\s+/g, '').toLowerCase();
}

export function codeSet(skus) {
  return [...new Set((skus || []).map((s) => String(s.code || '').trim()).filter(Boolean))].sort();
}

export function fingerprint(title, skus) {
  return JSON.stringify({ t: normalizeTitle(title), c: codeSet(skus) });
}

export function makeRowFilter(dimValues) {
  const parts = (dimValues || []).filter(Boolean).map((v) =>
    String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  );
  if (!parts.length) return (text) => /请输入/.test(text) || /规格/.test(text);
  const re = new RegExp(parts.join('|'));
  return (text) => re.test(text);
}

export function makeMapRow(dimNames, skuByKey) {
  return (text, inputs) => {
    // locate which excel sku this row belongs to by longest matching dim combo
    let best = null;
    let bestScore = -1;
    for (const [key, sku] of Object.entries(skuByKey)) {
      const parts = key.split('|');
      let score = 0;
      for (const p of parts) {
        if (p && text.includes(p)) score += p.length;
        else { score = -1; break; }
      }
      if (score > bestScore) { bestScore = score; best = { key, sku }; }
    }
    if (!best || bestScore < 0) return null;
    return {
      key: best.key,
      sku: best.sku,
      text,
      stock: inputs[0] ?? '',
      group: inputs[1] ?? '',
      single: inputs[2] ?? '',
      code: inputs.length >= 4 ? inputs[inputs.length - 1] : inputs[3] ?? '',
      inputs,
    };
  };
}

export function buildSkuByKey(skus, dimNames) {
  const map = {};
  for (const sku of skus) {
    const parts = (dimNames || []).map((d) => String(sku[d] ?? '').trim());
    map[parts.join('|')] = sku;
  }
  return map;
}

export function applyCodeTemplate(skus, template, { dims = [] } = {}) {
  if (!template) return skus || [];
  for (const s of skus || []) {
    let code = String(template);
    code = code.replace(/\{(\w+)\}/g, (_, k) => {
      if (k in s && s[k] != null) return String(s[k]);
      if (k === 'length' && s['长度']) return String(s['长度']);
      if (k === 'color' && s['颜色']) return String(s['颜色']);
      if (k === 'size' && s['尺寸']) return String(s['尺寸']);
      if (k === 'tier' && s['等级']) return String(s['等级']);
      if (k === 'd0' && dims[0]) return String(s[dims[0]] ?? '');
      if (k === 'd1' && dims[1]) return String(s[dims[1]] ?? '');
      return '';
    });
    s.code = code;
  }
  return skus;
}

export function evalCodesExact(skus, pageCodes, excelCount, { allowDuplicateCodes = false } = {}) {
  const excelCodes = codeSet(skus);
  const excelCodeList = (skus || [])
    .map((s) => String(s.code || '').trim())
    .filter(Boolean);
  const sharedExcel = new Set(excelCodeList).size !== excelCodeList.length;
  const allowDup = allowDuplicateCodes || sharedExcel;
  const pageSet = new Set(pageCodes);
  const missing = excelCodes.filter((c) => !pageSet.has(c)).length;
  const extra = [...new Set(pageCodes.filter((c) => !excelCodes.includes(c)))].length;
  const dup = pageCodes.filter((c, i) => pageCodes.indexOf(c) !== i).length;
  const dupSet = new Set(pageCodes.filter((c, i) => pageCodes.indexOf(c) !== i));
  const pass =
    missing === 0 &&
    extra === 0 &&
    (allowDup || dup === 0) &&
    pageCodes.length === excelCount;
  return {
    pass,
    missing,
    extra,
    dup: dupSet.size,
    sharedExcel,
    detail: `missing=${missing},extra=${extra},dup=${dupSet.size},shared_excel=${sharedExcel},rows=${pageCodes.length}/${excelCount}`,
  };
}

export function evalCodePerRow(rows, skuByKey) {
  const mismatches = [];
  let checked = 0;
  for (const row of rows || []) {
    const key = row && row.key;
    if (!key) continue;
    const sku = skuByKey[key];
    if (!sku) continue;
    const got = String(row.code ?? '').trim();
    const want = String(sku.code ?? '').trim();
    if (!got) continue;                  // emptiness是 codes_nonempty 的职责
    checked++;
    if (got !== want) mismatches.push({ key, got, want });
  }
  return { pass: mismatches.length === 0 && checked > 0, mismatches, checked };
}

export function dimToken(v) {
  const s = String(v == null ? '' : v);
  const i = s.search(/[*（(【\[]/);
  return i > 0 ? s.slice(0, i) : s;
}

// ───────── 运费模板（与属性下拉同一套逻辑）─────────
// freight-tpl-fns.mjs —— 运费模板：与属性下拉框同一套逻辑（点开 → 文本匹配 → click → 回读）

const LABEL = "运费模板";

const LOCAL = String.raw`
const norm = (s) => String(s || "").split(/\s+/).join(" ").trim();
const vis = (e) => !!(e && e.offsetParent);
const rectOf = (e) => { const r = e.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
const tplLabel = () => [...document.querySelectorAll("label, span, div, a")].find((e) => vis(e) && !e.children.length && norm(e.textContent).replace(/^[*\s]+/, "") === ${JSON.stringify(LABEL)}) || null;
const tplRow = () => {
  const lb = tplLabel();
  if (!lb) return null;
  let n = lb;
  for (let i = 0; i < 8 && n; i++) {
    n = n.parentElement;
    if (!n) break;
    if (n.querySelector('[class*="ST_selectValueSingle"], [class*="selectValue"], select')) return n;
    if (i >= 4) return n;
  }
  return lb.parentElement;
};
const selEl = () => {
  const row = tplRow();
  if (!row) return null;
  return [...row.querySelectorAll('[class*="ST_selectValueSingle"], [class*="selectValue"], select')].filter(vis)[0] || null;
};
const selCenter = () => {
  const s = selEl();
  if (!s) return null;
  s.scrollIntoView({ block: "center" });
  const r = s.getBoundingClientRect();
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), left: Math.round(r.left), bottom: Math.round(r.bottom) };
};
const otherLabel = () => {
  const row = tplRow();
  if (!row) return null;
  return [...row.querySelectorAll("label")].filter(vis).find((e) => norm(e.textContent) === "其他模板") || null;
};
const rowDefaultName = () => {
  const row = tplRow();
  if (!row) return null;
  const t = norm(row.innerText);
  const i = t.indexOf(${JSON.stringify(LABEL)}.replace(/\s+/g, " "));
  if (i < 0) return null;
  const tail = t.slice(i + 4);
  const j = tail.indexOf("推荐");
  return j > 0 ? norm(tail.slice(0, j)) : null;
};
// 只取「贴着运费模板选择框」的那一列下拉项（避免混入品牌等其它下拉）
const panelItems = () => {
  const s = selEl();
  if (!s) return [];
  const b = s.getBoundingClientRect();
  const out = [];
  [...document.querySelectorAll('[class*="cIL_item"], li, [class*="option"], [class*="Option"]')].filter(vis).forEach((e) => {
    const r = e.getBoundingClientRect();
    if (r.top < b.bottom - 34 || r.top > b.bottom + 520) return;
    if (Math.abs(r.left - b.left) > 240) return;
    const t = norm(e.textContent);
    // 排除从其它下拉混进来的单字项（如「无」）
    if (t && t !== "无" && t.length < 60 && !out.includes(t)) out.push(t);
  });
  return out;
};
const panelSpot = () => {
  const s = selEl();
  if (!s) return null;
  const b = s.getBoundingClientRect();
  return { x: Math.round(b.left + 60), y: Math.round(b.bottom + 70) };
};
const scrollPanel = (dy) => {
  const items = [...document.querySelectorAll('[class*="cIL_item"]')].filter(vis);
  let sc = null;
  if (items.length) { let n = items[0]; for (let i = 0; i < 10 && n; i++) { if (n.scrollHeight > n.clientHeight + 8) { sc = n; break; } n = n.parentElement; } }
  if (!sc) return false;
  sc.scrollTop = Math.max(0, sc.scrollTop + dy);
  return true;
};
`;

const S = (body) => `(function(){${LOCAL}\n${body}\n})()`;

export async function ensureFreightOtherMode(page, { attempts = 2 } = {}) {
  for (let i = 1; i <= attempts; i++) {
    const st = await page.evaluate(S(`const s = selEl(); return { hasSel: !!s, other: !!otherLabel(), row: tplRow() ? norm(tplRow().innerText).slice(0, 160) : null };`)).catch(() => ({}));
    if (st.hasSel) return { ok: true, mode: "other", attempt: i };
    if (!st.other) {
      const ex = await page
        .evaluate(`(function(){ const b = [...document.querySelectorAll('span,div,a,button')].filter((e) => e.offsetParent && !e.children.length).find((e) => (e.textContent || '').replace(/\\s+/g, ' ').trim() === '展开修改'); if (!b) return null; b.scrollIntoView({ block: 'center' }); const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`)
        .catch(() => null);
      if (ex) { await page.mouse.click(ex.x, ex.y, { label: "expand more service" }); await sleep(1300); continue; }
      return { ok: false, reason: "no_other_label", row: st.row };
    }
    await page.evaluate(S(`const el = otherLabel(); if (el) el.click(); return !!el;`)).catch(() => false);
    await sleep(1200);
  }
  const st = await page.evaluate(S(`return { hasSel: !!selEl() };`)).catch(() => ({}));
  return { ok: !!st.hasSel, mode: st.hasSel ? "other" : "default", attempts };
}

export async function readFreightTemplate(page) {
  return page
    .evaluate(S(`
const s = selEl();
if (s) { const inp = s.querySelector("input"); return { ok: true, mode: "other", value: norm(s.innerText) || (inp ? inp.value : "") }; }
const d = rowDefaultName();
return { ok: !!d, mode: "default", value: d || "" };
`))
    .catch((e) => ({ ok: false, reason: "eval_error:" + String(e.message).slice(0, 60) }));
}

export async function listFreightTemplates(page, { timeoutMs = 15000 } = {}) {
  const mode = await ensureFreightOtherMode(page);
  if (!mode.ok) return { ok: false, reason: mode.reason || "no_select" };

  const pos = await page.evaluate(S(`return selCenter();`)).catch(() => null);
  if (!pos) return { ok: false, reason: "no_select_pos" };

  // 连续调用时偶发「点了但下拉没弹」，最多再点一次
  let opened = false;
  for (let k = 0; k < 2 && !opened; k++) {
    await dismissOverlays(page).catch(() => {});
    const p2 = (await page.evaluate(S(`return selCenter();`)).catch(() => null)) || pos;
    await page.mouse.click(p2.x, p2.y, { label: "open freight template" });
    await sleep(950);
    const n = await page.evaluate(S(`return panelItems().length;`)).catch(() => 0);
    opened = n > 0;
  }

  const all = [];
    for (let round = 0; round < 8; round++) {
    const items = await page.evaluate(S(`return panelItems();`)).catch(() => []);
    for (const it of items) if (!all.includes(it)) all.push(it);
    const before = all.length;
    await page.evaluate(S(`return scrollPanel(140);`)).catch(() => false);
    await sleep(420);
    if (all.length === before && round > 3) break;
  }
  await page.keyboard.press("Escape").catch(() => {});
  return { ok: all.length > 0, options: all, count: all.length, mode: "other" };
}

export async function setFreightTemplate(page, name, { attempts = 3, settleMs = 900 } = {}) {
  const want = String(name || "").replace(/\s+/g, " ").trim();
  const wantNorm = want.replace(/\s+/g, "");
  if (!want) return { ok: false, reason: "empty_name" };

  const before = await readFreightTemplate(page).catch(() => ({ ok: false }));
  if (before.ok && before.value.replace(/\s+/g, "") === wantNorm) {
    return { ok: true, already: true, got: before.value, mode: before.mode };
  }

  let lastOptions = [];
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const mode = await ensureFreightOtherMode(page);
    if (!mode.ok) return { ok: false, reason: mode.reason || "cannot_switch_mode", got: before.value, mode: mode.mode };

    const pos = await page.evaluate(S(`return selCenter();`)).catch(() => null);
    if (!pos) return { ok: false, reason: "no_select_pos", got: null };

    let opened = false;
    for (let k = 0; k < 2 && !opened; k++) {
      await dismissOverlays(page).catch(() => {});
      const p2 = (await page.evaluate(S(`return selCenter();`)).catch(() => null)) || pos;
      await page.mouse.click(p2.x, p2.y, { label: "open freight template" });
      await sleep(settleMs);
      const n = await page.evaluate(S(`return panelItems().length;`)).catch(() => 0);
      opened = n > 0;
    }

    // 打开下拉后，把虚拟列表逐屏滚一遍，直到目标出现在 DOM 中
    lastOptions = [];
    for (let round = 0; round < 10; round++) {
      const items = await page.evaluate(S(`return panelItems();`)).catch(() => []);
      for (const it of items) if (!lastOptions.includes(it)) lastOptions.push(it);
      if ((lastOptions || []).some((o) => o.replace(/\s+/g, "") === wantNorm)) break;
      const moved = await page.evaluate(S(`return scrollPanel(130);`)).catch(() => false);
      if (!moved) {
        await sleep(420);
        continue;
      }
      await sleep(420);
    }

    // 与属性下拉完全相同的取项方式：整页文本完全匹配 → 取最后一个元素 click
    const clicked = await page
      .evaluate(`(function(){ const norm = (s) => (s || "").replace(/\\s+/g, " ").trim(); const els = [...document.querySelectorAll("*")].filter((el) => el.offsetParent && norm(el.textContent) === norm(${JSON.stringify(want)}) && !/立即体验|换背景/.test(norm(el.textContent))); if (!els.length) return { ok: false }; els[els.length - 1].click(); return { ok: true }; })()`)
      .catch(() => ({ ok: false }));

    if (clicked.ok) {
      await sleep(1300);
      const after = await readFreightTemplate(page).catch(() => ({ ok: false }));
      const got = after.ok ? after.value : null;
      if (!!got && got.replace(/\s+/g, "").includes(wantNorm)) {
        return { ok: true, got, options: lastOptions, mode: after.mode, attempt, how: "direct" };
      }
    }
    await page.keyboard.press("Escape").catch(() => {});
    await sleep(700);
  }

  const final = await readFreightTemplate(page).catch(() => ({ ok: false }));
  const got = final.ok ? final.value : null;
  return { ok: !!(got && got.replace(/\s+/g, "").includes(wantNorm)), got, options: lastOptions, mode: final.mode, how: "failed" };
}

// ───────── 截图（原版 PDD_SHOT：每步留证）─────────
export async function shotPage(page, dir, name, opts = {}) {
  const { fullPage = false } = opts;
  if (!page || typeof page.screenshot !== "function") return { ok: false, reason: "no_page" };
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15);
  const safe = String(name || "shot").replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 60);
  const outDir = String(dir || "D:/egoscripts/shots");
  const file = `${outDir}/${stamp}_${safe}.png`;
  try {
    await page.screenshot({ path: file, fullPage });
    return { ok: true, path: file };
  } catch (e) {
    return { ok: false, reason: String(e.message || e).slice(0, 120), path: file };
  }
}
