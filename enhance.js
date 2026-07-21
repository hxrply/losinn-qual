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

vec3 tap(vec2 uv) { return texture2D(uTex, uv).rgb; }

void main() {
  vec2 uv = vUv;
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
    if (uv.x < uSplit) col = orig;
    if (abs(uv.x - uSplit) < 0.0015) col = vec3(0.73, 0.55, 1.0);
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
['uTexel', 'uSharp', 'uDenoise', 'uSat', 'uVib', 'uContrast', 'uBright', 'uBlack', 'uCompare', 'uSplit']
  .forEach(n => U[n] = gl.getUniformLocation(prog, n));

/* ─────────────  State  ───────────── */
const video = document.getElementById('srcVideo');
let haveFrame = false;
let outW = 0, outH = 0;

const params = {
  sharp: 0.55, denoise: 0.12, sat: 1.14, vib: 0.30, contrast: 1.12, bright: -0.02, black: 0.05,
};
let compare = false, splitX = 0.5;

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
  if (!target) { outW = vw; outH = vh; }        // keep original
  else {
    const long = Math.max(vw, vh);
    const scale = target / long;
    outW = Math.round(vw * scale / 2) * 2;      // keep even
    outH = Math.round(vh * scale / 2) * 2;
  }
  canvas.width = outW;
  canvas.height = outH;
  updateMeta();
  updateQualityNote();
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

function loadFile(file) {
  if (!file || !file.type.startsWith('video/')) {
    setStatus('That doesn\'t look like a video file.', 'err');
    return;
  }
  video.src = URL.createObjectURL(file);
  video.muted = true;
  video.onloadeddata = () => {
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

dropZone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => loadFile(fileInput.files[0]));
['dragenter', 'dragover'].forEach(ev =>
  dropZone.addEventListener(ev, (e) => { e.preventDefault(); dropZone.classList.add('dragover'); }));
['dragleave', 'drop'].forEach(ev =>
  dropZone.addEventListener(ev, (e) => { e.preventDefault(); dropZone.classList.remove('dragover'); }));
dropZone.addEventListener('drop', (e) => loadFile(e.dataTransfer.files[0]));

document.getElementById('qualitySelect').addEventListener('change', () => {
  if (haveFrame) { computeOutSize(); render(); }
  else updateQualityNote();
});

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
  });
  presetRow.appendChild(b);
});
function markPresetCustom() {
  document.querySelectorAll('.preset').forEach(p => p.classList.remove('active'));
}
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

  const mbps = getQuality().mbps;
  const fps = 60;   // keep 60 for smooth gameplay

  // Draw a fresh frame first so the stream starts on real content, not a blank
  // or stale canvas (a blank first frame can corrupt the file's start).
  render();

  // Build the output stream: processed canvas video + original audio.
  const stream = canvas.captureStream(fps);
  try {
    video.muted = false;                       // needed so audio is in the capture
    const audio = video.captureStream ? video.captureStream()
                : video.mozCaptureStream ? video.mozCaptureStream() : null;
    if (audio) audio.getAudioTracks().forEach(t => stream.addTrack(t));
  } catch (_) { /* no audio track — export silent video */ }

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
  const onProg = () => {
    // Stop recording at the trim-out point.
    if (outPoint != null && video.currentTime >= outPoint) { finish(); return; }
    const pb = document.getElementById('pbar');
    if (pb && end > start) pb.style.width = ((video.currentTime - start) / (end - start) * 100) + '%';
  };
  video.addEventListener('timeupdate', onProg);

  rec.onstop = () => {
    video.removeEventListener('timeupdate', onProg);
    video.removeEventListener('ended', finish);
    video.muted = wasMuted;
    const blob = new Blob(chunks, { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `enhanced_${outW}x${outH}.${ext}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    const mb = (blob.size / 1048576).toFixed(1);
    setStatus(`✓ Done — <b>enhanced_${outW}x${outH}.${ext}</b> (${mb} MB) downloaded.`, '');
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
  try { await video.play(); }
  catch (err) { setStatus('Playback blocked: ' + err.message, 'err'); finish(); }
  playBtn.textContent = '❚❚ Recording…';
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
