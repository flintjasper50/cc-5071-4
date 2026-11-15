import * as THREE from 'three';
import { qInv, qMul, qRotate, v3, vAdd, vSub, vDot, vNorm, vScale } from '../core/math.js';

const D = 180 / Math.PI;

/**
 * Pointer interaction: grab a joint helper and drag it around its own hinge
 * axis, or grab any free body and pull it with a spring. Dragging a hinge
 * writes an angle target into the kernel; it does not teleport the body.
 */
export class Interaction {
  constructor({ renderer, camera, scene, view, ui }) {
    this.renderer = renderer;
    this.camera = camera;
    this.scene = scene;
    this.view = view;
    this.ui = ui;
    this.assembly = scene.assembly;

    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.drag = null;
    this.keys = new Set();

    this._bind();
  }

  _bind() {
    const el = this.renderer.domElement;
    el.addEventListener('pointerdown', (e) => this._onDown(e));
    el.addEventListener('pointermove', (e) => this._onMove(e));
    window.addEventListener('pointerup', () => this._onUp());
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    // Clicking the viewport must return keyboard focus from the panel inputs,
    // otherwise WASD silently stops driving the player after editing a field.
    el.addEventListener('pointerdown', () => el.focus({ preventScroll: true }));

    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      this.keys.add(e.code);
      if (e.code === 'KeyR') this.scene.resetPlayer();
      if (e.code === 'KeyF') this.ui.setActive('door');
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
  }

  _setPointer(e) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  }

  _pick() {
    this.raycaster.setFromCamera(this.pointer, this.camera);
    // Hinge gizmos are not pickable meshes, so test in screen space first.
    for (const h of this.assembly.hinges) {
      if (!this.ui.selected.has(h.id)) continue;
      const anchor = h.worldAnchorB();
      const screen = this.view.worldToScreen(anchor);
      if (!screen.visible) continue;
      const dx = screen.x - (this._lastClientX ?? -9999);
      const dy = screen.y - (this._lastClientY ?? -9999);
      if (Math.hypot(dx, dy) < 26) return { kind: 'hinge', hinge: h, anchor };
    }
    const meshes = this.view.meshes.map((m) => m.mesh);
    const hits = this.raycaster.intersectObjects(meshes, true);
    if (!hits.length) return null;
    let obj = hits[0].object;
    while (obj && !obj.userData.item) obj = obj.parent;
    if (!obj) return null;
    const item = obj.userData.item;
    return { kind: 'body', item, point: hits[0].point, collider: item.collider };
  }

  _onDown(e) {
    this._setPointer(e);
    this._lastClientX = e.clientX;
    this._lastClientY = e.clientY;
    const hit = this._pick();
    if (!hit) return;
    if (hit.kind === 'hinge') {
      this.drag = {
        kind: 'hinge',
        hinge: hit.hinge,
        startAngle: hit.hinge.angle,
        startX: e.clientX,
        startY: e.clientY,
      };
      this.ui.setActive(hit.hinge.id);
      this.renderer.domElement.setPointerCapture?.(e.pointerId);
      return;
    }
    const body = hit.collider.parent();
    if (!body || body.isFixed()) return;
    const bodyPos = body.translation();
    const local = qRotate(qInv(body.rotation()), vSub(hit.point, bodyPos));
    this.drag = {
      kind: 'body',
      body,
      local,
      planeY: hit.point.y,
      point: hit.point,
    };
    this.renderer.domElement.setPointerCapture?.(e.pointerId);
    this.renderer.domElement.style.cursor = 'grabbing';
  }

  _onMove(e) {
    this._lastClientX = e.clientX;
    this._lastClientY = e.clientY;
    if (!this.drag) {
      this._setPointer(e);
      const hit = this._pick();
      this.renderer.domElement.style.cursor = hit ? 'grab' : 'default';
      return;
    }
    if (this.drag.kind === 'hinge') {
      const h = this.drag.hinge;
      const dx = e.clientX - this.drag.startX;
      const dy = e.clientY - this.drag.startY;
      // Screen-space drag mapped to joint angle. The scale is deliberately
      // generous so a short drag covers a useful part of the range.
      const delta = (dx - dy) * 0.45 / D;
      const next = this.drag.startAngle + delta;
      const clamped = h.continuous ? next : Math.min(h.max, Math.max(h.min, next));
      this.assembly.setTarget(h.id, clamped);
      return;
    }
    // Free-body drag: project the pointer onto a horizontal plane at the grab height.
    this._setPointer(e);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -this.drag.planeY);
    const target = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(plane, target)) return;
    const grab = v3(target.x, target.y, target.z);
    this.drag.body.wakeUp();
    const bodyPos = this.drag.body.translation();
    const grabWorld = vAdd(bodyPos, qRotate(this.drag.body.rotation(), this.drag.local));
    const delta = vSub(grab, grabWorld);
    const v = this.drag.body.linvel();
    // A hand is a strong, damped spring, but it still cannot pass through walls.
    const impulse = vScale(vSub(vScale(delta, 55), vScale(v, 9)), this.drag.body.mass() * 0.02);
    this.drag.body.applyImpulseAtPoint(
      { x: impulse.x, y: impulse.y, z: impulse.z },
      grabWorld,
      true
    );
  }

  _onUp() {
    if (this.drag) {
      this.renderer.domElement.style.cursor = 'default';
      this.drag = null;
    }
  }

  /** Per-frame keyboard drive for the player body. */
  updatePlayer() {
    const st = this.scene.playerState;
    let forward = 0;
    let strafe = 0;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) forward += 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) forward -= 1;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) strafe -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) strafe += 1;
    st.forward = forward;
    st.strafe = strafe;
    st.sprint = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
    const p = this.scene.player.translation();
    // Camera-relative movement: W pushes away from the camera.
    const yaw = Math.atan2(p.x - this.camera.position.x, p.z - this.camera.position.z);
    if (forward || strafe) {
      this.scene.setPlayerYaw(yaw);
    }
    this.scene.setPlayerVelocity();
  }
}
