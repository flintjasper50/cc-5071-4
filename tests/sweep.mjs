/**
 * Solver budget sweep. Drives all three joints for 3 simulated seconds at each
 * (step, iteration) pair and prints the measured constraint error and cost.
 *
 *   npm run sweep
 */
import RAPIER from '@dimforge/rapier3d-compat';
import { buildScene } from '../src/scene/build.js';

const D = 180 / Math.PI;
await RAPIER.init();

const header = ['step', 'iters', 'max anchor (mm)', 'max axis err (deg)', 'max limit err (deg)', 'cost (ms/sim s)', 'steps'];
const rows = [];

for (const hz of [60, 120, 240]) {
  const dt = 1 / hz;
  for (const iterations of [2, 4, 6, 8, 12, 16]) {
    const scene = buildScene(RAPIER, { dt, solverIterations: iterations });
    scene.settle(0.4);
    scene.assembly.setTarget('shoulder', 25 * D);
    scene.assembly.setTarget('elbow', 70 * D);
    scene.assembly.setTarget('door', 40 * D);
    const steps = Math.round(3 / dt);
    const elapsed = scene.assembly.runSteps(steps, dt);
    const hinges = scene.assembly.hinges;
    rows.push([
      `${hz} Hz`,
      String(iterations),
      (Math.max(...hinges.map((h) => h.anchorErr)) * 1000).toFixed(3),
      (Math.max(...hinges.map((h) => h.axisErr)) * D).toFixed(4),
      (Math.max(...hinges.map((h) => Math.abs(h.limitErr))) * D).toFixed(4),
      (elapsed / 3).toFixed(1),
      String(steps),
    ]);
  }
}

const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
const line = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join('  ');
console.log(line(header));
console.log(widths.map((w) => '-'.repeat(w)).join('  '));
for (const r of rows) console.log(line(r));

const worstAnchor = Math.max(...rows.map((r) => Number(r[2])));
console.log(`\nWorst anchor error across all budgets: ${worstAnchor.toFixed(3)} mm`);
