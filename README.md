# Orbital Atlas

A looping, four-act generative astronomy show built for the LED display outside
the BYU CS department. Single-page, no build step, no backend — open
`index.html` in a browser (or point any static file server at the repo) and it
runs.

## What it shows

The show loops continuously through four acts, each with its own pacing and
camera language:

1. **Night Sky** — six constellations (Orion, Ursa Major, Cassiopeia, Cygnus,
   Leo, Scorpius) rendered on a star dome, with connect-the-dots line reveals,
   a drifting Milky Way band, and a seasonal background tint tied to each
   constellation's real observing season.
2. **Solar System** — the Sun and eight planets on log-compressed orbits, each
   with a procedurally textured surface, axial spin, and one of three camera
   behaviors (slow orbit for Jupiter/Saturn, quick flyby for the small rocky
   planets, distant framing for the rest).
3. **Scale of the Universe** — a continuous zoom from Earth out to the
   observable universe in six stages (Earth → Solar System → nearby stars →
   Milky Way → Local Group → observable universe), crossfading between stages
   rather than cutting.
4. **Frontier Discoveries** — Sagittarius A* (with a gravitational-lensing
   shader), TRAPPIST-1, LIGO's first gravitational-wave detection, JWST, and a
   live pull from NASA's Astronomy Picture of the Day.

Each item's screen time is weighted rather than evenly divided — a handful of
"hero" moments (Orion, Jupiter, Saturn, the observable-universe finale, the
black hole) get noticeably longer holds and more visual detail than the rest.

## Stack

- **Three.js r128** (UMD build, via CDN) — the only external dependency.
  Loaded as a plain `<script>` tag; no bundler, no package.json.
- **Vanilla JS**, one IIFE in `app.js`. No framework — the whole thing is a
  render loop driving a handful of THREE.Group objects, so a framework would
  have added indirection without solving a real problem here.
- **Canvas 2D**, used in exactly two places: generating planet textures at
  startup (see below) and drawing the between-scene "warp" transition, which
  is cheap to do as a 2D overlay and not worth doing in WebGL.
- **Google Fonts** (Fraunces + IBM Plex Mono) and no other assets — every
  visual is generated at runtime, nothing is a static image.

## Architecture

### Rendering pipeline

`renderer.render()` doesn't go straight to the screen. Every frame renders
first to an offscreen `WebGLRenderTarget`, then a second full-screen pass
samples that texture through a custom `ShaderMaterial` that radially warps
pixels toward the black hole's screen-space position — that's the
gravitational-lensing effect in Act 4. This two-pass approach was chosen over
`THREE.EffectComposer` deliberately: the composer pulls in several addon
modules that aren't part of the core UMD build, and for a single effect that
only matters in one scene, a ~30-line shader is less fragile than adding a
postprocessing dependency chain to a kiosk that needs to run unattended.

### Timeline / pacing

`beatLookup(baseDuration, weights, elapsedMs)` is the core scheduling
primitive: each act has an array of per-item weights (e.g.
`WEIGHTS2 = [0.75, 0.85, 1, 0.85, 1.6, 1.6, 0.8, 0.8]` for the eight planets),
and `beatLookup` walks the weighted durations to find which item is active
and how far into its beat the clock is. This replaced an earlier version
where every item got an equal slice of its act's runtime — see the commit
history for why that changed.

### Camera

There's one camera "director": `setCameraTarget(pos, look)` sets a target
position/look-at pair, and `updateCamera(dt)` exponentially damps the actual
camera toward that target every frame (critically-damped lerp, not a fixed
tween), so cuts between targets never snap. Each scene just calls
`setCameraTarget` with wherever it wants the camera to end up next; Act 2 goes
further and picks from three reusable camera *profiles* (`orbit`, `flyby`,
`distant`) keyed on `planet.cam` in the data, rather than hand-writing a shot
for each of the eight planets.

### Procedural planet textures

