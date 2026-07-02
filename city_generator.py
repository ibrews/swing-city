#!/usr/bin/env python3
"""
city_generator.py — a procedural neon city, written to be FOLLOWED.

Why this file exists
--------------------
The older `drone_shot_v3.py` builds its city inside giant triple-quoted
strings that get `exec()`'d — impossible for a person (or a local model) to
read or extend. This file is the opposite: every piece of the city is a
small, named, documented top-level function, and every dial that changes how
the city looks lives in the CONFIG block right below. Read it top to bottom
and you can see exactly how a bustling grid city is built.

The model
---------
  * The ground is the XY plane. Z is up. Units ~ meters-ish.
  * The city is a GRID_N x GRID_N array of square BLOCKS.
  * Narrow two-lane STREETS (with dashed centerlines) run between blocks in
    BOTH directions, crossing at intersections.
  * Each block carries a sidewalk slab and a sub-grid of BUILDINGS. Buildings
    are stacked, tapering segments (wider at the base, narrower up top) with
    glowing window grids, rooftop crown lights, occasional antenna spires,
    and occasional street-level neon signs — that mix is what makes the
    skyline read as varied instead of as rows of identical boxes.
  * TRAFFIC is simulated, not looped: every intersection runs a shared
    signal cycle (NS green -> all-red -> EW green -> all-red), and each car
    accelerates, brakes for red lights, queues bumper-to-bumper behind the
    car ahead, pulls away on green, and sometimes makes a right turn on a
    quarter-circle arc. The lights are what make two-way cross traffic safe:
    green never faces both axes at once. Parked cars line the sidewalks.

  Street proportions intentionally match the previously-approved corridor
  shot: lanes at +/-0.95 from the street centerline, ~3.8 curb-to-curb,
  dashes 1.4 long every 3.0, buildings ~3.8 from the centerline.

  Coordinates are centered on the origin:
    PITCH           = BLOCK_SIZE + STREET_W     (block-center spacing)
    block_center(i) = i*PITCH - HALF
    road_pos(k)     = (k-0.5)*PITCH - HALF      (N+1 roads per direction)
  With GRID_N even, road_pos(GRID_N//2) == 0 — so x=0 is a street the camera
  can fly straight down.

How to run
----------
  Explore in Blender's GUI (camera + traffic keyframed, scrub the timeline):
    "/Applications/Blender 5.1.2.app/Contents/MacOS/Blender" \
        --factory-startup --python city_generator.py -- gui

  Render the 5-second flythrough to PNGs:
    "/Applications/Blender 5.1.2.app/Contents/MacOS/Blender" --background \
        --factory-startup --python city_generator.py -- /tmp/city_frames [W H SAMPLES]

To change the city, edit CONFIG. To add a new kind of building or street
furniture, copy one of the build_* functions and follow the same pattern.
"""

import bpy, sys, os, math, random, mathutils

# ===========================================================================
# CONFIG — every dial that shapes the city. Change these, not the logic.
# ===========================================================================
SEED           = 7        # fixed seed => identical city every run
GRID_N         = 6        # city is GRID_N x GRID_N blocks
BLOCK_SIZE     = 18.0     # width of one block
STREET_W       = 4.4      # curb-to-curb street width (two lanes, human scale)
LANE_HALF      = 0.95     # lane centerline offset from street centerline
SIDEWALK_W     = 1.6      # buildings sit back this far from the block edge
DASH_LEN, DASH_STEP = 1.4, 3.0   # dashed centerline: dash length / spacing
LOTS_PER_SIDE  = 2        # each block hosts LOTS_PER_SIDE^2 building lots
EMPTY_LOT_ODDS = 0.10     # chance a lot stays an open plaza
# Height mix: mostly midrise, some lowrise, a few hero towers.
H_LOW, H_MID, H_HERO = (7.0, 12.0), (14.0, 34.0), (42.0, 58.0)
H_WEIGHTS      = [0.25, 0.62, 0.13]       # odds of low / mid / hero
ANTENNA_ODDS   = 0.28     # chance a building gets a rooftop antenna spire
SIGN_ODDS      = 0.45     # chance a building gets a street-level neon sign
CARS_PER_LANE  = 5        # moving cars per lane (2 lanes per street, both axes)
PARKED_PER_ROAD = 7       # parked cars per street side-pair, up on the sidewalk
CAR_SPEED      = 8.0      # cruise speed, units/second
# --- traffic simulation (stop/start behavior) ---
ACCEL          = 3.5      # how hard cars accelerate from a stop
DECEL          = 6.0      # how hard cars brake for lights / queues
MIN_GAP        = 1.6      # bumper-to-bumper gap cars keep in a queue
CAR_LEN        = 2.2      # car length (used for queue spacing)
LOOKAHEAD     = 14.0      # how far ahead a car scans for stop lines
TURN_ODDS      = 0.25     # fraction of cars that make one right turn
TURN_SPEED     = 5.0      # speed through the turn arc
# --- traffic lights: NS green, then all-red clearance, then EW green ---
LIGHT_GREEN    = 4.2      # seconds each axis holds green
LIGHT_ALLRED   = 0.9      # all-red clearance so the intersection empties
RAIN_COUNT     = 450      # rain streaks (0 disables rain)
FRAMES         = 150      # 5 seconds at 30fps

# Neon palette every building/sign draws from.
PALETTE = [(0.0, 0.85, 1.0),   # cyan
           (1.0, 0.10, 0.6),   # magenta
           (0.6, 0.20, 1.0),   # violet
           (0.1, 1.00, 0.7)]   # mint

# Derived layout constants (computed, don't edit).
PITCH = BLOCK_SIZE + STREET_W
HALF  = (GRID_N - 1) / 2 * PITCH
CITY_EXTENT = GRID_N * PITCH               # full city width
EDGE = CITY_EXTENT / 2                     # half-width: city spans [-EDGE, EDGE]


