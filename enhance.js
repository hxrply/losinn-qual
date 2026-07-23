/* Clip Enhancer — GPU sharpen / upscale / colour-grade / export.
 *
 * Everything runs client-side: the video never leaves the machine. Enhancement
 * is a single WebGL fragment shader (Contrast Adaptive Sharpening + light
 * denoise + colour grade). Export re-plays the clip in real time and records
 * the canvas + original audio through MediaRecorder.
 *
 * Honest scope: this is not neural super-resolution (Topaz/Wink). It upscales
 * with a good filter and sharpens with CAS, which crispens game footage a lot
 * without inventing detail — and it runs on the GPU, so a weak PC copes fine.
 */

/* ─────────────  Tabs  ───────────── */
document.getElementById('tabbar').addEventListener('click', (e) => {
  const btn = e.target.closest('.tab');
  if (!btn) return;
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t === btn));
  const id = btn.dataset.tab;
  document.querySelectorAll('.tab-panel').forEach(p => {
    p.hidden = p.id !== 'tab-' + id;
  });
});

/* ─────────────  WebGL setup  ───────────── */
const canvas = document.getElementById('glcanvas');
const gl = canvas.getContext('webgl', { preserveDrawingBuffer: true, alpha: false });

const VERT = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = vec2(aPos.x * 0.5 + 0.5, 1.0 - (aPos.y * 0.5 + 0.5));
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FRAG = `
precision highp float;
varying vec2 vUv;
uniform sampler2D uTex;
uniform vec2  uTexel;     // 1 / source size
uniform float uSharp;     // 0..1
uniform float uDenoise;   // 0..1
uniform float uSat;       // 0..2
uniform float uVib;       // 0..1
uniform float uContrast;  // ~0.5..1.6
uniform float uBright;    // -0.25..0.25
uniform float uBlack;     // 0..0.2  (black-point lift removal)
uniform float uCompare;   // 0/1
uniform float uSplit;     // 0..1
uniform vec2  uUvScale;   // crop/reframe: source UV span shown
uniform vec2  uUvOffset;  // crop/reframe: source UV origin

vec3 tap(vec2 uv) { return texture2D(uTex, uv).rgb; }

void main() {
  vec2 uv = vUv * uUvScale + uUvOffset;   // apply crop / 9:16 reframe
  vec3 orig = tap(uv);

  // ── light denoise (3x3 mean, blended) ──
  vec3 base = orig;
  if (uDenoise > 0.001) {
    vec3 s = vec3(0.0);
    for (int y = -1; y <= 1; y++)
      for (int x = -1; x <= 1; x++)
        s += tap(uv + uTexel * vec2(float(x), float(y)));
    base = mix(orig, s / 9.0, uDenoise * 0.7);
  }

  // ── Contrast Adaptive Sharpening (FidelityFX CAS, simplified) ──
  vec3 a = tap(uv + uTexel * vec2(-1.0, -1.0));
  vec3 b = tap(uv + uTexel * vec2( 0.0, -1.0));
  vec3 c = tap(uv + uTexel * vec2( 1.0, -1.0));
  vec3 d = tap(uv + uTexel * vec2(-1.0,  0.0));
  vec3 e = base;
  vec3 f = tap(uv + uTexel * vec2( 1.0,  0.0));
  vec3 g = tap(uv + uTexel * vec2(-1.0,  1.0));
  vec3 h = tap(uv + uTexel * vec2( 0.0,  1.0));
  vec3 i = tap(uv + uTexel * vec2( 1.0,  1.0));

  vec3 mn = min(min(min(d, e), min(f, b)), h);
  mn += min(mn, min(min(a, c), min(g, i)));
  vec3 mx = max(max(max(d, e), max(f, b)), h);
  mx += max(mx, max(max(a, c), max(g, i)));

  vec3 amp = clamp(min(mn, 2.0 - mx) / max(mx, vec3(1e-4)), 0.0, 1.0);
  amp = sqrt(amp);
  float peak = -1.0 / 5.0;                 // full-strength CAS weight
  vec3 w = amp * peak;
  vec3 sharp = (b * w + d * w + f * w + h * w + e) / (1.0 + 4.0 * w);

  vec3 col = mix(base, sharp, uSharp);

  // ── colour grade ──
  col += uBright;
  col = (col - 0.5) * uContrast + 0.5;

  // Deepen blacks: R6 at high in-game brightness lifts the black floor, so
  // rescale from a raised black point back down to 0 to restore contrast.
  col = (col - uBlack) / max(1.0 - uBlack, 1e-3);
  col = clamp(col, 0.0, 1.0);

  float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(l), col, uSat);                      // saturation

  float mxc = max(col.r, max(col.g, col.b));
  float mnc = min(col.r, min(col.g, col.b));
  float satv = mxc - mnc;
  col = mix(vec3(l), col, 1.0 + uVib * (1.0 - satv)); // vibrance

  col = clamp(col, 0.0, 1.0);

  // ── before/after split ──
  if (uCompare > 0.5) {
    if (vUv.x < uSplit) col = orig;
    if (abs(vUv.x - uSplit) < 0.0015) col = vec3(0.73, 0.55, 1.0);
  }

  gl_FragColor = vec4(col, 1.0);
}`;

function compile(type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
    throw new Error(gl.getShaderInfoLog(s));
  return s;
}

const prog = gl.createProgram();
gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
gl.linkProgram(prog);
gl.useProgram(prog);

const quad = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, quad);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
const aPos = gl.getAttribLocation(prog, 'aPos');
gl.enableVertexAttribArray(aPos);
gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

const tex = gl.createTexture();
gl.bindTexture(gl.TEXTURE_2D, tex);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);

const U = {};
['uTexel', 'uSharp', 'uDenoise', 'uSat', 'uVib', 'uContrast', 'uBright', 'uBlack', 'uCompare', 'uSplit', 'uUvScale', 'uUvOffset']
  .forEach(n => U[n] = gl.getUniformLocation(prog, n));

/* ─────────────  State  ───────────── */
const video = document.getElementById('srcVideo');
let haveFrame = false;
let outW = 0, outH = 0;