Each planet's surface is a small canvas (256×128, drawn at 3x and downscaled)
built from a shared vocabulary — `bands` for cloud belts, `blotches` for
continents, `craters`, a `spot` for storms like Jupiter's Great Red Spot,
`polarCaps`. Every shape is a radial gradient that fades to full transparency
at its edge (`softBlob()`), not a hard-edged fill — an earlier version used
flat `fillRect`/`ellipse()` calls and the result read as construction paper,
not terrain (see the "Fix the planet textures" commit). Drawing 3x oversize
and letting `drawImage()` downscale is a cheap stand-in for a proper blur
filter and doesn't depend on canvas `filter` support.

### Shared gravity-well grid

One function, `buildGrid(cols, rows, spacing, color, opacity)`, builds a
`LineSegments` mesh and hands back an `update(dipFunction, t)` closure that
recomputes every vertex's height from an arbitrary function of `(x, z, t)`.
The same mesh type is reused for three different physical ideas: a static
well under the Sun (and a second, smaller well that follows whichever planet
is currently featured) in Act 2, an extreme well under Sagittarius A* in
Act 4, and a traveling ripple (`rippleDip`) for the LIGO gravitational-wave
beat — one abstraction, three physics metaphors.

### Act 3's crossfade

The six scale stages used to hard-cut into each other, which undercuts the
premise of a "zoom out" sequence. Each stage's group now has its per-material
base opacity captured once at construction (`userData.baseOpacity`), and
`setStageFade(group, opacity, scale)` multiplies every material's opacity by
a 0–1 factor while also scaling the group up or down — so the outgoing stage
visibly grows and fades as if the camera flew past it, while the incoming
stage shrinks in from oversize as if arriving. The camera's dolly distance is
also a single `easeInOutCubic` curve across the *entire* act's runtime
instead of a per-stage jump.

### Live data, with a fallback that actually gets exercised

Act 4's last beat fetches `https://api.nasa.gov/planetary/apod` for today's
title and summary. It does **not** attempt to load the associated image into
a WebGL texture — `apod.nasa.gov`'s image host doesn't send
`Access-Control-Allow-Origin`, so a cross-origin texture load silently fails
every time regardless of network conditions. The JSON endpoint is
CORS-enabled, so the text still comes through live; the visual for that beat
is always the generated starfield, and the "LIVE" badge only appears when the
fetch actually succeeds. If offline, or if NASA's shared `DEMO_KEY` rate
limit gets hit (likely for a display running unattended for hours — a real
key from api.nasa.gov removes that ceiling), it falls back to a fixed fact
about the Hubble Deep Field with no visible error state.

## Running it

No build step. Either:

```
open index.html
```

or serve the directory with anything static, e.g.:

```
python3 -m http.server 8000
```

then visit `http://localhost:8000`. An internet connection is only required
for the Google Fonts stylesheet, the Three.js CDN script, and the optional
live NASA data — everything else (all geometry, all textures, all content)
is generated or embedded in `app.js` and works offline.

## Files

- `index.html` — page shell: canvases, the HUD/caption overlay markup, the
  two `<script>`/`<link>` tags for external dependencies.
- `style.css` — all layout and typography for the HUD overlay.
- `app.js` — everything else: Three.js scene setup, all four acts, the
  scene director, and the render loop.

## Known limitations

- Only tested in-browser at a handful of window sizes — not yet verified on
  the actual display hardware for extended unattended runtime (WebGL context
  loss, memory behavior over many hours, etc. are unverified).
- No touch/click interactivity; the loop is fully passive.
- NASA's `DEMO_KEY` is shared and rate-limited (see above).
- No accessibility considerations beyond a `prefers-reduced-motion` check
  that dampens (but doesn't remove) motion.

## Development history

This was built iteratively — 2D prototype, then a full rebuild onto Three.js,
then several rounds of camera work, visual polish, and one feature (an
atmospheric rim-light shader on the planets) that was implemented, evaluated,
and deliberately reverted. The commit history is written to be read in order
as that process, not squashed into one commit — each message explains what
changed and, where relevant, why.
