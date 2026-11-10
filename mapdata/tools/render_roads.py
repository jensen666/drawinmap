"""把裁剪后的广州路网 JSON 渲染成预览图（PNG），用于直观验证数据正确性。"""

import json
from pathlib import Path

from PIL import Image, ImageDraw

DATA = Path(r"D:\code\DrawInMap\mapdata\guangzhou-roads.json")
OUT = Path(r"D:\code\DrawInMap\mapdata\preview-roads.png")

WIDTH, HEIGHT = 1800, 1400
MARGIN = 40

# 道路类型配色（按重要度从深到浅）
TYPE_COLORS = {
    "motorway": (60, 60, 60),
    "trunk": (70, 70, 70),
    "primary": (90, 90, 90),
    "secondary": (110, 110, 110),
    "tertiary": (130, 130, 130),
    "residential": (160, 160, 160),
    "living_street": (170, 170, 170),
    "unclassified": (150, 150, 150),
    "service": (185, 185, 185),
    "pedestrian": (120, 150, 200),
    "footway": (150, 170, 210),
    "path": (170, 185, 215),
    "cycleway": (140, 190, 160),
    "steps": (190, 160, 190),
    "track": (180, 180, 160),
}
DEFAULT_COLOR = (190, 190, 190)


def main():
    payload = json.loads(DATA.read_text(encoding="utf-8"))
    meta = payload["meta"]
    roads = payload["roads"]
    min_lon, min_lat, max_lon, max_lat = meta["bbox"]

    lon_span = max_lon - min_lon
    lat_span = max_lat - min_lat
    scale = min((WIDTH - 2 * MARGIN) / lon_span, (HEIGHT - 2 * MARGIN) / lat_span)

    def project(lon, lat):
        x = MARGIN + (lon - min_lon) * scale
        y = MARGIN + (max_lat - lat) * scale  # 纬度向上
        return x, y

    image = Image.new("RGB", (WIDTH, HEIGHT), (248, 250, 252))
    draw = ImageDraw.Draw(image)

    for road in roads:
        color = TYPE_COLORS.get(road["h"], DEFAULT_COLOR)
        points = [project(lon, lat) for lon, lat in road["c"]]
        if len(points) >= 2:
            draw.line(points, fill=color, width=1)

    image.save(OUT)
    print(f"rendered {len(roads)} roads -> {OUT} ({OUT.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
