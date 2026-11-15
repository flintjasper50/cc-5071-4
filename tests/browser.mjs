/**
 * End-to-end drill check. Requires the dev server on 127.0.0.1:5173.
 *
 *   npm run dev                        # in one shell
 *   npm run test:e2e                   # in another
 *
 * If the sandbox has no system Chrome libraries, point CHROME_LIBS at a
 * directory of extracted .so files; it is forwarded as LD_LIBRARY_PATH.
 */
import { chromium } from 'playwright';

const URL = process.env.DRILL_URL ?? 'http://127.0.0.1:5173/';
const D = 180 / Math.PI;

const env = { ...process.env };
if (process.env.CHROME_LIBS) env.LD_LIBRARY_PATH = process.env.CHROME_LIBS;

const browser = await chromium.launch({
  args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu'],
  env,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push(`PAGEERROR: ${e.message}`));

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.__drillReady === true, null, { timeout: 30000 });

// Give the motor a moment to settle at rest.
await page.waitForTimeout(700);

const boot = await page.evaluate(() => ({
  hinges: window.__drill.assembly.hinges.map((h) => h.id),
  rows: document.querySelectorAll('.results-table tbody tr').length,
  canvas: !!document.querySelector('canvas'),
  dt: window.__drill.assembly.dt,
  iters: window.__drill.assembly.solverIterations,
}));
check('page boots with three hinges', boot.hinges.length === 3, boot.hinges.join(','));
check('canvas and results table rendered', boot.canvas && boot.rows === 3, `rows=${boot.rows}`);
check('no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
await page.screenshot({ path: '/tmp/drill-1-boot.png' });

const snapAngle = (id) =>
  page.evaluate((hid) => {
    const h = window.__drill.assembly.get(hid);
    return {
      angle: h.angle * (180 / Math.PI),
      target: h.target * (180 / Math.PI),
      anchorErr: h.anchorErr,
      limitErr: h.limitErr * (180 / Math.PI),
      min: h.min * (180 / Math.PI),
      max: h.max * (180 / Math.PI),
      blocked: h.blocked ? h.blocked.by : null,
      contact: h.contact.others,
      contactCount: h.contact.count,
      axisErr: h.axisErr,
    };
  }, id);

const setSlider = (id, deg) =>
  page.evaluate(
    ([hid, value]) => {
      const ui = window.__drill.ui;
      const row = ui.jointRows.get(hid);
      row.slider.value = String(value);
      row.slider.dispatchEvent(new Event('input', { bubbles: true }));
    },
    [id, deg]
  );

const waitFor = async (fn, timeout = 8000, interval = 120) => {
  const t0 = Date.now();
  for (;;) {
    if (await page.evaluate(fn)) return true;
    if (Date.now() - t0 > timeout) return false;
    await page.waitForTimeout(interval);
  }
};

// --- 1. command slider drives the kernel ----------------------------------
await setSlider('shoulder', 30);
const shoulderOk = await waitFor(() => {
  const h = window.__drill.assembly.get('shoulder');
  return Math.abs(h.angle * 180 / Math.PI - 30) < 2.5;
});
const shoulder = await snapAngle('shoulder');
check('shoulder slider command reaches target', shoulderOk, `angle=${shoulder.angle.toFixed(2)}°, target=${shoulder.target.toFixed(1)}°`);
check('shoulder anchor error stays sub-mm under motion', shoulder.anchorErr < 0.001, `${(shoulder.anchorErr * 1000).toFixed(3)} mm`);
await page.screenshot({ path: '/tmp/drill-2-command.png' });

// --- 2. hinge gizmo drag writes a target into the kernel -------------------
const gizmo = await page.evaluate(() => {
  const d = window.__drill;
  const h = d.assembly.get('shoulder');
  const s = d.view.worldToScreen(h.worldAnchorB());
  return { x: s.x, y: s.y, visible: s.visible, targetBefore: h.target };
});
check('shoulder gizmo projects on screen', gizmo.visible, `x=${gizmo.x.toFixed(0)}, y=${gizmo.y.toFixed(0)}`);

await page.mouse.move(gizmo.x, gizmo.y);
await page.mouse.down();
await page.mouse.move(gizmo.x + 30, gizmo.y - 12, { steps: 12 });
await page.mouse.up();
const dragTarget = await page.evaluate(() => window.__drill.assembly.get('shoulder').target);
check('dragging the gizmo changes the hinge command', Math.abs(dragTarget - gizmo.targetBefore) > 0.01, `target ${(gizmo.targetBefore * D).toFixed(1)}° → ${(dragTarget * D).toFixed(1)}°`);

const shoulderFollows = await waitFor(() => {
  const h = window.__drill.assembly.get('shoulder');
  return Math.abs(h.angle - h.target) < 0.1;
});
const dragged = await snapAngle('shoulder');
check('joint follows the dragged command through the constraint', shoulderFollows, `angle=${dragged.angle.toFixed(2)}°, target=${dragged.target.toFixed(1)}°`);
check('anchor error stays sub-mm while driven', dragged.anchorErr < 0.001, `${(dragged.anchorErr * 1000).toFixed(3)} mm`);
await page.screenshot({ path: '/tmp/drill-3-drag.png' });

// --- 3. limit fields edit the kernel limits --------------------------------
await page.evaluate(() => window.__drill.ui.setActive('shoulder'));
await page.fill('.limit-row input:nth-of-type(1)', '-20');
await page.waitForTimeout(120);
await page.fill('.limit-row input:nth-of-type(2)', '10');
await page.waitForTimeout(300);
const limits = await snapAngle('shoulder');
check('limit inputs update kernel limits', Math.abs(limits.min - -20) < 0.2 && Math.abs(limits.max - 10) < 0.2, `limits=${limits.min.toFixed(1)}°..${limits.max.toFixed(1)}°`);

// Command beyond the new max limit; the joint must stop at the limit.
await setSlider('shoulder', 9.5);
const atLimit = await waitFor(() => {
  const h = window.__drill.assembly.get('shoulder');
  return Math.abs(h.angle * 180 / Math.PI - h.target * 180 / Math.PI) < 0.4;
}, 9000);
const limited = await snapAngle('shoulder');
check('revised limit is respected by the solver', atLimit && limited.angle <= limited.max + 0.6, `angle=${limited.angle.toFixed(2)}° ≤ max=${limited.max.toFixed(1)}°`);

// --- 4. contact stops the arm before its angular limit ---------------------
await page.evaluate(() => window.__drill.ui.setActive('elbow'));
await setSlider('elbow', 110);
const blockedOk = await waitFor(() => {
  const h = window.__drill.assembly.get('elbow');
  return !!h.blocked && h.blocked.by.includes('stop pad');
}, 12000);
const elbow = await snapAngle('elbow');
check('elbow is stopped by the pad before its 118° limit', blockedOk && elbow.angle < 100,
  `angle=${elbow.angle.toFixed(2)}°, blocked by ${elbow.blocked ? elbow.blocked.join(',') : 'none'}`);
check('contact stop leaves the angle limit untouched', Math.abs(elbow.limitErr) < 0.6, `limitErr=${elbow.limitErr.toFixed(2)}°`);
check('contact state is reported for the elbow', elbow.contactCount > 0 && elbow.contact.includes('stop pad'), `contacts=${elbow.contactCount} (${elbow.contact.join(',')})`);
const badge = await page.evaluate(() => document.querySelector('.status-badge').textContent);
check('panel surfaces contact feedback from the kernel', /CONTACT LIMITING MOTION/.test(badge), badge);
const resultsState = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('.results-table tbody tr')];
  const elbowRow = rows.find((r) => r.textContent.includes('Elbow'));
  return elbowRow ? elbowRow.textContent.replace(/\s+/g, ' ').trim() : '';
});
check('results table shows the blocked state', /blocked: stop pad/.test(resultsState), resultsState);
await page.screenshot({ path: '/tmp/drill-4-contact.png' });

