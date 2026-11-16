import RAPIER from '@dimforge/rapier3d-compat';
import { buildScene } from './scene/build.js';
import { buildSceneFromAsset, exportSceneAsset } from './scene/loader.js';
import { ScriptPlayer } from './scene/script.js';
import { SceneView } from './render/view.js';
import { DrillUI } from './ui/panel.js';
import { Interaction } from './ui/interaction.js';
import './style.css';

const BUILTIN_ID = 'builtin';

async function boot() {
  await RAPIER.init();
  const params = new URLSearchParams(location.search);
  const dt = params.has('dt') ? 1 / Number(params.get('dt')) : 1 / 120;
  const iterations = params.has('iters') ? Number(params.get('iters')) : 6;
  const root = document.getElementById('app');

  // Committed scene assets, listed by the manifest the authoring CLI writes.
  let scenes = [];
  try {
    const res = await fetch('/assets/scenes/manifest.json');
    if (res.ok) scenes = (await res.json()).scenes ?? [];
  } catch {
    scenes = [];
  }

  let current = null;

  function teardown() {
    if (!current) return;
    current.interaction.dispose();
    current.ui.dispose();
    current.view.dispose();
    current.scene.world.free();
    current = null;
  }

  function mount(scene, sceneId) {
    // The UI constructor asks the host for the current id, so publish it
    // before building anything; the layers are filled in synchronously below.
    current = { scene, sceneId, view: null, ui: null, interaction: null, scriptPlayer: null };
    const ui = new DrillUI(root, scene, hostApi);
    const view = new SceneView(ui.canvasHost, scene, RAPIER);
    ui.view = view;
    const interaction = new Interaction({
      renderer: view.renderer,
      camera: view.camera,
      scene,
      view,
      ui,
    });
    const scriptPlayer = scene.asset?.script?.length
      ? new ScriptPlayer(scene, scene.asset.script, scene.asset.scriptDuration)
      : null;
    current = { scene, sceneId, view, ui, interaction, scriptPlayer };
    // Automation surface used by the browser test and the drill console.
    window.__drill = { scene, view, ui, interaction, assembly: scene.assembly };
  }

  async function loadScene(id) {
    let scene;
    if (id === BUILTIN_ID) {
      scene = buildScene(RAPIER, { dt, solverIterations: iterations });
    } else {
      const entry = scenes.find((s) => s.id === id);
      if (!entry) throw new Error(`unknown scene "${id}"`);
      const res = await fetch(entry.url);
      if (!res.ok) throw new Error(`failed to fetch ${entry.url}: ${res.status}`);
      const asset = await res.json();
      scene = buildSceneFromAsset(RAPIER, asset, {});
    }
    scene.settle(0.5);
    teardown();
    mount(scene, id);
    return scene;
  }

  const hostApi = {
    scenes,
    currentId: () => current?.sceneId ?? BUILTIN_ID,
    loadScene,
    replayScript() {
      current?.scriptPlayer?.start();
    },
    scriptStatus() {
      const p = current?.scriptPlayer;
      if (!p) return null;
      return { active: p.active, t: p.t, duration: p.duration, cursor: p.cursor, ops: p.ops.length };
    },
    exportScene() {
      return current ? exportSceneAsset(current.scene) : null;
    },
  };
  window.__drillHost = hostApi;

  const requested = params.get('scene');
  const initial = requested && scenes.some((s) => s.id === requested) ? requested : BUILTIN_ID;
  await loadScene(initial);

  let last = performance.now();
  let fps = 60;
  let smoothedCost = 0;

  function frame(now) {
    const rawDt = Math.min((now - last) / 1000, 0.05);
    last = now;
    fps = fps * 0.9 + (1 / Math.max(rawDt, 1e-4)) * 0.1;

    if (current) {
      const { scene, view, ui, interaction, scriptPlayer } = current;
      interaction.updatePlayer();
      scriptPlayer?.update();

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
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  window.__drillReady = true;
}

boot().catch((err) => {
  console.error(err);
  const root = document.getElementById('app');
  if (root) {
    root.innerHTML = `<pre class="fatal">Failed to start: ${String(err && err.stack ? err.stack : err)}</pre>`;
  }
});
