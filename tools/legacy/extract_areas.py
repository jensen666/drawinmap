"""从广东省 OSM PBF 抽出广州核心区的水面、开敞面和建成区多边形。

只做硬失败归因，不改路网产品数据。闭合 way 与 multipolygon relation 都收，
关系成员按端点拼成环。线状 waterway=river 不当作面。

用法：
  python mapdata/tools/extract_areas.py mapdata/guangdong-latest.osm.pbf .tmp/hard-fail-areas.json
"""

import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(__file__))

from parse_pbf import (  # noqa: E402
    decode_fields,
    decode_packed_varints,
    first_value,
    in_bbox,
    iter_block_items,
    iter_primitive_blocks,
)

# 与 parse_pbf.py 的道路裁剪一致，避免面数据和路网不是同一块地方
TARGET_BBOX = (113.22, 23.06, 113.36, 23.17)
# 关系成员经常伸出核心区，节点缓冲要大于道路那次的 0.015°
NODE_BUFFER_DEG = 0.08

PARK_LEISURE = {"park", "garden", "common", "nature_reserve"}
RECREATION_LEISURE = {"pitch", "playground", "track", "golf_course"}
GRASS_LANDUSE = {"grass", "meadow", "village_green"}
BUILT_LANDUSE = {
    "residential",
    "commercial",
    "industrial",
    "retail",
    "construction",
    "military",
    "railway",
    "brownfield",
}
WATER_NATURAL = {"water", "bay", "strait"}


def classify_area_tags(tags):
    """按标签判断面种类。返回 (layer, kind)；不是面则返回 None。"""
    natural = tags.get("natural")
    waterway = tags.get("waterway")
    water = tags.get("water")
    landuse = tags.get("landuse")
    leisure = tags.get("leisure")
    if natural in WATER_NATURAL or waterway == "riverbank" or landuse in {"reservoir", "basin"}:
        return "water", "water"
    if water and waterway not in {"river", "stream", "ditch", "drain", "canal"}:
        return "water", "water"
    if leisure in PARK_LEISURE:
        return "open", "park"
    if tags.get("place") == "square":
        return "open", "square"
    # 未标 area=yes 的 pedestrian 是街道中心线，不是广场
    if tags.get("highway") == "pedestrian" and tags.get("area") == "yes":
        return "open", "square"
    if leisure in RECREATION_LEISURE or landuse == "recreation_ground":
        return "open", "recreation"
    if landuse in GRASS_LANDUSE:
        return "open", "grass"
    if landuse in BUILT_LANDUSE:
        return "built", "built"
    return None


def iter_ways_and_relations(raw):
    """从一个 PrimitiveBlock 产出 way 与 relation。节点在另一遍收集。"""
    msg = decode_fields(raw)
    strings = []
    string_table = first_value(msg, 1)
    if string_table is not None:
        strings = [item.decode("utf-8", "replace") for _, item in decode_fields(string_table).get(1, [])]

    def tags_of(keys, vals):
        tags = {}
        for key_index, value_index in zip(keys, vals):
            if key_index < len(strings) and value_index < len(strings):
                tags[strings[key_index]] = strings[value_index]
        return tags

    for _, group_raw in msg.get(2, []):
        group = decode_fields(group_raw)
        for _, way_raw in group.get(3, []):
            way = decode_fields(way_raw)
            keys = decode_packed_varints(first_value(way, 2, b""))
            vals = decode_packed_varints(first_value(way, 3, b""))
            refs = decode_packed_varints(first_value(way, 8, b""), zigzag=True, delta=True)
            yield ("way", first_value(way, 1, 0), refs, tags_of(keys, vals))
        for _, rel_raw in group.get(4, []):
            rel = decode_fields(rel_raw)
            keys = decode_packed_varints(first_value(rel, 2, b""))
            vals = decode_packed_varints(first_value(rel, 3, b""))
            roles = decode_packed_varints(first_value(rel, 8, b""))
            memids = decode_packed_varints(first_value(rel, 9, b""), zigzag=True, delta=True)
            types = decode_packed_varints(first_value(rel, 10, b""))
            members = []
            if len(roles) < len(memids):
                roles = roles + [0] * (len(memids) - len(roles))
            for memid, member_type, role_sid in zip(memids, types, roles):
                role = strings[role_sid] if 0 <= role_sid < len(strings) else ""
                members.append((member_type, memid, role))
            yield ("relation", first_value(rel, 1, 0), members, tags_of(keys, vals))


