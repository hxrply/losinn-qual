# losinn qual

A browser-based GPU video enhancer for Rainbow Six Siege clips. Drop in a clip
(e.g. an Xbox clip edited in CapCut), sharpen it with Contrast Adaptive
Sharpening, upscale to 1080p / 1440p / 4K, colour-grade it, **trim it to the best
moment**, compare before/after with a split slider, and export a high-bitrate
MP4 ready for TikTok.

Everything runs client-side on your GPU — the video never leaves your machine,
and it works on weak PCs and phones that can't run Topaz. No install, no build
step, just static files. Black + light-purple theme.

**Tuned for Siege at 65 in-game brightness:** that setting lifts the black floor
(flat/greyish look), so the default preset adds contrast and a "Deepen blacks"
step to restore punch, rather than adding brightness.

Not neural super-resolution (Topaz/Wink) — it upscales with a good filter and
CAS sharpening rather than inventing new detail, but that covers most of the
"crisp clip" look.

## Run it

```
python serve.py
```

It prints two URLs — one for this PC, one for your phone.

### Use it on your phone

1. Run `python serve.py` on your PC (phone and PC on the **same Wi-Fi**).
2. If Windows asks to allow Python through the firewall, click **Allow**.
3. On your phone, open the **"On your phone"** URL it printed
   (e.g. `http://192.168.1.20:8000`).
4. Tap the box to pick a clip from your camera roll.

Preview/enhance/trim works on iPhone and Android. The final **Export** is most
reliable in Chrome on Android or on a desktop (iOS Safari's video recorder is
limited).

## Tabs

- **Enhance** — sharpness, denoise, saturation, vibrance, contrast, brightness,
  deepen-blacks, **trim (set start / end)**, resolution + quality, one-click presets.
- **CapCut Settings** — best export settings for Siege clips, plus the single
  highest-impact quality setting inside CapCut (the custom bitrate slider).
- **TikTok Tips** — how to upload for the best quality and reach.

## Export notes

- Exports **MP4 (H.264)** in Chrome/Edge; other browsers fall back to `.webm`.
- Recording is **real time** — a 30s clip takes ~30s. Keep the tab open.
- Only the trimmed range is exported if you set start/end points.
- Defaults to **1080p / ~16 Mbps / 60fps** — the sweet spot that survives
  TikTok's re-compression (going above ~20 Mbps just gets flattened anyway).

_(Project folder: `repos/R6 - Upscale`.)_