# ===========================================================================
# Small helpers
# ===========================================================================
def block_center(i):
    """World coordinate of the center of block index i (0..GRID_N-1)."""
    return i * PITCH - HALF


def road_pos(k):
    """World coordinate of road centerline k (0..GRID_N), at block edges."""
    return (k - 0.5) * PITCH - HALF


ROADS = None  # filled in build_city(); list of all road centerline coords


def near_intersection(v):
    """True if coordinate v falls inside any crossing street's width (used to
    break dashed lines and keep parked cars out of intersections)."""
    return any(abs(v - r) < STREET_W / 2 + 1.0 for r in ROADS)


def add_box(name, center, size, material=None):
    """The one primitive everything is built from: a scaled, placed cube."""
    bpy.ops.mesh.primitive_cube_add(size=1, location=center)
    o = bpy.context.active_object
    o.name = name
    o.scale = (size[0], size[1], size[2])
    if material is not None:
        o.data.materials.append(material)
    return o


# ===========================================================================
# Materials
# ===========================================================================
def mat_flat(name, rgb, metallic=0.0, rough=0.6):
    """Plain solid-color surface (road, sidewalk, car body)."""
    m = bpy.data.materials.new(name); m.use_nodes = True
    b = m.node_tree.nodes.get("Principled BSDF")
    b.inputs["Base Color"].default_value = (rgb[0], rgb[1], rgb[2], 1.0)
    b.inputs["Metallic"].default_value = metallic
    b.inputs["Roughness"].default_value = rough
    return m


def mat_emit(name, rgb, strength=6.0):
    """Glowing surface (lane dashes, lights, crowns, signs)."""
    m = bpy.data.materials.new(name); m.use_nodes = True
    b = m.node_tree.nodes.get("Principled BSDF")
    b.inputs["Base Color"].default_value = (rgb[0], rgb[1], rgb[2], 1.0)
    for k in ("Emission Color", "Emission"):
        if k in b.inputs:
            b.inputs[k].default_value = (rgb[0], rgb[1], rgb[2], 1.0)
    if "Emission Strength" in b.inputs:
        b.inputs["Emission Strength"].default_value = strength
    return m


def mat_windows(name, glow_rgb, lit=0.62):
    """A facade that lights a GRID OF WINDOWS in the given color.

    This is what makes towers read as buildings rather than colored slabs
    (the single most-flagged bug of the earlier city). Three steps, done in
    shader nodes on the surface:
      1. MODULO on world-space position divides every face into window-sized
         cells (same real-world window size on every building).
      2. Per-cell white noise switches ~`lit` of the cells on — a partly
         occupied tower at night.
      3. Lit cells emit `glow_rgb`; the rest stay dark facade.
    Node math carried over verbatim from the version validated on screen.
    """
    Pz, Ph = 1.35, 1.15                  # window row / column pitch
    base = (0.012, 0.014, 0.022)
    m = bpy.data.materials.new(name); m.use_nodes = True
    nt = m.node_tree; N, Lk = nt.nodes, nt.links
    b = N.get("Principled BSDF")
    b.inputs["Base Color"].default_value = (base[0], base[1], base[2], 1.0)
    b.inputs["Metallic"].default_value = 0.7
    b.inputs["Roughness"].default_value = 0.25

    geo = N.new("ShaderNodeNewGeometry"); sep = N.new("ShaderNodeSeparateXYZ")
    Lk.new(geo.outputs["Position"], sep.inputs["Vector"])
    rowmod = N.new("ShaderNodeMath"); rowmod.operation = "MODULO"; rowmod.inputs[1].default_value = Pz
    Lk.new(sep.outputs["Z"], rowmod.inputs[0])
    rowlt = N.new("ShaderNodeMath"); rowlt.operation = "LESS_THAN"; rowlt.inputs[1].default_value = Pz * 0.55
    Lk.new(rowmod.outputs[0], rowlt.inputs[0])
    hadd = N.new("ShaderNodeMath"); hadd.operation = "ADD"
    Lk.new(sep.outputs["X"], hadd.inputs[0]); Lk.new(sep.outputs["Y"], hadd.inputs[1])
    colmod = N.new("ShaderNodeMath"); colmod.operation = "MODULO"; colmod.inputs[1].default_value = Ph
    Lk.new(hadd.outputs[0], colmod.inputs[0])
    collt = N.new("ShaderNodeMath"); collt.operation = "LESS_THAN"; collt.inputs[1].default_value = Ph * 0.5
    Lk.new(colmod.outputs[0], collt.inputs[0])
    grid = N.new("ShaderNodeMath"); grid.operation = "MULTIPLY"
    Lk.new(rowlt.outputs[0], grid.inputs[0]); Lk.new(collt.outputs[0], grid.inputs[1])
    scl = N.new("ShaderNodeVectorMath"); scl.operation = "MULTIPLY"; scl.inputs[1].default_value = (1.0/Ph, 1.0/Ph, 1.0/Pz)
    flo = N.new("ShaderNodeVectorMath"); flo.operation = "FLOOR"
    wn = N.new("ShaderNodeTexWhiteNoise"); wn.noise_dimensions = "3D"
    Lk.new(geo.outputs["Position"], scl.inputs[0]); Lk.new(scl.outputs["Vector"], flo.inputs[0])
    Lk.new(flo.outputs["Vector"], wn.inputs["Vector"])
    noff = N.new("ShaderNodeMath"); noff.operation = "GREATER_THAN"; noff.inputs[1].default_value = (1.0 - lit)
    Lk.new(wn.outputs["Value"], noff.inputs[0])
    g2 = N.new("ShaderNodeMath"); g2.operation = "MULTIPLY"
    Lk.new(grid.outputs[0], g2.inputs[0]); Lk.new(noff.outputs[0], g2.inputs[1])
    col = N.new("ShaderNodeVectorMath"); col.operation = "SCALE"
    col.inputs[0].default_value = (glow_rgb[0], glow_rgb[1], glow_rgb[2])
    Lk.new(g2.outputs[0], col.inputs["Scale"])
    ek = "Emission Color" if "Emission Color" in b.inputs else "Emission"
    Lk.new(col.outputs[0], b.inputs[ek])
    if "Emission Strength" in b.inputs:
        # 2.8, not the corridor scene's 6.0: this city is a CONTINUOUS canyon
        # of facades filling the whole frame, and at 6.0 the sum of emissive
        # area + bloom left literally 0% dark pixels (vs 21% in the approved
        # corridor shot — measured, not eyeballed). Lower per-window power
        # restores the dark facade/sky contrast the approved look had.
        b.inputs["Emission Strength"].default_value = 2.8
    return m


