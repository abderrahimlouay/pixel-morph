"use strict";
const $ = (s) => document.querySelector(s);
const MAX_BYTES = 8 * 1024 * 1024;
const BG = (255 << 24) | (18 << 16) | (11 << 8) | 11; // #0b0b12 as ABGR

const canvas = $("#canvas"), ctx = canvas.getContext("2d");
const files = { source: null, target: null };
let M = null;          // current morph data (typed arrays, sizes)
let raf = 0, lastT = 0, busy = false;

/* ---------- UI helpers ---------- */
function setStatus(t) { $("#status").textContent = t; }
function showError(t) { const e = $("#error"); e.textContent = t; e.hidden = false; }
function clearError() { $("#error").hidden = true; }
function sync() {
  $("#morph").disabled = busy || !(files.source && files.target);
  $("#replay").disabled = busy || !M;
  $("#reset").disabled = busy || !M;
  $("#progress").hidden = !busy;
}
function setChip(id, text) { const c = $(id); c.textContent = text; c.hidden = false; }

$("#spatial").addEventListener("input", (e) => ($("#spatial-out").textContent = e.target.value));
$("#dur").addEventListener("input", (e) => ($("#dur-out").textContent = Number(e.target.value).toFixed(1) + " s"));

/* ---------- Drag & drop + previews ---------- */
document.querySelectorAll(".drop").forEach((zone) => {
  const kind = zone.dataset.kind, input = zone.querySelector("input"), img = zone.querySelector("img");
  const take = (file) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) return showError("Please choose an image file.");
    if (file.size > MAX_BYTES) return showError("That image is larger than 8 MB.");
    clearError();
    files[kind] = file;
    if (img.src) URL.revokeObjectURL(img.src);
    img.src = URL.createObjectURL(file);
    img.hidden = false;
    zone.classList.add("has");
    setStatus(files.source && files.target ? "Ready" : "Add the other image");
    sync();
  };
  input.addEventListener("change", () => take(input.files[0]));
  ["dragenter", "dragover"].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.add("over"); }));
  ["dragleave", "drop"].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.remove("over"); }));
  zone.addEventListener("drop", (e) => take(e.dataTransfer.files[0]));
});

/* ---------- Particle setup ---------- */
function setup(buf, n) {
  const m = n * n;
  const dest = new Uint16Array(buf, 0, m);
  const rgb = new Uint8Array(buf, m * 2, m * 3);
  const s = Math.max(2, Math.floor(640 / n)), W = n * s;

  canvas.width = canvas.height = W;
  const image = ctx.createImageData(W, W);
  const colors = new Uint32Array(m), r1 = new Float32Array(m), r2 = new Float32Array(m);
  for (let i = 0; i < m; i++) {
    colors[i] = (255 << 24) | (rgb[i * 3 + 2] << 16) | (rgb[i * 3 + 1] << 8) | rgb[i * 3];
    r1[i] = Math.random();
    r2[i] = Math.random();
  }
  M = {
    n, m, s, W, dest, colors, r1, r2, image, px: new Uint32Array(image.data.buffer),
    sx: new Float32Array(m), sy: new Float32Array(m), dx: new Float32Array(m), dy: new Float32Array(m),
    cx: new Float32Array(m), cy: new Float32Array(m), delay: new Float32Array(m), ph: new Float32Array(m),
    span: 1, jit: 0,
  };
  build();
  $("#frame").removeAttribute("data-empty");
}

// Precompute per-particle paths so the frame loop only does arithmetic.
function build() {
  const { n, m, s, dest, r1, r2, sx, sy, dx, dy, cx, cy, delay, ph } = M;
  const fancy = $("#fx").checked;
  let maxd = 1;
  for (let i = 0; i < m; i++) {
    sx[i] = (i % n) * s; sy[i] = ((i / n) | 0) * s;
    dx[i] = (dest[i] % n) * s - sx[i]; dy[i] = (((dest[i] / n) | 0) * s) - sy[i];
    maxd = Math.max(maxd, Math.hypot(dx[i], dy[i]));
  }
  const stagger = fancy ? 0.25 : 0;
  for (let i = 0; i < m; i++) {
    delay[i] = stagger * (0.6 * Math.hypot(dx[i], dy[i]) / maxd + 0.4 * r1[i]);
    const k = fancy ? (r2[i] * 2 - 1) * 0.18 : 0; // sideways arc, proportional to distance
    cx[i] = -dy[i] * k; cy[i] = dx[i] * k;
    ph[i] = r1[i] * 6.283;
  }
  M.span = 1 - stagger;
  M.jit = fancy ? 0.6 * s : 0;
}

