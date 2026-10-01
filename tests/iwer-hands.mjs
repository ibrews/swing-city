// Swing City — tracked-hand pinch verification with IWER (Meta's WebXR emulator).
// Proves the round-27 fix: on a Quest-style emulated headset in HAND mode,
// left pinch walks (xrKeys.KeyW), right pinch fires the web (xrWebHeld), and
// controller thumbsticks still move (regression).
//
// Run (needs playwright + iwer resolvable, e.g. from another checkout):
//   cd ~/GH/swing-city && python3 -m http.server 8791 --bind 127.0.0.1 &
//   NODE_MODULES=~/GH/isle-webxr/node_modules IWER_JS=~/GH/isle-webxr/node_modules/iwer/build/iwer.min.js \
//     node tests/iwer-hands.mjs http://127.0.0.1:8791/
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
// ESM ignores NODE_PATH; point NODE_MODULES at a checkout that has playwright installed.
const nm = process.env.NODE_MODULES;
const { chromium } = nm ? await import(pathToFileURL(`${nm}/playwright/index.mjs`).href) : await import('playwright');

const url = process.argv[2] || 'http://127.0.0.1:8791/';
const iwer = readFileSync(process.env.IWER_JS, 'utf8');
const outDir = process.env.TEST_OUTPUT || '.';
const failures = [];
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); if (!ok) failures.push(name); };

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'],
});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
await ctx.addInitScript({ content: `${iwer}\nwindow.xrDevice = new IWER.XRDevice(IWER.metaQuest3); window.xrDevice.installRuntime({ forceInstall: true }); window.xrDevice.stereoEnabled = true;` });
const page = await ctx.newPage();
page.on('pageerror', e => console.log('pageerror:', e.message));
await page.goto(url, { waitUntil: 'load' });
await page.waitForFunction(() => window.__sw && window.__sw.renderer, null, { timeout: 60000 });
await page.waitForSelector('#VRButton', { timeout: 30000 });
await page.evaluate(() => { window.xrDevice.primaryInputMode = 'hand'; });
await page.click('#VRButton');
await page.waitForFunction(() => window.__sw.renderer.xr.isPresenting, null, { timeout: 30000 });
// IWER surfaces the hand sources a few frames after the session starts.
await page.waitForFunction(() => window.__sw.renderer.xr.getSession().inputSources.length >= 2, null, { timeout: 10000 }).catch(() => {});
await page.waitForTimeout(500);

const sources = await page.evaluate(() => [...window.__sw.renderer.xr.getSession().inputSources].map(s => ({
  handedness: s.handedness, targetRayMode: s.targetRayMode, profiles: s.profiles,
  hasHand: !!s.hand, buttons: s.gamepad ? s.gamepad.buttons.length : null, axes: s.gamepad ? s.gamepad.axes.length : null,
})));
console.log('inputSources (hand mode):', JSON.stringify(sources));
check('two tracked hands present', sources.length === 2 && sources.every(s => s.targetRayMode === 'tracked-pointer'), JSON.stringify(sources.map(s => s.targetRayMode)));

const state = () => page.evaluate(() => ({ W: !!window.__sw.xrKeys.KeyW, held: !!window.__sw.xrWebHeld, x: window.__sw.player.pos ? window.__sw.player.pos.x : (window.__sw.player.position && window.__sw.player.position.x), z: window.__sw.player.pos ? window.__sw.player.pos.z : (window.__sw.player.position && window.__sw.player.position.z) }));

let s0 = await state();
check('idle: no walk, no web', !s0.W && !s0.held, JSON.stringify(s0));

await page.evaluate(() => window.xrDevice.hands.left.updatePinchValue(1));
await page.waitForTimeout(600);
let s1 = await state();
await page.waitForTimeout(1200);
let s2 = await state();
check('left pinch → walks (xrKeys.KeyW)', s1.W === true, JSON.stringify(s1));
const moved = Math.hypot((s2.x ?? 0) - (s1.x ?? 0), (s2.z ?? 0) - (s1.z ?? 0));
check('left pinch → player displaced', moved > 0.05, `moved ${moved.toFixed(2)} in 1.2s`);
check('left pinch does NOT fire web', s1.held === false, JSON.stringify(s1));
await page.screenshot({ path: `${outDir}/swing-city-iwer-left-pinch-walk.png` });

await page.evaluate(() => window.xrDevice.hands.left.updatePinchValue(0));
await page.waitForTimeout(400);
let s3 = await state();
check('release left → stops walking', s3.W === false, JSON.stringify(s3));

await page.evaluate(() => window.xrDevice.hands.right.updatePinchValue(1));
await page.waitForTimeout(400);
let s4 = await state();
check('right pinch → fires web (xrWebHeld)', s4.held === true && s4.W === false, JSON.stringify(s4));
await page.evaluate(() => window.xrDevice.hands.right.updatePinchValue(0));
await page.waitForTimeout(400);