# ===========================================================================
# Scene setup — world, lights, fog, bloom, render settings
# ===========================================================================
def reset_scene():
    for s in list(bpy.data.scenes):
        if s != bpy.context.scene:
            bpy.data.scenes.remove(s)
    sc = bpy.context.scene
    sc.name = "crazy_local"
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    return sc


def setup_world_and_lights(sc):
    """Dark blue night sky + a cool sun + warm/cool area fills."""
    w = bpy.data.worlds.new("Night"); sc.world = w; w.use_nodes = True
    bg = w.node_tree.nodes.get("Background")
    bg.inputs["Color"].default_value = (0.004, 0.006, 0.02, 1.0)
    bg.inputs["Strength"].default_value = 0.5

    bpy.ops.object.light_add(type="SUN", location=(20, -20, 60))
    sun = bpy.context.active_object
    sun.data.energy = 1.4; sun.data.color = (0.45, 0.6, 1.0)
    sun.rotation_euler = (math.radians(58), 0, math.radians(25))

    # Two SMALL warm/cool fill pools near the camera avenue (matching the
    # approved corridor shot's rig: size 16, low z, energies 5000/3500).
    # NOTE: an earlier version used two size-40 floods at z=40 covering the
    # whole city — verified by isolation renders (fog at ~zero density,
    # washout unchanged) that giant soft lights reflecting off the
    # semi-metallic facades (metallic .7 / rough .25) washed the entire
    # frame out in a uniform sheen. Small localized pools + the buildings'
    # own window emission is the rig that reads correctly.
    for loc, col, e in [((14, -EDGE + 18, 9), (1.0, 0.6, 0.35), 5000),
                        ((-14, -EDGE + 42, 8), (0.35, 0.65, 1.0), 3500)]:
        bpy.ops.object.light_add(type="AREA", location=loc)
        a = bpy.context.active_object
        a.data.energy = e; a.data.color = col; a.data.size = 16


def setup_fog(sc):
    """One thin volume cube over the whole city for depth haze."""
    box = add_box("Fog", (0, 0, 30), (CITY_EXTENT*1.2, CITY_EXTENT*1.2, 60))
    m = bpy.data.materials.new("FogVol"); m.use_nodes = True
    nt = m.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    vol = nt.nodes.new("ShaderNodeVolumePrincipled")
    # NOTE: this city is ~2x deeper than the old single-corridor scene, so the
    # same density the corridor used (0.0022) accumulates far more scatter
    # over these sightlines and washes the whole frame out — verified by a
    # smoke render. Roughly halve-to-quarter it for equivalent depth-haze.
    vol.inputs["Density"].default_value = 0.0008
    vol.inputs["Color"].default_value = (0.02, 0.04, 0.08, 1.0)
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    nt.links.new(vol.outputs["Volume"], out.inputs["Volume"])
    box.data.materials.append(m)


def setup_bloom(sc):
    """Compositor Glare(Bloom) so the neon glows."""
    sc.use_nodes = True
    for old in list(bpy.data.node_groups):
        if old.name == "CityBloom":
            bpy.data.node_groups.remove(old)
    ng = bpy.data.node_groups.new("CityBloom", "CompositorNodeTree")
    sc.compositing_node_group = ng
    ng.interface.new_socket(name="Image", socket_type="NodeSocketColor", in_out="OUTPUT")
    rl = ng.nodes.new("CompositorNodeRLayers")
    gl = ng.nodes.new("CompositorNodeGlare")
    gl.inputs["Type"].default_value = "Bloom"
    gl.inputs["Threshold"].default_value = 0.85
    gl.inputs["Size"].default_value = 9.0
    gl.inputs["Strength"].default_value = 0.9   # 1.35 veils the frame at this emissive density
    mix = ng.nodes.new("ShaderNodeMix"); mix.data_type = "RGBA"; mix.blend_type = "ADD"
    mix.inputs[0].default_value = 1.0
    out = ng.nodes.new("NodeGroupOutput")
    ng.links.new(rl.outputs["Image"], gl.inputs["Image"])
    ng.links.new(rl.outputs["Image"], mix.inputs[6])
    ng.links.new(gl.outputs["Glare"], mix.inputs[7])
    ng.links.new(mix.outputs[2], out.inputs["Image"])
    sc.view_settings.exposure = -0.3


def setup_render(sc, w, h, samples):
    sc.render.engine = "BLENDER_EEVEE"
    sc.render.resolution_x = w; sc.render.resolution_y = h
    try:
        sc.eevee.taa_render_samples = samples
        sc.eevee.use_raytracing = True
        sc.eevee.volumetric_end = max(400.0, CITY_EXTENT * 1.5)
    except Exception as e:
        print("eevee cfg:", e)
    sc.render.use_motion_blur = True
    sc.render.motion_blur_shutter = 2.0


# ===========================================================================
# Streets
# ===========================================================================
def build_ground():
    add_box("Ground", (0, 0, -0.1), (CITY_EXTENT*2, CITY_EXTENT*2, 0.2),
            mat_flat("GroundMat", (0.012, 0.012, 0.016), rough=0.9))


