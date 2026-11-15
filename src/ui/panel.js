import { clamp } from '../core/math.js';

const D = 180 / Math.PI;

/**
 * The contact-drill viewport UI.
 *
 * Every control writes to the hinge kernel through its public API, and every
 * readout is derived from kernel state sampled after the last physics step.
 * Nothing here integrates motion, clamps angles, or decides whether a joint is
 * blocked: the kernel owns that, and blocked/limit/contact results are mirrored
 * back into the panel.
 */
export class DrillUI {
  constructor(root, scene) {
    this.root = root;
    this.scene = scene;
    this.view = null;
    this.assembly = scene.assembly;
    this.selected = new Set(['door', 'shoulder', 'elbow']);
    this.paused = false;
    this.showHelpers = true;
    this.showContacts = true;
    this.slowMotion = false;
    this.lastResults = new Map();
    this._build();
    this._bindKeys();
    this.refreshStatic();
  }

  _el(tag, className, text) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text != null) e.textContent = text;
    return e;
  }

  _build() {
    this.root.innerHTML = '';

    const header = this._el('header', 'topbar');
    const title = this._el('div', 'title');
    title.innerHTML = '<strong>Hinge contact drill</strong><span>articulated joints · live constraint diagnostics</span>';
    header.appendChild(title);

    const stats = this._el('div', 'topstats');
    this.fpsEl = this._el('span', 'pill', '— fps');
    this.stepEl = this._el('span', 'pill', 'step —');
    this.selectedEl = this._el('span', 'pill', '—');
    stats.append(this.fpsEl, this.stepEl, this.selectedEl);
    header.appendChild(stats);
    this.root.appendChild(header);

    const main = this._el('main', 'layout');
    this.root.appendChild(main);

    // 3D viewport --------------------------------------------------------
    const stage = this._el('section', 'stage');
    main.appendChild(stage);
    const canvasHost = this._el('div', 'canvas-host');
    canvasHost.id = 'viewport';
    stage.appendChild(canvasHost);
    this.canvasHost = canvasHost;

    const overlay = this._el('div', 'overlay');
    stage.appendChild(overlay);
    this.badge = this._el('div', 'status-badge');
    overlay.appendChild(this.badge);

    const camRow = this._el('div', 'cam-row');
    for (const [label, preset] of [['Overview', 'overview'], ['Door', 'door'], ['Arm', 'arm'], ['Player', 'player']]) {
      const b = this._el('button', 'chip', label);
      b.dataset.preset = preset;
      b.addEventListener('click', () => this.view?.setCameraPreset(preset));
      camRow.appendChild(b);
    }
    overlay.appendChild(camRow);

    const legend = this._el('div', 'legend');
    legend.innerHTML = `
      <span><i class="dot door"></i>door hinge</span>
      <span><i class="dot shoulder"></i>shoulder</span>
      <span><i class="dot elbow"></i>elbow</span>
      <span><i class="dot limit"></i>limit arc</span>
      <span><i class="dot contact"></i>contact point</span>`;
    overlay.appendChild(legend);

    // Control panel ------------------------------------------------------
    const panel = this._el('aside', 'panel');
    main.appendChild(panel);

    panel.appendChild(this._sectionJoints());
    panel.appendChild(this._sectionSolver());
    panel.appendChild(this._sectionInteract());
    panel.appendChild(this._sectionResults());
  }

  _sectionJoints() {
    const wrap = this._el('section', 'card');
    wrap.appendChild(this._el('h2', null, 'Joints'));
    this.jointRows = new Map();
    for (const h of this.assembly.hinges) {
      const row = this._el('div', 'joint');
      const head = this._el('div', 'joint-head');
      const name = this._el('label', 'joint-name');
      const dot = this._el('i', `dot ${h.group}`);
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = this.selected.has(h.id);
      cb.addEventListener('change', () => {
        if (cb.checked) this.selected.add(h.id);
        else this.selected.delete(h.id);
      });
      name.append(cb, dot, document.createTextNode(h.label));
      head.appendChild(name);

      const angle = this._el('span', 'joint-angle', '0.0°');
      head.appendChild(angle);
      row.appendChild(head);

      const cmd = this._el('div', 'cmd-row');
      const label = this._el('span', 'cmd-label', 'command');
      cmd.appendChild(label);
      const slider = document.createElement('input');
      slider.type = 'range';
      slider.step = '0.5';
      slider.min = String(Math.round(h.min * D * 10) / 10);
      slider.max = String(Math.round(h.max * D * 10) / 10);
      slider.value = String(Math.round(h.target * D * 10) / 10);
      const out = this._el('output', null, `${(h.target * D).toFixed(1)}°`);
      slider.addEventListener('input', () => {
        const deg = Number(slider.value);
        this.assembly.setTarget(h.id, deg / D);
        out.textContent = `${deg.toFixed(1)}°`;
      });
      cmd.append(slider, out);
      row.appendChild(cmd);

      const feed = this._el('div', 'feed');
      feed.textContent = '';
      row.appendChild(feed);

      this.jointRows.set(h.id, { row, angle, feed, slider, out });
      wrap.appendChild(row);
    }
    return wrap;
  }

  _sectionSolver() {
    const wrap = this._el('section', 'card');
    wrap.appendChild(this._el('h2', null, 'Solver'));
    const grid = this._el('div', 'solver-grid');

    this.dtSelect = document.createElement('select');
    for (const [label, v] of [['1/60 s', 60], ['1/120 s', 120], ['1/240 s', 240]]) {
      const o = document.createElement('option');
      o.value = String(v);
      o.textContent = label;
      if (Math.abs(this.assembly.dt - 1 / v) < 1e-6) o.selected = true;
      this.dtSelect.appendChild(o);
    }
    grid.appendChild(this._labelled('step', this.dtSelect));

    this.iterSelect = document.createElement('select');
    for (const k of [2, 4, 6, 8, 12, 16]) {
      const o = document.createElement('option');
      o.value = String(k);
      o.textContent = `${k} iterations`;
      if (k === this.assembly.solverIterations) o.selected = true;
      this.iterSelect.appendChild(o);
    }
    grid.appendChild(this._labelled('iterations', this.iterSelect));

    const apply = () => {
      const dt = 1 / Number(this.dtSelect.value);
      const it = Number(this.iterSelect.value);
      this.assembly.setStep(dt, it);
      this.refreshStatic();
    };
    this.dtSelect.addEventListener('change', apply);
    this.iterSelect.addEventListener('change', apply);

    const speed = this._el('div', 'toggle-row');
    this.speedBtn = this._el('button', 'toggle', 'slow motion');
    this.speedBtn.addEventListener('click', () => {
      this.slowMotion = !this.slowMotion;
      this.speedBtn.classList.toggle('on', this.slowMotion);
    });
    this.pauseBtn = this._el('button', 'toggle', 'pause');
    this.pauseBtn.addEventListener('click', () => {
      this.paused = !this.paused;
      this.pauseBtn.classList.toggle('on', this.paused);
      this.pauseBtn.textContent = this.paused ? 'resume' : 'pause';
    });
    speed.append(this.speedBtn, this.pauseBtn);
    wrap.appendChild(grid);
    wrap.appendChild(speed);
    return wrap;
  }

  _labelled(text, control) {
    const l = this._el('label', 'field');
    l.appendChild(this._el('span', null, text));
    l.appendChild(control);
    return l;
  }

  _sectionInteract() {
    const wrap = this._el('section', 'card');
    wrap.appendChild(this._el('h2', null, 'Interact'));
    const info = this._el('p', 'hint', 'Drag a joint helper in the viewport to move it. Select a hinge below to drive it.');
    wrap.appendChild(info);

    const targets = this._el('div', 'seg');
    this.activeTarget = 'door';
    this.targetButtons = new Map();
    for (const h of this.assembly.hinges) {
      const b = this._el('button', 'seg-btn', h.label);
      b.classList.toggle('on', h.id === this.activeTarget);
      b.addEventListener('click', () => this.setActive(h.id));
      targets.appendChild(b);
      this.targetButtons.set(h.id, b);
    }
    wrap.appendChild(targets);

    this.dragInfo = this._el('p', 'hint', '');
    wrap.appendChild(this.dragInfo);

    const toggles = this._el('div', 'toggle-row');
    this.helperBtn = this._el('button', 'toggle on', 'joint gizmos');
    this.helperBtn.addEventListener('click', () => {
      this.showHelpers = !this.showHelpers;
      this.helperBtn.classList.toggle('on', this.showHelpers);
      if (this.view) this.view.helperGroup.visible = this.showHelpers;
    });
    this.contactBtn = this._el('button', 'toggle on', 'contact points');
    this.contactBtn.addEventListener('click', () => {
      this.showContacts = !this.showContacts;
      this.contactBtn.classList.toggle('on', this.showContacts);
    });
    toggles.append(this.helperBtn, this.contactBtn);
    wrap.appendChild(toggles);

    const limRow = this._el('div', 'limit-row');
    limRow.appendChild(this._el('span', null, 'limits'));
    this.minInput = document.createElement('input');
    this.minInput.type = 'number';
    this.minInput.step = '1';
    this.maxInput = document.createElement('input');
    this.maxInput.type = 'number';
    this.maxInput.step = '1';
    const apply = () => {
      const h = this.assembly.get(this.activeTarget);
      if (!h || h.continuous) return;
      const minDeg = Number(this.minInput.value);
      const maxDeg = Number(this.maxInput.value);
      if (!Number.isFinite(minDeg) || !Number.isFinite(maxDeg) || this.minInput.value === '' || this.maxInput.value === '') return;
      this.assembly.setLimits(h.id, minDeg / D, maxDeg / D);
      // Refresh the command sliders without rewriting the fields being typed in.
      for (const [id, row] of this.jointRows) {
        const hh = this.assembly.get(id);
        row.slider.min = String(Math.round(hh.min * D * 10) / 10);
        row.slider.max = String(Math.round(hh.max * D * 10) / 10);
        row.slider.value = String(clamp(Math.round(hh.target * D * 10) / 10, Number(row.slider.min), Number(row.slider.max)));
        row.out.textContent = `${(hh.target * D).toFixed(1)}°`;
      }
    };
    this.minInput.addEventListener('change', apply);
    this.maxInput.addEventListener('change', apply);
    this.minInput.addEventListener('input', apply);
    this.maxInput.addEventListener('input', apply);
    limRow.append(this.minInput, this._el('span', 'dash', '→'), this.maxInput, this._el('span', 'unit', 'deg'));
    wrap.appendChild(limRow);
    return wrap;
  }

  _sectionResults() {
    const wrap = this._el('section', 'card results');
    wrap.appendChild(this._el('h2', null, 'Results'));
    this.resultTable = this._el('table', 'results-table');
    this.resultTable.innerHTML = `
      <thead><tr><th>joint</th><th>angle</th><th>axle err</th><th>limit err</th><th>state</th></tr></thead>
      <tbody></tbody>`;
    wrap.appendChild(this.resultTable);
    this.resultBody = this.resultTable.querySelector('tbody');

    const foot = this._el('div', 'foot');
    this.costEl = this._el('span', 'mono', '');
    this.blockedEl = this._el('span', 'mono blocked', '');
    foot.append(this.costEl, this.blockedEl);
    wrap.appendChild(foot);
    return wrap;
  }

  setActive(id) {
    this.activeTarget = id;
    for (const [hid, b] of this.targetButtons) b.classList.toggle('on', hid === id);
    this.refreshStatic();
  }

  refreshStatic() {
    const h = this.assembly.get(this.activeTarget);
    if (!h) return;
    const supportsLimits = !h.continuous;
    this.minInput.disabled = !supportsLimits;
    this.maxInput.disabled = !supportsLimits;
    if (supportsLimits) {
      this.minInput.value = (h.min * D).toFixed(1);
      this.maxInput.value = (h.max * D).toFixed(1);
    } else {
      this.minInput.value = 'continuous';
      this.maxInput.value = 'continuous';
    }
    for (const [id, row] of this.jointRows) {
      const hh = this.assembly.get(id);
      row.slider.min = String(Math.round(hh.min * D * 10) / 10);
      row.slider.max = String(Math.round(hh.max * D * 10) / 10);
      row.slider.value = String(clamp(Math.round(hh.target * D * 10) / 10, Number(row.slider.min), Number(row.slider.max)));
      row.out.textContent = `${(hh.target * D).toFixed(1)}°`;
    }
  }

  _bindKeys() {
    this._keyHandler = (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      const map = { Digit1: 'door', Digit2: 'shoulder', Digit3: 'elbow' };
      if (map[e.code]) this.setActive(map[e.code]);
      if (e.code === 'Space') {
        e.preventDefault();
        this.paused = !this.paused;
        this.pauseBtn.classList.toggle('on', this.paused);
        this.pauseBtn.textContent = this.paused ? 'resume' : 'pause';
      }
    };
    window.addEventListener('keydown', this._keyHandler);
  }

  get timeScale() {
    return this.slowMotion ? 0.25 : 1;
  }

  update(dt, fps, costMs) {
    this.fpsEl.textContent = `${fps.toFixed(0)} fps`;
    this.stepEl.textContent = `dt 1/${Math.round(1 / this.assembly.dt)} · ${this.assembly.solverIterations} it`;
    const simBudgetMs = dt * this.timeScale * 1000;
    this.costEl.textContent = `step cost ${costMs.toFixed(2)} ms · ${((costMs / simBudgetMs) * 100).toFixed(1)}% budget`;
    this.selectedEl.textContent = `${this.selected.size} joints selected`;

    const rows = [];
    let anyBlocked = null;
    for (const h of this.assembly.hinges) {
      const row = this.jointRows.get(h.id);
      const deg = h.angle * D;
      row.angle.textContent = `${deg.toFixed(1)}°`;
      row.angle.classList.toggle('at-limit', !h.continuous && Math.abs(h.limitErr) > 1e-3);
      // Commands can come from the gizmo drag as well as the slider, so mirror
      // the kernel's target back into the control unless the user is dragging it.
      if (document.activeElement !== row.slider) {
        const targetDeg = h.target * D;
        row.slider.value = String(Math.round(clamp(targetDeg, Number(row.slider.min), Number(row.slider.max)) * 10) / 10);
        row.out.textContent = `${targetDeg.toFixed(1)}°`;
      }
      const errMM = h.anchorErr * 1000;
      const limitDeg = h.limitErr * D;
      let state = 'free';
      let cls = 'free';
      if (h.blocked) {
        state = `blocked: ${h.blocked.by.join(', ')}`;
        cls = 'blocked';
        anyBlocked = anyBlocked ?? `${h.label} blocked by ${h.blocked.by.join(', ')}`;
      } else if (!h.continuous && Math.abs(limitDeg) > 0.5) {
        state = 'limit reached';
        cls = 'limited';
      } else if (h.contact.count > 0) {
        state = `contact: ${h.contact.others.join(', ')}`;
        cls = 'contact';
      } else if (Math.abs(h.axisSpeed) > 0.05) {
        state = 'moving';
        cls = 'moving';
      }
      row.feed.className = `feed ${cls}`;
      row.feed.textContent = state;

      if (!this.selected.has(h.id)) continue;
      const tr = document.createElement('tr');
      tr.className = cls;
      tr.innerHTML = `
        <td>${h.label}</td>
        <td class="num">${deg.toFixed(2)}°</td>
        <td class="num ${errMM > 1 ? 'bad' : ''}">${errMM.toFixed(2)} mm</td>
        <td class="num ${Math.abs(limitDeg) > 0.5 ? 'bad' : ''}">${limitDeg.toFixed(2)}°</td>
        <td class="state">${state}</td>`;
      rows.push(tr);
    }
    this.resultBody.replaceChildren(...rows);
    this.blockedEl.textContent = anyBlocked ?? 'all clear';

    if (this.dragInfo) {
      const h = this.assembly.get(this.activeTarget);
      if (h) {
        const v = (h.axisSpeed * D).toFixed(1);
        const contact = h.contact.others.length ? ` · touching ${h.contact.others.join(', ')}` : '';
        const hold = h.contactHold ? ' · motor holding' : '';
        this.dragInfo.textContent = `${h.label}: ${(h.angle * D).toFixed(1)}° at ${v}°/s${contact}${hold}`;
      }
    }
    this.badge.className = `status-badge ${anyBlocked ? 'warn' : ''}`;
    this.badge.textContent = anyBlocked ? 'CONTACT LIMITING MOTION' : 'CONSTRAINTS SATISFIED';
  }
}