/* ---------- Rendering ---------- */
function render(T) {
  lastT = T;
  const { m, s, W, px, colors, sx, sy, dx, dy, cx, cy, delay, ph, span, jit, image } = M;
  const lim = W - s;
  px.fill(BG);
  for (let i = 0; i < m; i++) {
    let l = (T - delay[i]) / span;
    l = l < 0 ? 0 : l > 1 ? 1 : l;
    const e = l * l * l * (l * (6 * l - 15) + 10); // smootherstep
    const b = 4 * e * (1 - e);                      // 0 at both ends, 1 mid-flight
    let x = sx[i] + dx[i] * e + cx[i] * b;
    let y = sy[i] + dy[i] * e + cy[i] * b;
    if (jit) { x += Math.sin(T * 28 + ph[i]) * jit * b; y += Math.cos(T * 23 + ph[i] * 1.7) * jit * b; }
    let xi = Math.round(x), yi = Math.round(y);
    xi = xi < 0 ? 0 : xi > lim ? lim : xi;
    yi = yi < 0 ? 0 : yi > lim ? lim : yi;
    const c = colors[i];
    for (let yy = 0; yy < s; yy++) {
      let o = (yi + yy) * W + xi;
      for (let xx = 0; xx < s; xx++) px[o++] = c;
    }
  }
  ctx.putImageData(image, 0, 0);
}

/* ---------- Playback (rAF runs only while animating) ---------- */
function stop() { if (raf) cancelAnimationFrame(raf); raf = 0; }

function play() {
  if (!M) return;
  stop();
  const dur = Number($("#dur").value) * 1000, t0 = performance.now();
  setStatus("Morphing…");
  const tick = (now) => {
    const T = Math.min((now - t0) / dur, 1);
    render(T);
    if (T < 1) raf = requestAnimationFrame(tick);
    else { raf = 0; setStatus("Done"); }
  };
  raf = requestAnimationFrame(tick);
}

function reset() {
  if (!M) return;
  stop();
  render(0);
  setStatus("Reset");
}

$("#fx").addEventListener("change", () => { if (M) { build(); render(lastT); } });
$("#replay").addEventListener("click", play);
$("#reset").addEventListener("click", reset);

/* ---------- Request ---------- */
$("#morph").addEventListener("click", async () => {
  if (busy) return;
  stop();
  busy = true; clearError(); setStatus("Matching pixels…"); sync();

  const fd = new FormData();
  fd.append("source", files.source);
  fd.append("target", files.target);
  fd.append("n", document.querySelector('input[name="n"]:checked').value);
  fd.append("spatial", Number($("#spatial").value) / 100);

  try {
    const res = await fetch("/api/morph", { method: "POST", body: fd });
    if (!res.ok) {
      let msg = `Request failed (${res.status})`;
      try {
        const d = (await res.json()).detail;
        msg = Array.isArray(d) ? d[0]?.msg || msg : d || msg;
      } catch { /* keep default */ }
      throw new Error(msg);
    }
    const buf = await res.arrayBuffer();
    const n = Number(res.headers.get("X-N"));
    setup(buf, n);
    setChip("#chip-res", `${n} × ${n}`);
    setChip("#chip-px", `${n * n} particles`);
    setChip("#chip-time", `matched in ${res.headers.get("X-Time")} s`);
    busy = false; sync();
    play();
  } catch (err) {
    busy = false; sync();
    setStatus("Failed");
    showError(err.message || "Something went wrong.");
  }
});

sync();
