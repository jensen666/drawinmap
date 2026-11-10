"""验证裁剪后的广州路网 JSON 数据质量。"""

import json
import sys
from collections import Counter

DATA = r"D:\code\DrawInMap\mapdata\guangzhou-roads.json"


def main():
    with open(DATA, encoding="utf-8") as fh:
        payload = json.load(fh)

    meta = payload["meta"]
    roads = payload["roads"]
    print(f"meta             = {json.dumps(meta, ensure_ascii=False)[:300]}")
    print(f"road_count       = {len(roads)}")

    min_lon, min_lat, max_lon, max_lat = meta["bbox"]
    pad = 0.05
    inside = 0
    outside = []
    total_points = 0
    for road in roads:
        total_points += len(road["c"])
        for lon, lat in road["c"]:
            if (
                min_lon - pad <= lon <= max_lon + pad
                and min_lat - pad <= lat <= max_lat + pad
            ):
                inside += 1
            else:
                outside.append((road["id"], lon, lat))

    print(f"points_total     = {total_points}")
    print(f"points_inside    = {inside} ({inside * 100 / max(total_points, 1):.2f}%)")
    print(f"points_outside   = {len(outside)} (样本 {outside[:3]})")

    types = Counter(road["h"] for road in roads)
    print(f"highway_types    = {dict(sorted(types.items(), key=lambda x: -x[1]))}")

    named = sum(1 for road in roads if road.get("n"))
    print(f"named_ratio      = {named}/{len(roads)} = {named * 100 / max(len(roads), 1):.1f}%")
    samples = [road["n"] for road in roads if road.get("n")][:10]
    print(f"name_samples     = {samples}")

    length_estimate = total_points * 0.000015 * 111000  # 粗略估算，仅供量级参考
    print(f"approx_total_km  = {length_estimate:.0f} (粗估)")

    ok = (
        len(roads) > 1000
        and inside > 0.95 * total_points
        and total_points > 10000
    )
    print("VERDICT:", "PASS" if ok else "FAIL")
    return 0 if ok else 2


if __name__ == "__main__":
    sys.exit(main())