const params = {
  sharp: 0.55, denoise: 0.12, sat: 1.14, vib: 0.30, contrast: 1.12, bright: -0.02, black: 0.05,
};
let compare = false, splitX = 0.5;
let aspect = 'source';        // 'source' | '9x16'
let reframe = 0;              // -0.5..0.5 pan within the crop
const crop = { sx: 1, sy: 1, ox: 0, oy: 0 };   // source UV transform

// Tuned for R6 Siege on 65 in-game brightness: that setting lifts the black
// floor (flat / greyish look), so the defaults add contrast + deepen blacks
// rather than adding brightness, then boost vibrance so colours pop after
// TikTok re-compresses the upload.
const PRESETS = {
  'R6 · 65 bright': { sharp: 0.55, denoise: 0.12, sat: 1.14, vib: 0.30, contrast: 1.12, bright: -0.02, black: 0.05 },
  'Punchy':         { sharp: 0.70, denoise: 0.08, sat: 1.28, vib: 0.38, contrast: 1.18, bright: -0.03, black: 0.07 },
  'Clean/soft':     { sharp: 0.35, denoise: 0.35, sat: 1.06, vib: 0.18, contrast: 1.04, bright: 0.00,  black: 0.02 },
  'Max sharp':      { sharp: 0.92, denoise: 0.05, sat: 1.16, vib: 0.32, contrast: 1.12, bright: -0.02, black: 0.05 },
  'None':           { sharp: 0.00, denoise: 0.00, sat: 1.00, vib: 0.00, contrast: 1.00, bright: 0.00,  black: 0.00 },
};

/* Remember the user's settings between visits. */
const LS_KEY = 'losinnqual.settings.v1';
function saveSettings() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({
      params,
      quality: document.getElementById('qualitySelect').value,
      aspect, reframe,
      mute: document.getElementById('muteChk').checked,
    }));
  } catch (_) { /* private mode / storage disabled — just don't persist */ }
}
function loadSettings() {
  let s;
  try { s = JSON.parse(localStorage.getItem(LS_KEY) || 'null'); } catch (_) { return; }
  if (!s) return;
  if (s.params) Object.assign(params, s.params);
  const q = document.getElementById('qualitySelect');
  if (s.quality && [...q.options].some(o => o.value === s.quality)) q.value = s.quality;
  if (s.aspect) {
    aspect = s.aspect;
    document.getElementById('aspectSelect').value = aspect;
    document.getElementById('reframeCtrl').hidden = aspect === 'source';
  }
  if (typeof s.reframe === 'number') {
    reframe = s.reframe;
    document.getElementById('s-reframe').value = reframe;
    document.getElementById('v-reframe').textContent = reframe.toFixed(2);
  }
  if (s.mute) document.getElementById('muteChk').checked = true;
}

/* ── Profiles: user-saved looks (separate from the built-in presets) ── */
const PROF_KEY = 'losinnqual.profiles.v1';
function getProfiles() { try { return JSON.parse(localStorage.getItem(PROF_KEY) || '{}'); } catch (_) { return {}; } }
function setProfiles(p) { try { localStorage.setItem(PROF_KEY, JSON.stringify(p)); } catch (_) {} }
function refreshProfileList(selName) {
  const el = document.getElementById('profileSelect');
  const names = Object.keys(getProfiles());
  el.innerHTML = '';
  const ph = document.createElement('option');
  ph.value = '';
  ph.textContent = names.length ? 'Your saved profiles…' : 'No profiles yet — save one below';
  el.appendChild(ph);
  names.forEach(n => { const o = document.createElement('option'); o.value = n; o.textContent = n; el.appendChild(o); });
  if (selName) el.value = selName;
}
function applyParams(prms) {
  Object.assign(params, prms);
  markPresetCustom();
  syncUI();
  if (haveFrame) render();
  saveSettings();
}
function saveProfileFromParams(prms) {
  const name = (prompt('Name this profile:') || '').trim();
  if (!name) return null;
  const p = getProfiles(); p[name] = { ...prms }; setProfiles(p); refreshProfileList(name);
  return name;
}
// Turn an analysed look into Enhance parameters (shared by the Analyse tab).
function lookToParams(look) {
  const { B, C, S, Sh } = look;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  return {
    sharp:    +clamp((Sh - 10) / 70, 0, 1).toFixed(2),
    denoise:  params.denoise,
    sat:      +clamp(1 + (S - 30) / 70 * 0.8, 0.6, 1.9).toFixed(2),
    vib:      +clamp((S - 30) / 70 * 0.4, 0, 0.5).toFixed(2),
    contrast: +clamp(1 + (C - 40) / 60 * 0.5, 0.6, 1.5).toFixed(2),
    bright:   +clamp((B - 50) / 100 * 0.4, -0.2, 0.2).toFixed(2),
    black:    +clamp((C - 40) / 60 * 0.06, 0, 0.08).toFixed(3),
  };
}

document.getElementById('profileSave').addEventListener('click', () => saveProfileFromParams(params));
document.getElementById('profileApply').addEventListener('click', () => {
  const n = document.getElementById('profileSelect').value; if (!n) return;
  const p = getProfiles(); if (p[n]) applyParams(p[n]);
});
document.getElementById('profileDelete').addEventListener('click', () => {
  const n = document.getElementById('profileSelect').value; if (!n) return;
  if (!confirm('Delete profile "' + n + '"?')) return;
  const p = getProfiles(); delete p[n]; setProfiles(p); refreshProfileList();
});
refreshProfileList();

/* ─────────────  Rendering  ───────────── */
function render() {
  if (!haveFrame || video.readyState < 2) return;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, video);

  gl.uniform2f(U.uTexel, 1 / video.videoWidth, 1 / video.videoHeight);
  gl.uniform1f(U.uSharp, params.sharp);
  gl.uniform1f(U.uDenoise, params.denoise);
  gl.uniform1f(U.uSat, params.sat);
  gl.uniform1f(U.uVib, params.vib);
  gl.uniform1f(U.uContrast, params.contrast);
  gl.uniform1f(U.uBright, params.bright);
  gl.uniform1f(U.uBlack, params.black);
  gl.uniform1f(U.uCompare, compare ? 1 : 0);
  gl.uniform1f(U.uSplit, splitX);
  gl.uniform2f(U.uUvScale, crop.sx, crop.sy);
  gl.uniform2f(U.uUvOffset, crop.ox, crop.oy);

  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

