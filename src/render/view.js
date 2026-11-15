import * as THREE from 'three';

/**
 * Builds meshes whose transforms are copied from the Rapier colliders each
 * frame. Rendering never owns a transform: it mirrors the collision shape, so
 * a visible panel cannot end up somewhere its collider is not.
 */
export class SceneView {
  constructor(container, scene, RAPIER) {
    this.container = container;
    this.scene = scene;
    this.RAPIER = RAPIER;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor(0x10151c, 1);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.domElement.tabIndex = -1;
    this.renderer.domElement.style.outline = 'none';
    container.appendChild(this.renderer.domElement);

    this.threeScene = new THREE.Scene();
    this.threeScene.fog = new THREE.Fog(0x10151c, 16, 34);

    this.camera = new THREE.PerspectiveCamera(52, 1, 0.1, 120);
    this.camera.position.set(8.0, 5.6, -9.0);
    this.camera.lookAt(0.5, 1.05, -0.4);

    const hemi = new THREE.HemisphereLight(0xbfd4ef, 0x2a3138, 1.15);
    this.threeScene.add(hemi);
    const sun = new THREE.DirectionalLight(0xfff2dd, 2.4);
    sun.position.set(6, 10, 5);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 40;
    sun.shadow.camera.left = -12;
    sun.shadow.camera.right = 12;
    sun.shadow.camera.top = 12;
    sun.shadow.camera.bottom = -12;
    sun.shadow.bias = -0.0006;
    this.threeScene.add(sun);
    const rim = new THREE.DirectionalLight(0x7fa8dd, 0.55);
    rim.position.set(-7, 5, -6);
    this.threeScene.add(rim);

    this.group = new THREE.Group();
    this.threeScene.add(this.group);

    this.meshes = [];
    this.helperGroup = new THREE.Group();
    this.threeScene.add(this.helperGroup);
    this._hingeHelpers = new Map();
    this._contactMarkers = [];

    this._buildFromItems();
    this._buildHingeHelpers();
    this._buildGroundGrid();

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
  }

  _material(color, opts = {}) {
    return new THREE.MeshStandardMaterial({
      color,
      roughness: opts.roughness ?? 0.72,
      metalness: opts.metalness ?? 0.08,
      transparent: opts.transparent ?? false,
      opacity: opts.opacity ?? 1,
      flatShading: false,
    });
  }

  _buildFromItems() {
    for (const item of this.scene.items) {
      const material = this._material(item.color, {
        roughness: item.kind === 'handle' ? 0.35 : 0.78,
        metalness: item.kind === 'handle' ? 0.6 : 0.06,
        transparent: item.kind === 'player',
        opacity: item.kind === 'player' ? 0.95 : 1,
      });
      let geometry;
      let mesh;
      if (item.shape === 'cuboid') {
        geometry = new THREE.BoxGeometry(item.half.x * 2, item.half.y * 2, item.half.z * 2);
        mesh = new THREE.Mesh(geometry, material);
        if (item.edge != null) {
          const edges = new THREE.LineSegments(
            new THREE.EdgesGeometry(geometry),
            new THREE.LineBasicMaterial({ color: item.edge, transparent: true, opacity: 0.55 })
          );
          mesh.add(edges);
        }
      } else if (item.shape === 'capsule') {
        geometry = new THREE.CapsuleGeometry(item.radius, item.halfHeight * 2, 8, 16);
        mesh = new THREE.Mesh(geometry, material);
      } else {
        geometry = new THREE.SphereGeometry(0.2, 16, 12);
        mesh = new THREE.Mesh(geometry, material);
      }
      mesh.castShadow = item.kind !== 'ground';
      mesh.receiveShadow = true;
      mesh.userData.item = item;
      this.group.add(mesh);
      this.meshes.push({ mesh, item });
      item.mesh = mesh;
    }
  }

