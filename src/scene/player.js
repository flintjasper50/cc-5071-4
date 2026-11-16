import { v3 } from '../core/math.js';

/**
 * The capsule player shared by every drill scene. Owns the body, its collider
 * registration and the keyboard-driven velocity state, so a scene builder only
 * picks the spawn point.
 */
export function createPlayerRig(RAPIER, world, items, labels, start) {
  // Capsule half-height 0.55 + radius 0.32 => centre sits 0.87 m above the floor.
  const player = world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(start.x, start.y, start.z)
      .lockRotations()
      .setLinearDamping(0.35)
      .setCcdEnabled(true)
      .setCanSleep(false)
  );
  const playerCollider = world.createCollider(RAPIER.ColliderDesc.capsule(0.55, 0.32).setMass(80).setFriction(0.3), player);
  labels.set(playerCollider.handle, 'player');
  items.push({ collider: playerCollider, shape: 'capsule', halfHeight: 0.55, radius: 0.32, color: 0x4c86cf, kind: 'player', label: 'player' });

  let playerYaw = 0;
  const playerState = { forward: 0, strafe: 0, sprint: false, enabled: true };

  function setPlayerVelocity() {
    if (!playerState.enabled) return;
    const speed = playerState.sprint ? 3.4 : 1.9;
    const cos = Math.cos(playerYaw);
    const sin = Math.sin(playerYaw);
    // yaw=0 faces +Z. forward moves along (sin, cos), strafe along (cos, -sin).
    const vx = (playerState.forward * sin + playerState.strafe * cos) * speed;
    const vz = (playerState.forward * cos - playerState.strafe * sin) * speed;
    const v = player.linvel();
    player.setLinvel({ x: vx, y: v.y, z: vz }, true);
  }

  function setPlayerYaw(yaw) {
    playerYaw = yaw;
  }

  function placePlayer(pos, yaw) {
    player.setTranslation(pos, true);
    player.setLinvel(v3(), true);
    player.setAngvel(v3(), true);
    playerYaw = yaw;
  }

  function resetPlayer() {
    placePlayer(start, 0);
    playerState.forward = 0;
    playerState.strafe = 0;
    playerState.enabled = true;
  }

  return { player, playerCollider, playerState, setPlayerVelocity, setPlayerYaw, placePlayer, resetPlayer };
}
