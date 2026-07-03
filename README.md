# Swing City

A low-poly, rain-soaked neon city you can swing across — Insomniac's Spider-Man web-swinging feel, dropped into a Blade Runner grid. Built by Alex Coulombe Presents.

The whole city — streets, traffic-light-obeying cars, rain, neon towers — is procedurally generated from a single seed, so every load is the same city, ready to explore.

**[▶ Play it live](https://ibrews.github.io/swing-city/)**

## Quickstart

No build step, no install — it's one self-contained HTML file pulling Three.js from a CDN.

```bash
git clone https://github.com/ibrews/swing-city.git
cd swing-city
python3 -m http.server 8377
# open http://localhost:8377
```

Click to enter (pointer lock gives the best mouse-look; it'll fall back to a raw mouse-look mode automatically if your browser/embed blocks pointer lock).

**Controls** — keyboard/mouse, gamepad, touch, and WebXR all work at once and drive the same actions, so mix and match freely.
- Mouse / right stick / touch drag (right half of screen) / XR right-stick — look around
- **Tap** left-click, Space, gamepad A, or an XR trigger — jump (hold through it to also fire a web if a building's in range)
- Hold left-click / Space / gamepad A / touch WEB button / XR trigger against a building — swing; against a bare wall — **climb it Spider-Man style**
- **WASD** / left stick / touch joystick (left half of screen) / XR left-stick — run / air control
- **Shift** / full-stick deflection / right trigger — sprint
- **W** while swinging — pump the swing for more speed
- **R** / gamepad X / touch R button — respawn on a nearby rooftop
- Sprint into a car to knock it flying — chain hits on multiple cars within ~1.6s for a score combo

## How it's built

`index.html` is the playable game. `city_generator.py` is where the city design actually comes from — a Blender/Python procedural-city generator, written as small documented functions (not string-exec blobs) specifically so it's easy to read and retune. The JS city in `index.html` is a faithful port of that file's layout math, window-facade shader logic, traffic-light cycle, and stop-and-go car simulation — same seed, same city, now swingable.

The city is a grid of blocks with two-lane streets in both directions, dashed lane lines, sidewalks, and buildings built from stacked tapering segments (not flat boxes) with glowing window grids, rooftop crowns, antenna spires, and street-level neon signs. Traffic runs a real signal cycle — cars accelerate, brake for red lights, queue bumper-to-bumper, and release on green, with about a quarter of them making right turns.

## Things to Try

1. **Click "click to enter" and just walk around** — WASD moves you, the city should feel alive with traffic queuing and releasing at the lights below.
2. **Aim up at a nearby building and hold the web button** — watch the reticle in the center of the screen turn green when a web will connect, then swing. Release at the bottom of the arc to fling yourself forward.
3. **Walk up to a building and hold the web button against it** instead of jumping — you'll climb straight up the wall.
4. **Sprint into two or three cars in a row** without stopping — each knock rolls the car based on how fast you hit it, and chaining hits stacks a score combo.
5. **Chain two swings in a row** without touching the ground — hold W while swinging to pump momentum, then release-and-immediately-fire-again toward the next building.
6. **Press R a few times** — you'll respawn on a different mid-height rooftop each time, always surrounded by taller neighbors so your first web always has something to grab.
7. **Stand at a street intersection and watch a full signal cycle** — cars stop, queue, and release; watch for one making a right turn through the intersection on a proper arc.

## Tuning the city

Everything about the layout — grid size, block size, street width, building height mix, traffic density, rain amount — lives in one `CONFIG` block at the top of `city_generator.py`. Change a number, re-run the generator in Blender, see a different city. The JS port in `index.html` mirrors the same constants near the top of its `<script>` block.

## Multiplayer (opt-in)

Off by default — the game only connects if loaded with `?mp=<websocket-url>` pointing at a deployed instance of the relay in `multiplayer/`. It's joust rules: land on top of another player to explode them (Fortnite/[fly.pieter.com](https://fly.pieter.com)-style). See `multiplayer/README.md` for the one-time `wrangler login && wrangler deploy` to get your own live URL (free Cloudflare tier covers a casual room easily) and how to test it locally with no login at all.

## WebXR

Click **Enter VR** (bottom-right, only shown if your browser/headset supports it) for an immersive third-person view — the same follow-the-player camera desktop uses, just with real head tracking layered on top. Left controller stick moves, right stick looks, either trigger fires a web.

---

Built by [Alex Coulombe Presents](https://www.alexcoulombepresents.com).