function loop() {
  if (!video.paused && !video.ended) render();
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

/* ─────────────  Output quality  ─────────────
 * One picker sets both the target resolution and the bitrate. The value is
 * "<longEdgePx>|<mbps>"; 0 px means "keep the source resolution". */
function getQuality() {
  const [res, mbps] = document.getElementById('qualitySelect').value.split('|');
  return { res: parseInt(res, 10), mbps: parseInt(mbps, 10) };
}

function computeOutSize() {
  const target = getQuality().res;
  const vw = video.videoWidth, vh = video.videoHeight;
  const srcA = vw / vh;

  // Output aspect: keep the source, or force TikTok's 9:16.
  const outA = aspect === '9x16' ? (9 / 16) : srcA;

  // Output pixels: long edge = chosen resolution (or source long edge).
  const long = target || Math.max(vw, vh);
  if (outA >= 1) { outW = long; outH = Math.round(long / outA); }
  else           { outH = long; outW = Math.round(long * outA); }
  outW = Math.round(outW / 2) * 2;               // keep even (encoder-friendly)
  outH = Math.round(outH / 2) * 2;
  canvas.width = outW;
  canvas.height = outH;

  computeCrop(srcA, outA);
  updateMeta();
  updateQualityNote();
}

// Fill the output aspect from the source (crop the overflowing axis), honouring
// the reframe pan. When aspects match this is a no-op (whole frame shown).
function computeCrop(srcA, outA) {
  if (srcA > outA) {          // source wider than target → crop width
    crop.sx = outA / srcA; crop.sy = 1;
    const room = 1 - crop.sx;
    crop.ox = room * (0.5 + reframe); crop.oy = 0;
    crop.ox = Math.max(0, Math.min(room, crop.ox));
  } else if (srcA < outA) {   // source taller than target → crop height
    crop.sy = srcA / outA; crop.sx = 1;
    const room = 1 - crop.sy;
    crop.oy = room * (0.5 + reframe); crop.ox = 0;
    crop.oy = Math.max(0, Math.min(room, crop.oy));
  } else {
    crop.sx = 1; crop.sy = 1; crop.ox = 0; crop.oy = 0;
  }
}

// Honest, Wink-style explainer under the picker: upscaling past the source
// doesn't invent detail, the sharpening/grade is what makes it look cleaner.
function updateQualityNote() {
  const note = document.getElementById('qualityNote');
  if (!note) return;
  const { res, mbps } = getQuality();
  const vw = video.videoWidth || 0, vh = video.videoHeight || 0;
  const long = Math.max(vw, vh);
  let msg = `Exports ${outW || '—'}×${outH || '—'} at ~${mbps} Mbps, 60fps.`;
  if (res && long && res > long)
    msg += ` Upscaling from ${long}p — the sharpen + grade do the visible work; it won't add real detail past the source.`;
  else if (res && long && res < long)
    msg += ` Downscaling from ${long}p — sharper and smaller, ideal for TikTok.`;
  note.textContent = msg;
}

function updateMeta() {
  const el = document.getElementById('stageMeta');
  if (!video.videoWidth) { el.textContent = ''; return; }
  el.textContent = `Source ${video.videoWidth}×${video.videoHeight} → output ${outW}×${outH}`;
}

/* ─────────────  Load a file  ───────────── */
const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');
const previewWrap = document.getElementById('previewWrap');

let srcFileSize = 0;

function loadFile(file) {
  if (!file || !file.type.startsWith('video/')) {
    setStatus('That doesn\'t look like a video file.', 'err');
    return;
  }
  srcFileSize = file.size || 0;
  video.src = URL.createObjectURL(file);
  video.muted = true;
  video.preload = 'auto';
  video.onloadeddata = async () => {
    // Many phone / previously-exported clips report duration = Infinity or 0,
    // which made the recorder stop after ~2s. Force the real duration first.
    if (!isFinite(video.duration) || video.duration <= 0) await fixDuration();
    haveFrame = true;
    dropZone.hidden = true;
    previewWrap.hidden = false;
    document.getElementById('exportBtn').disabled = false;
    computeOutSize();
    render();
    updateTcode();
    resetTrim();
  };
  video.onended = () => { playBtn.textContent = '▶ Play'; };
}

// Coax a real duration out of a clip whose metadata says Infinity/0 by seeking
// far past the end; the browser clamps to the true end and updates duration.
function fixDuration() {
  return new Promise((res) => {
    let done = false;
    const finish = () => {
      if (done) return; done = true;
      video.removeEventListener('durationchange', check);
      video.removeEventListener('timeupdate', check);
      try { video.currentTime = 0; } catch (_) {}
      res();
    };
    const check = () => { if (isFinite(video.duration) && video.duration > 0) finish(); };
    video.addEventListener('durationchange', check);
    video.addEventListener('timeupdate', check);
    try { video.currentTime = 1e101; } catch (_) { finish(); }
    setTimeout(finish, 2500);   // safety: never hang the load
  });
}

// Keep the screen awake during export so mobile dimming can't stall capture.
let wakeLock = null;
async function acquireWake() {
  try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); }
  catch (_) { /* not supported / denied — fine */ }
}
function releaseWake() { try { wakeLock && wakeLock.release(); } catch (_) {} wakeLock = null; }

dropZone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => loadFile(fileInput.files[0]));
['dragenter', 'dragover'].forEach(ev =>
  dropZone.addEventListener(ev, (e) => { e.preventDefault(); dropZone.classList.add('dragover'); }));
['dragleave', 'drop'].forEach(ev =>
  dropZone.addEventListener(ev, (e) => { e.preventDefault(); dropZone.classList.remove('dragover'); }));
