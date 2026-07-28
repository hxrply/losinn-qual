/* Clip Enhancer — GPU restore / upscale / colour-grade / export.
 *
 * Everything runs client-side: the video never leaves the machine.
 *
 * The picture goes through three GPU passes, in the same order a desktop
 * restoration tool would run them:
 *
 *   1. RESTORE  (at source resolution) — deblock, edge-aware denoise, chroma
 *      clean-up, deband. Compression damage has to come off *before* anything
 *      magnifies it; sharpening a blocky frame just makes crisp blocks.
 *   2. RESAMPLE — AMD FidelityFX EASU (edge-adaptive spatial upsampling) when
 *      enlarging, a windowed area filter when shrinking. Both beat the browser's
 *      built-in bilinear by a wide margin on diagonals and fine text.
 *   3. FINISH   (at output resolution) — FidelityFX RCAS sharpening with halo
 *      and noise suppression, local-contrast "clarity", then a proper grade:
 *      exposure and white balance in linear light, an endpoint-preserving
 *      S-curve for contrast, highlight rolloff, saturation/vibrance, optional
 *      grain, and triangular dither so 8-bit output doesn't band.
 *
 * Honest scope: this is not neural super-resolution (Topaz/Wink). Nothing here
 * invents detail that isn't in the source. What it does do is remove the
 * artefacts that make a console clip look cheap, then enlarge and sharpen with
 * far better filters than a video player uses — which covers most of the gap,
 * and runs in real time on a weak GPU.
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

/* ─────────────  WebGL setup  ─────────────
 * WebGL2 where available (better non-power-of-two handling), WebGL1 otherwise.
 * The shaders are written in GLSL ES 1.00, which both accept. */
const canvas = document.getElementById('glcanvas');
// preserveDrawingBuffer stays off: it forces the driver to keep a second copy of
// the surface every frame, which at 4K is an extra 33MB of traffic per frame for
// nothing. Every reader of this canvas (VideoFrame during export, captureStream
// in the fallback recorder) samples it before the compositor can clear it.
const glOpts = { preserveDrawingBuffer: false, alpha: false, antialias: false, depth: false, stencil: false };
const gl = canvas.getContext('webgl2', glOpts) || canvas.getContext('webgl', glOpts);

const VERT = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = vec2(aPos.x * 0.5 + 0.5, 1.0 - (aPos.y * 0.5 + 0.5));
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

/* Shared shader prologue: mediump is not enough for the edge maths below, but
 * some older phone GPUs don't offer highp in fragment shaders. */