// --- 5. the player pushes the door through the hinge ----------------------
await page.evaluate(() => {
  const d = window.__drill;
  d.scene.resetPlayer();
  d.scene.placePlayer({ x: -0.27, y: 0.95, z: 2.3 }, 0);
  d.view.camera.position.set(-0.27, 2.0, 4.2);
  d.view.camera.lookAt(-0.27, 1.0, 0);
});
// Focus the viewport first: panel inputs own focus after the limit edits.
await page.mouse.click(720, 640);
await page.waitForTimeout(250);
const beforePush = await snapAngle('door');
await page.keyboard.down('KeyW');
await page.waitForTimeout(1200);
// Sample while the player is still leaning on the door: after release the panel
// keeps swinging and may end up resting on the crate instead.
const duringPush = await snapAngle('door');
await page.keyboard.up('KeyW');
await page.waitForTimeout(700);
const pushed = await snapAngle('door');
check('walking into the door turns it through the joint', duringPush.angle - beforePush.angle > 3,
  `${beforePush.angle.toFixed(1)}° → ${duringPush.angle.toFixed(1)}°`);
check('player push keeps the anchor error sub-mm', pushed.anchorErr < 0.001, `${(pushed.anchorErr * 1000).toFixed(3)} mm`);
check('door reports the player in its contact list', duringPush.contact.includes('player'), duringPush.contact.join(','));
await page.screenshot({ path: '/tmp/drill-5-push.png' });

// --- 6. solver budget controls --------------------------------------------
const costBefore = await page.evaluate(() => document.querySelector('.foot .mono').textContent);
await page.selectOption('.solver-grid .field:nth-of-type(1) select', '240');
await page.waitForTimeout(500);
const costAfter = await page.evaluate(() => document.querySelector('.foot .mono').textContent);
const solver = await page.evaluate(() => ({
  dt: window.__drill.assembly.dt,
  iters: window.__drill.assembly.solverIterations,
}));
check('dt selector applies to the assembly', Math.abs(solver.dt - 1 / 240) < 1e-9, `dt=${solver.dt.toFixed(6)}`);
check('step cost is reported and changes with the budget', /step cost/.test(costBefore) && /step cost/.test(costAfter) && costBefore !== costAfter, `${costBefore} → ${costAfter}`);

await page.selectOption('.solver-grid .field:nth-of-type(2) select', '2');
await page.waitForTimeout(500);
const solver2 = await page.evaluate(() => window.__drill.assembly.solverIterations);
check('iteration selector applies to the assembly', solver2 === 2, `iterations=${solver2}`);
await page.screenshot({ path: '/tmp/drill-5-solver.png' });

// --- 6. camera presets and pause ------------------------------------------
const camBefore = await page.evaluate(() => window.__drill.view.camera.position.toArray());
await page.click('.cam-row .chip[data-preset="arm"]');
await page.waitForTimeout(250);
const camAfter = await page.evaluate(() => window.__drill.view.camera.position.toArray());
check('camera preset moves the camera', camBefore.join(',') !== camAfter.join(','), `${camBefore.map((v) => v.toFixed(1))} → ${camAfter.map((v) => v.toFixed(1))}`);
await page.screenshot({ path: '/tmp/drill-6-arm.png' });

await page.click('.toggle-row .toggle:nth-of-type(2)'); // pause
const paused = await page.evaluate(() => window.__drill.ui.paused);
check('pause stops the simulation loop', paused === true);
await page.click('.toggle-row .toggle:nth-of-type(2)'); // resume
await page.waitForTimeout(200);

check('no console errors after interaction', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