dropZone.addEventListener('drop', (e) => loadFile(e.dataTransfer.files[0]));

document.getElementById('qualitySelect').addEventListener('change', () => {
  saveSettings();
  if (haveFrame) { computeOutSize(); render(); }
  else updateQualityNote();
});

/* ─────────────  Framing (aspect + reframe)  ───────────── */
const aspectSelect = document.getElementById('aspectSelect');
const reframeCtrl = document.getElementById('reframeCtrl');
aspectSelect.addEventListener('change', () => {
  aspect = aspectSelect.value;
  reframeCtrl.hidden = aspect === 'source';
  saveSettings();
  if (haveFrame) { computeOutSize(); render(); }
});
document.getElementById('s-reframe').addEventListener('input', (e) => {
  reframe = parseFloat(e.target.value);
  document.getElementById('v-reframe').textContent = reframe.toFixed(2);
  if (haveFrame) {
    computeCrop(video.videoWidth / video.videoHeight, aspect === '9x16' ? 9 / 16 : video.videoWidth / video.videoHeight);
    render();
  }
  saveSettings();
});
document.getElementById('muteChk').addEventListener('change', saveSettings);

/* ─────────────  Transport  ───────────── */
const playBtn = document.getElementById('playBtn');
const scrub = document.getElementById('scrub');

playBtn.addEventListener('click', () => {
  if (video.paused) {
    // Start from the trim-in if we're outside the selected range.
    if (video.currentTime < inPoint || video.currentTime >= effOut() - 0.05) video.currentTime = inPoint;
    video.play(); playBtn.textContent = '❚❚ Pause';
  } else { video.pause(); playBtn.textContent = '▶ Play'; }
});

video.addEventListener('timeupdate', () => {
  if (!scrub.matches(':active')) scrub.value = (video.currentTime / video.duration) * 1000 || 0;
  updateTcode();
});
scrub.addEventListener('input', () => {
  video.currentTime = (scrub.value / 1000) * video.duration;
  render();
});

function fmt(t) {
  t = Math.max(0, t | 0);
  return `${(t / 60) | 0}:${String(t % 60).padStart(2, '0')}`;
}
function updateTcode() {
  document.getElementById('tcode').textContent = `${fmt(video.currentTime)} / ${fmt(video.duration || 0)}`;
}

/* before/after split */
const compareChk = document.getElementById('compareChk');
compareChk.addEventListener('change', () => { compare = compareChk.checked; render(); });

// Pointer events cover both mouse drag and touch drag (phones/tablets).
function moveSplit(clientX) {
  if (!compare) return;
  const r = canvas.getBoundingClientRect();
  splitX = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
  render();
}
canvas.addEventListener('pointermove', (e) => moveSplit(e.clientX));
canvas.addEventListener('pointerdown', (e) => moveSplit(e.clientX));

/* ─────────────  Trim (in / out points)  ─────────────
 * Pick just the best moment of a clip to export, instead of the whole thing.
 * inPoint/outPoint are in seconds; outPoint === null means "to the end". */
let inPoint = 0;
let outPoint = null;

function effOut() { return outPoint == null ? (video.duration || 0) : outPoint; }

function resetTrim() { inPoint = 0; outPoint = null; updateTrimUI(); }

function updateTrimUI() {
  const rangeEl = document.getElementById('trimRange');
  const resetBtn = document.getElementById('trimResetBtn');
  const trimmed = inPoint > 0.01 || outPoint != null;
  resetBtn.hidden = !trimmed;
  if (!trimmed) { rangeEl.textContent = 'full clip'; return; }
  rangeEl.textContent = `${fmt(inPoint)} → ${fmt(effOut())} (${Math.max(0, effOut() - inPoint).toFixed(1)}s)`;
}

document.getElementById('setInBtn').addEventListener('click', () => {
  inPoint = video.currentTime;
  if (outPoint != null && inPoint >= outPoint) outPoint = null;
  updateTrimUI();
});
document.getElementById('setOutBtn').addEventListener('click', () => {
  outPoint = video.currentTime;
  if (outPoint <= inPoint) inPoint = 0;
  updateTrimUI();
});
document.getElementById('trimResetBtn').addEventListener('click', resetTrim);

// While previewing (not recording), stop at the trim end so you can see the cut.
video.addEventListener('timeupdate', () => {
  if (!recording && outPoint != null && !video.paused && video.currentTime >= outPoint) {
    video.pause();
    playBtn.textContent = '▶ Play';
  }
});

/* ─────────────  Controls  ───────────── */
const SLIDERS = {
  'sharp': 's-sharp', 'denoise': 's-denoise', 'sat': 's-sat',
  'vib': 's-vib', 'contrast': 's-contrast', 'bright': 's-bright', 'black': 's-black',
};
const VALS = {
  'sharp': 'v-sharp', 'denoise': 'v-denoise', 'sat': 'v-sat',
  'vib': 'v-vib', 'contrast': 'v-contrast', 'bright': 'v-bright', 'black': 'v-black',
};
const PCT = { sharp: 1, denoise: 1, vib: 1, black: 1 };   // shown as %

function fmtVal(k) {
  return PCT[k] ? Math.round(params[k] * 100) + '%' : params[k].toFixed(2);
}

function syncUI() {
  for (const k in SLIDERS) {
    document.getElementById(SLIDERS[k]).value = params[k];
    document.getElementById(VALS[k]).textContent = fmtVal(k);
  }
}

for (const k in SLIDERS) {
  document.getElementById(SLIDERS[k]).addEventListener('input', (e) => {
    params[k] = parseFloat(e.target.value);
    document.getElementById(VALS[k]).textContent = fmtVal(k);
    markPresetCustom();
    render();
    saveSettings();
  });
}

/* presets */
const presetRow = document.getElementById('presetRow');
Object.keys(PRESETS).forEach((name) => {
  const b = document.createElement('button');
  b.className = 'preset';
  b.textContent = name;
  b.dataset.preset = name;
  if (name === 'R6 · 65 bright') b.classList.add('active');
  b.addEventListener('click', () => {
    Object.assign(params, PRESETS[name]);
    document.querySelectorAll('.preset').forEach(p => p.classList.toggle('active', p === b));
    syncUI();
    render();
    saveSettings();
  });
  presetRow.appendChild(b);
});
function markPresetCustom() {
  document.querySelectorAll('.preset').forEach(p => p.classList.remove('active'));
}
loadSettings();     // restore saved sliders/quality/framing before first paint
syncUI();
updateQualityNote();