const HEAD = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec2 vUv;
float lum(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
`;

/* ── Pass 1: RESTORE — undo compression damage at source resolution ── */
const FRAG_RESTORE = HEAD + `
uniform sampler2D uTex;
uniform vec2  uTexel;      // 1 / source size
uniform vec2  uSrcSize;    // source pixels
uniform vec2  uUvScale;    // crop / 9:16 reframe
uniform vec2  uUvOffset;
uniform float uDeblock;
uniform float uDenoise;
uniform float uChroma;
uniform float uDeband;
uniform float uSeed;

/* One bilateral tap: spatial weight times a range weight, so a neighbour only
 * contributes if it is close in brightness — that is what keeps edges intact
 * where a plain box blur would smear them. */
void bi(inout vec3 acc, inout float wsum, vec2 uv, vec2 o, float l0, float inv, float sp) {
  vec3 s = texture2D(uTex, uv + uTexel * o).rgb;
  float dl = lum(s) - l0;
  float w = sp * exp(-dl * dl * inv);
  acc += s * w;
  wsum += w;
}

void main() {
  vec2 uv = vUv * uUvScale + uUvOffset;
  vec3 c0 = texture2D(uTex, uv).rgb;
  vec3 col = c0;
  float l0 = lum(c0);

  // ── edge-aware denoise ──
  // Kills mosquito noise around HUD edges and the grain Xbox capture leaves in
  // dark rooms, without the softening a mean filter costs you.
  if (uDenoise > 0.001) {
    float sig = mix(0.020, 0.115, uDenoise);
    float inv = 1.0 / (2.0 * sig * sig);
    vec3 acc = c0;
    float wsum = 1.0;
    bi(acc, wsum, uv, vec2( 1.0,  0.0), l0, inv, 1.00);
    bi(acc, wsum, uv, vec2(-1.0,  0.0), l0, inv, 1.00);
    bi(acc, wsum, uv, vec2( 0.0,  1.0), l0, inv, 1.00);
    bi(acc, wsum, uv, vec2( 0.0, -1.0), l0, inv, 1.00);
    bi(acc, wsum, uv, vec2( 1.0,  1.0), l0, inv, 0.71);
    bi(acc, wsum, uv, vec2(-1.0,  1.0), l0, inv, 0.71);
    bi(acc, wsum, uv, vec2( 1.0, -1.0), l0, inv, 0.71);
    bi(acc, wsum, uv, vec2(-1.0, -1.0), l0, inv, 0.71);
    bi(acc, wsum, uv, vec2( 2.0,  0.0), l0, inv, 0.42);
    bi(acc, wsum, uv, vec2(-2.0,  0.0), l0, inv, 0.42);
    bi(acc, wsum, uv, vec2( 0.0,  2.0), l0, inv, 0.42);
    bi(acc, wsum, uv, vec2( 0.0, -2.0), l0, inv, 0.42);
    col = mix(c0, acc / wsum, clamp(uDenoise * 1.25, 0.0, 1.0));
  }

  // ── deblock ──
  // H.264 quantises in 8x8 blocks, so flat dark areas end up with a faint grid.
  // Smooth only *across* those grid lines, and only where the step is small
  // enough to be an artefact rather than real geometry.
  if (uDeblock > 0.001) {
    vec2 px = uv * uSrcSize;
    vec2 bp = fract(px / 8.0) * 8.0;                       // position inside the block
    vec2 dist = min(bp, 8.0 - bp);                          // distance to the grid line
    vec2 dir = vec2(bp.x < 4.0 ? -1.0 : 1.0, bp.y < 4.0 ? -1.0 : 1.0);
    float thr = mix(0.020, 0.075, uDeblock);
    vec3 acc = col;
    float wsum = 1.0;

    vec3 nx = texture2D(uTex, uv + uTexel * vec2(dir.x, 0.0)).rgb;
    float wx = (1.0 - smoothstep(0.0, 1.6, dist.x)) * uDeblock
             * (1.0 - smoothstep(thr, thr * 2.2, abs(lum(nx) - l0)));
    acc += nx * wx;
    wsum += wx;

    vec3 ny = texture2D(uTex, uv + uTexel * vec2(0.0, dir.y)).rgb;
    float wy = (1.0 - smoothstep(0.0, 1.6, dist.y)) * uDeblock
             * (1.0 - smoothstep(thr, thr * 2.2, abs(lum(ny) - l0)));
    acc += ny * wy;
    wsum += wy;

    col = acc / wsum;
  }

  // ── chroma clean-up ──
  // 4:2:0 video stores colour at quarter resolution, so colour is where
  // compression damage shows first (blotchy reds, smeared blues). Blur the
  // colour only and keep this pixel's own luma: clean colour, no softening.
  if (uChroma > 0.001) {
    float r = 2.0;
    vec3 acc = col;
    acc += texture2D(uTex, uv + uTexel * vec2( r,  0.0)).rgb;
    acc += texture2D(uTex, uv + uTexel * vec2(-r,  0.0)).rgb;
    acc += texture2D(uTex, uv + uTexel * vec2( 0.0,  r)).rgb;
    acc += texture2D(uTex, uv + uTexel * vec2( 0.0, -r)).rgb;
    acc += texture2D(uTex, uv + uTexel * vec2( r,  r)).rgb;
    acc += texture2D(uTex, uv + uTexel * vec2(-r,  r)).rgb;
    acc += texture2D(uTex, uv + uTexel * vec2( r, -r)).rgb;
    acc += texture2D(uTex, uv + uTexel * vec2(-r, -r)).rgb;
    vec3 blur = acc / 9.0;
    col = mix(col, vec3(lum(col)) + (blur - vec3(lum(blur))), uChroma);
  }

  // ── deband ──
  // Smoke, skyboxes and muzzle glow quantise into visible stair-steps. Where
  // the neighbourhood is flat enough to be a gradient, swap in a wide average
  // so the step dissolves; anywhere with real detail is left alone. The sample
  // ring is rotated per pixel so the fix never looks like a pattern itself.
  if (uDeband > 0.001) {
    float r = mix(4.0, 15.0, uDeband);
    float a = hash21(gl_FragCoord.xy + uSeed) * 6.2831853;
    vec2 e1 = vec2(cos(a), sin(a)) * r;
    vec2 e2 = vec2(-e1.y, e1.x);
    vec3 s1 = texture2D(uTex, uv + uTexel * e1).rgb;
    vec3 s2 = texture2D(uTex, uv - uTexel * e1).rgb;
    vec3 s3 = texture2D(uTex, uv + uTexel * e2).rgb;
    vec3 s4 = texture2D(uTex, uv - uTexel * e2).rgb;
    vec3 avg = (s1 + s2 + s3 + s4) * 0.25;
    vec3 dif = max(max(abs(s1 - col), abs(s2 - col)), max(abs(s3 - col), abs(s4 - col)));
    float dmax = max(dif.r, max(dif.g, dif.b));
    float thr = mix(0.010, 0.030, uDeband);
    float flatness = 1.0 - smoothstep(thr, thr * 2.0, dmax);
    col = mix(col, avg, flatness * uDeband * 0.9);
  }

  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

/* ── Pass 2a: EASU — AMD FidelityFX edge-adaptive upsampling ──
 * Bilinear enlargement staircases every diagonal; EASU measures the local edge
 * direction from a 12-tap neighbourhood and stretches an anisotropic kernel
 * along it, so edges come out straight instead of jagged. The result is clamped
 * to the surrounding 2x2, which is why it can enlarge hard without ringing. */
const FRAG_EASU = HEAD + `
uniform sampler2D uTex;
uniform vec2 uSrcSize;
uniform vec2 uSrcTexel;

float dLum(vec3 c) { return c.g + 0.5 * (c.r + c.b); }   // FSR's luma proxy

void easuSet(inout vec2 dir, inout float len, vec2 pp,
             float wS, float wT, float wU, float wV,
             float lA, float lB, float lC, float lD, float lE) {
  float w = wS * (1.0 - pp.x) * (1.0 - pp.y) + wT * pp.x * (1.0 - pp.y)
          + wU * (1.0 - pp.x) * pp.y         + wV * pp.x * pp.y;

  float lenX = max(abs(lD - lC), abs(lC - lB));
  lenX = 1.0 / max(lenX, 1e-5);
  float dirX = lD - lB;
  dir.x += dirX * w;
  lenX = clamp(abs(dirX) * lenX, 0.0, 1.0);
  len += lenX * lenX * w;

  float lenY = max(abs(lE - lC), abs(lC - lA));
  lenY = 1.0 / max(lenY, 1e-5);
  float dirY = lE - lA;
  dir.y += dirY * w;
  lenY = clamp(abs(dirY) * lenY, 0.0, 1.0);
  len += lenY * lenY * w;
}

void easuTap(inout vec3 aC, inout float aW, vec2 off, vec2 dir, vec2 len2,
             float lob, float clp, vec3 c) {
  vec2 v = vec2(off.x * dir.x + off.y * dir.y, off.y * dir.x - off.x * dir.y);
  v *= len2;
  float d2 = min(v.x * v.x + v.y * v.y, clp);
  float wB = 2.0 / 5.0 * d2 - 1.0;
  float wA = lob * d2 - 1.0;
  wB *= wB;
  wA *= wA;
  wB = 25.0 / 16.0 * wB - (25.0 / 16.0 - 1.0);
  float w = wB * wA;
  aC += c * w;
  aW += w;
}

void main() {
  vec2 pp = vUv * uSrcSize - 0.5;
  vec2 fp = floor(pp);
  pp -= fp;
  vec2 base = (fp + 0.5) * uSrcTexel;

  //   b c
  // e f g h
  // i j k l
  //   n o
  vec3 b = texture2D(uTex, base + uSrcTexel * vec2( 0.0, -1.0)).rgb;
  vec3 c = texture2D(uTex, base + uSrcTexel * vec2( 1.0, -1.0)).rgb;
  vec3 e = texture2D(uTex, base + uSrcTexel * vec2(-1.0,  0.0)).rgb;
  vec3 f = texture2D(uTex, base).rgb;
  vec3 g = texture2D(uTex, base + uSrcTexel * vec2( 1.0,  0.0)).rgb;
  vec3 h = texture2D(uTex, base + uSrcTexel * vec2( 2.0,  0.0)).rgb;
  vec3 i = texture2D(uTex, base + uSrcTexel * vec2(-1.0,  1.0)).rgb;
  vec3 j = texture2D(uTex, base + uSrcTexel * vec2( 0.0,  1.0)).rgb;
  vec3 k = texture2D(uTex, base + uSrcTexel * vec2( 1.0,  1.0)).rgb;
  vec3 l = texture2D(uTex, base + uSrcTexel * vec2( 2.0,  1.0)).rgb;
  vec3 n = texture2D(uTex, base + uSrcTexel * vec2( 0.0,  2.0)).rgb;
  vec3 o = texture2D(uTex, base + uSrcTexel * vec2( 1.0,  2.0)).rgb;

  float bL = dLum(b), cL = dLum(c), eL = dLum(e), fL = dLum(f);
  float gL = dLum(g), hL = dLum(h), iL = dLum(i), jL = dLum(j);
  float kL = dLum(k), lL = dLum(l), nL = dLum(n), oL = dLum(o);

  vec2 dir = vec2(0.0);
  float len = 0.0;
  easuSet(dir, len, pp, 1.0, 0.0, 0.0, 0.0, bL, eL, fL, gL, jL);
  easuSet(dir, len, pp, 0.0, 1.0, 0.0, 0.0, cL, fL, gL, hL, kL);
  easuSet(dir, len, pp, 0.0, 0.0, 1.0, 0.0, fL, iL, jL, kL, nL);
  easuSet(dir, len, pp, 0.0, 0.0, 0.0, 1.0, gL, jL, kL, lL, oL);

  vec2 dir2 = dir * dir;
  float dirR = dir2.x + dir2.y;
  bool zro = dirR < (1.0 / 32768.0);
  dirR = zro ? 1.0 : inversesqrt(max(dirR, 1e-12));
  dir.x = zro ? 1.0 : dir.x;
  dir.y = zro ? 0.0 : dir.y;
  dir *= dirR;

  len = len * 0.5;
  len *= len;
  float stretch = (dir.x * dir.x + dir.y * dir.y) / max(abs(dir.x), abs(dir.y));
  vec2 len2 = vec2(1.0 + (stretch - 1.0) * len, 1.0 - 0.5 * len);
  float lob = 0.5 - 0.25 * len;
  float clp = 1.0 / lob;

  vec3 aC = vec3(0.0);
  float aW = 0.0;
  easuTap(aC, aW, vec2( 0.0, -1.0) - pp, dir, len2, lob, clp, b);
  easuTap(aC, aW, vec2( 1.0, -1.0) - pp, dir, len2, lob, clp, c);
  easuTap(aC, aW, vec2(-1.0,  0.0) - pp, dir, len2, lob, clp, e);
  easuTap(aC, aW, vec2( 0.0,  0.0) - pp, dir, len2, lob, clp, f);
  easuTap(aC, aW, vec2( 1.0,  0.0) - pp, dir, len2, lob, clp, g);
  easuTap(aC, aW, vec2( 2.0,  0.0) - pp, dir, len2, lob, clp, h);
  easuTap(aC, aW, vec2(-1.0,  1.0) - pp, dir, len2, lob, clp, i);
  easuTap(aC, aW, vec2( 0.0,  1.0) - pp, dir, len2, lob, clp, j);
  easuTap(aC, aW, vec2( 1.0,  1.0) - pp, dir, len2, lob, clp, k);
  easuTap(aC, aW, vec2( 2.0,  1.0) - pp, dir, len2, lob, clp, l);
  easuTap(aC, aW, vec2( 0.0,  2.0) - pp, dir, len2, lob, clp, n);
  easuTap(aC, aW, vec2( 1.0,  2.0) - pp, dir, len2, lob, clp, o);

  vec3 mn = min(min(f, g), min(j, k));
  vec3 mx = max(max(f, g), max(j, k));
  gl_FragColor = vec4(clamp(aC / max(aW, 1e-5), mn, mx), 1.0);
}`;

/* ── Pass 2b: windowed area filter for shrinking ──
 * Minifying with bilinear only reads 4 of the source pixels a destination pixel
 * covers, so fences and foliage crawl and alias. This averages the whole
 * footprint with a tent window. Taps sit on half-texel offsets so the hardware's
 * own bilinear filter doubles the coverage for free. */
const FRAG_AREA = HEAD + `
uniform sampler2D uTex;
uniform vec2 uSrcTexel;
uniform vec2 uRatio;      // source pixels per destination pixel

void main() {
  vec3 acc = vec3(0.0);
  float wsum = 0.0;
  for (int y = 0; y < 4; y++) {
    for (int x = 0; x < 4; x++) {
      vec2 o = (vec2(float(x), float(y)) - 1.5) * 0.5;    // -0.75 .. 0.75
      float w = max(0.0, 1.0 - abs(o.x) / 0.9) * max(0.0, 1.0 - abs(o.y) / 0.9);
      acc += texture2D(uTex, vUv + o * uRatio * uSrcTexel).rgb * w;
      wsum += w;
    }
  }
  gl_FragColor = vec4(acc / wsum, 1.0);
}`;

/* ── Pass 3: FINISH — sharpen, local contrast, grade, dither ── */
const FRAG_FINISH = HEAD + `
uniform sampler2D uTex;      // restored + resampled image
uniform sampler2D uSrc;      // untouched source, for the before/after split
uniform vec2  uTexel;        // 1 / output size
uniform vec2  uUvScale;
uniform vec2  uUvOffset;
uniform float uSharp;
uniform float uClarity;
uniform float uRadius;
uniform float uSat;
uniform float uVib;
uniform float uContrast;
uniform float uExposure;
uniform float uBlack;
uniform float uHighlight;
uniform float uGrain;
uniform vec3  uWb;
uniform float uCompare;
uniform float uSplit;
uniform float uSeed;

vec3 toLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
}
vec3 toSrgb(vec3 c) {
  c = max(c, 0.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}

void main() {
  vec3 e = texture2D(uTex, vUv).rgb;
  vec3 col = e;

  // ── RCAS sharpening ──
  // Contrast-adaptive: the amount is derived per pixel from how much headroom
  // the neighbourhood has, so it can't overshoot into a halo. The extra noise
  // term backs off in areas that are all high-frequency (grass, grain) instead
  // of amplifying them, which is where a plain unsharp mask falls apart.
  if (uSharp > 0.001) {
    vec3 b = texture2D(uTex, vUv + vec2( 0.0, -1.0) * uTexel).rgb;
    vec3 d = texture2D(uTex, vUv + vec2(-1.0,  0.0) * uTexel).rgb;
    vec3 f = texture2D(uTex, vUv + vec2( 1.0,  0.0) * uTexel).rgb;
    vec3 h = texture2D(uTex, vUv + vec2( 0.0,  1.0) * uTexel).rgb;
    float bL = lum(b), dL = lum(d), eL = lum(e), fL = lum(f), hL = lum(h);

    float nz = 0.25 * (bL + dL + fL + hL) - eL;
    float rng = max(max(max(bL, dL), max(fL, hL)), eL)
              - min(min(min(bL, dL), min(fL, hL)), eL);
    nz = clamp(abs(nz) / max(rng, 1e-4), 0.0, 1.0);
    nz = 1.0 - 0.5 * nz;

    vec3 mn4 = min(min(b, d), min(f, h));
    vec3 mx4 = max(max(b, d), max(f, h));
    vec3 hitMin = mn4 / (4.0 * mx4 + 1e-5);
    vec3 hitMax = (vec3(1.0) - mx4) / min(4.0 * mn4 - 4.0, -1e-4);
    vec3 lobeRGB = max(-hitMin, hitMax);
    float lobe = max(-0.1875, min(max(lobeRGB.r, max(lobeRGB.g, lobeRGB.b)), 0.0));
    lobe *= uSharp * 0.9 * nz;

    vec3 sh = (lobe * (b + d + f + h) + e) / (4.0 * lobe + 1.0);
    vec3 lo = min(mn4, e);
    vec3 hi = max(mx4, e);
    col = mix(sh, clamp(sh, lo, hi), 0.6);      // belt-and-braces dehalo
  }

  // ── clarity ──
  // Mid-radius local contrast. This is most of what reads as "HD" on a phone:
  // it lifts texture in walls, gun models and smoke without touching global
  // contrast. The detail term is soft-limited so strong edges can't grow rims.
  if (uClarity > 0.001) {
    float r = uRadius;
    float rd = r * 0.7071;
    float lb = lum(texture2D(uTex, vUv + vec2(  r,  0.0) * uTexel).rgb)
             + lum(texture2D(uTex, vUv + vec2( -r,  0.0) * uTexel).rgb)
             + lum(texture2D(uTex, vUv + vec2( 0.0,   r) * uTexel).rgb)
             + lum(texture2D(uTex, vUv + vec2( 0.0,  -r) * uTexel).rgb)
             + lum(texture2D(uTex, vUv + vec2( rd,  rd) * uTexel).rgb)
             + lum(texture2D(uTex, vUv + vec2(-rd,  rd) * uTexel).rgb)
             + lum(texture2D(uTex, vUv + vec2( rd, -rd) * uTexel).rgb)
             + lum(texture2D(uTex, vUv + vec2(-rd, -rd) * uTexel).rgb);
    lb /= 8.0;
    float lc = lum(col);
    float det = lc - lb;
    det = det / (1.0 + abs(det) * 3.0);
    float nl = clamp(lc + det * uClarity * 2.2, 0.0, 1.0);
    col *= (lc > 0.002) ? (nl / lc) : 1.0;      // scale RGB together to hold hue
  }

  // ── grade ──
  // Exposure and white balance belong in linear light: doing them on gamma
  // values is what makes a brightened clip look milky.
  vec3 lin = toLinear(clamp(col, 0.0, 1.0));
  lin *= exp2(uExposure);
  lin *= uWb;
  float wp = 1.0 + uHighlight * 0.9;
  lin = lin * (1.0 + lin / (wp * wp)) / (1.0 + lin);      // highlight rolloff
  col = toSrgb(lin);

  // Deepen blacks: R6 at high in-game brightness lifts the black floor, so
  // rescale from a raised black point back down to 0 to restore contrast.
  col = clamp((col - uBlack) / max(1.0 - uBlack, 1e-3), 0.0, 1.0);

  // S-curve contrast. Pins 0 and 1 in place, so it adds punch without crushing
  // shadow detail to solid black or blowing highlights to flat white.
  vec3 lo2 = 0.5 * pow(clamp(2.0 * col, 0.0, 2.0), vec3(uContrast));
  vec3 hi2 = 1.0 - 0.5 * pow(clamp(2.0 - 2.0 * col, 0.0, 2.0), vec3(uContrast));
  col = mix(lo2, hi2, step(vec3(0.5), col));

  float l2 = lum(col);
  col = mix(vec3(l2), col, uSat);
  float mxc = max(col.r, max(col.g, col.b));
  float mnc = min(col.r, min(col.g, col.b));
  col = mix(vec3(l2), col, 1.0 + uVib * (1.0 - (mxc - mnc)));
  col = clamp(col, 0.0, 1.0);

  // Grain, weighted to the midtones like real film. Masks any banding the
  // encoder reintroduces and gives compression something less obvious to chew.
  if (uGrain > 0.001) {
    float m = 1.0 - abs(lum(col) * 2.0 - 1.0);
    col += (hash21(gl_FragCoord.xy + uSeed) - 0.5) * uGrain * 0.06 * m;
  }

  // ── before / after split, against the untouched source ──
  if (uCompare > 0.5) {
    if (vUv.x < uSplit) col = texture2D(uSrc, vUv * uUvScale + uUvOffset).rgb;
    if (abs(vUv.x - uSplit) < 0.0015) col = vec3(0.73, 0.55, 1.0);
  }

  // Triangular dither: one LSB of noise so the 8-bit output doesn't band where
  // the grade stretched a gradient.
  float d1 = hash21(gl_FragCoord.xy + uSeed + 11.7);
  float d2 = hash21(gl_FragCoord.xy + uSeed + 23.3);
  col += vec3((d1 + d2 - 1.0) / 255.0);

  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

function compile(type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
    throw new Error(gl.getShaderInfoLog(s) + '\n' + src);
  return s;
}

// Uniform locations are scraped from the source so adding a uniform to a shader
// never needs a matching edit to a list down here.
function makeProgram(frag) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl.VERTEX_SHADER, VERT));
  gl.attachShader(p, compile(gl.FRAGMENT_SHADER, frag));
  gl.bindAttribLocation(p, 0, 'aPos');
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS))
    throw new Error(gl.getProgramInfoLog(p));
  const u = {};
  const re = /uniform\s+\w+\s+(\w+)\s*;/g;
  let m;
  while ((m = re.exec(frag))) u[m[1]] = gl.getUniformLocation(p, m[1]);
  return { p, u };
}

const P_RESTORE = makeProgram(FRAG_RESTORE);
const P_EASU    = makeProgram(FRAG_EASU);
const P_AREA    = makeProgram(FRAG_AREA);
const P_FINISH  = makeProgram(FRAG_FINISH);

const quad = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, quad);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
gl.enableVertexAttribArray(0);
gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
gl.disable(gl.DEPTH_TEST);
gl.disable(gl.BLEND);

function makeTex() {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  return t;
}

const srcTex = makeTex();

// Off-screen render targets for the intermediate passes, resized on demand.
function makeTarget() {
  return { tex: makeTex(), fb: gl.createFramebuffer(), w: 0, h: 0 };
}
function sizeTarget(t, w, h) {
  if (t.w !== w || t.h !== h) {
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t.tex, 0);
    t.w = w;
    t.h = h;
  }
  return t;
}
const tgtClean = makeTarget();
const tgtScaled = makeTarget();

function drawTo(target, w, h) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fb : null);
  gl.viewport(0, 0, w, h);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

/* ─────────────  State  ───────────── */
const video = document.getElementById('srcVideo');
let haveFrame = false;
let outW = 0, outH = 0;          // final export size
let viewW = 0, viewH = 0;        // preview size (capped so 4K stays smooth)
let cleanW = 0, cleanH = 0;      // restore-pass size = cropped source size
let srcFps = 60;
let seed = 0;

const params = {
  deblock: 0.45, denoise: 0.20, chroma: 0.35, deband: 0.30,
  sharp: 0.55, clarity: 0.28,
  sat: 1.12, vib: 0.28, temp: 0.00,
  contrast: 1.12, bright: -0.02, black: 0.05, highlight: 0.25, grain: 0.00,
};
let compare = false, splitX = 0.5;
let aspect = 'source';        // 'source' | '9x16'
let reframe = 0;              // -0.5..0.5 pan within the crop
const crop = { sx: 1, sy: 1, ox: 0, oy: 0 };   // source UV transform

/* Every slider in one place: the panel, the persistence and the preset
 * plumbing are all generated from this. */
const CONTROLS = [
  { g: 'Restore', k: 'deblock', label: 'Deblock', min: 0, max: 1, step: 0.01, pct: true,
    note: 'Erases the 8×8 grid H.264 leaves in dark smoke and fast motion — the single biggest reason console clips look cheap.' },
  { g: 'Restore', k: 'denoise', label: 'Denoise', min: 0, max: 1, step: 0.01, pct: true,
    note: 'Edge-aware, so it removes dark-scene grain and the fizz around HUD text without softening walls or gun models.' },
  { g: 'Restore', k: 'chroma', label: 'Colour clean-up', min: 0, max: 1, step: 0.01, pct: true,
    note: 'Video stores colour at quarter resolution, so blotchy reds and smeared blues appear first. Cleans colour only — luma detail is untouched.' },
  { g: 'Restore', k: 'deband', label: 'Deband', min: 0, max: 1, step: 0.01, pct: true,
    note: 'Removes the stair-steps in smoke, skyboxes and muzzle glow. Worth having on before you add contrast, which makes banding worse.' },

  { g: 'Detail', k: 'sharp', label: 'Sharpness', min: 0, max: 1, step: 0.01, pct: true,
    note: 'Contrast-adaptive (FidelityFX RCAS) — it works out its own limit per pixel, so it can go hard without white rims on edges.' },
  { g: 'Detail', k: 'clarity', label: 'Clarity', min: 0, max: 1, step: 0.01, pct: true,
    note: 'Local contrast. This is what actually reads as "HD" on a phone: texture in walls and smoke lifts without the whole clip getting harsh.' },

  { g: 'Colour', k: 'sat', label: 'Saturation', min: 0.4, max: 2, step: 0.01,
    note: 'Overall colour intensity.' },
  { g: 'Colour', k: 'vib', label: 'Vibrance', min: 0, max: 1, step: 0.01, pct: true,
    note: 'Boosts dull colours only, leaving already-strong ones alone. Safer than saturation on skin and HUD.' },
  { g: 'Colour', k: 'temp', label: 'Temperature', min: -1, max: 1, step: 0.01, signed: true,
    note: 'Cool ← → warm. Applied in linear light with the brightness held constant, so it shifts colour without shifting exposure.' },

  { g: 'Tone', k: 'contrast', label: 'Contrast', min: 0.5, max: 1.8, step: 0.01,
    note: 'An S-curve that pins black and white in place — punch without crushing shadow detail or blowing muzzle flashes flat.' },
  { g: 'Tone', k: 'bright', label: 'Brightness', min: -0.5, max: 0.5, step: 0.01, signed: true,
    note: 'True exposure, in stops. Nudge down slightly if 65 in-game brightness looks washed out.' },
  { g: 'Tone', k: 'black', label: 'Deepen blacks', min: 0, max: 0.25, step: 0.005, pct: true,
    note: 'Key setting for R6 at 65 brightness — pulls the lifted, greyish blacks back down so the clip has real contrast.' },
  { g: 'Tone', k: 'highlight', label: 'Highlight rolloff', min: 0, max: 1, step: 0.01, pct: true,
    note: 'Compresses the top end instead of clipping it, so drone lights and sky keep some shape after the contrast curve.' },

  { g: 'Finish', k: 'grain', label: 'Film grain', min: 0, max: 1, step: 0.01, pct: true, advanced: true,
    note: 'A little grain hides banding and gives TikTok\'s encoder something less obvious to smear. Keep it under ~15%.' },
];

// Tuned for R6 Siege on 65 in-game brightness: that setting lifts the black
// floor (flat / greyish look), so the defaults add contrast + deepen blacks
// rather than adding brightness, then boost vibrance so colours pop after
// TikTok re-compresses the upload.
const PRESETS = {
  'R6 · 65 bright': { deblock: 0.45, denoise: 0.20, chroma: 0.35, deband: 0.30, sharp: 0.55, clarity: 0.28, sat: 1.12, vib: 0.28, temp: 0.00, contrast: 1.12, bright: -0.02, black: 0.05, highlight: 0.25, grain: 0.00 },
  'HD restore':     { deblock: 0.70, denoise: 0.35, chroma: 0.55, deband: 0.45, sharp: 0.62, clarity: 0.35, sat: 1.10, vib: 0.30, temp: 0.00, contrast: 1.08, bright: 0.00,  black: 0.03, highlight: 0.30, grain: 0.04 },
  'Punchy':         { deblock: 0.40, denoise: 0.15, chroma: 0.30, deband: 0.25, sharp: 0.72, clarity: 0.42, sat: 1.26, vib: 0.36, temp: 0.05, contrast: 1.20, bright: -0.03, black: 0.07, highlight: 0.35, grain: 0.00 },
  'Clean / soft':   { deblock: 0.55, denoise: 0.45, chroma: 0.60, deband: 0.40, sharp: 0.30, clarity: 0.15, sat: 1.05, vib: 0.16, temp: 0.00, contrast: 1.04, bright: 0.00,  black: 0.02, highlight: 0.20, grain: 0.00 },
  'Max detail':     { deblock: 0.30, denoise: 0.10, chroma: 0.20, deband: 0.20, sharp: 0.88, clarity: 0.50, sat: 1.14, vib: 0.30, temp: 0.00, contrast: 1.12, bright: -0.02, black: 0.05, highlight: 0.25, grain: 0.00 },
  'Off':            { deblock: 0, denoise: 0, chroma: 0, deband: 0, sharp: 0, clarity: 0, sat: 1, vib: 0, temp: 0, contrast: 1, bright: 0, black: 0, highlight: 0, grain: 0 },
};

/* Remember the user's settings between visits. */
const LS_KEY = 'losinnqual.settings.v2';
function saveSettings() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({
      params,
      res: document.getElementById('resSelect').value,
      quality: document.getElementById('qualitySelect').value,
      codec: document.getElementById('codecSelect').value,
      aspect, reframe,
      mute: document.getElementById('muteChk').checked,
    }));
  } catch (_) { /* private mode / storage disabled — just don't persist */ }
}
function loadSettings() {
  let s;
  try { s = JSON.parse(localStorage.getItem(LS_KEY) || 'null'); } catch (_) { return; }
  if (!s) { migrateV1(); return; }
  if (s.params) Object.assign(params, s.params);
  setSelect('resSelect', s.res);
  setSelect('qualitySelect', s.quality);
  setSelect('codecSelect', s.codec);
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
function setSelect(id, val) {
  const el = document.getElementById(id);
  if (val && [...el.options].some(o => o.value === val)) el.value = val;
}
// The old build stored resolution and bitrate as one "1920|16" string and had
// no restore stage; carry across what still means the same thing.
function migrateV1() {
  let s;
  try { s = JSON.parse(localStorage.getItem('losinnqual.settings.v1') || 'null'); } catch (_) { return; }
  if (!s) return;
  if (s.params) {
    for (const k of ['sharp', 'sat', 'vib', 'contrast', 'black'])
      if (typeof s.params[k] === 'number') params[k] = s.params[k];
  }
  if (typeof s.quality === 'string') setSelect('resSelect', s.quality.split('|')[0]);
  if (s.aspect) {
    aspect = s.aspect;
    document.getElementById('aspectSelect').value = aspect;
    document.getElementById('reframeCtrl').hidden = aspect === 'source';
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

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const round2 = (v) => +v.toFixed(2);

/* Turn a measured look into Enhance parameters. Shared by the Analyse tab and
 * the Auto-enhance button. Restore settings come from the clip's measured
 * damage; tone and colour come from how far its look sits from a good target. */
function lookToParams(look) {
  const { B, C, S, Sh, warm, noise, block } = look;
  const deblock = clamp(block * 2.2, 0, 0.9);
  const denoise = clamp((noise - 2.0) / 12.0, 0, 0.75);
  return {
    deblock: round2(deblock),
    denoise: round2(denoise),
    chroma: round2(clamp(denoise * 0.8 + deblock * 0.55 + 0.12, 0, 0.9)),
    deband: round2(clamp(0.45 - noise / 18, 0.12, 0.55)),
    sharp: round2(clamp(0.9 - Sh / 90, 0.15, 0.9)),
    clarity: round2(clamp(0.55 - C / 180, 0.08, 0.5)),
    sat: round2(clamp(1 + (34 - S) / 90, 0.85, 1.45)),
    vib: round2(clamp((36 - S) / 80, 0.05, 0.45)),
    temp: round2(clamp(-warm / 45, -0.5, 0.5)),
    contrast: round2(clamp(1 + (46 - C) / 90, 0.95, 1.35)),
    bright: round2(clamp((52 - B) / 90, -0.25, 0.25)),
    black: +clamp((52 - C) / 400 + 0.02, 0, 0.11).toFixed(3),
    highlight: round2(clamp(B / 260 + 0.12, 0.1, 0.45)),
    grain: params.grain,
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
let srcTexW = 0, srcTexH = 0;
function uploadFrame() {
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, srcTex);
  // Reallocating the texture every frame is wasteful; only do it when the
  // source dimensions actually change.
  if (video.videoWidth !== srcTexW || video.videoHeight !== srcTexH) {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
    srcTexW = video.videoWidth;
    srcTexH = video.videoHeight;
  } else {
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, video);
  }
}

// Warmth as an RGB gain, normalised so it never doubles as a brightness slider.
function wbGain(temp) {
  let r = 1 + 0.30 * temp;
  let g = 1;
  let b = 1 - 0.30 * temp;
  const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return [r / l, g / l, b / l];
}

function render() {
  if (!haveFrame || video.readyState < 2 || !video.videoWidth) return;
  uploadFrame();
  seed = (seed + 7.13) % 1024;

  const W = canvas.width, H = canvas.height;
  if (!W || !H || !cleanW || !cleanH) return;

  // ── pass 1: restore, at source resolution (and cropped to the output shape,
  //    so a 9:16 crop doesn't waste work on pixels that get thrown away) ──
  sizeTarget(tgtClean, cleanW, cleanH);
  gl.useProgram(P_RESTORE.p);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, srcTex);
  gl.uniform1i(P_RESTORE.u.uTex, 0);
  gl.uniform2f(P_RESTORE.u.uTexel, 1 / video.videoWidth, 1 / video.videoHeight);
  gl.uniform2f(P_RESTORE.u.uSrcSize, video.videoWidth, video.videoHeight);
  gl.uniform2f(P_RESTORE.u.uUvScale, crop.sx, crop.sy);
  gl.uniform2f(P_RESTORE.u.uUvOffset, crop.ox, crop.oy);
  gl.uniform1f(P_RESTORE.u.uDeblock, params.deblock);
  gl.uniform1f(P_RESTORE.u.uDenoise, params.denoise);
  gl.uniform1f(P_RESTORE.u.uChroma, params.chroma);
  gl.uniform1f(P_RESTORE.u.uDeband, params.deband);
  gl.uniform1f(P_RESTORE.u.uSeed, seed);
  drawTo(tgtClean, cleanW, cleanH);

  // ── pass 2: resample to the output size, if it differs ──
  let detail = tgtClean;
  if (W !== cleanW || H !== cleanH) {
    sizeTarget(tgtScaled, W, H);
    const up = W > cleanW;
    const P = up ? P_EASU : P_AREA;
    gl.useProgram(P.p);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tgtClean.tex);
    gl.uniform1i(P.u.uTex, 0);
    gl.uniform2f(P.u.uSrcTexel, 1 / cleanW, 1 / cleanH);
    if (up) gl.uniform2f(P.u.uSrcSize, cleanW, cleanH);
    else    gl.uniform2f(P.u.uRatio, cleanW / W, cleanH / H);
    drawTo(tgtScaled, W, H);
    detail = tgtScaled;
  }

  // ── pass 3: sharpen, clarity, grade, dither → the visible canvas ──
  gl.useProgram(P_FINISH.p);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, detail.tex);
  gl.uniform1i(P_FINISH.u.uTex, 0);
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, srcTex);
  gl.uniform1i(P_FINISH.u.uSrc, 1);
  gl.uniform2f(P_FINISH.u.uTexel, 1 / W, 1 / H);
  gl.uniform2f(P_FINISH.u.uUvScale, crop.sx, crop.sy);
  gl.uniform2f(P_FINISH.u.uUvOffset, crop.ox, crop.oy);
  gl.uniform1f(P_FINISH.u.uSharp, params.sharp);
  gl.uniform1f(P_FINISH.u.uClarity, params.clarity);
  gl.uniform1f(P_FINISH.u.uRadius, Math.max(2, Math.round(Math.max(W, H) / 540)));
  gl.uniform1f(P_FINISH.u.uSat, params.sat);
  gl.uniform1f(P_FINISH.u.uVib, params.vib);
  gl.uniform1f(P_FINISH.u.uContrast, params.contrast);
  gl.uniform1f(P_FINISH.u.uExposure, params.bright * 2.0);   // slider → stops
  gl.uniform1f(P_FINISH.u.uBlack, params.black);
  gl.uniform1f(P_FINISH.u.uHighlight, params.highlight);
  gl.uniform1f(P_FINISH.u.uGrain, params.grain);
  gl.uniform3fv(P_FINISH.u.uWb, wbGain(params.temp));
  gl.uniform1f(P_FINISH.u.uCompare, compare ? 1 : 0);
  gl.uniform1f(P_FINISH.u.uSplit, splitX);
  gl.uniform1f(P_FINISH.u.uSeed, seed);
  drawTo(null, W, H);

  gl.activeTexture(gl.TEXTURE0);
}

function loop() {
  if (!video.paused && !video.ended) render();
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

/* ─────────────  Output size & bitrate  ─────────────
 * Bitrate is derived the way an encoder front-end does it — bits per pixel per
 * frame — instead of a fixed number per preset. That keeps quality constant
 * when you change resolution or the clip turns out to be 30fps, rather than
 * starving 4K and wasting bits on 720p. */
const BPP_LABEL = { '0.060': 'Efficient', '0.090': 'Balanced', '0.130': 'High', '0.190': 'Master' };
const PREVIEW_CAP = 1920;      // render the preview no larger than this

function getPlan() {
  const bpp = parseFloat(document.getElementById('qualitySelect').value) || 0.13;
  const codec = document.getElementById('codecSelect').value;
  const fps = Math.min(srcFps || 60, 60);
  // HEVC reaches the same quality at roughly 30% fewer bits.
  const eff = codec === 'hevc' ? 0.72 : 1;
  const bitrate = clamp(Math.round(outW * outH * fps * bpp * eff), 2e6, 90e6);
  return { bpp, codec, fps, bitrate };
}

function computeOutSize() {
  const target = parseInt(document.getElementById('resSelect').value, 10);
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) return;
  const srcA = vw / vh;
  const outA = aspect === '9x16' ? (9 / 16) : srcA;

  const long = target || Math.max(vw, vh);
  if (outA >= 1) { outW = long; outH = Math.round(long / outA); }
  else           { outH = long; outW = Math.round(long * outA); }
  outW = Math.round(outW / 2) * 2;               // keep even (encoder-friendly)
  outH = Math.round(outH / 2) * 2;

  // Preview at a capped size so a 4K export still scrubs smoothly on a weak
  // GPU. The export swaps the canvas up to full size for the render itself.
  const scale = Math.min(1, PREVIEW_CAP / Math.max(outW, outH));
  viewW = Math.max(2, Math.round(outW * scale / 2) * 2);
  viewH = Math.max(2, Math.round(outH * scale / 2) * 2);

  computeCrop(srcA, outA);
  cleanW = Math.max(2, Math.round(vw * crop.sx));
  cleanH = Math.max(2, Math.round(vh * crop.sy));

  setRenderSize(viewW, viewH);
  updateMeta();
  updateQualityNote();
}

function setRenderSize(w, h) {
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
}

// Fill the output aspect from the source (crop the overflowing axis), honouring
// the reframe pan. When aspects match this is a no-op (whole frame shown).
function computeCrop(srcA, outA) {
  if (srcA > outA) {          // source wider than target → crop width
    crop.sx = outA / srcA; crop.sy = 1;
    const room = 1 - crop.sx;
    crop.ox = clamp(room * (0.5 + reframe), 0, room); crop.oy = 0;
  } else if (srcA < outA) {   // source taller than target → crop height
    crop.sy = srcA / outA; crop.sx = 1;
    const room = 1 - crop.sy;
    crop.oy = clamp(room * (0.5 + reframe), 0, room); crop.ox = 0;
  } else {
    crop.sx = 1; crop.sy = 1; crop.ox = 0; crop.oy = 0;
  }
}

function fmtSize(bytes) {
  return bytes >= 1073741824 ? (bytes / 1073741824).toFixed(2) + ' GB'
                             : Math.round(bytes / 1048576) + ' MB';
}

// Honest explainer under the picker: upscaling past the source doesn't invent
// detail, the restore + sharpen is what makes it look cleaner.
function updateQualityNote() {
  const note = document.getElementById('qualityNote');
  if (!note) return;
  const plan = getPlan();
  const codecName = plan.codec === 'hevc' ? 'H.265' : 'H.264';
  const secs = Math.max(0.5, (haveFrame ? (effOut() - inPoint) : 30) || 30);
  let msg = `Exports ${outW || '—'}×${outH || '—'} · ${plan.fps} fps · ${codecName} at ` +
            `~${(plan.bitrate / 1e6).toFixed(1)} Mbps — about ${fmtSize(plan.bitrate / 8 * secs)} ` +
            `for ${secs.toFixed(1)}s.`;

  const long = Math.max(video.videoWidth || 0, video.videoHeight || 0);
  const outLong = Math.max(outW, outH);
  if (long && outLong > long)
    msg += ` Enlarging from ${long}p with EASU — the restore and sharpen do the visible work; nothing here invents detail past the source.`;
  else if (long && outLong < long)
    msg += ` Shrinking from ${long}p through an area filter — sharper and smaller, ideal for TikTok.`;

  if (outLong >= 2560)
    msg += canWebCodecs()
      ? ` Every frame is processed one at a time rather than recorded in real time, so 2K/4K takes noticeably longer than the clip itself — and TikTok shows it at 1080p either way.`
      : ` ⚠ On this browser, 2K/4K can drop frames while recording — 1080p stays smoothest.`;
  note.textContent = msg;
}

function updateMeta() {
  const el = document.getElementById('stageMeta');
  if (!video.videoWidth) { el.textContent = ''; return; }
  let t = `Source ${video.videoWidth}×${video.videoHeight} @ ${srcFps}fps → output ${outW}×${outH}`;
  if (viewW !== outW) t += `  ·  previewing at ${viewW}×${viewH}`;
  el.textContent = t;
  updatePipelineMeta();
}

// Show which stages are actually doing something, so the sliders stop being
// guesswork about what the GPU is running.
function updatePipelineMeta() {
  const el = document.getElementById('pipelineMeta');
  if (!el) return;
  const on = [];
  if (params.deblock > 0.01) on.push('deblock');
  if (params.denoise > 0.01) on.push('denoise');
  if (params.chroma > 0.01) on.push('chroma');
  if (params.deband > 0.01) on.push('deband');
  const outLong = Math.max(outW, outH);
  const srcLong = Math.max(cleanW, cleanH);
  if (outLong > srcLong) on.push('EASU upscale');
  else if (outLong < srcLong) on.push('area downscale');
  if (params.sharp > 0.01) on.push('RCAS sharpen');
  if (params.clarity > 0.01) on.push('clarity');
  on.push('grade + dither');
  el.textContent = 'Pipeline: ' + on.join(' → ');
}

/* ─────────────  Load a file  ───────────── */
const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');
const previewWrap = document.getElementById('previewWrap');

let srcFileSize = 0;
let curFile = null;

function loadFile(file) {
  if (!file || !file.type.startsWith('video/')) {
    setStatus('That doesn\'t look like a video file.', 'err');
    return;
  }
  srcFileSize = file.size || 0;
  curFile = file;
  srcFps = 60;
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
    document.getElementById('autoBtn').disabled = false;
    computeOutSize();
    render();
    updateTcode();
    resetTrim();
    await probeFps();
    computeOutSize();
    render();
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

// Frame rate isn't in any metadata the browser exposes, so measure it: play
// muted for a fraction of a second and time the frame callbacks. Getting this
// right matters — a 30fps clip encoded as 60 wastes half the bitrate on
// duplicate frames, and the bitrate maths below depends on it.
function probeFps() {
  return new Promise((resolve) => {
    const samples = [];
    let done = false;
    const hasRvfc = 'requestVideoFrameCallback' in video;
    let q0 = null, t0 = 0;

    const finish = () => {
      if (done) return; done = true;
      const raw = estimateFps(samples) || decodedFps(q0, t0);
      if (raw > 1) {
        srcFps = [24, 25, 30, 48, 50, 60, 90, 120]
          .reduce((a, b) => Math.abs(b - raw) < Math.abs(a - raw) ? b : a);
      }
      try { video.pause(); } catch (_) {}
      try { video.currentTime = 0; } catch (_) {}
      playBtn.textContent = '▶ Play';
      resolve();
    };

    const step = (now, meta) => {
      samples.push({
        t: meta && typeof meta.mediaTime === 'number' ? meta.mediaTime : video.currentTime,
        n: meta && typeof meta.presentedFrames === 'number' ? meta.presentedFrames : -1,
      });
      if (samples.length >= 16) return finish();
      video.requestVideoFrameCallback(step);
    };

    video.muted = true;
    video.play().then(() => {
      if (typeof video.getVideoPlaybackQuality === 'function') {
        q0 = video.getVideoPlaybackQuality();
        t0 = video.currentTime;
      }
      if (hasRvfc) video.requestVideoFrameCallback(step);
    }).catch(finish);
    setTimeout(finish, 1500);
  });
}

// Frames presented divided by media time elapsed. That ratio is immune to the
// callback firing more than once for the same frame, which is what made a 30fps
// clip read as 60 on a 60Hz screen. The median non-zero gap covers browsers that
// don't report presentedFrames.
function estimateFps(samples) {
  if (samples.length < 4) return 0;
  const a = samples[0], b = samples[samples.length - 1];
  const dt = b.t - a.t;
  if (a.n >= 0 && b.n > a.n && dt > 0.05) return (b.n - a.n) / dt;
  const gaps = [];
  for (let i = 1; i < samples.length; i++) {
    const g = samples[i].t - samples[i - 1].t;
    if (g > 1e-4) gaps.push(g);
  }
  if (!gaps.length) return 0;
  gaps.sort((x, y) => x - y);
  return 1 / gaps[gaps.length >> 1];
}

// Fallback for browsers without requestVideoFrameCallback: count decoded frames
// instead of presented ones. Skipped while the tab is hidden, because browsers
// throttle decoding there and the reading would be nonsense.
function decodedFps(q0, t0) {
  if (!q0 || document.hidden || typeof video.getVideoPlaybackQuality !== 'function') return 0;
  const q1 = video.getVideoPlaybackQuality();
  const dt = video.currentTime - t0;
  const df = q1.totalVideoFrames - q0.totalVideoFrames;
  return (dt > 0.15 && df > 3) ? df / dt : 0;
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

['resSelect', 'qualitySelect', 'codecSelect'].forEach(id =>
  document.getElementById(id).addEventListener('change', () => {
    saveSettings();
    if (haveFrame) { computeOutSize(); render(); }
    else updateQualityNote();
  }));

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
  if (haveFrame) { computeOutSize(); render(); }
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
  splitX = clamp((clientX - r.left) / r.width, 0, 1);
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
  rangeEl.textContent = trimmed
    ? `${fmt(inPoint)} → ${fmt(effOut())} (${Math.max(0, effOut() - inPoint).toFixed(1)}s)`
    : 'full clip';
  updateQualityNote();
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
function fmtVal(c) {
  const v = params[c.k];
  if (c.pct) return Math.round(v * 100) + '%';
  if (c.signed) return (v > 0 ? '+' : '') + v.toFixed(2);
  return v.toFixed(2);
}

// Build the slider panel from CONTROLS, grouped, with the advanced bits folded
// away so the default view stays short.
(function buildControls() {
  const host = document.getElementById('ctrlGroups');
  const groups = [];
  CONTROLS.forEach(c => {
    let grp = groups.find(g => g.name === c.g);
    if (!grp) { grp = { name: c.g, items: [] }; groups.push(grp); }
    grp.items.push(c);
  });

  groups.forEach(grp => {
    const h = document.createElement('h2');
    h.className = 'panel-title';
    h.style.marginTop = '22px';
    h.textContent = grp.name;
    host.appendChild(h);

    const plain = grp.items.filter(c => !c.advanced);
    const adv = grp.items.filter(c => c.advanced);
    plain.forEach(c => host.appendChild(ctrlEl(c)));
    if (adv.length) {
      const det = document.createElement('details');
      det.className = 'adv';
      const sum = document.createElement('summary');
      sum.textContent = 'Advanced';
      det.appendChild(sum);
      adv.forEach(c => det.appendChild(ctrlEl(c)));
      host.appendChild(det);
    }
  });
})();

function ctrlEl(c) {
  const wrap = document.createElement('div');
  wrap.className = 'ctrl';
  wrap.innerHTML =
    `<div class="ctrl-head"><span>${c.label}</span><span class="ctrl-val" id="v-${c.k}"></span></div>` +
    `<input type="range" id="s-${c.k}" min="${c.min}" max="${c.max}" step="${c.step}">` +
    `<div class="ctrl-note">${c.note}</div>`;
  wrap.querySelector('input').addEventListener('input', (e) => {
    params[c.k] = parseFloat(e.target.value);
    document.getElementById('v-' + c.k).textContent = fmtVal(c);
    markPresetCustom();
    updatePipelineMeta();
    render();
    saveSettings();
  });
  return wrap;
}

function syncUI() {
  CONTROLS.forEach(c => {
    document.getElementById('s-' + c.k).value = params[c.k];
    document.getElementById('v-' + c.k).textContent = fmtVal(c);
  });
  updatePipelineMeta();
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

/* Auto-enhance: measure the loaded clip, then set every slider from what it
 * actually needs — the one-tap "HD" button, but showing its working. */
document.getElementById('autoBtn').addEventListener('click', async () => {
  if (!haveFrame) return;
  const btn = document.getElementById('autoBtn');
  const noteEl = document.getElementById('autoNote');
  btn.disabled = true;
  const wasTime = video.currentTime;
  try {
    const look = await measureLook(video, (p) => { btn.textContent = `✦ Reading clip… ${p}%`; });
    applyParams(lookToParams(look));
    noteEl.innerHTML = `Measured: <b>${look.noise.toFixed(1)}</b> noise, <b>${Math.round(look.block * 100)}%</b> blocking, ` +
      `<b>${Math.round(look.C)}</b>/100 contrast, <b>${Math.round(look.S)}</b>/100 colour, <b>${Math.round(look.Sh)}</b>/100 sharpness. Sliders set to match.`;
  } catch (e) {
    noteEl.textContent = 'Could not read this clip — set the sliders by hand, or try a preset.';
  }
  btn.textContent = '✦ Auto-enhance this clip';
  btn.disabled = false;
  try { video.currentTime = wasTime; } catch (_) {}
  render();
});

loadSettings();     // restore saved sliders/quality/framing before first paint
syncUI();
updateQualityNote();

/* ─────────────  Measuring a clip  ─────────────
 * Samples frames and reports what the picture is like now: tone and colour from
 * a downscaled copy, and — importantly — noise and compression blocking from a
 * native-resolution crop, because downscaling destroys the 8×8 grid and the
 * grain that those two need to see. */
async function measureLook(vid, onProgress) {
  const W = 320, H = Math.max(1, Math.round(320 * vid.videoHeight / vid.videoWidth));
  const small = document.createElement('canvas');
  small.width = W; small.height = H;
  const sctx = small.getContext('2d', { willReadFrequently: true });

  const NW = Math.min(256, vid.videoWidth), NH = Math.min(256, vid.videoHeight);
  const sx = Math.max(0, Math.floor((vid.videoWidth - NW) / 2));
  const sy = Math.max(0, Math.floor((vid.videoHeight - NH) / 2));
  const nat = document.createElement('canvas');
  nat.width = NW; nat.height = NH;
  const nctx = nat.getContext('2d', { willReadFrequently: true });

  const seekTo = (t) => new Promise(res => {
    const on = () => { vid.removeEventListener('seeked', on); res(); };
    vid.addEventListener('seeked', on);
    try { vid.currentTime = t; } catch (_) { res(); }
    setTimeout(res, 2000);
  });

  const dur = (vid.duration && isFinite(vid.duration)) ? vid.duration : 0;
  const N = 8;
  let count = 0, sumL = 0, sumL2 = 0, sumS = 0, sumR = 0, sumB = 0;
  let sumEdge = 0, frames = 0, sumNoise = 0, noiseN = 0;
  let onGrid = 0, onGridN = 0, offGrid = 0, offGridN = 0;

  try { vid.pause(); } catch (_) {}

  for (let i = 0; i < N; i++) {
    if (onProgress) onProgress(Math.round(i / N * 100));
    const t = dur ? Math.min(dur * (i + 0.5) / N, Math.max(0, dur - 0.05)) : 0;
    await seekTo(t);

    sctx.drawImage(vid, 0, 0, W, H);
    let img;
    try { img = sctx.getImageData(0, 0, W, H).data; }
    catch (_) { throw new Error('frames blocked'); }

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

    // ── native-resolution crop: noise + blocking ──
    nctx.drawImage(vid, sx, sy, NW, NH, 0, 0, NW, NH);
    const nimg = nctx.getImageData(0, 0, NW, NH).data;
    const nl = new Float32Array(NW * NH);
    for (let p = 0, q = 0; p < nimg.length; p += 4, q++)
      nl[q] = 0.2126 * nimg[p] + 0.7152 * nimg[p + 1] + 0.0722 * nimg[p + 2];

    for (let y = 1; y < NH - 1; y++) for (let x = 1; x < NW - 1; x++) {
      const q = y * NW + x;
      const l = nl[q], lft = nl[q - 1], rgt = nl[q + 1], up = nl[q - NW], dn = nl[q + NW];
      // Noise is the high-frequency energy left in patches that are otherwise
      // flat — real detail would show up as a gradient across the neighbours.
      const rng = Math.max(lft, rgt, up, dn) - Math.min(lft, rgt, up, dn);
      if (rng < 12) { sumNoise += Math.abs(4 * l - (lft + rgt + up + dn)) / 4; noiseN++; }
      // Blocking shows as steps that line up with the codec's 8-pixel grid,
      // so compare the differences on those columns/rows against all the rest.
      const d = Math.abs(l - lft);
      if ((sx + x) % 8 === 0) { onGrid += d; onGridN++; } else { offGrid += d; offGridN++; }
      const dv = Math.abs(l - up);
      if ((sy + y) % 8 === 0) { onGrid += dv; onGridN++; } else { offGrid += dv; offGridN++; }
    }

    frames++;
    if (!dur) break;
  }

  if (!count) throw new Error('no frames');

  const meanL = sumL / count;
  const stdL = Math.sqrt(Math.max(0, sumL2 / count - meanL * meanL));
  const noise = noiseN ? sumNoise / noiseN : 0;
  const onM = onGridN ? onGrid / onGridN : 0;
  const offM = offGridN ? offGrid / offGridN : 0;
  const block = offM > 0.01 ? clamp(onM / offM - 1, 0, 1.5) : 0;

  return {
    B: meanL / 255 * 100,
    C: Math.min(100, stdL / 70 * 100),
    S: Math.min(100, sumS / count * 100),
    Sh: Math.min(100, (frames ? sumEdge / frames : 0) / 18 * 100),
    warm: (sumR - sumB) / count,
    noise,
    block,
  };
}

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

// True when we can do the proper offline, frame-by-frame transcode (modern
// Chrome/Edge). This keeps every frame, does real 4K, and controls file size.
function canWebCodecs() {
  // No requestVideoFrameCallback requirement: the export walks the clip by
  // seeking, so it doesn't depend on the browser presenting frames on schedule.
  return typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined' &&
    !!window.Mp4Muxer;
}

/* Find the best encoder configuration this machine will actually accept.
 *
 * Two ladders, tried in order. Codec strings run best-compression-first (H.264
 * High 5.2, High 4.0, Main, Baseline). Each is offered with the quality tuning
 * and then without: latencyMode 'quality' lets the encoder reorder frames and
 * look ahead, which is most of the difference between a browser export and a
 * real encoder, but a browser that rejects it should still get the offline path
 * rather than dropping all the way back to real-time recording.
 *
 * HEVC is only ever a preference. Plenty of machines expose no HEVC encoder at
 * all, and silently producing a worse file is nicer than refusing to export. */
const H264_LADDER = [
  ['avc1.640834', { avc: { format: 'avc' } }],
  ['avc1.640028', { avc: { format: 'avc' } }],
  ['avc1.4d0028', { avc: { format: 'avc' } }],
  ['avc1.42E01E', { avc: { format: 'avc' } }],
];
const HEVC_LADDER = [['hev1.1.6.L123.B0', { hevc: { format: 'hevc' } }]];

async function pickVideoConfig(size, preferHevc) {
  const ladders = preferHevc ? [HEVC_LADDER, H264_LADDER] : [H264_LADDER];
  const tunings = [{ latencyMode: 'quality', bitrateMode: 'variable' }, {}];
  for (const ladder of ladders) {
    for (const tune of tunings) {
      for (const [codec, extra] of ladder) {
        const c = { ...size, codec, ...extra, ...tune };
        try { if ((await VideoEncoder.isConfigSupported(c)).supported) return c; } catch (_) {}
      }
    }
  }
  return null;
}

// Not every machine has an HEVC encoder. Find out once, up front, and grey the
// option out rather than letting someone pick it and quietly get H.264.
(async function checkHevc() {
  const opt = document.querySelector('#codecSelect option[value="hevc"]');
  if (!opt) return;
  let ok = false;
  if (typeof VideoEncoder !== 'undefined') {
    try {
      ok = (await VideoEncoder.isConfigSupported({
        codec: 'hev1.1.6.L123.B0', hevc: { format: 'hevc' },
        width: 1920, height: 1080, bitrate: 12e6, framerate: 60,
      })).supported;
    } catch (_) { ok = false; }
  }
  if (!ok) {
    opt.disabled = true;
    opt.textContent = 'H.265 / HEVC — not available on this device';
    if (document.getElementById('codecSelect').value === 'hevc') {
      document.getElementById('codecSelect').value = 'h264';
      saveSettings();
      updateQualityNote();
    }
  }
})();

// Report the export format up front so nobody's surprised by a .webm, and warn
// about the main TikTok "couldn't decode" cause (webm / iOS recorder).
(function noteFormat() {
  const note = document.getElementById('fmtNote');
  if (canWebCodecs()) {
    note.innerHTML = 'Exports <b>.mp4</b> frame-by-frame — keeps every frame, does real 4K, and controls the file size. TikTok-ready.';
    return;
  }
  const mime = pickMime();
  if (!mime) { note.textContent = 'Video export isn\'t supported in this browser — use Chrome or Edge.'; return; }
  if (mime.startsWith('video/mp4'))
    note.innerHTML = 'Exports <b>.mp4 (H.264)</b> — TikTok reads this directly.';
  else
    note.innerHTML = 'This browser records <b>.webm</b>, which TikTok often <b>can\'t decode</b>. ' +
      'For a TikTok-ready .mp4, use <b>Chrome or Edge</b>.';
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
      ? 'On iPhone, restoring/preview works; if <b>Export</b> fails, use Chrome on Android or a laptop for the final render (iOS Safari\'s recorder is limited).'
      : 'Export works in Chrome on Android. Keep the screen on while it renders.');
})();

let recording = false;

function resetExportState() {
  recording = false;
  exportBtn.disabled = false;
  exportBtn.textContent = '⬇ Export enhanced clip';
  try { video.pause(); } catch (_) {}
  releaseWake();
  setRenderSize(viewW, viewH);
  playBtn.textContent = '▶ Play';
}

function downloadBlob(blob, name, audioDropped) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  const outMB = blob.size / 1048576;
  let msg = `✓ Saved <b>${name}</b> — ${outMB.toFixed(1)} MB`;
  if (srcFileSize) {
    const inMB = srcFileSize / 1048576;
    const pct = Math.round((1 - blob.size / srcFileSize) * 100);
    msg += pct > 0 ? `, <b>${pct}% smaller</b> than the ${inMB.toFixed(1)} MB original.`
                   : ` (original ${inMB.toFixed(1)} MB — pick a lower Quality to shrink it).`;
  } else msg += '.';
  if (audioDropped) msg += ' <b>Audio couldn\'t be kept — add a sound in TikTok.</b>';
  setStatus(msg, '');
}

// Seek to an exact time and wait until that frame is really the current one.
// Setting currentTime to where we already are fires no 'seeked' event in some
// browsers, so short-circuit that case rather than waiting out the timeout.
function seekFrame(t) {
  return new Promise((resolve) => {
    if (Math.abs(video.currentTime - t) < 1e-4) return resolve();
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      video.removeEventListener('seeked', finish);
      resolve();
    };
    const timer = setTimeout(finish, 3000);    // never hang on a bad seek
    video.addEventListener('seeked', finish);
    try { video.currentTime = t; } catch (_) { finish(); }
  });
}

function fmtEta(secs) {
  if (secs < 60) return Math.ceil(secs) + 's';
  const m = Math.floor(secs / 60);
  return `${m}m ${Math.ceil(secs - m * 60)}s`;
}

/* Yield to the event loop without a timer. setTimeout is clamped — to 4ms
 * normally and to a full second once the tab is backgrounded — so polling the
 * encoder queue with it turned a sub-millisecond wait into a stall long enough
 * to dominate the export. A MessageChannel round trip isn't clamped. */
const yieldNow = (() => {
  const ch = new MessageChannel();
  let waiting = [];
  ch.port1.onmessage = () => { const w = waiting; waiting = []; w.forEach(f => f()); };
  return () => new Promise(res => { waiting.push(res); ch.port2.postMessage(0); });
})();

let cancelExport = false;

exportBtn.addEventListener('click', async () => {
  // While an export is running the same button is the cancel control — these
  // can take a while now that they're frame-exact rather than real time.
  if (recording) {
    cancelExport = true;
    setStatus('Cancelling…', 'busy');
    return;
  }
  if (!haveFrame) return;
  cancelExport = false;
  if (canWebCodecs()) {
    try { await webcodecsExport(); return; }
    catch (e) {
      console.warn('Offline encoder fell back:', e);
      resetExportState();
      setStatus('Switching to the standard recorder…', 'busy');
    }
  }
  await mediaRecorderExport();
});

/* ── Offline WebCodecs transcode: keeps every frame, true 4K, small files ── */
async function webcodecsExport() {
  const plan = getPlan();
  // Render at full output size for the export, whatever the preview was using.
  setRenderSize(outW, outH);
  const width = canvas.width, height = canvas.height;
  const start = inPoint, end = effOut();
  const dur = Math.max(0.1, end - start);
  const muteOut = document.getElementById('muteChk').checked;
  const wasMuted = video.muted;

  recording = true;
  exportBtn.textContent = '✕ Cancel export';
  compare = false; compareChk.checked = false;
  await acquireWake();
  setStatus(`<span>Processing every frame at ${width}×${height} — keep this tab open. ` +
    `This runs as fast as your GPU allows, not in real time, so heavy settings take longer than the clip.</span>` +
    '<div class="progress"><i id="pbar"></i></div><span id="pdet"></span>', 'busy');
  playBtn.textContent = '⏳ Processing…';

  // 1. Decode source audio up front (best-effort) so the muxer track matches it.
  let audioInfo = null;
  if (!muteOut && curFile) {
    try {
      const ab = await curFile.arrayBuffer();
      const ac = new (window.AudioContext || window.webkitAudioContext)();
      const buf = await ac.decodeAudioData(ab.slice(0));
      ac.close();
      if (buf.length > 0) audioInfo = { buf, sampleRate: buf.sampleRate, channels: Math.min(2, buf.numberOfChannels) };
    } catch (_) { audioInfo = null; }
  }

  // 2. Pick the encoder config first — the muxer has to be told up front which
  //    codec it is going to be handed.
  const vcfg = await pickVideoConfig(
    { width, height, bitrate: plan.bitrate, framerate: plan.fps }, plan.codec === 'hevc');
  if (!vcfg) throw new Error('No supported H.264 encoder');
  const isHevc = vcfg.codec.indexOf('hev') === 0;
  // The plan discounted the bitrate for HEVC's efficiency; if we ended up on
  // H.264 anyway, give those bits back rather than shipping a starved file.
  if (!isHevc && plan.codec === 'hevc') vcfg.bitrate = Math.round(vcfg.bitrate / 0.72);

  const target = new Mp4Muxer.ArrayBufferTarget();
  const muxer = new Mp4Muxer.Muxer(Object.assign({
    target, fastStart: 'in-memory',
    firstTimestampBehavior: 'offset',
    video: { codec: isHevc ? 'hevc' : 'avc', width, height, frameRate: plan.fps },
  }, audioInfo ? { audio: { codec: 'aac', numberOfChannels: audioInfo.channels, sampleRate: audioInfo.sampleRate } } : {}));

  let encErr = null;
  const encoder = new VideoEncoder({
    output: (c, m) => { try { muxer.addVideoChunk(c, m); } catch (e) { encErr = e; } },
    error: (e) => { encErr = e; },
  });
  encoder.configure(vcfg);

  // 3. Walk the clip frame by frame by SEEKING to each one, not by playing it.
  //
  //    This used to play the clip and encode whatever requestVideoFrameCallback
  //    handed over. That callback only fires for frames the browser actually
  //    *presents*: at 4K this pipeline needs longer than a frame interval to
  //    render one, so the browser skipped ahead and those frames were lost for
  //    good. Because the timestamps came from mediaTime, every gap got baked
  //    into the file as a held frame — that was the stuttering. Encoder
  //    back-pressure never helped, because the encoder was not the slow part.
  //
  //    Seeking costs wall-clock time, but it is frame-exact no matter how heavy
  //    the settings are, and it emits a constant frame rate, which players and
  //    TikTok both prefer to the variable timing real-time capture produced.
  const frameDur = Math.round(1e6 / plan.fps);
  const gop = Math.max(30, Math.round(plan.fps * 2));   // keyframe every ~2s
  const stepT = 1 / plan.fps;
  const total = Math.max(1, Math.ceil(dur / stepT));
  const lastT = Math.min(end, (video.duration || end) - 1e-3);

  video.muted = true;
  video.pause();

  const pb = document.getElementById('pbar');
  const pd = document.getElementById('pdet');
  let frameCount = 0;
  const t0 = performance.now();

  for (let i = 0; i < total; i++) {
    if (encErr || cancelExport) break;
    await seekFrame(Math.min(start + i * stepT, lastT));
    render();
    const vf = new VideoFrame(canvas, { timestamp: i * frameDur, duration: frameDur });
    encoder.encode(vf, { keyFrame: i % gop === 0 });
    vf.close();
    frameCount++;

    if (pb) pb.style.width = ((i + 1) / total * 100).toFixed(1) + '%';
    if (pd && i % 4 === 0) {
      const elapsed = (performance.now() - t0) / 1000;
      const left = Math.max(0, elapsed / ((i + 1) / total) - elapsed);
      pd.textContent = `frame ${i + 1} of ${total} · ${((i + 1) / elapsed).toFixed(1)} fps · ~${fmtEta(left)} left`;
    }

    // Keep the encoder queue bounded so a long 4K clip can't balloon memory.
    let guard = 0;
    while (encoder.encodeQueueSize > 8 && !encErr && guard++ < 100000) await yieldNow();
  }

  video.muted = wasMuted;
  const bail = (err) => {
    try { encoder.close(); } catch (_) {}
    releaseWake();
    setRenderSize(viewW, viewH);
    render();
    throw err;
  };
  if (encErr) bail(encErr);
  if (cancelExport) {
    try { encoder.close(); } catch (_) {}
    releaseWake();
    recording = false;
    exportBtn.textContent = '⬇ Export enhanced clip';
    setRenderSize(viewW, viewH);
    render();
    playBtn.textContent = '▶ Play';
    setStatus('Export cancelled — nothing was saved.', '');
    return;
  }
  if (frameCount < 2) bail(new Error('No frames captured'));
  await encoder.flush();
  try { encoder.close(); } catch (_) {}

  // 4. Audio (offline, best-effort — silent export if it fails).
  let audioKept = false;
  if (audioInfo) { try { audioKept = await encodeAudioRange(audioInfo, muxer, start, end); } catch (_) { audioKept = false; } }

  muxer.finalize();
  const blob = new Blob([target.buffer], { type: 'video/mp4' });
  releaseWake();
  recording = false;
  exportBtn.disabled = false;
  exportBtn.textContent = '⬇ Export enhanced clip';
  playBtn.textContent = '▶ Play';
  setRenderSize(viewW, viewH);
  render();
  downloadBlob(blob, `losinn_${width}x${height}.mp4`, !!audioInfo && !audioKept);
}

async function encodeAudioRange(info, muxer, start, end) {
  const { buf, sampleRate, channels } = info;
  let aerr = null;
  const aenc = new AudioEncoder({
    output: (c, m) => { try { muxer.addAudioChunk(c, m); } catch (e) { aerr = e; } },
    error: (e) => { aerr = e; },
  });
  const acfg = { codec: 'mp4a.40.2', sampleRate, numberOfChannels: channels, bitrate: 192000 };
  if (!(await AudioEncoder.isConfigSupported(acfg)).supported) return false;
  aenc.configure(acfg);
  const chData = [];
  for (let c = 0; c < channels; c++) chData.push(buf.getChannelData(c));
  const startS = Math.max(0, Math.floor(start * sampleRate));
  const endS = Math.min(buf.length, Math.ceil(end * sampleRate));
  const CH = 4096;
  for (let pos = startS; pos < endS && !aerr; pos += CH) {
    const n = Math.min(CH, endS - pos);
    const planar = new Float32Array(n * channels);
    for (let c = 0; c < channels; c++) planar.set(chData[c].subarray(pos, pos + n), c * n);
    const adata = new AudioData({
      format: 'f32-planar', sampleRate, numberOfFrames: n, numberOfChannels: channels,
      timestamp: Math.round((pos - startS) / sampleRate * 1e6), data: planar,
    });
    aenc.encode(adata); adata.close();
  }
  await aenc.flush();
  try { aenc.close(); } catch (_) {}
  return !aerr;
}

/* ── Fallback: real-time MediaRecorder (older browsers without WebCodecs) ── */
async function mediaRecorderExport() {
  const mime = pickMime();
  if (!mime) { setStatus('Your browser can\'t export video. Use Chrome or Edge.', 'err'); resetExportState(); return; }

  recording = true;
  exportBtn.disabled = true;
  compare = false; compareChk.checked = false;
  const wasMuted = video.muted;
  await acquireWake();

  const plan = getPlan();
  setRenderSize(outW, outH);
  render();

  const muteOut = document.getElementById('muteChk').checked;
  const stream = canvas.captureStream(plan.fps);
  if (!muteOut) {
    try {
      video.muted = false;
      const audio = video.captureStream ? video.captureStream()
                  : video.mozCaptureStream ? video.mozCaptureStream() : null;
      if (audio) audio.getAudioTracks().forEach(t => stream.addTrack(t));
    } catch (_) {}
  }

  let rec;
  try {
    rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: plan.bitrate, audioBitsPerSecond: 192_000 });
  } catch (err) {
    setStatus('Could not start recorder: ' + err.message, 'err');
    recording = false; exportBtn.disabled = false; video.muted = wasMuted; releaseWake();
    setRenderSize(viewW, viewH);
    return;
  }

  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const ext = mime.startsWith('video/mp4') ? 'mp4' : 'webm';
  setStatus('<span>Rendering in real time — keep this tab open…</span><div class="progress"><i id="pbar"></i></div>', 'busy');

  const start = inPoint, end = effOut();
  let safetyTimer = 0;
  const onProg = () => {
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
    recording = false; exportBtn.disabled = false; playBtn.textContent = '▶ Play';
    setRenderSize(viewW, viewH);
    render();
    downloadBlob(blob, `losinn_${outW}x${outH}.${ext}`, false);
  };

  const finish = () => { if (rec.state !== 'inactive') rec.stop(); video.pause(); };
  video.addEventListener('ended', finish, { once: true });

  video.pause();
  video.currentTime = inPoint;
  await new Promise(r => { video.onseeked = r; });
  video.onseeked = null;

  rec.start(250);
  safetyTimer = setTimeout(finish, (end - start) * 1000 + 5000);
  try { await video.play(); }
  catch (err) { setStatus('Playback blocked: ' + err.message, 'err'); finish(); }
  playBtn.textContent = '❚❚ Recording…';

  if ('requestVideoFrameCallback' in video) {
    const pump = () => { if (!recording) return; render(); video.requestVideoFrameCallback(pump); };
    video.requestVideoFrameCallback(pump);
  }
}

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
      <b>Editing tips for R6:</b> turn CapCut's own <b>Sharpen off</b>, or keep it under 10.
      This app's sharpening is contrast-adaptive and runs <i>after</i> deblocking, so it doesn't
      carve halos into artefacts the way a plain sharpen slider does — stacking both just adds crunch.
      Use CapCut's <b>Enhance / Super Resolution</b> toggle only on low-res source; on already-1080p clips it does little and can smear.
    </div>
    <div class="callout">
      <b>Your 65 in-game brightness (important):</b> R6's brightness slider at 65 sits <i>above</i> the ~50 default,
      which <b>lifts the black floor</b> — shadows go grey and the whole clip looks flat and washed. The fix is <i>not</i> more brightness.
      In this app use the <b>"R6 · 65 bright"</b> preset: it adds <b>Contrast ~1.12</b>, a small <b>Brightness −0.02</b>, and
      <b>Deepen blacks ~5%</b> to pull those lifted blacks back down, plus <b>Vibrance ~28%</b> so colours pop after upload.
      <b>Deband</b> matters here too — lifting flat shadows is exactly what makes banding visible.
    </div>
  </div>
  <div class="info-card">
    <h3>⭐ The single best-quality thing you can do inside CapCut</h3>
    <div class="sub">If you change one thing, change this.</div>
    <ul class="tip-list">
      <li><b>Use the custom Bit rate slider, not "Recommended".</b> On the export screen tap the bitrate dropdown → <b>Custom</b> and drag it high (aim <b>~24 Mbps</b> for a 1080p master). CapCut's "Recommended" is deliberately low to save space — it's the biggest hidden quality killer.</li>
      <li><b>Match the project to your source, don't upscale in CapCut.</b> Set the project to <b>1080p 60fps</b> for a 1080p Xbox clip. Exporting a 1080p clip at "4K" just bloats the file with no new detail — do the upscaling in <b>this app</b> instead, where it's edge-adaptive.</li>
      <li><b>Export HEVC (H.265) if you want the cleanest master</b> at a smaller size, then restore + convert to H.264 here for TikTok. Same quality, less generation loss to carry forward.</li>
      <li><b>Do all your cuts/effects in one project and export once.</b> Every extra export is another lossy re-encode, and every re-encode adds blocking that this app then has to undo.</li>
      <li><b>Turn off any "reduce size / smart compression" toggle</b> before exporting the master.</li>
    </ul>
    <div class="callout">
      <b>Bottom line:</b> CapCut = clean high-bitrate cut. <b>losinn qual</b> = restore + upscale + sharpen + grade + trim.
      TikTok = final compression. Each step does one job, so nothing gets double-crushed.
    </div>
  </div>
  <div class="info-card">
    <h3>Avoid double compression</h3>
    <div class="sub">Every re-encode loses quality. Keep the chain short.</div>
    <ul class="tip-list">
      <li>Xbox clip → CapCut (edit once, export ~16–24 Mbps 1080p60) → <b>this app</b> (restore, enhance, export) → TikTok. That's it.</li>
      <li>Don't export from CapCut, re-import, export again. Each pass adds mush and blocky artefacts.</li>
      <li>Always feed this app the <b>highest-bitrate</b> version you have. Deblock and denoise can hide what compression did, but nothing can bring back detail it already threw away.</li>
    </ul>
  </div>`;

document.getElementById('tab-tiktok').innerHTML = `
  <div class="info-card">
    <h3>⚠ TikTok says "couldn't decode / unsupported"?</h3>
    <div class="sub">Almost always the file format — here's how to get one TikTok accepts.</div>
    <ul class="tip-list">
      <li><b>Check the file is .mp4, not .webm.</b> TikTok frequently rejects .webm. This app exports .mp4 in <b>Chrome or Edge</b>; some browsers (older or in-app ones) fall back to .webm — the note under the Export button tells you which you'll get.</li>
      <li><b>Set Codec to H.264.</b> H.265/HEVC makes a smaller file and is great as a master, but a few phones and apps won't read it. If an upload fails, switch to H.264 and re-export.</li>
      <li><b>iPhone is the usual culprit.</b> iOS Safari's recorder can make files TikTok won't read. Do the <b>Export</b> step in <b>Chrome on Android</b> or <b>Chrome/Edge on a computer</b> — you can still enhance/preview on iPhone, just export elsewhere.</li>
      <li><b>If you already have a .webm,</b> drop it into CapCut and export it as MP4 (H.264) — that re-wraps it into something TikTok reads.</li>
      <li><b>Still failing?</b> Try <b>1080p</b> (not 4K) — huge files from a phone can finish half-written and won't decode.</li>
    </ul>
  </div>
  <div class="info-card">
    <h3>Get the most views + best quality on TikTok</h3>
    <div class="sub">TikTok compresses hard. These settings and habits fight that and help the algorithm.</div>
    <ul class="tip-list">
      <li><b>Turn on HD upload:</b> Profile → ☰ → Settings → <b>"Data Saver" OFF</b>, and on the post screen tick <b>"Upload HD"</b> / "Allow high-quality uploads". Huge difference.</li>
      <li><b>Upload 1080×1920, 9:16, MP4 (H.264), 60fps.</b> Fills the screen, no black bars. The <b>High</b> quality option here lands around 16 Mbps at 1080p60 — under ~5 gets a quality-downgrade flag, over ~25 gets flattened anyway.</li>
      <li><b>Give it a clean master.</b> TikTok's encoder spends its bits on whatever moves — noise and blocking eat the budget that should go to your gameplay. Deblock + denoise before upload genuinely survives the re-compression better.</li>
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
      clean, sharp, high-bitrate, correctly-sized master (HD upload ON) means what survives compression looks far better than a soft, noisy, low-bitrate clip.
    </div>
  </div>`;

/* ─────────────  Analyse tab  ─────────────
 * Same measurement the Auto button uses, on a clip you drop here instead of the
 * one you're editing. It reports what the video looks like now — it cannot
 * recover the exact CapCut slider values someone used, because a finished,
 * re-encoded video no longer stores that edit history. */
(function () {
  const drop = document.getElementById('anDrop');
  const fileIn = document.getElementById('anFile');
  const busy = document.getElementById('anBusy');
  const results = document.getElementById('anResults');
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

  async function run(file) {
    if (!file.type.startsWith('video/')) { fail('Please choose a video file.'); return; }
    drop.hidden = true; results.hidden = true;
    showBusy('Loading clip…');
    anVideo.src = URL.createObjectURL(file);
    try {
      await new Promise((res, rej) => { anVideo.onloadeddata = res; anVideo.onerror = () => rej(); });
    } catch (_) { fail('Could not read that video file.'); return; }
    if (!anVideo.videoWidth) { fail('Could not read that video file.'); return; }

    let look;
    try { look = await measureLook(anVideo, (p) => showBusy(`Analysing… ${p}%`)); }
    catch (e) {
      fail(String(e.message).includes('blocked')
        ? 'The browser blocked reading this video\'s frames.'
        : 'Could not analyse that clip.');
      return;
    }
    renderMetrics(look);
    busy.hidden = true; results.hidden = false;
  }

  function showBusy(msg) { busy.hidden = false; busy.textContent = msg; }
  function fail(msg) { busy.hidden = false; busy.textContent = msg; drop.hidden = false; }

  // first threshold strictly greater than v wins
  function pick(v, table) { for (const [th, word] of table) if (v < th) return word; return table[table.length - 1][1]; }

  function renderMetrics(m) {
    lastLook = m;
    const { B, C, S, Sh, warm, noise, block } = m;
    const noisePct = Math.min(100, noise / 14 * 100);
    const blockPct = Math.min(100, block * 100);

    const bW = pick(B, [[30, 'Dark'], [42, 'Dim'], [58, 'Balanced'], [72, 'Bright'], [101, 'Very bright']]);
    const cW = pick(C, [[30, 'Flat'], [45, 'Medium'], [64, 'Punchy'], [101, 'Very punchy']]);
    const sW = pick(S, [[18, 'Muted'], [30, 'Natural'], [45, 'Vivid'], [101, 'Very saturated']]);
    const shW = pick(Sh, [[25, 'Soft'], [45, 'Natural'], [65, 'Sharpened'], [101, 'Heavily sharpened']]);
    const nW = pick(noisePct, [[15, 'Clean'], [35, 'Slight'], [60, 'Noisy'], [101, 'Very noisy']]);
    const kW = pick(blockPct, [[12, 'None'], [30, 'Slight'], [55, 'Blocky'], [101, 'Heavily compressed']]);
    const wW = warm < -6 ? 'Cool' : warm > 6 ? 'Warm' : 'Neutral';
    const warmPct = clamp(warm / 40 * 100, -100, 100);
    const warmLabel = wW === 'Neutral' ? 'Neutral' : `${wW} (${warm >= 0 ? '+' : '−'}${Math.abs(Math.round(warm))})`;

    document.getElementById('anSummary').innerHTML =
      `Overall this clip looks <b>${bW.toLowerCase()}</b>, <b>${cW.toLowerCase()}</b> contrast, ` +
      `<b>${sW.toLowerCase()}</b> colour, <b>${shW.toLowerCase()}</b>, and colour-wise <b>${wW.toLowerCase()}</b>. ` +
      `Compression-wise it's <b>${nW.toLowerCase()}</b> for noise and <b>${kW.toLowerCase()}</b> for blocking. ` +
      `Hit <b>Use in Enhance</b> to set every slider from these readings.`;

    const warmHalf = Math.abs(warmPct) / 2;
    document.getElementById('anMetrics').innerHTML = [
      bar('Brightness', Math.round(B) + ' / 100', B, `${bW} — average lightness of the picture.`),
      bar('Contrast', Math.round(C) + ' / 100', C, `${cW} — gap between the darkest and brightest parts.`),
      bar('Saturation', Math.round(S) + ' / 100', S, `${sW} — how strong the colours are.`),
      bar('Sharpness', Math.round(Sh) + ' / 100', Sh, `${shW} — amount of fine edge detail.`),
      centreBar('Warmth', warmLabel, warm >= 0 ? 50 : 50 - warmHalf, warmHalf, 'Cool (blue) ← → warm (orange).'),
      bar('Noise', Math.round(noisePct) + ' / 100', noisePct, `${nW} — grain and fizz left by the encoder. Drives the Denoise slider.`),
      bar('Blocking', Math.round(blockPct) + ' / 100', blockPct, `${kW} — 8×8 compression squares. Drives the Deblock slider.`),
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
