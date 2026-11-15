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
- Example: <http://127.0.0.1:5173/?dt=240&iters=12>

You can also change both from the **Solver** card while it runs.

### Controls

| Action | Input |
| --- | --- |
| Drive a joint | Joint card slider, or drag the joint's ring gizmo in the viewport |
| Edit limits | **Interact** card → pick a hinge → `limits min → max` number fields (degrees) |
| Move the player | `W A S D` / arrow keys, `Shift` to sprint; click the viewport first so keys focus it |
| Reset player | `R` |
| Pick hinge for limit editing | `1` / `2` / `3`, or the Interact segmented buttons |
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

## How it is built

```
src/core/math.js      vectors, quaternions, frame construction, twist extraction
src/core/angles.js    continuous angle tracker and limit projection
src/core/hinges.js    Hinge + HingeAssembly (the kernel: joints, diagnostics,
                      gravity feed-forward, contact hold state machine)
src/scene/build.js    the drill scene; one collider per visual, all labelled
src/render/view.js    meshes mirror collider transforms; hinge/limit gizmos
src/ui/panel.js       controls → kernel API, kernel state → readouts
src/ui/interaction.js screen-space gizmo drag, body drag, keyboard player
src/main.js           boot, fixed-step loop, automation surface
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
npm test          # kernel, angle and solver unit tests (Node)
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
the player, and switches dt/iterations while checking the reported cost.

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