def coords_of(refs, nodes):
    """把节点引用换成坐标；缺节点的引用跳过。"""
    coords = []
    for ref in refs:
        pos = nodes.get(ref)
        if pos is not None:
            coords.append(pos)
    return coords


def is_closed(coords):
    """首尾坐标相同且至少 4 个点（含重复终点）才算环。"""
    if len(coords) < 4:
        return False
    return coords[0] == coords[-1]


def endpoint_key(point):
    """端点匹配键，六位小数与路网坐标精度一致。"""
    return (round(point[0], 6), round(point[1], 6))


def stitch_rings(segments):
    """把共端点的折线拼成闭合环。拼不上的丢弃。"""
    unused = set(range(len(segments)))
    endpoints = {}
    for index, segment in enumerate(segments):
        if len(segment) < 2:
            unused.discard(index)
            continue
        for point in (segment[0], segment[-1]):
            endpoints.setdefault(endpoint_key(point), []).append(index)
    rings = []
    while unused:
        index = unused.pop()
        ring = list(segments[index])
        guard = 0
        while endpoint_key(ring[0]) != endpoint_key(ring[-1]) and guard < 10000:
            guard += 1
            candidates = endpoints.get(endpoint_key(ring[-1]), [])
            attached = False
            for other in candidates:
                if other not in unused:
                    continue
                segment = segments[other]
                if endpoint_key(segment[0]) == endpoint_key(ring[-1]):
                    ring.extend(segment[1:])
                elif endpoint_key(segment[-1]) == endpoint_key(ring[-1]):
                    ring.extend(list(reversed(segment[:-1])))
                else:
                    continue
                unused.remove(other)
                attached = True
                break
            if not attached:
                break
        if is_closed(ring):
            rings.append(ring)
    return rings


def ring_hits_bbox(ring, bbox):
    """环上是否有点落在 bbox 内。"""
    for lon, lat in ring:
        if in_bbox(lon, lat, bbox):
            return True
    return False


def round_ring(ring):
    """坐标收成六位小数，减小输出。"""
    return [[round(lon, 6), round(lat, 6)] for lon, lat in ring]


def bbox_of(ring):
    """环的外包矩形 [minLon, minLat, maxLon, maxLat]。"""
    lons = [point[0] for point in ring]
    lats = [point[1] for point in ring]
    return [min(lons), min(lats), max(lons), max(lats)]


def self_test():
    """拼环与标签分类的最小自检。失败时非零退出。"""
    square_a = [(0, 0), (1, 0)]
    square_b = [(1, 0), (1, 1), (0, 1), (0, 0)]
    rings = stitch_rings([square_a, square_b])
    if len(rings) != 1 or not is_closed(rings[0]):
        raise SystemExit("self-test: stitch failed")
    if classify_area_tags({"natural": "water"}) != ("water", "water"):
        raise SystemExit("self-test: water tag failed")
    if classify_area_tags({"waterway": "river"}) is not None:
        raise SystemExit("self-test: river centerline must not be an area")
    if classify_area_tags({"leisure": "park"}) != ("open", "park"):
        raise SystemExit("self-test: park tag failed")
    if classify_area_tags({"highway": "primary"}) is not None:
        raise SystemExit("self-test: ordinary highway must not be an area")
    print("[self-test] PASS", flush=True)


