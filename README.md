# Hinge contact drill

An articulated revolute-joint kernel plus an interactive Three.js drill viewport.
Nothing on screen is animated by scripted keyframes: a door panel and a
two-link robot arm are driven by Rapier revolute **constraints** with motors and
angle limits, and the display copies each collider's transform every frame.

## Start the UI

```bash
npm install
npm run dev
```

Then open **http://127.0.0.1:5173/**.

Optional query parameters set the initial solver budget:

- `?dt=120&iters=6` — 120 Hz step (also `60`, `240`) and 6 solver iterations
  (also `2`, `4`, `8`, `12`, `16`).
- `?scene=dock-gate-arm` — boot straight into a committed scene asset instead
  of the built-in drill.
- Example: <http://127.0.0.1:5173/?dt=240&iters=12>

You can also change both from the **Solver** card while it runs.

### Controls

| Action | Input |
| --- | --- |
| Drive a joint | Joint card slider, or drag the joint's ring gizmo in the viewport |
| Edit limits | **Interact** card → pick a hinge → `limits min → max` number fields (degrees) |
| Load a scene asset | **Scene** card → pick a scene → **load** |
| Replay a scene's saved script | **Scene** card → **replay script** |
| Export the live scene as an asset | **Scene** card → **export asset** (downloads JSON) |
| Move the player | `W A S D` / arrow keys, `Shift` to sprint; click the viewport first so keys focus it |
| Reset player | `R` |
| Pick hinge for limit editing | `1`…`9` (joint order), or the Interact segmented buttons |
| Pause / resume | `Space` or the **pause** button |
| Slow motion | **slow motion** button (¼ speed) |
| Cameras | Overview / Door / Arm / Player chips |
| Helpers | **joint gizmos** and **contact points** toggles |

The green **CONSTRAINTS SATISFIED** badge switches to amber
**CONTACT LIMITING MOTION** whenever any joint is held up by a real contact,
and the Results table names what it hit.

## What the drill demonstrates

- **Door hinge** on the wall (`parent = wall`, pivot offset from the panel
  centre). Swing it with its slider or gizmo, change its limits, and walk into
  it with the player from either face. The crate behind the doorway stops it
  before its angle limit does.
- **Shoulder + elbow** on a robot arm whose mount is yawed 32° and tilted −8°,
  so world axes and body axes disagree. The elbow is stopped by a physical stop
  pad at ≈56° even though its configured limit is 118°; deleting the pad (the
  hidden `window.__drill` surface or the test) lets it reach the limit.
- **Results table** shows, per joint: angle, anchor (axle) error in mm, limit
  error in degrees, and state (`free` / `moving` / `contact` / `limit reached`
  / `blocked: <thing>`). The footer reports measured step cost as a percentage
  of the current step budget.

## Scene assets

Committed scenes live in `public/assets/scenes/` and load into the drill
viewport as-is. The graphical entry is the **Scene** card in the UI (top of the
panel): **load** swaps the running scene, **replay script** re-issues the
scene's saved interaction script against the live kernel, and **export asset**
downloads the current geometry, limits, targets and solver settings as an
editable `hinge-scene/1` JSON file.

`dock-gate-arm` ("Loading dock: reversed gate + ceiling arm") is the authored
sample: a gate on a **reversed** vertical axis `[0,-1,0]` with limits
`[-6°, 96°]` that a bollard blocks at ≈61°, plus a ceiling-mounted two-link arm
whose shoulder and elbow swing to their negative limit angles. The asset JSON
stores the geometry, the interaction input script (`setTarget` / `setLimits`
ops with sim times — they only command kernel motors and limits, never
transforms), and a `meta` block recording the authoring source and parameters.

Each scene ships with its original record (`*.trace.json`): per-step joint
diagnostics captured when the asset was authored — angles, targets, anchor/axis
/limit errors, contacts, blockages and limit hits.

### Authoring and verification (auxiliary CLI)

The CLI only assists the assets; the drill UI above is the product.

```bash
npm run asset:build    # author scenes from scripts/dock-asset.mjs, run the
                       # saved script headlessly, and write the assets plus
                       # their traces (refuses to write if the reconstruction
                       # does not conform or the evidence is missing)
npm run asset:verify   # rebuild and replay every committed scene in a clean
                       # temporary directory, comparing fresh joint errors and
                       # limit hits against the committed original records
```

`npm run asset:verify` copies `src/` and `public/assets/` into a fresh temp
directory and runs the check there, so nothing in the working tree can
influence the result; it exits non-zero on any mismatch and keeps the
directory (with `verification-report.json`) for inspection.
`tests/assets.test.mjs` covers the same pipeline in-place, including detection
of a tampered record.

## How it is built

