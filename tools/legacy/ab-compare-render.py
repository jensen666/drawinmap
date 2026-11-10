# -*- coding: utf-8 -*-
"""同输入前后对照图（方案 2026-11-05 §2.4）。

把「在花城广场画只猫，旁边再画只兔子」这条**逐字节相同**的输入，
在 2026-11-04 旧代码与 2026-11-05 新代码下的两张真实截图并排渲染，
下方附逐项指标对照表：

- 左：旧代码 —— 只交付「兔」，回复却声称"并排由猫和兔子组成的双环"（契约失败）
- 右：新代码 —— 交付「猫+兔」复合目标，回复与交付一致（契约 13/13）

用法：python tools/ab-compare-render.py
输出：docs/测试报告/2026-11-05-交付正确性验收/同输入前后对照/compare-ab.png
"""

import json
import re
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

sys.stdout.reconfigure(encoding="utf-8")

ROOT = Path(__file__).resolve().parents[1]
BASE = ROOT / "docs" / "测试报告" / "2026-11-05-交付正确性验收" / "同输入前后对照"
OLD_DIR = ROOT / "docs" / "测试报告" / "2026-11-04-真实LLM-E2E-40例" / "全新复杂例"

OLD_PNG = OLD_DIR / "x14-cat-and-rabbit.png"
NEW_PNG = BASE / "x14-ab-ab-cat-rabbit.png"
AB_JSON = BASE / "result-ab.json"
OLD_JSON = OLD_DIR / "result-new-final.json"
OUT = BASE / "compare-ab.png"
OUT_OUTLINE = BASE / "compare-ab-outline.png"

# 目标轮廓预览在页面右侧"推理过程"面板里的位置（原图像素坐标）
OUTLINE_BOX = (1020, 410, 1250, 545)

IMG_W = 880          # 单张截图缩放宽度
GAP = 26
MARGIN = 26
HEADER_H = 96
CAPTION_H = 46
TABLE_H = 232
BG = (244, 246, 250)
INK = (15, 23, 42)
MUTED = (71, 85, 105)
LINE = (203, 213, 225)
GOOD = (22, 163, 74)
BAD = (220, 38, 38)
BLUE = (37, 99, 235)


def font(size, bold=False):
    for path in (
        r"C:\Windows\Fonts\msyhbd.ttc" if bold else r"C:\Windows\Fonts\msyh.ttc",
        r"C:\Windows\Fonts\simhei.ttf",
    ):
        if Path(path).exists():
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


F_TITLE = font(21, True)
F_SUB = font(14)
F_CAP = font(17, True)
F_ROW = font(15)
F_KEY = font(15, True)


def load_old_case():
    data = json.loads(OLD_JSON.read_text(encoding="utf-8"))
    for case in data["cases"]:
        if case.get("id") == "X14":
            return case
    raise SystemExit("旧结果里找不到 X14")


def load_new_case():
    data = json.loads(AB_JSON.read_text(encoding="utf-8"))
    return data["cases"][0]


def old_metrics(case):
    """旧结果 JSON 没记路线/步行/偏移（这正是方案 B1 补的洞），从回复原文解析。"""
    reply = case["actual"].get("reply", "")
    route_km = None
    match = re.search(r"路线：([\d.]+)\s*km", reply)
    if match:
        route_km = float(match.group(1))
    walk_min = None
    match = re.search(r"约\s*(\d+)\s*小时(?:\s*(\d+)\s*分)?", reply)
    if match:
        walk_min = int(match.group(1)) * 60 + int(match.group(2) or 0)
    offset_km = None
    match = re.search(r"在[东南西北]约\s*([\d.]+)\s*km", reply)
    if match:
        offset_km = float(match.group(1))
    return {
        "delivered": case["actual"].get("shape", {}).get("shapeName", "兔"),
        "claimed": "猫+兔子（双环）",
        "size": case["actual"].get("shape", {}).get("sizeMeters"),
        "score": case["actual"].get("shape", {}).get("score"),
        "routeKm": route_km,
        "walkMin": walk_min,
        "offsetKm": offset_km,
        "contract": "失败：多对象交付必须包含全部对象「猫+兔」",
        "contractOk": False,
    }