def extract(pbf_path, out_path):
    """两遍扫描 PBF，写出与路网 bbox 相交的面。"""
    self_test()
    min_lon, min_lat, max_lon, max_lat = TARGET_BBOX
    node_bbox = (
        min_lon - NODE_BUFFER_DEG,
        min_lat - NODE_BUFFER_DEG,
        max_lon + NODE_BUFFER_DEG,
        max_lat + NODE_BUFFER_DEG,
    )
    started = time.time()
    nodes = {}
    for block_type, raw in iter_primitive_blocks(pbf_path):
        if block_type != "OSMData":
            continue
        for item in iter_block_items(raw):
            if item[0] != "node":
                continue
            _, node_id, lon, lat = item
            if in_bbox(lon, lat, node_bbox):
                nodes[node_id] = (lon, lat)
    print(f"[pass1] nodes={len(nodes)} elapsed={time.time() - started:.1f}s", flush=True)

    wanted_ways = {}
    relations = []
    direct = []
    started = time.time()
    for block_type, raw in iter_primitive_blocks(pbf_path):
        if block_type != "OSMData":
            continue
        for kind, obj_id, payload, tags in iter_ways_and_relations(raw):
            if kind == "way":
                # 关系外环经常没有自己的面标签，几何必须先存下来
                coords = coords_of(payload, nodes)
                if len(coords) < 2:
                    continue
                wanted_ways[obj_id] = coords
                area = classify_area_tags(tags)
                if area is None:
                    continue
                layer, area_kind = area
                if is_closed(coords) and ring_hits_bbox(coords, TARGET_BBOX):
                    direct.append((obj_id, layer, area_kind, tags.get("name", ""), coords, []))
            else:
                if tags.get("type") == "route":
                    continue
                area = classify_area_tags(tags)
                if area is None:
                    continue
                relations.append((obj_id, area, tags.get("name", ""), payload))
    print(
        f"[pass2] ways={len(wanted_ways)} direct={len(direct)} relations={len(relations)} "
        f"elapsed={time.time() - started:.1f}s",
        flush=True,
    )

    polygons = []
    for obj_id, layer, area_kind, name, outer, inners in direct:
        polygons.append({
            "id": obj_id,
            "layer": layer,
            "kind": area_kind,
            "name": name,
            "bbox": bbox_of(outer),
            "outer": round_ring(outer),
            "inners": [round_ring(inner) for inner in inners],
        })

    relation_rings = 0
    for obj_id, area, name, members in relations:
        layer, area_kind = area
        outers = []
        inners = []
        for member_type, memid, role in members:
            if member_type != 1:
                continue
            coords = wanted_ways.get(memid)
            if not coords or len(coords) < 2:
                continue
            if role == "inner":
                inners.append(coords)
            else:
                outers.append(coords)
        outer_rings = stitch_rings(outers)
        inner_rings = stitch_rings(inners)
        for ring in outer_rings:
            if not ring_hits_bbox(ring, TARGET_BBOX):
                continue
            relation_rings += 1
            polygons.append({
                "id": obj_id,
                "layer": layer,
                "kind": area_kind,
                "name": name,
                "bbox": bbox_of(ring),
                "outer": round_ring(ring),
                "inners": [round_ring(inner) for inner in inner_rings if is_closed(inner)],
            })
    print(f"[relations] stitched-outers={relation_rings}", flush=True)

    payload = {
        "meta": {
            "source": "OpenStreetMap extract (guangdong-latest.osm.pbf)",
            "license": "ODbL 1.0",
            "bbox": list(TARGET_BBOX),
            "nodeBufferDeg": NODE_BUFFER_DEG,
            "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "polygon_count": len(polygons),
        },
        "polygons": polygons,
    }
    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"))
    print(f"[out] {out_path} polygons={len(polygons)}", flush=True)


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("usage: extract_areas.py <input.pbf> <output.json>")
        raise SystemExit(2)
    extract(sys.argv[1], sys.argv[2])