```
src/core/math.js      vectors, quaternions, frame construction, twist extraction
src/core/angles.js    continuous angle tracker and limit projection
src/core/hinges.js    Hinge + HingeAssembly (the kernel: joints, diagnostics,
                      gravity feed-forward, contact hold state machine)
src/scene/build.js    the built-in drill scene; one collider per visual, all labelled
src/scene/hinge-config.js  shared hinge frame math (world pivot/axis → joint locals)
src/scene/player.js   the player rig used by every scene
src/scene/loader.js   hinge-scene/1 assets: validate, rebuild, conformance check, export
src/scene/script.js   interaction scripts: headless replay, trace summaries,
                      record comparison, live ScriptPlayer
src/render/view.js    meshes mirror collider transforms; hinge/limit gizmos
src/ui/panel.js       controls → kernel API, kernel state → readouts; Scene card
src/ui/interaction.js screen-space gizmo drag, body drag, keyboard player
src/main.js           boot, scene mount/teardown, fixed-step loop, automation surface
scripts/dock-asset.mjs     the dock scene definition (single source of its parameters)
scripts/build-assets.mjs   authoring CLI: rebuild → conform → record → write assets
scripts/verify-assets.mjs  clean-directory verification against the committed records
```

Design points that matter:

- **One source of truth.** `solid()` creates a Rapier collider and records its
  visual; `SceneView.sync()` copies `collider.translation()/rotation()` onto the
  mesh each frame. The visible door cannot be anywhere its collider is not.
- **The joint's local X axis is the free axis.** Frames are built with
  `qFromXAxis(worldAxis)` and converted into each body's frame, so rendering,
  the angle readout and the Rapier limit share one axis.
- **Angle continuity.** `AngleTracker` unwraps the raw twist toward the running
  angle, so crossing ±π is a small step, not a phantom revolution. Limits are
  projected through `clampToLimits`, which preserves whole turns.
- **Contact-aware control.** `updateBlockage()` uses real manifold data from
  `sampleContacts()`, gravity feed-forward and a hold/probe state machine. This
  is what stops the motor from winding up against the pad and snapping back.
- **Solver budget is measured, not assumed.** `runSteps(count, dt)` reports
  elapsed time, and the test suite sweeps dt × iterations checking anchor error
  and cost.

## Tests

```bash
npm test          # kernel, angle, solver and scene-asset unit tests (Node)
npm run sweep     # dt × iterations budget sweep with measured error and cost
npm run build     # production build
```

### Measured solver budget

`npm run sweep` drives all three joints for 3 s at each setting (numbers are
from this machine; re-run to compare):

```
step    iters  max anchor (mm)  max axis err (deg)  max limit err (deg)  cost (ms/sim s)
60 Hz   2      14.883           3.7167              0.0000               15.1
60 Hz   6      0.547            0.2290              0.0000               6.1
60 Hz   16     0.084            0.0320              0.0000               6.7
120 Hz  2      4.203            1.6318              0.0000               5.5
120 Hz  6      0.127            0.2059              0.0000               5.9
120 Hz  16     0.095            0.0094              0.0000               9.3
240 Hz  2      0.282            0.4076              0.0000               8.4
240 Hz  6      0.169            0.0285              0.0000               11.7
240 Hz  16     0.004            0.0015              0.0035               18.8
```

The default (120 Hz, 6 iterations) holds the pivots to ~0.13 mm while all three
joints are driven for 3 s. Under-budgeting is visible rather than hidden: 60 Hz
with 2 iterations leaves ~15 mm of anchor error under that load, and the same
number appears in the Results table.

The browser drill test needs the dev server running in another shell:

```bash
npm run dev
npm run test:e2e
```

`tests/browser.mjs` drives the real page: boots, reads kernel state, drags a
gizmo, edits limits, drives the elbow into the stop pad, pushes the door with
the player, switches dt/iterations while checking the reported cost, then loads
the committed dock scene through the Scene card, drives its gate, replays its
script into the bollard block, edits its limits and exports the edited asset.

If Chromium cannot find system libraries in a headless container, extract the
missing Debian packages into a directory and pass
`CHROME_LIBS=/path/to/libs` — the test forwards it as `LD_LIBRARY_PATH`.

## Automation surface

`window.__drill` exposes `{ scene, view, ui, interaction, assembly }` for the
browser test, e.g.:

```js
assembly.setTarget('elbow', 110 * Math.PI / 180);
assembly.runSteps(900, 1 / 120);   // returns elapsed ms
assembly.get('elbow').contact.others;  // → ['stop pad']
```

`window.__drillHost` manages scenes: `listScenes` is not needed — the host
exposes `scenes`, `currentId()`, `loadScene(id)`, `replayScript()`,
`scriptStatus()` and `exportScene()`, the same calls the Scene card buttons
use.