/* ─────────────  Export  ───────────── */
const exportBtn = document.getElementById('exportBtn');
const statusEl = document.getElementById('exportStatus');

function setStatus(msg, cls) {
  statusEl.className = 'export-status' + (cls ? ' ' + cls : '');
  statusEl.innerHTML = msg;
}

function pickMime() {
  // Prefer H.264 + AAC MP4 (what TikTok decodes most reliably). Full a/v codec
  // strings first so the browser muxes a standard file, then looser fallbacks.
  const list = [
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/mp4;codecs=avc1.42E01E',
    'video/mp4;codecs=h264,aac',
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];
  for (const m of list) if (MediaRecorder.isTypeSupported(m)) return m;
  return '';
}

// Report the export format up front so nobody's surprised by a .webm, and warn
// about the main TikTok "couldn't decode" cause (webm / iOS recorder).
(function noteFormat() {
  const mime = pickMime();
  const note = document.getElementById('fmtNote');
  if (!mime) { note.textContent = 'Recording isn\'t supported in this browser — use Chrome or Edge.'; return; }
  if (mime.startsWith('video/mp4'))
    note.innerHTML = 'Exports <b>.mp4 (H.264)</b> — TikTok reads this directly.';
  else
    note.innerHTML = 'This browser records <b>.webm</b>, which is what TikTok often <b>can\'t decode</b>. ' +
      'For a TikTok-ready .mp4, export in <b>Chrome or Edge on a computer</b> (or re-save the .webm through CapCut).';
})();

// Phone support: works on Android Chrome and modern iOS Safari. Pick a clip
// from the camera roll with the drop zone (it opens the file picker on a tap).
// iOS's MediaRecorder is newer/flakier, so warn if export might not record.
(function noteMobile() {
  const ua = navigator.userAgent;
  const isMobile = /Android|iPhone|iPad|iPod/i.test(ua);
  if (!isMobile) return;
  const el = document.getElementById('mobileNote');
  el.hidden = false;
  const isIOS = /iPhone|iPad|iPod/i.test(ua);
  el.innerHTML = 'On phone: tap the box to pick a clip from your camera roll. ' +
    (isIOS
      ? 'On iPhone, sharpening/preview works; if <b>Export</b> fails, use Chrome on Android or a laptop for the final render (iOS Safari\'s recorder is limited).'
      : 'Export works in Chrome on Android. Keep the screen on while it renders.');
})();

let recording = false;

