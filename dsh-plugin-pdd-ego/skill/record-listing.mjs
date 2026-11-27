// 上架后落账：node record-listing.mjs --shop <店铺> --goods-id <新商品ID> --goods-name "<商品名>" [--status 审核中] [--evidence <报告>] [--root <店铺运营日志>] [--dry-run]
import { resolveLedgerRoot, readState, recordResult } from "./product-ledger.mjs";

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith("--")) {
    const k = a.slice(2);
    const v = process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[++i] : true;
    args[k] = v;
  }
}
if (args.help || !args.shop || !args["goods-id"]) {
  console.log('用法: node record-listing.mjs --shop <店铺> --goods-id <新商品ID> --goods-name "<商品名>" [--status 审核中|在售] [--evidence <报告>] [--root <店铺运营日志>] [--dry-run]');
  process.exit(args.help ? 0 : 2);
}
const root = String(args.root || process.env.PDD_LEDGER_ROOT || resolveLedgerRoot({})).replace(/\\/g, "/");
const shop = String(args.shop);
const goodsId = String(args["goods-id"]);
const goodsName = String(args["goods-name"] || "");
const status = String(args.status || "审核中");
if (!["审核中", "在售"].includes(status)) { console.error("status 只能是 审核中 或 在售"); process.exit(2); }
const state = await readState(root, shop, goodsId);
const isRelist = state.lifecycleStatus === "已下架";
const action = isRelist ? "relist" : "listing-new";
const before = isRelist ? "已下架" : "未上架";
const runId = String(args["run-id"] || ("listing-" + new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)));
const result = {
  ok: true, root, shop, goodsId, goodsName, action, before, status,
  dryRun: args["dry-run"] === true,
};
if (args["dry-run"] === true) {
  console.log(JSON.stringify(result, null, 1));
  process.exit(0);
}
const rec = await recordResult({
  root, skill: "pdd-ego-listing", shop, goodsId, goodsName,
  action, targetId: goodsId, target: isRelist ? "重新上架" : "新链接上架",
  before, after: { lifecycleStatus: status, verified: true },
  result: "success", runId, evidence: String(args.evidence || ""),
});
console.log(JSON.stringify({ ...result, recordId: rec.event.eventId, state: rec.state }, null, 1));
