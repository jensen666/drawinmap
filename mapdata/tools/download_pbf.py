"""并发分块下载 OSM 广东数据（断点续传），合并为单个 PBF 文件。

数据源：OSM France 镜像（download.openstreetmap.fr），实测命令行单连接约 29 KB/s，
16 连接并发约 280 KB/s。分块下载后按序合并，并校验 MD5。
"""

import hashlib
import os
import sys
import threading
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

URL = "http://download.openstreetmap.fr/extracts/asia/china/guangdong-latest.osm.pbf"
BASE = r"D:\code\DrawInMap\mapdata"
DL_DIR = os.path.join(BASE, "download")
FINAL = os.path.join(BASE, "guangdong-latest.osm.pbf")
CHUNK = 1024 * 1024
WORKERS = 16
RETRIES = 4
UA = {"User-Agent": "DrawInMap-prototype/0.1 (dev; data prefetch)"}

print_lock = threading.Lock()


def log(msg):
    with print_lock:
        print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def fetch_chunk(job):
    index, start, size = job
    path = os.path.join(DL_DIR, f"chunk_{index:05d}.bin")
    if os.path.exists(path) and os.path.getsize(path) == size:
        return index, size, True
    for attempt in range(RETRIES):
        try:
            req = urllib.request.Request(
                URL,
                headers={
                    "Range": f"bytes={start}-{start + size - 1}",
                    "User-Agent": UA["User-Agent"],
                },
            )
            with urllib.request.urlopen(req, timeout=180) as resp:
                data = resp.read()
            if len(data) != size:
                raise ValueError(f"size mismatch: {len(data)} != {size}")
            with open(path, "wb") as fh:
                fh.write(data)
            return index, size, True
        except Exception as exc:  # noqa: BLE001
            log(f"chunk {index} attempt {attempt + 1} failed: {exc}")
            time.sleep(2 * (attempt + 1))
    return index, 0, False


def main():
    os.makedirs(DL_DIR, exist_ok=True)

    req = urllib.request.Request(URL, method="HEAD", headers={"User-Agent": UA["User-Agent"]})
    with urllib.request.urlopen(req, timeout=60) as resp:
        total = int(resp.headers["Content-Length"])
    log(f"remote size = {total} bytes")

    jobs = []
    for index in range((total + CHUNK - 1) // CHUNK):
        start = index * CHUNK
        jobs.append((index, start, min(CHUNK, total - start)))

    t0 = time.time()
    done_bytes = 0
    failed = []
    last_report = 0
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        futures = [pool.submit(fetch_chunk, job) for job in jobs]
        for future in as_completed(futures):
            index, size, ok = future.result()
            if ok:
                done_bytes += size
            else:
                failed.append(index)
            if time.time() - last_report > 20 or done_bytes == total:
                elapsed = time.time() - t0
                speed = done_bytes / 1024 / elapsed if elapsed else 0
                log(
                    f"progress {done_bytes * 100 // total}% "
                    f"({done_bytes}/{total}, {speed:.0f} KB/s)"
                )
                last_report = time.time()

    if failed:
        log(f"failed chunks: {failed[:20]}... total {len(failed)}")
        sys.exit(2)

    # 合并分块
    log("merging chunks ...")
    md5 = hashlib.md5()
    with open(FINAL, "wb") as out:
        for index in range(len(jobs)):
            path = os.path.join(DL_DIR, f"chunk_{index:05d}.bin")
            with open(path, "rb") as fh:
                while True:
                    block = fh.read(1024 * 1024)
                    if not block:
                        break
                    out.write(block)
                    md5.update(block)
    log(f"merged -> {FINAL}, size={os.path.getsize(FINAL)}, md5={md5.hexdigest()}")

    # 校验 MD5（服务器提供 .md5 文件）
    try:
        with urllib.request.urlopen(URL + ".md5", timeout=30) as resp:
            expected = resp.read().decode().split()[0]
        log(f"remote md5 = {expected}")
        if expected.lower() == md5.hexdigest().lower():
            log("MD5 OK")
        else:
            log("MD5 MISMATCH")
    except Exception as exc:  # noqa: BLE001
        log(f"md5 check skipped: {exc}")

    log("download finished")


if __name__ == "__main__":
    if not os.path.exists(BASE):
        os.makedirs(BASE)
    main()