def new_metrics(case):
    actual = case["actual"]
    report = actual.get("deliveryReport") or {}
    details = report.get("details") or {}
    return {
        "delivered": actual.get("shape", {}).get("shapeName", "-"),
        "claimed": "猫+兔子（双环）",
        "size": actual.get("shape", {}).get("sizeMeters"),
        "score": actual.get("shape", {}).get("score"),
        "routeKm": round(details.get("routeMeters", 0) / 1000, 2),
        "walkMin": details.get("walkMinutes"),
        "offsetKm": round((details.get("offsetMeters") or 0) / 1000, 2),
        "contract": f"通过 {case['passed']}/{case['checks'].__len__()}",
        "contractOk": case["status"] == "pass",
    }


def fit(img, width):
    return img.resize((width, round(img.height * width / img.width)), Image.LANCZOS)


def render_outline_compare():
    """目标轮廓放大对照：旧=只有一只兔，新=猫+兔两个部分。"""
    old = Image.open(OLD_PNG).convert("RGB").crop(OUTLINE_BOX)
    new = Image.open(NEW_PNG).convert("RGB").crop(OUTLINE_BOX)
    box_w = 620
    old_big = old.resize((box_w, round(old.height * box_w / old.width)), Image.LANCZOS)
    new_big = new.resize((box_w, round(new.height * box_w / new.width)), Image.LANCZOS)

    margin = 30
    gap = 34
    head_h = 108
    cap_h = 84
    width = margin * 2 + box_w * 2 + gap
    height = margin + head_h + max(old_big.height, new_big.height) + cap_h + margin

    canvas = Image.new("RGB", (width, height), BG)
    draw = ImageDraw.Draw(canvas)
    draw.text((margin, margin), "目标轮廓放大对照：同一句「在花城广场画只猫，旁边再画只兔子」", fill=INK, font=F_TITLE)
    draw.text(
        (margin, margin + 34),
        "系统自己认定的目标轮廓（页面右侧「推理过程 → 目标点序列」预览）",
        fill=MUTED,
        font=F_SUB,
    )

    top = margin + head_h
    canvas.paste(old_big, (margin, top))
    canvas.paste(new_big, (margin + box_w + gap, top))

    cap_y = top + max(old_big.height, new_big.height) + 12
    draw.text((margin, cap_y), "旧代码（2026-11-04）", fill=INK, font=F_CAP)
    draw.text((margin + box_w + gap, cap_y), "新代码（2026-11-05）", fill=INK, font=F_CAP)
    draw.text((margin, cap_y + 26), "只有一只兔 —— 猫根本没进目标轮廓", fill=BAD, font=F_SUB)
    draw.text((margin + box_w + gap, cap_y + 26), "猫 + 兔 两个部分都在目标轮廓里", fill=GOOD, font=F_SUB)

    OUT_OUTLINE.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(OUT_OUTLINE)
    print(f"轮廓放大对比图已写入 {OUT_OUTLINE}（{canvas.width}×{canvas.height}）")


