"""解析 OSM PBF 数据，裁剪广州核心区道路为精简 JSON（供原型路网使用）。

OSM PBF 结构：文件由 BlobHeader + Blob 组成，Blob 解压后是 PrimitiveBlock，
其中含 stringtable、primitivegroup（dense nodes / ways 等）。坐标按
(lat_offset + granularity * raw) / 1e9 还原为 WGS84 度。
"""

import json
import struct
import sys
import time
import zlib

# 保留的道路类型（步行/骑行/驾车都可能用到）
HIGHWAY_KEEP = {
    "motorway", "trunk", "primary", "secondary", "tertiary",
    "unclassified", "residential", "living_street", "service", "road",
    "pedestrian", "footway", "path", "cycleway", "steps", "track",
    "motorway_link", "trunk_link", "primary_link", "secondary_link", "tertiary_link",
}

# 保留的通行权限标签（供步行等出行方式建图判断是否可通行）
ACCESS_KEYS = (
    "foot", "access", "bicycle", "motor_vehicle", "motorcar",
    "vehicle", "horse", "wheelchair", "oneway",
)

# 广州核心区（约 14km x 12km，覆盖广州塔—沙面—北京路—天河核心）
TARGET_BBOX = (113.22, 23.06, 113.36, 23.17)
BUFFER_DEG = 0.015


# ---------- protobuf 基础解码 ----------

def read_varint(buf, pos):
    """读取 base-128 变长整数，返回 (值, 新位置)。"""
    result = 0
    shift = 0
    while True:
        byte = buf[pos]
        pos += 1
        result |= (byte & 0x7F) << shift
        if not (byte & 0x80):
            return result, pos
        shift += 7
        if shift > 70:
            raise ValueError("varint too long")


def decode_fields(buf):
    """把 protobuf 消息解码为 {field_number: [(wire_type, value), ...]}。"""
    fields = {}
    pos = 0
    size = len(buf)
    while pos < size:
        key, pos = read_varint(buf, pos)
        field = key >> 3
        wire = key & 0x07
        if wire == 0:
            value, pos = read_varint(buf, pos)
        elif wire == 1:
            value = struct.unpack_from("<Q", buf, pos)[0]
            pos += 8
        elif wire == 2:
            length, pos = read_varint(buf, pos)
            if pos + length > size:
                raise ValueError("truncated length-delimited field")
            value = buf[pos:pos + length]
            pos += length
        elif wire == 5:
            value = struct.unpack_from("<I", buf, pos)[0]
            pos += 4
        else:
            raise ValueError(f"unsupported wire type {wire}")
        fields.setdefault(field, []).append((wire, value))
    return fields


def first_value(fields, number, default=None):
    """取字段的第一个值。"""
    items = fields.get(number)
    if not items:
        return default
    return items[0][1]


def zigzag_decode(value):
    """protobuf zigzag 解码。"""
    return (value >> 1) ^ -(value & 1)


def decode_packed_varints(raw, zigzag=False, delta=False):
    """解码 packed varint 数组，可选 zigzag 与 delta 还原。"""
    if not raw:
        return []
    values = []
    pos = 0
    while pos < len(raw):
        value, pos = read_varint(raw, pos)
        values.append(value)
    if zigzag:
        values = [zigzag_decode(v) for v in values]
    if delta:
        out = []
        acc = 0
        for value in values:
            acc += value
            out.append(acc)
        return out
    return values


# ---------- PBF 文件遍历 ----------

def iter_primitive_blocks(path):
    """按顺序读取 PBF 文件，返回 (block_type, 解压后的 PrimitiveBlock bytes)。"""
    with open(path, "rb") as fh:
        while True:
            header_size_raw = fh.read(4)
            if len(header_size_raw) < 4:
                break
            header_size = struct.unpack(">I", header_size_raw)[0]
            header_raw = fh.read(header_size)
            if len(header_raw) < header_size:
                break
            header = decode_fields(header_raw)
            block_type = first_value(header, 1, b"").decode("utf-8", "replace")
            data_size = first_value(header, 3, 0)
            blob_raw = fh.read(data_size)
            if len(blob_raw) < data_size:
                break
            blob = decode_fields(blob_raw)
            raw = first_value(blob, 1)
            if raw is None:
                zlib_data = first_value(blob, 3)
                if zlib_data is None:
                    raise ValueError("unsupported blob compression")
                raw = zlib.decompress(zlib_data)
            yield block_type, raw


