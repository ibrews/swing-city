// Swing City — Meta VR Glasses input with IWER 2.5 (round 29).
//
// Alex, from the glasses hands-on: input is tracked hands, a gaze ray, and
// both. IWER's metaVRGlasses profile inherits Quest 3's features and does not
// declare gaze, so this adds it. Checks:
//   - the session offers a gaze source alongside two hands
//   - gazeDir() follows the eyes, not the head, and folds in the rig's yaw
//   - the WEB aims with the eyes (webAimDir); walking still follows the head
//   - with gaze disconnected, everything falls back to the head (no gaze
//     device behaves exactly as before)
//   - the round-27/28 pinch controls still work with a gaze source present
//
// Run like iwer-hands.mjs:
//   cd ~/GH/swing-city && python3 -m http.server 8791 --bind 127.0.0.1 &
//   NODE_MODULES=~/GH/isle-webxr/node_modules IWER_JS=~/GH/isle-webxr/node_modules/iwer/build/iwer.min.js \
//     node tests/iwer-glasses.mjs http://127.0.0.1:8791/
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
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
await ctx.addInitScript({ content: `${iwer}
window.xrDevice = new IWER.XRDevice({ ...IWER.metaVRGlasses,
  supportedFeatures: [...IWER.metaVRGlasses.supportedFeatures, 'gaze-tracking'] });
window.xrDevice.installRuntime({ forceInstall: true });
window.xrDevice.stereoEnabled = true;` });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => { errors.push(e.message); console.log('pageerror:', e.message); });
await page.goto(url, { waitUntil: 'load' });
await page.waitForFunction(() => window.__sw && window.__sw.renderer, null, { timeout: 60000 });
await page.waitForSelector('#VRButton', { timeout: 30000 });
await page.evaluate(() => { window.xrDevice.primaryInputMode = 'hand'; });
await page.click('#VRButton');
await page.waitForFunction(() => window.__sw.renderer.xr.isPresenting, null, { timeout: 30000 });
await page.waitForFunction(() => window.__sw.renderer.xr.getSession().inputSources.length >= 3, null, { timeout: 10000 }).catch(() => {});
await page.waitForTimeout(500);

const sources = await page.evaluate(() => [...window.__sw.renderer.xr.getSession().inputSources].map(s => `${s.targetRayMode}${s.hand ? '+hand' : ''}`));
check('gaze source offered alongside two hands', sources.filter(s => s === 'gaze').length === 1 && sources.filter(s => s.endsWith('+hand')).length === 2, sources.join(', '));

// Head faces straight ahead; eyes look 60 degrees to the right.
const yawOf = v => Math.atan2(-v.x, -v.z);
const dirs = () => page.evaluate(() => {
  const s = window.__sw, g = s.gazeDir(), w = s.webAimDir(), h = s.aimDir();
  const pick = v => v && { x: v.x, y: v.y, z: v.z };
  return { gaze: pick(g), web: pick(w), head: pick(h) };
});
await page.evaluate(() => {
  const a = -Math.PI / 3; // 60 deg to the right about +Y
  window.xrDevice.gaze.quaternion.set(0, Math.sin(a / 2), 0, Math.cos(a / 2));
});
await page.waitForTimeout(300);
let d = await dirs();
const rigYaw = await page.evaluate(() => { const q = window.__sw.cameraRig.getWorldQuaternion(new window.__sw.THREE.Quaternion()); return new window.__sw.THREE.Euler().setFromQuaternion(q, 'YXZ').y; });
const deg = r => (r * 180 / Math.PI);
const wrap = r => Math.atan2(Math.sin(r), Math.cos(r));
check('gazeDir follows the eyes (60° right of the head)', d.gaze && Math.abs(deg(wrap(yawOf(d.gaze) - yawOf(d.head))) + 60) < 3,
  d.gaze ? `gaze ${deg(yawOf(d.gaze)).toFixed(1)}°, head ${deg(yawOf(d.head)).toFixed(1)}°, rig ${deg(rigYaw).toFixed(1)}°` : 'null');
check('the web aims with the eyes', d.web && d.gaze && Math.hypot(d.web.x - d.gaze.x, d.web.y - d.gaze.y, d.web.z - d.gaze.z) < 1e-6);

// Turning the rig (snap turn / about-face) must carry the gaze with it.
await page.evaluate(() => { window.__sw.cameraRig.rotation.y += Math.PI / 2; window.__sw.cameraRig.updateMatrixWorld(true); });
await page.waitForTimeout(200);
const turned = await dirs();
check('gaze turns with the rig', turned.gaze && Math.abs(deg(wrap(yawOf(turned.gaze) - yawOf(turned.head))) + 60) < 3,
  turned.gaze ? `gaze−head ${deg(wrap(yawOf(turned.gaze) - yawOf(turned.head))).toFixed(1)}°` : 'null');
await page.evaluate(() => { window.__sw.cameraRig.rotation.y -= Math.PI / 2; window.__sw.cameraRig.updateMatrixWorld(true); });

// Walking still follows the head, not the eyes.
const walk = await page.evaluate(async () => {
  const s = window.__sw, p0 = s.player.pos.clone();
  window.xrDevice.hands.left.updatePinchValue(1);
  await new Promise(r => setTimeout(r, 1000));
  window.xrDevice.hands.left.updatePinchValue(0);
  const d = s.player.pos.clone().sub(p0); d.y = 0;
  const h = s.aimDir(); h.y = 0;
  return { moved: d.length(), cos: d.length() > 1e-3 ? d.normalize().dot(h.normalize()) : 0 };
});
check('left pinch still walks where the HEAD faces', walk.moved > 0.3 && walk.cos > 0.9, `moved ${walk.moved.toFixed(2)}m, alignment with head ${walk.cos.toFixed(2)}`);

// Right pinch still fires the web with a gaze source present.
await page.waitForTimeout(400);
await page.evaluate(() => window.xrDevice.hands.right.updatePinchValue(1));
await page.waitForTimeout(250);
const held = await page.evaluate(() => !!window.__sw.xrWebHeld);
await page.evaluate(() => window.xrDevice.hands.right.updatePinchValue(0));
check('right pinch still fires the web', held);

// No gaze: everything falls back to the head, as on every tuned device.
await page.evaluate(() => { window.xrDevice.gaze.connected = false; });
await page.waitForTimeout(400);
d = await dirs();
check('without gaze, the web falls back to the head', d.gaze === null && d.web && Math.hypot(d.web.x - d.head.x, d.web.y - d.head.y, d.web.z - d.head.z) < 1e-6);

await page.screenshot({ path: `${outDir}/swing-city-glasses.png` });
check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(failures.length ? `\n${failures.length} FAILED: ${failures.join(', ')}` : '\nALL PASSED');
process.exit(failures.length ? 1 : 0);