def main():
    old_case = load_old_case()
    new_case = load_new_case()
    om, nm = old_metrics(old_case), new_metrics(new_case)

    left = fit(Image.open(OLD_PNG).convert("RGB"), IMG_W)
    right = fit(Image.open(NEW_PNG).convert("RGB"), IMG_W)
    width = MARGIN * 2 + IMG_W * 2 + GAP
    height = MARGIN + HEADER_H + max(left.height, right.height) + CAPTION_H + TABLE_H + MARGIN

    canvas = Image.new("RGB", (width, height), BG)
    draw = ImageDraw.Draw(canvas)

    # 标题区
    draw.text((MARGIN, MARGIN), "同输入前后对照：在花城广场画只猫，旁边再画只兔子", fill=INK, font=F_TITLE)
    draw.text(
        (MARGIN, MARGIN + 32),
        "同一句输入、同一份真实路网、同一套真实 LLM；只换代码版本（2026-11-04 旧 → 2026-11-05 新）",
        fill=MUTED,
        font=F_SUB,
    )

    top = MARGIN + HEADER_H
    canvas.paste(left, (MARGIN, top))
    canvas.paste(right, (MARGIN + IMG_W + GAP, top))

    cap_y = top + max(left.height, right.height) + 8
    draw.text((MARGIN, cap_y), "旧代码（2026-11-04）", fill=INK, font=F_CAP)
    draw.text(
        (MARGIN + IMG_W + GAP, cap_y),
        "新代码（2026-11-05）",
        fill=INK,
        font=F_CAP,
    )
    draw.text(
        (MARGIN, cap_y + 22),
        "契约失败：只交付「兔」，回复却声称「并排由猫和兔子组成的双环」",
        fill=BAD,
        font=F_SUB,
    )
    draw.text(
        (MARGIN + IMG_W + GAP, cap_y + 22),
        "契约通过 13/13：交付「猫+兔」复合目标，回复与交付一致",
        fill=GOOD,
        font=F_SUB,
    )

    # 指标对照表
    ty = cap_y + CAPTION_H + 6
    draw.rectangle([MARGIN, ty, width - MARGIN, ty + TABLE_H - 14], fill=(255, 255, 255), outline=LINE)
    rows = [
        ("实际交付对象", om["delivered"], nm["delivered"], False),
        ("回复声称", om["claimed"], nm["claimed"], False),
        ("契约断言", om["contract"], nm["contract"], None),
        ("交付尺寸", f"{om['size']} m", f"{nm['size']} m", None),
        ("路线长度", f"{om['routeKm']} km", f"{nm['routeKm']} km", None),
        ("步行时间", f"{om['walkMin']} 分钟", f"{nm['walkMin']} 分钟", None),
        ("路线贴合分", f"{om['score']}", f"{nm['score']}", None),
        ("偏离请求地点", f"{om['offsetKm']} km", f"{nm['offsetKm']} km", None),
    ]
    col = [MARGIN + 18, MARGIN + 200, MARGIN + 470, MARGIN + 760]
    draw.text((col[0], ty + 12), "指标", fill=INK, font=F_KEY)
    draw.text((col[1], ty + 12), "旧代码", fill=INK, font=F_KEY)
    draw.text((col[2], ty + 12), "新代码", fill=INK, font=F_KEY)
    draw.text((col[3], ty + 12), "变化", fill=INK, font=F_KEY)
    draw.line([(MARGIN + 12, ty + 36), (width - MARGIN - 12, ty + 36)], fill=LINE)
    for i, (key, ov, nv, fixed) in enumerate(rows):
        y = ty + 46 + i * 21
        draw.text((col[0], y), key, fill=MUTED, font=F_ROW)
        draw.text((col[1], y), ov, fill=INK, font=F_ROW)
        draw.text((col[2], y), nv, fill=INK, font=F_ROW)
        note = ""
        color = MUTED
        if key == "实际交付对象":
            note, color = "✔ 修好", GOOD
        elif key == "契约断言":
            note, color = ("✔ 修好", GOOD) if nm["contractOk"] else ("", MUTED)
        elif key == "路线长度":
            note, color = ("↑ 变贵", BAD)
        elif key == "步行时间":
            note, color = ("↑ 变贵", BAD)
        elif key == "路线贴合分":
            note, color = ("↓ 变低", BAD)
        elif key == "偏离请求地点":
            note, color = ("↓ 变好", GOOD)
        draw.text((col[3], y), note, fill=color, font=F_ROW)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(OUT)
    print(f"对比图已写入 {OUT}（{canvas.width}×{canvas.height}）")
    render_outline_compare()


if __name__ == "__main__":
    main()