exportBtn.addEventListener('click', async () => {
  if (recording || !haveFrame) return;
  const mime = pickMime();
  if (!mime) { setStatus('Your browser can\'t record video. Use Chrome or Edge.', 'err'); return; }

  recording = true;
  exportBtn.disabled = true;
  compare = false; compareChk.checked = false;
  const wasMuted = video.muted;
  await acquireWake();

  const mbps = getQuality().mbps;
  const fps = 60;   // keep 60 for smooth gameplay

  // Draw a fresh frame first so the stream starts on real content, not a blank
  // or stale canvas (a blank first frame can corrupt the file's start).
  render();

  // Build the output stream: processed canvas video + original audio.
  // Manual-capture mode (captureStream(0) + requestFrame per decoded video
  // frame) makes recording deterministic instead of relying on the animation
  // loop, which the browser throttles when the screen dims — the old cause of
  // clips getting cut short.
  const muteOut = document.getElementById('muteChk').checked;
  const useManual = 'requestVideoFrameCallback' in video;
  const stream = canvas.captureStream(useManual ? 0 : fps);
  const vTrack = stream.getVideoTracks()[0];
  if (!muteOut) {
    try {
      video.muted = false;                       // needed so audio is in the capture
      const audio = video.captureStream ? video.captureStream()
                  : video.mozCaptureStream ? video.mozCaptureStream() : null;
      if (audio) audio.getAudioTracks().forEach(t => stream.addTrack(t));
    } catch (_) { /* no audio track — export silent video */ }
  }

  let rec;
  try {
    rec = new MediaRecorder(stream, {
      mimeType: mime,
      videoBitsPerSecond: mbps * 1_000_000,
      audioBitsPerSecond: 192_000,
    });
  } catch (err) {
    setStatus('Could not start recorder: ' + err.message, 'err');
    recording = false; exportBtn.disabled = false; video.muted = wasMuted;
    return;
  }

  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };

  const ext = mime.startsWith('video/mp4') ? 'mp4' : 'webm';
  setStatus('<span>Rendering in real time — keep this tab open…</span>' +
    '<div class="progress"><i id="pbar"></i></div>', 'busy');

  const start = inPoint, end = effOut();
  let safetyTimer = 0;
  const onProg = () => {
    // Stop at the trim-out point OR the true end of the clip (backup to 'ended').
    if (video.currentTime >= end - 0.05) { finish(); return; }
    const pb = document.getElementById('pbar');
    if (pb && end > start) pb.style.width = ((video.currentTime - start) / (end - start) * 100) + '%';
  };
  video.addEventListener('timeupdate', onProg);

  rec.onstop = () => {
    clearTimeout(safetyTimer);
    video.removeEventListener('timeupdate', onProg);
    video.removeEventListener('ended', finish);
    video.muted = wasMuted;
    releaseWake();
    const blob = new Blob(chunks, { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `losinn_${outW}x${outH}.${ext}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    const outMB = blob.size / 1048576;
    let msg = `✓ Saved <b>losinn_${outW}x${outH}.${ext}</b> — ${outMB.toFixed(1)} MB`;
    if (srcFileSize) {
      const inMB = srcFileSize / 1048576;
      const pct = Math.round((1 - blob.size / srcFileSize) * 100);
      msg += pct > 0 ? `, <b>${pct}% smaller</b> than the ${inMB.toFixed(1)} MB original.`
                     : ` (original ${inMB.toFixed(1)} MB — pick a smaller quality option to shrink it).`;
    } else msg += '.';
    setStatus(msg, '');
    recording = false;
    exportBtn.disabled = false;
    playBtn.textContent = '▶ Play';
  };

  const finish = () => { if (rec.state !== 'inactive') rec.stop(); video.pause(); };
  video.addEventListener('ended', finish, { once: true });

  video.pause();
  video.currentTime = inPoint;
  await new Promise(r => { video.onseeked = r; });
  video.onseeked = null;

  rec.start(250);   // flush data every 250ms so the file finalises cleanly
  // Hard safety net: if playback stalls or 'ended' never fires, stop anyway.
  safetyTimer = setTimeout(finish, (end - start) * 1000 + 5000);
  try { await video.play(); }
  catch (err) { setStatus('Playback blocked: ' + err.message, 'err'); finish(); }
  playBtn.textContent = '❚❚ Recording…';

  // Render + push one frame per decoded video frame (deterministic capture).
  if (useManual) {
    const pump = () => {
      if (!recording) return;
      render();
      try { vTrack.requestFrame && vTrack.requestFrame(); } catch (_) {}
      video.requestVideoFrameCallback(pump);
    };
    video.requestVideoFrameCallback(pump);
  }
});

/* ─────────────  Info tabs content  ───────────── */
document.getElementById('tab-capcut').innerHTML = `
  <div class="info-card">
    <h3>CapCut export settings — best quality for Siege clips</h3>
    <div class="sub">Set these in the export dialog (the ⬆ / "Export" screen). Match your source; don't invent frames.</div>
    <table class="setting-table">
      <tr><td>Resolution</td><td><b>1080p</b> for TikTok (it resizes everything to 1080×1920 anyway). Only pick 4K if your source is genuinely 4K and you want a master copy.</td></tr>
      <tr><td>Frame rate</td><td><b>60fps</b> — Xbox R6 clips record at 60, and gameplay is high-motion, so 60 survives TikTok's compression far better than 30.</td></tr>
      <tr><td>Bit rate</td><td>Set to <b>Higher / Custom</b>. For a TikTok upload <b>~16–24 Mbps</b> at 1080p is the sweet spot — going above ~20–25 gets flattened by TikTok anyway. This is the #1 thing that kills quality when left on "Recommended".</td></tr>
      <tr><td>Codec</td><td><b>H.264</b> (High Profile) for max compatibility, or <b>HEVC (H.265)</b> for a smaller master at the same quality.</td></tr>
      <tr><td>Format</td><td><b>MP4</b>.</td></tr>
      <tr><td>Smart HDR</td><td><b>Off</b> unless your source is real HDR — it can wash out SDR game clips.</td></tr>
      <tr><td>Aspect ratio</td><td><b>9:16</b> for TikTok. Set the canvas ratio at the start of the project, not on export.</td></tr>
    </table>
    <div class="callout">
      <b>Editing tips for R6:</b> keep CapCut's own "Sharpen" around <b>10–25</b> (more looks crunchy).
      Use CapCut's <b>Enhance / Super Resolution</b> toggle only on low-res source — on already-1080p clips it does little and can smear.
      Do your colour/sharpen in <b>this</b> app <i>after</i> CapCut so you're not stacking two rounds of compression sharpening.
    </div>
    <div class="callout">
      <b>Your 65 in-game brightness (important):</b> R6's brightness slider at 65 sits <i>above</i> the ~50 default,
      which <b>lifts the black floor</b> — shadows go grey and the whole clip looks flat and washed. The fix is <i>not</i> more brightness.
      In this app use the <b>"R6 · 65 bright"</b> preset: it adds <b>Contrast ~1.12</b>, a small <b>Brightness −0.02</b>, and
      <b>Deepen blacks ~5%</b> to pull those lifted blacks back down, plus <b>Vibrance ~30%</b> so colours pop after upload.
    </div>
  </div>
  <div class="info-card">
    <h3>⭐ The single best-quality thing you can do inside CapCut</h3>
    <div class="sub">If you change one thing, change this.</div>
    <ul class="tip-list">
      <li><b>Use the custom Bit rate slider, not "Recommended".</b> On the export screen tap the bitrate dropdown → <b>Custom</b> and drag it high (aim <b>~24 Mbps</b> for a 1080p master). CapCut's "Recommended" is deliberately low to save space — it's the biggest hidden quality killer.</li>
      <li><b>Match the project to your source, don't upscale in CapCut.</b> Set the project to <b>1080p 60fps</b> for a 1080p Xbox clip. Exporting a 1080p clip at "4K" just bloats the file with no new detail — do the upscaling in <b>this app</b> instead.</li>
      <li><b>Export HEVC (H.265) if you want the cleanest master</b> at a smaller size, then enhance + convert to H.264 here for TikTok. Same quality, less generation loss to carry forward.</li>
      <li><b>Do all your cuts/effects in one project and export once.</b> Every extra export is another lossy re-encode. Keep CapCut's own Sharpen modest (10–25) and leave the real sharpening/grading to this app.</li>
      <li><b>Turn off any "reduce size / smart compression" toggle</b> before exporting the master.</li>
    </ul>
    <div class="callout">
      <b>Bottom line:</b> CapCut = clean high-bitrate cut. <b>losinn qual</b> = sharpen + upscale + grade + trim.
      TikTok = final compression. Each step does one job, so nothing gets double-crushed.
    </div>
  </div>
  <div class="info-card">
    <h3>Avoid double compression</h3>
    <div class="sub">Every re-encode loses quality. Keep the chain short.</div>
    <ul class="tip-list">
      <li>Xbox clip → CapCut (edit once, export ~16–24 Mbps 1080p60) → <b>this app</b> (enhance, export) → TikTok. That's it.</li>
      <li>Don't export from CapCut, re-import, export again. Each pass adds mush and blocky artefacts.</li>
      <li>Always feed this app the <b>highest-bitrate</b> version you have — it can't recover detail that compression already threw away.</li>
    </ul>
  </div>`;

document.getElementById('tab-tiktok').innerHTML = `
  <div class="info-card">
    <h3>⚠ TikTok says "couldn't decode / unsupported"?</h3>
    <div class="sub">Almost always the file format — here's how to get one TikTok accepts.</div>
    <ul class="tip-list">
      <li><b>Check the file is .mp4, not .webm.</b> TikTok frequently rejects .webm. This app exports .mp4 in <b>Chrome or Edge</b>; some browsers (older or in-app ones) fall back to .webm — the note under the Export button tells you which you'll get.</li>
      <li><b>iPhone is the usual culprit.</b> iOS Safari's recorder can make files TikTok won't read. Do the <b>Export</b> step in <b>Chrome on Android</b> or <b>Chrome/Edge on a computer</b> — you can still enhance/preview on iPhone, just export elsewhere.</li>
      <li><b>If you already have a .webm,</b> drop it into CapCut and export it as MP4 (H.264) — that re-wraps it into something TikTok reads.</li>
      <li><b>Still failing?</b> Try the <b>HD · 1080p</b> quality option (not 4K) — huge files from a phone can finish half-written and won't decode.</li>
    </ul>
  </div>
  <div class="info-card">
    <h3>Get the most views + best quality on TikTok</h3>
    <div class="sub">TikTok compresses hard. These settings and habits fight that and help the algorithm.</div>
    <ul class="tip-list">
      <li><b>Turn on HD upload:</b> Profile → ☰ → Settings → <b>"Data Saver" OFF</b>, and on the post screen tick <b>"Upload HD"</b> / "Allow high-quality uploads". Huge difference.</li>
      <li><b>Upload 1080×1920, 9:16, MP4 (H.264), 60fps.</b> Fills the screen, no black bars. Keep the video bitrate around <b>10–16 Mbps</b> — under ~5 gets a quality-downgrade flag, over ~20 gets flattened anyway.</li>
      <li><b>Never re-upload a downloaded/compressed clip.</b> Post the cleanest master you have — that's what this app exports.</li>
      <li><b>Hook in the first 1–2 seconds:</b> best frag / clutch first, context after. Watch-time and rewatches drive the algorithm more than likes.</li>
      <li><b>Use a trending sound</b> (even low, under your gameplay audio) — TikTok pushes videos on rising sounds.</li>
      <li><b>Keep UI safe zones clear:</b> don't put kills/important action in the far-right or bottom third — buttons and captions cover it.</li>
      <li><b>3–5 relevant hashtags:</b> mix broad + niche, e.g. #rainbowsixsiege #r6 #r6clips #gaming #fyp. Don't spam 30.</li>
      <li><b>Post at peak times</b> for your audience (evenings / weekends for gaming) and stay consistent — a few posts a week beats one big drop.</li>
      <li><b>Add a short caption / on-screen text</b> so it reads with sound off, and reply to early comments to boost reach.</li>
      <li><b>Loop it:</b> clips that end where they began get rewatched, and rewatches count as extra views.</li>
    </ul>
    <div class="callout">
      <b>Quality reality check:</b> TikTok will always re-compress your upload. You can't stop that — but giving it a
      sharp, high-bitrate, correctly-sized master (HD upload ON) means what survives compression looks far better than a soft, dark, low-bitrate clip.
    </div>
  </div>`;

/* ─────────────  Analyse tab  ─────────────
 * Samples several frames of a dropped clip and measures its current look:
 * brightness, contrast, saturation, warmth and sharpness. It reports what the
 * video looks like now — it cannot recover the exact CapCut slider values used,
 * because a finished, re-encoded video no longer stores that edit history. */
(function () {
  const drop = document.getElementById('anDrop');
  const fileIn = document.getElementById('anFile');
  const busy = document.getElementById('anBusy');
  const results = document.getElementById('anResults');
  const cvs = document.getElementById('anCanvas');
  const anVideo = document.createElement('video');
  anVideo.muted = true; anVideo.playsInline = true; anVideo.preload = 'auto';

  drop.addEventListener('click', () => fileIn.click());
  fileIn.addEventListener('change', () => { if (fileIn.files[0]) run(fileIn.files[0]); });
  ['dragenter', 'dragover'].forEach(ev =>
    drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('dragover'); }));
  ['dragleave', 'drop'].forEach(ev =>
    drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('dragover'); }));
  drop.addEventListener('drop', e => { if (e.dataTransfer.files[0]) run(e.dataTransfer.files[0]); });
  document.getElementById('anAgain').addEventListener('click', () => {
    results.hidden = true; drop.hidden = false;
  });

  let lastLook = null;

  // Map an analysed look to Enhance settings, then jump there. Approximate on
  // purpose: the Enhance sliders are adjustments applied to whatever clip you
  // load, so these push a clip toward the analysed look.
  document.getElementById('anUse').addEventListener('click', () => {
    if (!lastLook) return;
    applyParams(lookToParams(lastLook));
    document.querySelector('.tab[data-tab="enhance"]').click();
    const es = document.getElementById('exportStatus');
    if (es) { es.className = 'export-status'; es.textContent = 'Loaded these readings as a starting point — tweak to taste.'; }
  });

  // Save the analysed look straight to a reusable profile.
  document.getElementById('anSaveProfile').addEventListener('click', () => {
    if (!lastLook) return;
    const name = saveProfileFromParams(lookToParams(lastLook));
    if (name) document.getElementById('anSummary').innerHTML += ` <b>Saved as profile "${name}".</b>`;
  });

  const seek = (t) => new Promise(res => {
    const on = () => { anVideo.removeEventListener('seeked', on); res(); };
    anVideo.addEventListener('seeked', on);
    try { anVideo.currentTime = t; } catch (_) { res(); }
  });

  async function run(file) {
    if (!file.type.startsWith('video/')) { showBusy('Please choose a video file.'); return; }
    drop.hidden = true; results.hidden = true;
    showBusy('Loading clip…');
    anVideo.src = URL.createObjectURL(file);
    try {
      await new Promise((res, rej) => { anVideo.onloadeddata = res; anVideo.onerror = () => rej(); });
    } catch (_) { fail('Could not read that video file.'); return; }
    if (!anVideo.videoWidth) { fail('Could not read that video file.'); return; }

    const W = 320, H = Math.max(1, Math.round(320 * anVideo.videoHeight / anVideo.videoWidth));
    cvs.width = W; cvs.height = H;
    const ctx = cvs.getContext('2d', { willReadFrequently: true });
    const dur = (anVideo.duration && isFinite(anVideo.duration)) ? anVideo.duration : 0;
    const N = 8;
    let count = 0, sumL = 0, sumL2 = 0, sumS = 0, sumR = 0, sumB = 0, sumEdge = 0, frames = 0;

    for (let i = 0; i < N; i++) {
      showBusy(`Analysing… ${Math.round(i / N * 100)}%`);
      const t = dur ? Math.min(dur * (i + 0.5) / N, Math.max(0, dur - 0.05)) : 0;
      await seek(t);
      try { ctx.drawImage(anVideo, 0, 0, W, H); } catch (_) {}
      let img;
      try { img = ctx.getImageData(0, 0, W, H).data; }
      catch (_) { fail('The browser blocked reading this video\'s frames.'); return; }

      const luma = new Float32Array(W * H);
      for (let p = 0, q = 0; p < img.length; p += 4, q++) {
        const r = img[p], g = img[p + 1], b = img[p + 2];
        const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        luma[q] = l;
        sumL += l; sumL2 += l * l;
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        sumS += mx > 0 ? (mx - mn) / mx : 0;
        sumR += r; sumB += b; count++;
      }
      let e = 0, ec = 0;
      for (let y = 0; y < H - 1; y++) for (let x = 0; x < W - 1; x++) {
        const idx = y * W + x;
        e += Math.abs(luma[idx] - luma[idx + 1]) + Math.abs(luma[idx] - luma[idx + W]);
        ec++;
      }
      if (ec) sumEdge += e / ec;
      frames++;
      if (!dur) break;
    }

    if (!count) { fail('Could not analyse that clip.'); return; }
    const meanL = sumL / count;
    const stdL = Math.sqrt(Math.max(0, sumL2 / count - meanL * meanL));
    const meanS = sumS / count;
    const warm = (sumR - sumB) / count;
    const edge = frames ? sumEdge / frames : 0;
    renderMetrics({ meanL, stdL, meanS, warm, edge });
    busy.hidden = true; results.hidden = false;
  }

  function showBusy(msg) { busy.hidden = false; busy.textContent = msg; }
  function fail(msg) { busy.hidden = false; busy.textContent = msg; drop.hidden = false; }

  // first threshold strictly greater than v wins
  function pick(v, table) { for (const [th, word] of table) if (v < th) return word; return table[table.length - 1][1]; }

  function renderMetrics(m) {
    const B = m.meanL / 255 * 100;
    const C = Math.min(100, m.stdL / 70 * 100);
    const S = Math.min(100, m.meanS * 100);
    const Sh = Math.min(100, m.edge / 18 * 100);
    const warmPct = Math.max(-100, Math.min(100, m.warm / 40 * 100));
    lastLook = { B, C, S, Sh, warm: m.warm };

    const bW = pick(B, [[30, 'Dark'], [42, 'Dim'], [58, 'Balanced'], [72, 'Bright'], [101, 'Very bright']]);
    const cW = pick(C, [[30, 'Flat'], [45, 'Medium'], [64, 'Punchy'], [101, 'Very punchy']]);
    const sW = pick(S, [[18, 'Muted'], [30, 'Natural'], [45, 'Vivid'], [101, 'Very saturated']]);
    const shW = pick(Sh, [[25, 'Soft'], [45, 'Natural'], [65, 'Sharpened'], [101, 'Heavily sharpened']]);
    const wW = m.warm < -6 ? 'Cool' : m.warm > 6 ? 'Warm' : 'Neutral';
    const warmLabel = wW === 'Neutral' ? 'Neutral' : `${wW} (${m.warm >= 0 ? '+' : '−'}${Math.abs(Math.round(m.warm))})`;

    document.getElementById('anSummary').innerHTML =
      `Overall this clip looks <b>${bW.toLowerCase()}</b>, <b>${cW.toLowerCase()}</b> contrast, ` +
      `<b>${sW.toLowerCase()}</b> colour, <b>${shW.toLowerCase()}</b>, and colour-wise <b>${wW.toLowerCase()}</b>. ` +
      `To recreate it on your own clip, open <b>Enhance</b> and push the sliders toward these readings.`;

    const warmHalf = Math.abs(warmPct) / 2;
    const warmLeft = m.warm >= 0 ? 50 : 50 - warmHalf;

    document.getElementById('anMetrics').innerHTML = [
      bar('Brightness', Math.round(B) + ' / 100', B, `${bW} — average lightness of the picture.`),
      bar('Contrast', Math.round(C) + ' / 100', C, `${cW} — gap between the darkest and brightest parts.`),
      bar('Saturation', Math.round(S) + ' / 100', S, `${sW} — how strong the colours are.`),
      bar('Sharpness', Math.round(Sh) + ' / 100', Sh, `${shW} — amount of fine edge detail.`),
      centreBar('Warmth', warmLabel, warmLeft, warmHalf, 'Cool (blue) ← → warm (orange).'),
    ].join('');
  }

  function bar(name, val, pct, desc) {
    return `<div class="metric">
      <div class="metric-head"><span>${name}</span><span class="mval">${val}</span></div>
      <div class="metric-bar"><div class="metric-fill" style="width:${pct}%"></div></div>
      <div class="metric-desc">${desc}</div>
    </div>`;
  }
  function centreBar(name, val, left, width, desc) {
    return `<div class="metric">
      <div class="metric-head"><span>${name}</span><span class="mval">${val}</span></div>
      <div class="metric-bar center"><div class="metric-fill" style="left:${left}%;width:${width}%"></div></div>
      <div class="metric-desc">${desc}</div>
    </div>`;
  }
})();