// Round 28: two right-pinch STARTS within 400 ms = 180 degree about-face.
// WHY the whole gesture is driven INSIDE one page.evaluate, on in-page
// timers: the app's window is only 400 ms wide, and this used to be four
// separate page.evaluate calls separated by page.waitForTimeout(120). Each
// Playwright round trip (CDP latency) plus frame granularity ate the 160 ms
// of margin, so under host load the test lied in BOTH directions -- a
// working app could fail and a broken one could pass. Driven in-page, the
// only jitter left is a single animation frame.
//
// Runs a timed pinch plan on the emulated right hand and, every frame,
// counts rising edges of that hand's gamepad buttons[0].pressed -- the exact
// signal index.html edge-detects (nothing on window.__sw exposes the
// pinch-start itself). The sample is taken BEFORE the frame's plan step, so
// an edge only counts once the pressed state has survived into a frame the
// app's own loop could see too.
const drivePinches = async ({ plan, endAt }) => {
  const hand = window.xrDevice.hands.right;
  // Drive on the XR SESSION's frame loop, not window.requestAnimationFrame:
  // while presenting, the window loop is throttled and ticks far slower than
  // the frames the app's own stepXR actually reads input on.
  const session = window.__sw.renderer.xr.getSession();
  const rightSrc = () => [...window.__sw.renderer.xr.getSession().inputSources].find(s => s.handedness === 'right');
  const yaw0 = window.__sw.yaw;
  let starts = 0, prev = false, next = 0, frames = 0, t = 0;
  const startTimes = [];
  const t0 = performance.now();
  await new Promise(resolve => {
    const tick = () => {
      t = performance.now() - t0;
      frames++;
      const src = rightSrc();
      const pressed = !!(src && src.gamepad && src.gamepad.buttons[0] && src.gamepad.buttons[0].pressed);
      if (pressed && !prev) { starts++; startTimes.push(Math.round(t)); }
      prev = pressed;
      // At most ONE plan step per frame. A press and its release applied in
      // the same frame would be invisible to this sampler AND to the app's
      // own edge detector -- this scene renders on swiftshader, where a
      // frame can be longer than the 120 ms hold.
      if (next < plan.length && t >= plan[next][0]) hand.updatePinchValue(plan[next++][1]);
      if (next >= plan.length && t >= endAt) { hand.updatePinchValue(0); resolve(); return; }
      session.requestAnimationFrame(tick);
    };
    session.requestAnimationFrame(tick);
  });
  return { yaw0, yaw1: window.__sw.yaw, starts, startTimes, frames, ms: Math.round(t) };
};

// Gap between the two pinch STARTS. 240 ms sits inside the app's 400 ms
// window; ABOUT_FACE_GAP_MS=500 widens it past the window, which is the
// control run that proves the yaw assertion can actually go red.
const gapMs = Number(process.env.ABOUT_FACE_GAP_MS || 240);
const dbl = await page.evaluate(drivePinches, { plan: [[0, 1], [120, 0], [gapMs, 1], [gapMs + 200, 0]], endAt: gapMs + 560 });
check('double-pinch right: gesture seen (2 pinch starts)', dbl.starts === 2, `rising edges ${dbl.starts} at ${JSON.stringify(dbl.startTimes)}ms, requested gap ${gapMs}ms, ${dbl.frames} frames in ${dbl.ms}ms`);
const turned = Math.abs(Math.abs(dbl.yaw1 - dbl.yaw0) - Math.PI);
check('double-pinch right -> 180 degree about-face', turned < 0.01, `yaw ${dbl.yaw0.toFixed(3)} -> ${dbl.yaw1.toFixed(3)}, gap ${gapMs}ms`);

await page.waitForTimeout(600);   // let the app's 400 ms double-tap window lapse
const sgl = await page.evaluate(drivePinches, { plan: [[0, 1], [300, 0]], endAt: 800 });
check('single right pinch does NOT turn', sgl.starts === 1 && Math.abs(sgl.yaw1 - sgl.yaw0) < 1e-6, `starts ${sgl.starts} at ${JSON.stringify(sgl.startTimes)}ms, yaw ${sgl.yaw0.toFixed(3)} -> ${sgl.yaw1.toFixed(3)}`);

// Regression: controllers still drive movement via the thumbstick.
await page.evaluate(() => { window.xrDevice.primaryInputMode = 'controller'; });
await page.waitForTimeout(800);
const csrc = await page.evaluate(() => [...window.__sw.renderer.xr.getSession().inputSources].map(s => ({ h: s.handedness, m: s.targetRayMode, axes: s.gamepad ? s.gamepad.axes.length : null })));
console.log('inputSources (controller mode):', JSON.stringify(csrc));
await page.evaluate(() => window.xrDevice.controllers.left.updateAxes('thumbstick', 0, 1));
await page.waitForTimeout(500);
let s5 = await state();
check('controller: left stick forward → walks', s5.W === true, JSON.stringify(s5));
await page.evaluate(() => window.xrDevice.controllers.left.updateAxes('thumbstick', 0, 0));
await page.evaluate(() => window.xrDevice.controllers.right.updateButtonValue('trigger', 1));
await page.waitForTimeout(400);
let s6 = await state();
check('controller: right trigger → fires web', s6.held === true, JSON.stringify(s6));
await page.evaluate(() => window.xrDevice.controllers.right.updateButtonValue('trigger', 0));
await page.screenshot({ path: `${outDir}/swing-city-iwer-controller-mode.png` });

await browser.close();
console.log(failures.length ? `\n${failures.length} FAILED: ${failures.join(', ')}` : '\nALL PASSED');
process.exit(failures.length ? 1 : 0);