def build_streets():
    """Two-lane streets with DASHED glowing centerlines, both directions.

    Dashes stop at intersections (real striping does too) — that's what
    near_intersection() is for. Road slabs simply overlap at crossings."""
    road = mat_flat("RoadMat", (0.02, 0.02, 0.024), rough=0.85)
    dash = mat_emit("LaneDash", (0.9, 0.85, 0.5), 2.0)
    span = CITY_EXTENT + STREET_W
    for k in range(GRID_N + 1):
        p = road_pos(k)
        add_box("RoadV%d" % k, (p, 0, 0.02), (STREET_W, span, 0.04), road)
        add_box("RoadH%d" % k, (0, p, 0.02), (span, STREET_W, 0.04), road)
        d = -EDGE
        while d < EDGE:
            if not near_intersection(d + DASH_LEN/2):
                add_box("DashV%d_%d" % (k, int(d*10)), (p, d + DASH_LEN/2, 0.045),
                        (0.1, DASH_LEN, 0.012), dash)
                add_box("DashH%d_%d" % (k, int(d*10)), (d + DASH_LEN/2, p, 0.045),
                        (DASH_LEN, 0.1, 0.012), dash)
            d += DASH_STEP


# ===========================================================================
# Buildings
# ===========================================================================
def pick_height(rng):
    """Low / mid / hero height mix (H_WEIGHTS)."""
    r = rng.random()
    if r < H_WEIGHTS[0]:
        return rng.uniform(*H_LOW)
    if r < H_WEIGHTS[0] + H_WEIGHTS[1]:
        return rng.uniform(*H_MID)
    return rng.uniform(*H_HERO)


