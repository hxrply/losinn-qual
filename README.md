# losinn qual

A browser-based GPU video restorer/enhancer for Rainbow Six Siege clips. Drop in
a clip (e.g. an Xbox clip edited in CapCut), strip the compression damage out of
it, upscale to 1080p / 1440p / 4K, colour-grade it, **trim it to the best
moment**, compare before/after with a split slider, and export a high-bitrate MP4
ready for TikTok.

Everything runs client-side on your GPU — the video never leaves your machine,
and it works on weak PCs and phones that can't run Topaz. No install, no build
step, just static files. Black + light-purple theme.

**Tuned for Siege at 65 in-game brightness:** that setting lifts the black floor
(flat/greyish look), so the default preset adds contrast and a "Deepen blacks"
step to restore punch, rather than adding brightness.

## What it actually does

Three GPU passes, in the order a desktop restoration tool would run them.
Sharpening a blocky frame just gives you crisp blocks, so the artefacts come off
*first*, before anything magnifies them.

1. **Restore** (at source resolution) — deblock, edge-aware denoise, chroma
   clean-up, deband, and **temporal denoise**.
2. **Resample** — AMD FidelityFX **EASU** (edge-adaptive spatial upsampling) when
   enlarging, a windowed area filter when shrinking. Both beat the browser's
   built-in bilinear by a wide margin on diagonals, fences and fine text.
3. **Finish** (at output resolution) — FidelityFX **RCAS** sharpening with halo
   and noise suppression, local-contrast "clarity", then the grade: exposure and
   white balance in linear light, an endpoint-preserving S-curve for contrast,
   highlight rolloff, saturation/vibrance, optional grain, and triangular dither
   so 8-bit output doesn't band.

### Temporal denoise

The one thing no single-frame filter can do, and the biggest single quality lever
here. Noise is different on every frame but the scene mostly isn't, so averaging
in the previous restored frame cancels the noise anywhere the picture held still
— walls, floor, sky — at no cost in detail, because nothing there changed.

Anything that moved has to be rejected or it smears. The test for "did this
move?" runs on a **blurred** comparison of the two frames, never the raw
per-pixel difference: that difference *is* the noise being removed, so gating on
it would switch the filter off exactly where it's needed.

Measured on a synthetic clip with a static noisy patch and a bar crossing the
frame at 20px per frame: **43.8% less noise, with zero smearing** — the moving
bar's edge profile is identical with the filter on and off, and the largest
deviation anywhere behind it is 1 unit out of 277.

**Not neural super-resolution (Topaz/Wink).** Nothing here invents detail that
isn't in the source. What it does is remove the artefacts that make a console
clip look cheap, then enlarge and sharpen with far better filters than a video
player uses — which covers most of the gap, and runs in real time on a weak GPU.

### Auto-enhance

The **✦ Auto-enhance** button measures the clip and sets every slider from what
it actually needs. Tone and colour come from a downscaled copy; noise and
compression blocking are measured on a **native-resolution** crop, because
downscaling destroys the 8×8 grid and the grain those two need to see. The
**black floor** — how far off true black the darkest half-percent of the picture
sits — is read straight off a luma histogram, which is the direct measurement of
the problem this app exists for: at 65 in-game brightness R6 never reaches 0, so
the shadows sit raised and the clip looks washed. It shows you every reading it
used, so it isn't a black box.

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

- **Enhance** — auto-enhance, presets, saved profiles, 15 sliders grouped into
  Restore / Detail / Colour / Tone / Finish, **trim (set start / end)**, 9:16
  reframing, resolution + quality + codec.
- **Analyse** — measures any clip's brightness, contrast, saturation, warmth,
  sharpness, **noise, blocking and black floor**, and can load those readings
  straight into Enhance or save them as a profile.
- **CapCut Settings** — best export settings for Siege clips, plus the single
  highest-impact quality setting inside CapCut (the custom bitrate slider).
- **TikTok Tips** — how to upload for the best quality and reach.

## Export notes

- Exports **MP4** via WebCodecs in Chrome/Edge. The clip is walked **by seeking to
  every frame in turn**, not by playing it back: playback capture only ever sees
  the frames the browser manages to present, so at heavy settings it skipped
  frames and baked the gaps into the file as visible stutter. Seeking costs
  wall-clock time but is frame-exact at any setting, and emits a constant frame
  rate. Older browsers fall back to a real-time `MediaRecorder` capture, and some
  to `.webm`.
- Export runs **as fast as the GPU allows, not in real time** — heavy settings
  take longer than the clip itself. Progress shows frames done, throughput and an
  ETA, and the Export button becomes **Cancel** while it runs.
- H.264 by default (plays everywhere). **H.265/HEVC** is offered when the machine
  has an HEVC encoder, and the option greys itself out when it doesn't.
- Bitrate is derived the way an encoder front-end does it — **bits per pixel per
  frame** — rather than a fixed number per preset, so quality stays constant when
  you change resolution or the clip turns out to be 30fps. The picker shows the
  resulting Mbps and an estimated file size.
- Frame rate is **measured** from the clip rather than assumed, so a 30fps source
  doesn't get encoded as 60 and waste half its bitrate on duplicate frames.
- Only the trimmed range is exported if you set start/end points.
- The preview renders at up to 1080p even when exporting 4K, so scrubbing stays
  smooth on a weak GPU; the export itself always runs at full size.
- Defaults to **1080p / High quality (~16 Mbps at 60fps)** — the sweet spot that
  survives TikTok's re-compression (going above ~25 Mbps just gets flattened).

_(Project folder: `repos/R6 - Upscale`.)_
