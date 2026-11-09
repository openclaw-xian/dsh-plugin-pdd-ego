#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
xlsx_to_product.py —— 素材包一键生成 product.json（read_excel + build_product 的胶水）

用法：
  python xlsx_to_product.py --assets "D:/assets/竹节加厚-店1-链1" \
                            --out    "<包目录>/work" \
                            [--attrs-from "<参考 product.json>"] \
                            [--title "..."] [--brand 祺讯] [--ref 128]

逻辑：
  1) 用 read_excel.py 解析 商品信息.xlsx → 结构化数据
  2) 组装 listing.json（rows 直通模式，逐行给 stock/价格/编码/预览图绝对路径）
  3) 调 build_product.py --listing --assets --out 生成 work/product.json
"""
import argparse
import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
PY = sys.executable
READ_EXCEL = os.path.join(HERE, 'read_excel.py')
BUILD = os.path.join(HERE, 'build_product.py')


def run_json(script, args):
    p = subprocess.run([PY, '-X', 'utf8', script] + args, capture_output=True, text=True, encoding='utf-8')
    out = (p.stdout or '') + '\n' + (p.stderr or '')
    i = out.find('{')
    if i < 0:
        raise SystemExit('cannot parse json from %s\n%s' % (script, out[:500]))
    try:
        return json.loads(out[i:out.rfind('}') + 1])
    except Exception:
        raise SystemExit('bad json from %s\n%s' % (script, out[:500]))


def find_dir(root, *needles):
    """在 root 下按关键字找目录（支持 拼多多/<包名>/ 两层结构）"""
    for dirpath, dirnames, _ in os.walk(root):
        for d in dirnames:
            for n in needles:
                if n in d:
                    return os.path.join(dirpath, d)
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--assets', required=True, help='素材包根目录（含 商品信息.xlsx）')
    ap.add_argument('--out', required=True, help='输出目录（work）')
    ap.add_argument('--attrs-from', default='', help='从参考 product.json 继承 attributes')
    ap.add_argument('--title', default='')
    ap.add_argument('--brand', default='')
    ap.add_argument('--ref', type=float, default=0)
    ap.add_argument('--dry', action='store_true', help='只生成 listing.json 不 build')
    a = ap.parse_args()

    xlsx = None
    for dirpath, _, files in os.walk(a.assets):
        for f in files:
            if f.endswith('.xlsx') and '商品信息' in f:
                xlsx = os.path.join(dirpath, f)
                break
        if xlsx:
            break
    if not xlsx:
        raise SystemExit('找不到 商品信息.xlsx in %s' % a.assets)

    d = run_json(READ_EXCEL, [xlsx])
    if not d.get('ok'):
        raise SystemExit('read_excel failed: %s' % json.dumps(d.get('warnings'), ensure_ascii=False))

    prod = d.get('product') or {}
    dims = d.get('dimensions') or []
    skus = d.get('skus') or []
    v0 = []
    v1 = []
    for s in skus:
        k0 = str(s.get(dims[0], ''))
        k1 = str(s.get(dims[1], ''))
        if k0 not in v0:
            v0.append(k0)
        if k1 not in v1:
            v1.append(k1)

    sku_dir = find_dir(a.assets, '预览图', 'SKU图') or a.assets
    detail_dir = find_dir(a.assets, '商品详情', '详情图') or a.assets
    main_dir = find_dir(a.assets, '商品轮播图', '主图') or a.assets

    rows = []
    for s in skus:
        pv = str(s.get('preview') or '')
        pv_path = os.path.join(sku_dir, pv) if pv and not os.path.isabs(pv) else pv
        rows.append({
            'i0': v0.index(str(s.get(dims[0], ''))),
            'i1': v1.index(str(s.get(dims[1], ''))),
            'stock': s.get('stock') or 9999,
            'group_price': s.get('group_price'),
            'single_price': s.get('single_price'),
            'code': s.get('code'),
            'preview': pv_path.replace('\\', '/'),
        })

    attrs = {}
    if a.attrs_from and os.path.isfile(a.attrs_from):
        ref = json.load(open(a.attrs_from, encoding='utf-8-sig'))
        attrs = (ref.get('product') or {}).get('attributes') or {}

    listing = {
        'category': prod.get('category') or d.get('category'),
        'category_id': prod.get('category_id') or d.get('category_id') or '',
        'title': a.title or prod.get('title'),
        'brand': a.brand or prod.get('brand') or '祺讯',
        'ref_price': a.ref or prod.get('ref_price') or 128,
        'dimensions': dims,
        'attrs': attrs,
        'v0': v0,
        'v1': v1,
        'stock': 9999,
        'dirs': {'main': main_dir, 'detail': detail_dir, 'sku': sku_dir},
        'rows': rows,
    }

    os.makedirs(a.out, exist_ok=True)
    lp = os.path.join(a.out, 'listing.json')
    json.dump(listing, open(lp, 'w', encoding='utf-8', newline='\n'), ensure_ascii=False, indent=1)
    print('[listing] %s  (skus=%d, dims=%s, v0=%d, v1=%d)' % (lp, len(rows), dims, len(v0), len(v1)))

    if a.dry:
        return

    r = subprocess.run([PY, '-X', 'utf8', BUILD, '--listing', lp, '--assets', a.assets, '--out', a.out],
                       capture_output=True, text=True, encoding='utf-8')
    out = (r.stdout or '') + (r.stderr or '')
    print(out.strip()[-1200:])
    if r.returncode != 0:
        raise SystemExit('build_product failed rc=%d' % r.returncode)


if __name__ == '__main__':
    main()