def iter_block_items(raw):
    """解析一个 PrimitiveBlock，产出 ("node", id, lon, lat) 与 ("way", id, refs, tags)。"""
    msg = decode_fields(raw)
    granularity = first_value(msg, 17, 100)
    lat_offset = first_value(msg, 19, 0)
    lon_offset = first_value(msg, 20, 0)

    strings = []
    st_raw = first_value(msg, 1)
    if st_raw is not None:
        string_table = decode_fields(st_raw)
        strings = [s.decode("utf-8", "replace") for _, s in string_table.get(1, [])]

    for _, group_raw in msg.get(2, []):
        group = decode_fields(group_raw)

        # DenseNodes（现代 PBF 的主要节点编码）
        for _, dense_raw in group.get(2, []):
            dense = decode_fields(dense_raw)
            ids = decode_packed_varints(first_value(dense, 1, b""), zigzag=True, delta=True)
            lats = decode_packed_varints(first_value(dense, 8, b""), zigzag=True, delta=True)
            lons = decode_packed_varints(first_value(dense, 9, b""), zigzag=True, delta=True)
            limit = min(len(ids), len(lats), len(lons))
            for index in range(limit):
                lon = (lon_offset + granularity * lons[index]) / 1e9
                lat = (lat_offset + granularity * lats[index]) / 1e9
                yield ("node", ids[index], lon, lat)

        # 普通 Node（兼容旧格式）
        for _, node_raw in group.get(1, []):
            node = decode_fields(node_raw)
            node_id = zigzag_decode(first_value(node, 1, 0))
            raw_lat = first_value(node, 8, 0)
            raw_lon = first_value(node, 9, 0)
            lat = (lat_offset + granularity * zigzag_decode(raw_lat)) / 1e9
            lon = (lon_offset + granularity * zigzag_decode(raw_lon)) / 1e9
            yield ("node", node_id, lon, lat)

        # Way
        for _, way_raw in group.get(3, []):
            way = decode_fields(way_raw)
            way_id = first_value(way, 1, 0)
            keys = decode_packed_varints(first_value(way, 2, b""))
            vals = decode_packed_varints(first_value(way, 3, b""))
            refs = decode_packed_varints(first_value(way, 8, b""), zigzag=True, delta=True)
            tags = {}
            for key_index, value_index in zip(keys, vals):
                if key_index < len(strings) and value_index < len(strings):
                    tags[strings[key_index]] = strings[value_index]
            yield ("way", way_id, refs, tags)


# ---------- 提取流程 ----------

def in_bbox(lon, lat, bbox):
    """判断坐标是否在 bbox 内。"""
    return bbox[0] <= lon <= bbox[2] and bbox[1] <= lat <= bbox[3]


def extract_roads(pbf_path, out_path):
    """两遍扫描：先收集缓冲区节点坐标，再提取核心区道路，输出 JSON。"""
    min_lon, min_lat, max_lon, max_lat = TARGET_BBOX
    ext_bbox = (
        min_lon - BUFFER_DEG, min_lat - BUFFER_DEG,
        max_lon + BUFFER_DEG, max_lat + BUFFER_DEG,
    )

    # Pass 1：收集扩展 bbox 内节点
    t0 = time.time()
    nodes = {}
    for block_type, raw in iter_primitive_blocks(pbf_path):
        if block_type != "OSMData":
            continue
        for item in iter_block_items(raw):
            if item[0] != "node":
                continue
            _, node_id, lon, lat = item
            if in_bbox(lon, lat, ext_bbox):
                nodes[node_id] = (lon, lat)
    print(f"[pass1] nodes={len(nodes)} elapsed={time.time() - t0:.1f}s", flush=True)

    # Pass 2：提取核心区道路
    t1 = time.time()
    roads = []
    for block_type, raw in iter_primitive_blocks(pbf_path):
        if block_type != "OSMData":
            continue
        for item in iter_block_items(raw):
            if item[0] != "way":
                continue
            _, way_id, refs, tags = item
            highway = tags.get("highway")
            if highway not in HIGHWAY_KEEP:
                continue
            coords = []
            coord_refs = []
            hits_core = False
            for ref in refs:
                pos = nodes.get(ref)
                if pos is None:
                    continue
                coords.append(pos)
                coord_refs.append(ref)
                if in_bbox(pos[0], pos[1], TARGET_BBOX):
                    hits_core = True
            if not hits_core or len(coords) < 2:
                continue

            # 基础几何 + 显式节点引用（refs 与 c 一一对应，供拓扑重建使用）
            road = {
                "id": way_id,
                "h": highway,
                "n": tags.get("name", ""),
                "c": [[round(lon, 6), round(lat, 6)] for lon, lat in coords],
                "r": coord_refs,
            }

            # 立交分层信息：桥上/桥下、隧道、显式 layer（避免把几何相交当成路口）
            bridge = tags.get("bridge")
            if bridge and bridge != "no":
                road["b"] = bridge
            tunnel = tags.get("tunnel")
            if tunnel and tunnel != "no":
                road["t"] = tunnel
            layer_raw = tags.get("layer")
            if layer_raw and layer_raw.lstrip("-").isdigit():
                road["ly"] = int(layer_raw)

            # 通行权限/限制标签（foot=no、access=private、oneway 等）
            access = {key: tags[key] for key in ACCESS_KEYS if key != "oneway" and key in tags}
            if access:
                road["a"] = access
            oneway = tags.get("oneway")
            if oneway:
                road["o"] = oneway

            roads.append(road)
    print(f"[pass2] roads={len(roads)} elapsed={time.time() - t1:.1f}s", flush=True)

    payload = {
        "meta": {
            "source": "OpenStreetMap extract (download.openstreetmap.fr, guangdong-latest.osm.pbf)",
            "license": "ODbL 1.0",
            "bbox": list(TARGET_BBOX),
            "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "road_count": len(roads),
            "highway_types": sorted({road["h"] for road in roads}),
        },
        "roads": roads,
    }
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, separators=(",", ":"))
    print(f"[out] {out_path} size={len(json.dumps(payload, ensure_ascii=False))} chars", flush=True)


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("usage: parse_pbf.py <input.pbf> <output.json>")
        sys.exit(1)
    extract_roads(sys.argv[1], sys.argv[2])
