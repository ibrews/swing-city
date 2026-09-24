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

// Round 28: two right-pinch STARTS within 400 ms = 180° about-face.
const yaw0 = await page.evaluate(() => window.__sw.yaw);
await page.evaluate(() => window.xrDevice.hands.right.updatePinchValue(1));
await page.waitForTimeout(120);
await page.evaluate(() => window.xrDevice.hands.right.updatePinchValue(0));
await page.waitForTimeout(120);
await page.evaluate(() => window.xrDevice.hands.right.updatePinchValue(1));
await page.waitForTimeout(200);
await page.evaluate(() => window.xrDevice.hands.right.updatePinchValue(0));
await page.waitForTimeout(200);
const yaw1 = await page.evaluate(() => window.__sw.yaw);
const turned = Math.abs(Math.abs(yaw1 - yaw0) - Math.PI);
check('double-pinch right → 180° about-face', turned < 0.01, `yaw ${yaw0.toFixed(3)} → ${yaw1.toFixed(3)}`);
await page.waitForTimeout(600);
await page.evaluate(() => window.xrDevice.hands.right.updatePinchValue(1));
await page.waitForTimeout(300);
await page.evaluate(() => window.xrDevice.hands.right.updatePinchValue(0));
await page.waitForTimeout(200);
const yaw2 = await page.evaluate(() => window.__sw.yaw);
check('single right pinch does NOT turn', Math.abs(yaw2 - yaw1) < 1e-6, `yaw ${yaw1.toFixed(3)} → ${yaw2.toFixed(3)}`);

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