  _buildGroundGrid() {
    const grid = new THREE.GridHelper(28, 56, 0x2b3a4a, 0x1b242e);
    grid.position.y = 0.002;
    grid.material.transparent = true;
    grid.material.opacity = 0.65;
    this.threeScene.add(grid);
  }

  _buildHingeHelpers() {
    const ringGeo = new THREE.TorusGeometry(0.16, 0.012, 8, 40);
    const axisGeo = new THREE.CylinderGeometry(0.012, 0.012, 0.5, 8);
    axisGeo.rotateZ(Math.PI / 2); // cylinder along +X, matching the joint frame's X axis
    const colors = { door: 0x5ad1a5, shoulder: 0x7fb0ff, elbow: 0xffc861 };
    for (const h of this.scene.assembly.hinges) {
      const g = new THREE.Group();
      const mat = new THREE.MeshBasicMaterial({ color: colors[h.id] ?? 0xffffff });
      const ring = new THREE.Mesh(ringGeo, mat);
      const axis = new THREE.Mesh(axisGeo, mat);
      ring.renderOrder = 3;
      axis.renderOrder = 3;
      g.add(ring);
      g.add(axis);
      this.helperGroup.add(g);
      this._hingeHelpers.set(h.id, { group: g, ring, axis, hinge: h });
    }

    this._limitArcs = new Map();
    for (const h of this.scene.assembly.hinges) {
      if (h.continuous) continue;
      const arcGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(1, 0, 0)]);
      const arc = new THREE.Line(arcGeo, new THREE.LineBasicMaterial({ color: 0xff9c55, transparent: true, opacity: 0.9 }));
      arc.renderOrder = 2;
      this.helperGroup.add(arc);
      const pointerGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(1, 0, 0)]);
      const pointer = new THREE.Line(pointerGeo, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9 }));
      pointer.renderOrder = 4;
      this.helperGroup.add(pointer);
      this._limitArcs.set(h.id, { arc, pointer });
    }
  }

  /** Rebuilds a line's vertex buffer from a world-space point list. */
  _setLinePoints(line, points) {
    const positions = new Float32Array(points.length * 3);
    points.forEach((p, i) => {
      positions[i * 3 + 0] = p.x;
      positions[i * 3 + 1] = p.y;
      positions[i * 3 + 2] = p.z;
    });
    line.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    line.geometry.computeBoundingSphere();
  }

  /**
   * Limit arcs are drawn in the hinge's own swing plane. The zero reference is
   * the parent frame's Y axis (the joint frees its local X axis), so rotating
   * that reference about the world hinge axis by an angle yields the exact
   * direction the child points to at that joint angle.
   */
  _swingDirection(hinge, angle, radius) {
    // Parent frame orientation in world: qA = bodyA.rotation * frameA
    const qa = this._qmul(hinge.bodyA.rotation(), hinge.frameA);
    const zero = this._qrot(qa, { x: 0, y: 1, z: 0 });
    const axis = hinge.worldAxisA();
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const v = zero;
    const dot = axis.x * v.x + axis.y * v.y + axis.z * v.z;
    const cross = {
      x: axis.y * v.z - axis.z * v.y,
      y: axis.z * v.x - axis.x * v.z,
      z: axis.x * v.y - axis.y * v.x,
    };
    const dir = {
      x: v.x * c + cross.x * s + axis.x * dot * (1 - c),
      y: v.y * c + cross.y * s + axis.y * dot * (1 - c),
      z: v.z * c + cross.z * s + axis.z * dot * (1 - c),
    };
    const a = hinge.worldAnchorB();
    return {
      x: a.x + dir.x * radius,
      y: a.y + dir.y * radius,
      z: a.z + dir.z * radius,
    };
  }

  _qmul(a, b) {
    return {
      x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
      y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
      z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
      w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    };
  }

  _qrot(q, v) {
    const tx = 2 * (q.y * v.z - q.z * v.y);
    const ty = 2 * (q.z * v.x - q.x * v.z);
    const tz = 2 * (q.x * v.y - q.y * v.x);
    return {
      x: v.x + q.w * tx + (q.y * tz - q.z * ty),
      y: v.y + q.w * ty + (q.z * tx - q.x * tz),
      z: v.z + q.w * tz + (q.x * ty - q.y * tx),
    };
  }

  _syncHelpers() {
    for (const [, { group, hinge }] of this._hingeHelpers) {
      const anchor = hinge.worldAnchorB();
      const axis = hinge.worldAxisB();
      group.position.set(anchor.x, anchor.y, anchor.z);
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(1, 0, 0), new THREE.Vector3(axis.x, axis.y, axis.z));
      group.quaternion.copy(q);
    }
    for (const [id, { arc, pointer }] of this._limitArcs) {
      const hinge = this.scene.assembly.get(id);
      if (!hinge) continue;
      const segments = Math.max(8, Math.ceil(((hinge.max - hinge.min) / (Math.PI * 2)) * 96));
      const pts = [];
      for (let i = 0; i <= segments; i++) {
        const t = hinge.min + ((hinge.max - hinge.min) * i) / segments;
        pts.push(this._swingDirection(hinge, t, 0.3));
      }
      this._setLinePoints(arc, pts);
      this._setLinePoints(pointer, [
        hinge.worldAnchorB(),
        this._swingDirection(hinge, hinge.angle, 0.34),
      ]);
    }
  }

  /** Copies collider transforms into the meshes and refreshes joint helpers. */
  sync() {
    for (const { mesh, item } of this.meshes) {
      const c = item.collider;
      const t = c.translation();
      const q = c.rotation();
      mesh.position.set(t.x, t.y, t.z);
      mesh.quaternion.set(q.x, q.y, q.z, q.w);
      // The mesh was built around the collider's own centre/shape, so no offset
      // is applied here; any shape-local offset lives in the collider itself.
    }
    this._syncHelpers();
  }

  /** Draws contact markers for hinges currently touching the scene. */
  syncContacts(show) {
    for (const m of this._contactMarkers) {
      this.helperGroup.remove(m);
      m.geometry.dispose();
      m.material.dispose();
    }
    this._contactMarkers = [];
    if (!show) return;
    for (const h of this.scene.assembly.hinges) {
      for (const p of h.contact.points) {
        const g = new THREE.SphereGeometry(0.035, 8, 6);
        const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0xff5555 }));
        m.position.set(p.point.x, p.point.y, p.point.z);
        this.helperGroup.add(m);
        this._contactMarkers.push(m);
      }
    }
  }

  resize() {
    const rect = this.container.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width));
    const h = Math.max(1, Math.floor(rect.height));
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  render() {
    this.renderer.render(this.threeScene, this.camera);
  }

  worldToScreen(point) {
    const v = new THREE.Vector3(point.x, point.y, point.z).project(this.camera);
    const rect = this.renderer.domElement.getBoundingClientRect();
    return {
      x: rect.left + ((v.x + 1) / 2) * rect.width,
      y: rect.top + ((1 - v.y) / 2) * rect.height,
      visible: v.z < 1,
    };
  }

  setCameraPreset(name) {
    if (name === 'door') {
      this.camera.position.set(-0.4, 2.6, 4.4);
      this.camera.lookAt(-0.35, 1.25, 0);
    } else if (name === 'arm') {
      this.camera.position.set(5.9, 3.1, -4.3);
      this.camera.lookAt(3.3, 1.3, -1.65);
    } else if (name === 'player') {
      this.camera.position.set(0.9, 2.2, -4.0);
      this.camera.lookAt(-1.3, 1.0, -1.1);
    } else {
      this.camera.position.set(7.0, 5.0, -7.8);
      this.camera.lookAt(0.6, 1.1, -0.5);
    }
  }
}