def build_building(name, x, y, max_foot, rng):
    """One tower: stacked TAPERING segments + crown + optional antenna/sign.

    The taper (each segment 0.78-0.92 the width of the one below) is what
    gives the skyline its tiered, varied silhouette — a single full-height
    box reads as a slab. Footprint is slightly rectangular (per-axis jitter)
    so buildings aren't all perfect squares."""
    color = rng.choice(PALETTE)
    wmat = mat_windows(name + "_win", color, lit=rng.uniform(0.5, 0.72))
    h = pick_height(rng)
    segs = max(1, min(4, int(h // 9)))
    fx = max_foot * rng.uniform(0.78, 0.95)
    fy = max_foot * rng.uniform(0.78, 0.95)
    z, wx, wy = 0.0, fx, fy
    for s in range(segs):
        sh = (h / segs) * rng.uniform(0.85, 1.15)
        add_box("%s_s%d" % (name, s), (x, y, z + sh/2), (wx, wy, sh), wmat)
        z += sh
        wx *= rng.uniform(0.78, 0.92)
        wy *= rng.uniform(0.78, 0.92)
    # glowing crown cap on the top segment
    add_box(name + "_crown", (x, y, z + 0.12), (wx*1.06, wy*1.06, 0.22),
            mat_emit(name + "_crownm", color, 8.0))
    if rng.random() < ANTENNA_ODDS:
        ah = h * rng.uniform(0.18, 0.35)
        bpy.ops.mesh.primitive_cylinder_add(radius=0.06, depth=ah, location=(x, y, z + ah/2))
        ant = bpy.context.active_object; ant.name = name + "_ant"
        ant.data.materials.append(mat_emit(name + "_antm", color, 10.0))
    if rng.random() < SIGN_ODDS:
        # street-level neon sign: a thin glowing strip on a random face
        side = rng.choice([(1, 0), (-1, 0), (0, 1), (0, -1)])
        sx = x + side[0] * (fx/2 + 0.06)
        sy = y + side[1] * (fy/2 + 0.06)
        sw = (0.12, fy*0.5) if side[0] else (fx*0.5, 0.12)
        add_box(name + "_sign", (sx, sy, rng.uniform(1.2, 2.4)), (sw[0], sw[1], 0.5),
                mat_emit(name + "_signm", rng.choice(PALETTE), 5.0))


def build_block(i, j, rng):
    """Sidewalk slab + LOTS_PER_SIDE^2 lots of varied buildings."""
    cx, cy = block_center(i), block_center(j)
    sidewalk = bpy.data.materials.get("SidewalkMat") or \
        mat_flat("SidewalkMat", (0.09, 0.09, 0.10), rough=0.7)
    add_box("Walk_%d_%d" % (i, j), (cx, cy, 0.05), (BLOCK_SIZE, BLOCK_SIZE, 0.10), sidewalk)
    interior = BLOCK_SIZE - 2 * SIDEWALK_W
    lot = interior / LOTS_PER_SIDE
    for li in range(LOTS_PER_SIDE):
        for lj in range(LOTS_PER_SIDE):
            if rng.random() < EMPTY_LOT_ODDS:
                continue
            lx = cx - interior/2 + (li + 0.5) * lot
            ly = cy - interior/2 + (lj + 0.5) * lot
            build_building("Bld_%d_%d_%d_%d" % (i, j, li, lj), lx, ly, lot, rng)


def build_all_blocks(rng):
    for i in range(GRID_N):
        for j in range(GRID_N):
            build_block(i, j, rng)


# ===========================================================================
# Cars
# ===========================================================================
def make_car(name, color):
    """One car: parent Empty + mesh children (chassis/cabin/head/taillights),
    modeled pointing +X. Animate/rotate the Empty; children follow."""
    bpy.ops.object.empty_add(location=(0, 0, 0))
    car = bpy.context.active_object; car.name = name
    body = mat_flat(name + "_body", color, metallic=0.4, rough=0.4)
    head = mat_emit(name + "_head", (1.0, 1.0, 0.9), 8.0)
    tail = mat_emit(name + "_tail", (1.0, 0.1, 0.1), 6.0)
    for p in [
        add_box(name + "_chassis", (0, 0, 0.30), (2.2, 0.95, 0.45), body),
        add_box(name + "_cabin",   (-0.1, 0, 0.68), (1.1, 0.85, 0.5), body),
        add_box(name + "_hl_l", (1.05, 0.30, 0.30), (0.12, 0.18, 0.18), head),
        add_box(name + "_hl_r", (1.05, -0.30, 0.30), (0.12, 0.18, 0.18), head),
        add_box(name + "_tl_l", (-1.05, 0.30, 0.34), (0.10, 0.18, 0.16), tail),
        add_box(name + "_tl_r", (-1.05, -0.30, 0.34), (0.10, 0.18, 0.16), tail),
    ]:
        p.parent = car
    return car


CAR_COLORS = [(0.8, 0.2, 0.2), (0.2, 0.4, 0.9), (0.85, 0.7, 0.2),
              (0.2, 0.7, 0.4), (0.7, 0.7, 0.75), (0.9, 0.45, 0.15)]


# ===========================================================================
# Traffic lights
#
# One global cycle shared by every intersection: NS holds green for
# LIGHT_GREEN seconds, then an all-red clearance of LIGHT_ALLRED so the
# intersection empties, then EW gets green, then all-red again. Because the
# cycle serializes the two street directions, cars can now legally drive on
# BOTH axes without ever meeting inside an intersection — which is what
# makes stop-and-go cross traffic possible at all.
# ===========================================================================
def light_phase(t):
    """'NS' or 'EW' when that axis has green; 'X' during all-red clearance."""
    period = 2 * (LIGHT_GREEN + LIGHT_ALLRED)
    tm = t % period
    if tm < LIGHT_GREEN:
        return "NS"
    if tm < LIGHT_GREEN + LIGHT_ALLRED:
        return "X"
    if tm < 2 * LIGHT_GREEN + LIGHT_ALLRED:
        return "EW"
    return "X"


RED, GREEN = (1.0, 0.06, 0.04), (0.1, 1.0, 0.25)
NS_LIGHT_MAT = EW_LIGHT_MAT = None   # created in build_traffic_lights()


def build_traffic_lights():
    """A signal head at each approach's right-hand entry corner of every
    intersection: a thin pole + a small emissive box. All NS-facing heads
    share one material, all EW-facing heads share another, so animating the
    whole city's lights is just recoloring two materials per frame."""
    global NS_LIGHT_MAT, EW_LIGHT_MAT
    NS_LIGHT_MAT = mat_emit("NSLight", GREEN, 12.0)
    EW_LIGHT_MAT = mat_emit("EWLight", RED, 12.0)
    pole_mat = mat_flat("PoleMat", (0.05, 0.05, 0.06), metallic=0.6, rough=0.5)
    sw = STREET_W / 2 + 0.4
    # (corner offsets, material) — each approach's head sits on the corner to
    # the driver's right just before the intersection.
    corners = [((+sw, -sw), "NS"), ((-sw, +sw), "NS"),
               ((-sw, -sw), "EW"), ((+sw, +sw), "EW")]
    n = 0
    for ki in range(GRID_N + 1):
        for kj in range(GRID_N + 1):
            p, q = road_pos(ki), road_pos(kj)
            for (ox, oy), which in corners:
                bpy.ops.mesh.primitive_cylinder_add(radius=0.05, depth=4.4,
                                                    location=(p + ox, q + oy, 2.2))
                pole = bpy.context.active_object; pole.name = "LPole%d" % n
                pole.data.materials.append(pole_mat)
                add_box("LHead%d" % n, (p + ox, q + oy, 4.6), (0.3, 0.3, 0.55),
                        NS_LIGHT_MAT if which == "NS" else EW_LIGHT_MAT)
                n += 1
    print("traffic light heads:", n)


def set_light_colors(t, keyframe_at=None):
    """Recolor the two shared light materials for time t. With keyframe_at,
    also key them so the GUI timeline animates the lights."""
    phase = light_phase(t)
    for mat, mine in ((NS_LIGHT_MAT, "NS"), (EW_LIGHT_MAT, "EW")):
        col = GREEN if phase == mine else RED
        b = mat.node_tree.nodes.get("Principled BSDF")
        for k in ("Emission Color", "Emission", "Base Color"):
            if k in b.inputs:
                b.inputs[k].default_value = (col[0], col[1], col[2], 1.0)
                if keyframe_at is not None:
                    try:
                        b.inputs[k].keyframe_insert(data_path="default_value",
                                                    frame=keyframe_at)
                    except Exception:
                        pass


# ===========================================================================
# Traffic simulation
#
# Every moving car is simulated with simple kinematics, frame by frame:
#   * accelerate toward CAR_SPEED when the way is clear,
#   * brake (never harder than DECEL) for a red light's stop line or for the
#     car ahead, queuing bumper-to-bumper behind it,
#   * pull away again when the light turns green — so queues compress and
#     release exactly like real stop-and-go traffic,
#   * a TURN_ODDS fraction of cars make one RIGHT turn at a chosen
#     intersection (right turns never cross the oncoming lane, so they're
#     safe without any extra logic), following a quarter-circle arc.
#
# The whole 5s of motion is simulated once up front (it's pure Python and
# instant); rendering/keyframing then just replays the stored states.
#
# A car's state: axis 'NS' (drives along Y) or 'EW' (along X); dirn +/-1;
# lane = its fixed cross-street coordinate; s = position along the street;
# v = current speed. Right-hand traffic: dirn>0 lane sits at +LANE_HALF.
# ===========================================================================
def build_traffic(rng):
    cars = []
    span = 2 * EDGE
    for k in range(GRID_N + 1):
        p = road_pos(k)
        for axis in ("NS", "EW"):
            for dirn in (1, -1):
                # right-hand traffic: heading +Y your right is +X, but
                # heading +X your right is -Y — hence the sign flip.
                lane = p + dirn * LANE_HALF if axis == "NS" else p - dirn * LANE_HALF
                lane_spawns = []
                for ncar in range(CARS_PER_LANE):
                    s = -EDGE + (span / CARS_PER_LANE) * ncar + rng.uniform(0, span / CARS_PER_LANE * 0.4)
                    if dirn < 0:
                        s = -s
                    # SPAWN SANITATION (fixes two verified frame-0/28
                    # collisions): (a) a car spawning closer to a red light's
                    # stop line than its braking distance physically
                    # overshoots into the box and meets cross traffic, so EW
                    # cars (red at t=0) keep 7u clear of lines; (b) no car
                    # spawns inside an intersection box; (c) resampled spawns
                    # must ALSO keep same-lane spacing — the first version of
                    # this fix resampled uniformly and let two same-lane cars
                    # land overlapping at frame 0.
                    for _ in range(80):
                        in_box = any(abs(s - q) < STREET_W / 2 + 1.4 for q in ROADS)
                        lane_clash = any(abs(s - o) < CAR_LEN + MIN_GAP + 1.2 for o in lane_spawns)
                        too_close = False
                        if axis == "EW":
                            for q in ROADS:
                                dline = dirn * ((q - dirn * (STREET_W / 2 + 0.8)) - s)
                                if 0 < dline < 7.0:
                                    too_close = True
                        if not in_box and not too_close and not lane_clash:
                            break
                        s = rng.uniform(-EDGE, EDGE)
                    lane_spawns.append(s)
                    turn_q = None
                    if rng.random() < TURN_ODDS:
                        turn_q = rng.choice(ROADS[1:-1])   # turn at an interior crossing
                    car = {
                        "obj": make_car("Car_%s_%d_%d_%d" % (axis, k, (dirn+1)//2, ncar),
                                        rng.choice(CAR_COLORS)),
                        "axis": axis, "dirn": dirn, "lane": lane,
                        "s": s, "v": CAR_SPEED * rng.uniform(0.6, 1.0),
                        "turn_q": turn_q, "arc": None,
                    }
                    cars.append(car)
    return cars


def _stop_distance(car, phase, lane_groups):
    """Distance (along travel) at which this car must be stopped, or None.
    Considers: red/all-red stop lines ahead, and the car ahead in its lane."""
    d_stop = None
    dirn, s = car["dirn"], car["s"]
    stop_off = STREET_W / 2 + 0.8          # stop line sits just before the box
    if phase != car["axis"]:               # my light is red (or all-red)
        for q in ROADS:
            line = q - dirn * stop_off
            d = dirn * (line - s)
            if -0.5 < d < LOOKAHEAD:       # ahead of me (or basically at it)
                d_stop = d if d_stop is None else min(d_stop, d)
    # queue behind the car ahead of me in the same lane
    ahead = None
    for other_s in lane_groups.get((car["axis"], round(car["lane"], 2)), ()):
        d = dirn * (other_s - s)
        if 0.1 < d and (ahead is None or d < ahead):
            ahead = d
    if ahead is not None:
        d_gap = ahead - CAR_LEN - MIN_GAP
        if d_gap < LOOKAHEAD:
            d_stop = d_gap if d_stop is None else min(d_stop, d_gap)
    return d_stop


# Right-turn arc geometry: the arc's center is the intersection corner on the
# driver's right, radius reaches from that corner to the lane line. Headings
# come from the arc tangent. Table maps (axis, dirn) -> (corner signs, start
# angle, new axis, new dirn); every turn sweeps -90 degrees of arc.
_TURNS = {("NS", 1):  ((+1, -1), math.pi,      "EW", 1),
          ("NS", -1): ((-1, +1), 0.0,          "EW", -1),
          ("EW", 1):  ((-1, -1), math.pi / 2,  "NS", -1),
          ("EW", -1): ((+1, +1), -math.pi / 2, "NS", 1)}


def _begin_arc(car):
    """Set up the quarter-circle right turn at car['turn_q']."""
    (cx_sign, cy_sign), th0, new_axis, new_dirn = _TURNS[(car["axis"], car["dirn"])]
    q = car["turn_q"]
    # intersection center in world x/y (recover the street centerline from
    # the lane coordinate; note the EW lane sign is flipped, see build_traffic)
    if car["axis"] == "NS":
        ix, iy = car["lane"] - car["dirn"] * LANE_HALF, q
    else:
        ix, iy = q, car["lane"] + car["dirn"] * LANE_HALF
    sw = STREET_W / 2
    car["arc"] = {
        "cx": ix + cx_sign * sw, "cy": iy + cy_sign * sw,
        "r": sw - LANE_HALF, "th0": th0, "prog": 0.0,
        "new_axis": new_axis, "new_dirn": new_dirn,
    }
    car["turn_q"] = None


def _arc_state(arc):
    """Position + heading along the arc at its current progress."""
    r = arc["r"]
    th = arc["th0"] - (arc["prog"] / r if r > 0 else 0)
    x = arc["cx"] + r * math.cos(th)
    y = arc["cy"] + r * math.sin(th)
    return x, y, th - math.pi / 2


def simulate_traffic(cars, frames):
    """Run the whole shot's traffic up front. Returns
    states[frame][car_index] = (x, y, heading)."""
    dt = 1.0 / 30.0
    states = []
    for i in range(frames):
        t = i * dt
        phase = light_phase(t)
        # lane occupancy snapshot (previous positions) for car-following
        lane_groups = {}
        for c in cars:
            if c["arc"] is None:
                lane_groups.setdefault((c["axis"], round(c["lane"], 2)), []).append(c["s"])
        frame = []
        for c in cars:
            if c["arc"] is not None:
                a = c["arc"]
                a["prog"] += TURN_SPEED * dt
                if a["prog"] >= a["r"] * math.pi / 2:      # turn complete
                    x, y, hd = _arc_state(a)
                    c["axis"], c["dirn"] = a["new_axis"], a["new_dirn"]
                    if c["axis"] == "NS":
                        c["lane"], c["s"] = x, y
                    else:
                        c["lane"], c["s"] = y, x
                    c["v"] = TURN_SPEED
                    c["arc"] = None
                else:
                    x, y, hd = _arc_state(a)
                    frame.append((x, y, hd))
                    continue
            # --- straight-line driving with braking/queuing ---
            d = _stop_distance(c, phase, lane_groups)
            if d is not None:
                # fastest speed that can still rest 0.3 short of the target
                v_allow = math.sqrt(max(0.0, 2 * DECEL * max(d - 0.3, 0.0)))
            else:
                v_allow = CAR_SPEED
            v_target = min(CAR_SPEED, v_allow)
            if c["v"] < v_target:
                c["v"] = min(v_target, c["v"] + ACCEL * dt)
            else:
                c["v"] = max(v_target, c["v"] - DECEL * dt)
            c["s"] += c["dirn"] * c["v"] * dt
            # begin a right turn as we cross our turn entry on green — but
            # only into a CLEAR exit lane (a verified bug class: landing on
            # a car queued at the cross street's red). If the window is
            # missed or the exit is blocked, cancel and just drive on.
            if c["turn_q"] is not None and phase == c["axis"]:
                entry = c["turn_q"] - c["dirn"] * (STREET_W / 2)
                de = c["dirn"] * (c["s"] - entry)
                if 0 <= de < 1.2:
                    _begin_arc(c)
                    a = c["arc"]
                    th_end = a["th0"] - math.pi / 2
                    lx = a["cx"] + a["r"] * math.cos(th_end)
                    ly = a["cy"] + a["r"] * math.sin(th_end)
                    land_lane, land_s = ((lx, ly) if a["new_axis"] == "NS" else (ly, lx))
                    blocked = any(abs(os_ - land_s) < 5.0 for os_ in
                                  lane_groups.get((a["new_axis"], round(land_lane, 2)), ()))
                    if blocked:
                        c["arc"] = None      # abort: exit occupied, go straight
                    else:
                        x, y, hd = _arc_state(c["arc"])
                        frame.append((x, y, hd))
                        continue
                elif de >= 1.2:
                    c["turn_q"] = None       # window missed; keep it simple
            # wrap off-city ends (out of view); fresh pass re-arms nothing
            if c["dirn"] * c["s"] > EDGE + 5:
                c["s"] = -c["dirn"] * (EDGE + 5)
            if c["axis"] == "NS":
                hd = math.pi / 2 if c["dirn"] > 0 else -math.pi / 2
                frame.append((c["lane"], c["s"], hd))
            else:
                hd = 0.0 if c["dirn"] > 0 else math.pi
                frame.append((c["s"], c["lane"], hd))
        states.append(frame)
    return states


def apply_traffic(cars, states, i):
    for c, (x, y, hd) in zip(cars, states[i]):
        c["obj"].location = (x, y, 0.0)
        c["obj"].rotation_euler = (0, 0, hd)


def build_parked(rng):
    """Parked cars up on the SIDEWALK edge (not in the roadway — the streets
    are exactly two lanes wide, so anything on the pavement reads as parked
    mid-street, which was a flagged bug). Both street directions, clear of
    intersections, spaced so parked cars never overlap each other."""
    total = 0
    off = STREET_W / 2 + 0.7          # just past the curb, on the sidewalk
    for k in range(GRID_N + 1):
        p = road_pos(k)
        for axis in ("EW", "NS"):
            placed, tries, used = 0, 0, []
            while placed < PARKED_PER_ROAD and tries < 80:
                tries += 1
                a = rng.uniform(-EDGE + 2, EDGE - 2)
                if near_intersection(a) or any(abs(a - u) < 3.4 for u in used):
                    continue
                side = rng.choice([1, -1])
                car = make_car("Parked_%s_%d_%d" % (axis, k, tries), rng.choice(CAR_COLORS))
                if axis == "EW":
                    car.rotation_euler = (0, 0, 0 if rng.random() < 0.5 else math.pi)
                    car.location = (a, p + side * off, 0.0)
                else:
                    car.rotation_euler = (0, 0, math.radians(90 if rng.random() < 0.5 else -90))
                    car.location = (p + side * off, a, 0.0)
                used.append(a)
                placed += 1
            total += placed
    print("parked cars:", total)


# ===========================================================================
# Rain — hand-managed streak geometry (EEVEE particle systems render nothing
# in this build; per-frame repositioned cylinders are the proven approach).
# ===========================================================================
def build_rain(rng):
    if RAIN_COUNT <= 0:
        return []
    m = bpy.data.materials.new("Rain"); m.use_nodes = True
    b = m.node_tree.nodes.get("Principled BSDF")
    b.inputs["Base Color"].default_value = (0.75, 0.85, 1.0, 1.0)
    for k in ("Emission Color", "Emission"):
        if k in b.inputs:
            b.inputs[k].default_value = (0.75, 0.85, 1.0, 1.0)
    if "Emission Strength" in b.inputs:
        b.inputs["Emission Strength"].default_value = 1.5
    if "Alpha" in b.inputs:
        b.inputs["Alpha"].default_value = 0.4
    try:
        m.blend_method = "BLEND"
    except Exception:
        pass
    rain = []
    wrap = 34.0
    for i in range(RAIN_COUNT):
        bpy.ops.mesh.primitive_cylinder_add(radius=0.006, depth=1.0, location=(0, 0, -999))
        o = bpy.context.active_object; o.name = "Rain%d" % i
        # dy = forward distance from the camera (which flies +Y here).
        # Minimum 3.0 keeps any streak from ever sitting right on the lens —
        # a near-lens streak subtends most of the frame and reads as a
        # full-screen flash once per fall cycle (a debugged, real bug).
        dy = rng.uniform(3.0, 26.0)
        dx = rng.uniform(-14, 14)
        o.scale = (1.0, 1.0, min(2.4, 0.3 + 0.08 * dy) * rng.uniform(0.75, 1.25))
        o.rotation_euler = (math.radians(rng.uniform(3, 11)), math.radians(rng.uniform(-3, 4)), 0)
        o.data.materials.append(m)
        rain.append((o, dx, dy, rng.uniform(0, wrap), rng.uniform(8.0, 14.0), wrap))
    return rain


def position_rain(rain, cam_pos, t):
    for o, dx, dy, z0, spd, wrap in rain:
        rz = ((z0 - spd * 4.0 * t) % wrap) + 0.3
        o.location = (cam_pos.x + dx, cam_pos.y + dy, rz)


# ===========================================================================
# Camera — glide down the central avenue; level horizon, constant rates.
# Proportions (height 11->6.5, ~28 units of travel over 5s, gentle pitch-down
# reveal) match the previously-approved corridor shot.
# ===========================================================================
WORLD_UP = mathutils.Vector((0, 0, 1))
CAM_START = mathutils.Vector((0.0, -EDGE + 8.0, 11.0))
CAM_END   = mathutils.Vector((0.0, -EDGE + 36.0, 6.5))
CAM_FWD_START = mathutils.Vector((0.0, 1.0, -0.10)).normalized()
CAM_FWD_END   = mathutils.Vector((0.0, 1.0, -0.30)).normalized()


def level_rot(forward):
    """Rotation looking along `forward` with a LEVEL horizon (no roll)."""
    f = forward.normalized()
    right = f.cross(WORLD_UP).normalized()
    up = right.cross(f).normalized()
    return mathutils.Matrix(((right.x, up.x, -f.x),
                             (right.y, up.y, -f.y),
                             (right.z, up.z, -f.z))).to_4x4()


def setup_camera(sc):
    cam_data = bpy.data.cameras.new("Camera")
    cam = bpy.data.objects.new("Camera", cam_data)
    sc.collection.objects.link(cam)
    sc.camera = cam
    cam.data.lens = 32.0
    cam.data.clip_start = 0.5
    cam.data.clip_end = max(2000.0, CITY_EXTENT * 4)
    return cam


def camera_at(cam, i):
    u = i / (FRAMES - 1)
    pos = CAM_START.lerp(CAM_END, u)
    fwd = CAM_FWD_START.lerp(CAM_FWD_END, u)
    M = level_rot(fwd); M.translation = pos
    cam.matrix_world = M
    return pos


# ===========================================================================
# Main
# ===========================================================================
def build_city():
    global ROADS
    ROADS = [road_pos(k) for k in range(GRID_N + 1)]
    rng = random.Random(SEED)
    sc = reset_scene()
    setup_world_and_lights(sc)
    build_ground()
    build_streets()
    build_all_blocks(rng)
    setup_fog(sc)
    setup_bloom(sc)
    build_traffic_lights()
    cars = build_traffic(rng)
    build_parked(rng)
    rain = build_rain(rng)
    cam = setup_camera(sc)
    states = simulate_traffic(cars, FRAMES)   # whole shot, precomputed
    print("CITY_BUILT blocks=%d cars=%d rain=%d" % (GRID_N*GRID_N, len(cars), len(rain)))
    return sc, cam, cars, states, rain


def render_animation(sc, cam, cars, states, rain, outdir):
    os.makedirs(outdir, exist_ok=True)
    for i in range(FRAMES):
        pos = camera_at(cam, i)
        t = i / 30.0
        apply_traffic(cars, states, i)
        set_light_colors(t)
        position_rain(rain, pos, t)
        sc.render.filepath = os.path.join(outdir, "f%04d.png" % i)
        bpy.ops.render.render(write_still=True)
        if i % 25 == 0:
            print("frame", i)
    print("CITY_RENDER_DONE", outdir, FRAMES)


def keyframe_animation(sc, cam, cars, states, rain):
    """Bake camera + traffic + light colors + rain into keyframes so the GUI
    timeline scrubs the exact shot, weather and signals included. (Rain is
    keyed every 3rd frame — it falls fast enough that interpolation between
    keys is invisible, and it keeps the key count sane.)"""
    for i in range(FRAMES):
        camera_at(cam, i)
        t = i / 30.0
        cam.keyframe_insert(data_path="location", frame=i)
        cam.keyframe_insert(data_path="rotation_euler", frame=i)
        apply_traffic(cars, states, i)
        for c in cars:
            c["obj"].keyframe_insert(data_path="location", frame=i)
            c["obj"].keyframe_insert(data_path="rotation_euler", frame=i)
        set_light_colors(t, keyframe_at=i)
        if i % 3 == 0:
            pos = CAM_START.lerp(CAM_END, i / (FRAMES - 1))
            position_rain(rain, pos, t)
            for o, *_ in rain:
                o.keyframe_insert(data_path="location", frame=i)
    sc.frame_start = 0; sc.frame_end = FRAMES - 1; sc.frame_current = 0
    print("CITY_KEYFRAME_DONE", FRAMES)

    def _view():
        try:
            win = bpy.context.window_manager.windows[0]
            for area in win.screen.areas:
                if area.type == "VIEW_3D":
                    for space in area.spaces:
                        if space.type == "VIEW_3D":
                            space.shading.type = "RENDERED"
                    with bpy.context.temp_override(window=win, area=area, screen=win.screen):
                        bpy.ops.view3d.view_camera()
                    break
        except Exception as e:
            print("view setup (set manually):", e)
        return None
    bpy.app.timers.register(_view, first_interval=0.6)


def main():
    argv = sys.argv[sys.argv.index("--")+1:] if "--" in sys.argv else []
    sc, cam, cars, states, rain = build_city()
    if argv and argv[0] == "gui":
        setup_render(sc, 960, 540, 32)
        keyframe_animation(sc, cam, cars, states, rain)
    else:
        outdir = argv[0] if argv else "/tmp/city_frames"
        w = int(argv[1]) if len(argv) > 1 else 960
        h = int(argv[2]) if len(argv) > 2 else 540
        samples = int(argv[3]) if len(argv) > 3 else 32
        setup_render(sc, w, h, samples)
        render_animation(sc, cam, cars, states, rain, outdir)


main()
