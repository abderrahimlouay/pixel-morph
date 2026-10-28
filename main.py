import time
from functools import lru_cache

import cv2
import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles

app = FastAPI()

MIN_N, MAX_N = 16, 128
MAX_BYTES = 8 * 1024 * 1024
PASSES = 400    # upper bound on swap rounds
BUDGET = 5.0    # seconds; refinement stops when exceeded
STALL = 15      # stop after this many consecutive rounds with almost no improvement


@lru_cache(maxsize=8)
def grid(n: int) -> np.ndarray:
    """Normalized (x, y) of every grid cell, row-major. Cached per resolution."""
    ys, xs = np.divmod(np.arange(n * n), n)
    return np.stack([xs, ys], axis=1) / n


@lru_cache(maxsize=128)
def local_pairs(n: int, dx: int, dy: int, fx: int, fy: int):
    """Disjoint cell pairs (p, p + (dx, dy)), optionally in a mirrored frame.
    Sources sit in even blocks and partners in odd blocks, so no cell is used twice."""
    ym, xm = np.divmod(np.arange(n * n), n)
    ok = (xm + dx < n) & (ym + dy < n)
    if dx:
        ok &= (xm // dx) % 2 == 0
    if dy:
        ok &= (ym // dy) % 2 == 0
    xm, ym = xm[ok], ym[ok]

    def idx(x, y):
        return (n - 1 - y if fy else y) * n + (n - 1 - x if fx else x)

    return idx(xm, ym), idx(xm + dx, ym + dy)


def load(upload: UploadFile, n: int) -> np.ndarray:
    data = upload.file.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise HTTPException(413, "Image is larger than 8 MB.")
    img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        raise HTTPException(400, f"'{upload.filename}' is not a readable image.")
    h, w = img.shape[:2]
    s = min(h, w)
    y0, x0 = (h - s) // 2, (w - s) // 2
    img = cv2.resize(img[y0:y0 + s, x0:x0 + s], (n, n), interpolation=cv2.INTER_AREA)
    return cv2.cvtColor(img, cv2.COLOR_BGR2RGB).reshape(-1, 3)


def match(src: np.ndarray, tgt: np.ndarray, n: int, spatial_w: float) -> np.ndarray:
    """Approximate one-to-one assignment minimizing color^2 + spatial_w * position^2.

    1. Initialize by matching brightness ranks.
    2. Refine with swaps of disjoint slot pairs (mostly local, some global).

    Both terms live in one 5-D feature space, and a swap of source features fa, fb
    between slots ta, tb changes the cost by 2 * (fa - fb) . (ta - tb), so each
    candidate pair needs a single small dot product."""
    m = n * n
    pos = grid(n) * np.sqrt(spatial_w)
    FS = np.hstack([src / 255.0, pos]).astype(np.float32)
    FT = np.hstack([tgt / 255.0, pos]).astype(np.float32)
    lw = np.array([0.299, 0.587, 0.114])

    owner = np.empty(m, np.int64)  # owner[t] = source pixel currently in slot t
    owner[np.argsort(tgt @ lw, kind="stable")] = np.argsort(src @ lw, kind="stable")

    rng = np.random.default_rng(0)
    h = m // 2
    radii = (1, 2, 4, max(8, n // 8))
    t0, stall = time.perf_counter(), 0

    for it in range(PASSES):
        if it % 5 == 4:  # occasional global swaps
            p = rng.permutation(m)
            a, b = p[:h], p[h:2 * h]
        else:  # local swaps, radius cycles from fine to coarse
            r = radii[it % 4]
            dx, dy = int(rng.integers(0, r + 1)), int(rng.integers(0, r + 1))
            if dx == 0 and dy == 0:
                dx = 1
            a, b = local_pairs(n, dx, dy, int(rng.integers(2)), int(rng.integers(2)))

        sa, sb = owner[a], owner[b]
        sel = np.einsum("ij,ij->i", FS[sa] - FS[sb], FT[a] - FT[b]) < -1e-9
        cnt = int(sel.sum())
        if cnt:
            a, b, sa, sb = a[sel], b[sel], sa[sel], sb[sel]
            owner[a] = sb
            owner[b] = sa

        stall = stall + 1 if cnt < 0.001 * len(sel) else 0
        if stall >= STALL or time.perf_counter() - t0 > BUDGET:
            break

    dest = np.empty(m, np.int64)
    dest[owner] = np.arange(m)  # dest[source] = target slot
    return dest


@app.post("/api/morph")
def morph(
    source: UploadFile = File(...),
    target: UploadFile = File(...),
    n: int = Form(64),
    spatial: float = Form(0.35),
):
    if not MIN_N <= n <= MAX_N:
        raise HTTPException(422, f"Resolution must be between {MIN_N} and {MAX_N}.")
    if not 0.0 <= spatial <= 1.0:
        raise HTTPException(422, "Spatial weight must be between 0 and 1.")

    t0 = time.perf_counter()
    try:
        src = load(source, n)
        tgt = load(target, n)
        dest = match(src, tgt, n, 0.02 + spatial * 3.0)
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(500, "Processing failed. Try different images or a lower resolution.")

    # Binary payload: uint16 destinations, then uint8 RGB (no JSON overhead).
    body = dest.astype("<u2").tobytes() + src.astype(np.uint8).tobytes()
    return Response(
        body,
        media_type="application/octet-stream",
        headers={
            "X-N": str(n),
            "X-Pixels": str(n * n),
            "X-Time": f"{time.perf_counter() - t0:.2f}",
            "Cache-Control": "no-store",
        },
    )


app.mount("/", StaticFiles(directory="static", html=True), name="static")