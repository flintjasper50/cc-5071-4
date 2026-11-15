import RAPIER from '@dimforge/rapier3d-compat';
import { buildScene } from './scene/build.js';
import { SceneView } from './render/view.js';
import { DrillUI } from './ui/panel.js';
import { Interaction } from './ui/interaction.js';
import './style.css';

async function boot() {
  await RAPIER.init();
  const params = new URLSearchParams(location.search);
  const dt = params.has('dt') ? 1 / Number(params.get('dt')) : 1 / 120;
  const iterations = params.has('iters') ? Number(params.get('iters')) : 6;

  const scene = buildScene(RAPIER, { dt, solverIterations: iterations });
  scene.settle(0.5);

  const root = document.getElementById('app');
  const ui = new DrillUI(root, scene);
  const view = new SceneView(ui.canvasHost, scene, RAPIER);
  ui.view = view;

  const interaction = new Interaction({
    renderer: view.renderer,
    camera: view.camera,
    scene,
    view,
    ui,
  });

  let last = performance.now();
  let fps = 60;
  let smoothedCost = 0;

  function frame(now) {
    const rawDt = Math.min((now - last) / 1000, 0.05);
    last = now;
    fps = fps * 0.9 + (1 / Math.max(rawDt, 1e-4)) * 0.1;

    interaction.updatePlayer();

    if (!ui.paused) {
      const simDt = rawDt * ui.timeScale;
      const t0 = performance.now();
      scene.assembly.advance(simDt);
      const cost = performance.now() - t0;
      smoothedCost = smoothedCost * 0.85 + cost * 0.15;
    }

    view.sync();
    view.syncContacts(ui.showContacts);
    view.render();
    ui.update(rawDt, fps, smoothedCost);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // Automation surface used by the browser test and the drill console.
  window.__drill = { scene, view, ui, interaction, assembly: scene.assembly };
  window.__drillReady = true;
}

boot().catch((err) => {
  console.error(err);
  const root = document.getElementById('app');
  if (root) {
    root.innerHTML = `<pre class="fatal">Failed to start: ${String(err && err.stack ? err.stack : err)}</pre>`;
  }
});
