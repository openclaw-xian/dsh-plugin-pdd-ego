// cli-ego.mjs —— ego 侧命令入口（供 DSH 插件/命令行调用）
//   PDD_CMD=spaces | freight | current | run | probe
//   PDD_SPACE=3                    店铺 space id
//   PDD_TARGET=内地包邮默认模板       freight 时可选：顺手选中并回读
//   PDD_SHOT_DIR=...               截图目录（可选）
// 用法：ego-browser nodejs -e "await import('file:///<你的 ego-scripts 目录>/cli-ego.mjs')"
import { readFile, writeFile } from "node:fs/promises";
import * as flow from "./pdd_flow_ego.mjs";

// ego-browser 启动时不会继承调用方通过 execFile 传入的自定义环境变量，
// 所以支持把配置内联进 -e 脚本：globalThis.__PDD_CFG = {cmd, space, target}
const INLINE = (typeof globalThis !== "undefined" && globalThis.__PDD_CFG) || {};
const CMD = String(INLINE.cmd || process.env.PDD_CMD || "spaces").trim();
const SPACE = Number(INLINE.space || process.env.PDD_SPACE || 0);
const TARGET = String(INLINE.target || process.env.PDD_TARGET || "").trim();
const OUT = { cmd: CMD, space: SPACE || null, target: TARGET || null, ok: false };

try {
  if (CMD === "spaces") {
    const spaces = await listTaskSpaces().catch(() => null);
    OUT.spaces = spaces;
    OUT.ok = !!spaces;
  } else if (CMD === "freight") {
    if (!SPACE) throw new Error("PDD_SPACE required");
    const { page } = await flow.connectShop(SPACE);
    OUT.url = (await page.url()).slice(0, 120);
    OUT.current = await flow.readFreightTemplate(page);
    if (TARGET) {
      OUT.set = await flow.setFreightTemplate(page, TARGET);
      OUT.after = await flow.readFreightTemplate(page);
    } else {
      OUT.templates = await flow.listFreightTemplates(page);
    }
    OUT.ok = !!((OUT.current && OUT.current.ok) || (OUT.templates && OUT.templates.ok));
  } else if (CMD === "current") {
    if (!SPACE) throw new Error("PDD_SPACE required");
    const { page } = await flow.connectShop(SPACE);
    OUT.url = (await page.url()).slice(0, 140);
    OUT.current = await flow.readFreightTemplate(page);
    OUT.ok = !!(OUT.current && OUT.current.ok);
  } else if (CMD === "run") {
    await import("./run_listing_ego.mjs");
    OUT.ok = true;
  } else if (CMD === "probe") {
    if (!SPACE) throw new Error("PDD_SPACE required");
    const { page } = await flow.connectShop(SPACE);
    OUT.url = (await page.url()).slice(0, 140);
    OUT.state = await page.evaluate(() => {
      const t = (document.body.innerText || "").split(/\s+/).join(" ");
      // 只读采集：页面「错误（N）」提示通常不带明细，这里把可见的出错文案与附近文本带出来
      const errorTexts = [];
      for (const el of document.querySelectorAll('[class*="error" i]')) {
        if (!el.offsetParent) continue;
        const txt = (el.innerText || "").replace(/\s+/g, " ").trim();
        if (txt && txt.length < 160 && !errorTexts.includes(txt)) errorTexts.push(txt);
      }
      const near = t.match(/错误（\d+）[\s\S]{0,300}/);
      return {
        url: location.href,
        len: t.length,
        hasFreight: t.includes("运费模板"),
        hasImages: t.includes("商品轮播图"),
        // 类目页形态标记：搜索框 / 「最近使用」捷径 / 推荐卡 / 手动入口 / 下一步
        markers: {
          searchBox: !!document.querySelector('input[placeholder*="关键词搜索分类"]'),
          chooseCategory: document.querySelectorAll('.choose-category').length,
          recommendCards: document.querySelectorAll('[class*="cateItemCard"], [class*="chooseCategory"]').length,
          manualEntry: [...document.querySelectorAll("*")].some((e) => e.offsetParent && /手动选择商品分类|手动选择分类/.test((e.innerText || "").trim())),
          moreRecommend: [...document.querySelectorAll("*")].some((e) => e.offsetParent && /查看更多推荐/.test((e.innerText || "").trim())),
          nextButton: [...document.querySelectorAll("button")].some((b) => b.offsetParent && /下一步/.test(b.innerText || "")),
          fileInputs: document.querySelectorAll("input[type=file]").length,
        },
        textSample: t.slice(0, 400),
        errorTexts: errorTexts.slice(0, 15),
        nearErrors: near ? near[0].slice(0, 300) : null,
      };
    });
    OUT.ok = true;
  } else {
    throw new Error("unknown_cmd:" + CMD);
  }
} catch (e) {
  OUT.error = String(e && e.message ? e.message : e).slice(0, 240);
}

if (process.env.PDD_OUT) {
  await writeFile(String(process.env.PDD_OUT), JSON.stringify(OUT, null, 1), "utf8").catch(() => {});
}
console.log(JSON.stringify(OUT, null, 1));
