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

**Controls**
- Mouse — look around
- Hold **left-click** or **Space** — shoot a web and swing (release to let go)
- **WASD** — run / air control
- **Shift** — sprint
- **W while swinging** — pump the swing for more speed
- **R** — respawn on a nearby rooftop

## How it's built

`index.html` is the playable game. `city_generator.py` is where the city design actually comes from — a Blender/Python procedural-city generator, written as small documented functions (not string-exec blobs) specifically so it's easy to read and retune. The JS city in `index.html` is a faithful port of that file's layout math, window-facade shader logic, traffic-light cycle, and stop-and-go car simulation — same seed, same city, now swingable.

The city is a grid of blocks with two-lane streets in both directions, dashed lane lines, sidewalks, and buildings built from stacked tapering segments (not flat boxes) with glowing window grids, rooftop crowns, antenna spires, and street-level neon signs. Traffic runs a real signal cycle — cars accelerate, brake for red lights, queue bumper-to-bumper, and release on green, with about a quarter of them making right turns.

## Things to Try

1. **Click "click to enter" and just walk around** — WASD moves you, the city should feel alive with traffic queuing and releasing at the lights below.
2. **Aim up at a nearby building and hold the web button** — watch the reticle in the center of the screen turn green when a web will connect, then swing. Release at the bottom of the arc to fling yourself forward.
3. **Chain two swings in a row** without touching the ground — hold W while swinging to pump momentum, then release-and-immediately-fire-again toward the next building.
4. **Press R a few times** — you'll respawn on a different mid-height rooftop each time, always surrounded by taller neighbors so your first web always has something to grab.
5. **Stand at a street intersection and watch a full signal cycle** — cars stop, queue, and release; watch for one making a right turn through the intersection on a proper arc.

## Tuning the city

Everything about the layout — grid size, block size, street width, building height mix, traffic density, rain amount — lives in one `CONFIG` block at the top of `city_generator.py`. Change a number, re-run the generator in Blender, see a different city. The JS port in `index.html` mirrors the same constants near the top of its `<script>` block.

---

Built by [Alex Coulombe Presents](https://www.alexcoulombepresents.com).
