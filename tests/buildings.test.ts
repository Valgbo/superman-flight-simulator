import test from 'node:test';
import assert from 'node:assert/strict';
import { Box3, Scene, Vector3 } from 'three';
import { World } from '../src/world';

test('detailed tower colliders cover their architecture and turbo/reset still work', () => {
  // Texture drawing is stubbed: this check exercises real geometry, hierarchy,
  // material batching and collisions without pretending to test browser rendering.
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const gradient = { addColorStop() {} };
  const context = new Proxy({}, {
    get: (_, key) => String(key).startsWith('create') ? () => gradient : () => {},
  });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    createElement: () => ({ width: 0, height: 0, getContext: () => context }),
  } });
  try {
    const world = new World(new Scene());
    assert.equal(world.buildings.length, 180);
    world.update(1 / 60, new Vector3(0, 145, 920), 0, false);
    for (const building of world.buildings) {
      assert.ok(building.bounds.containsBox(new Box3().setFromObject(building.group)),
        `Collider must contain roof, crown, and entrance at ${building.group.position.toArray()}`);
    }
    const center = world.buildings[0].bounds.getCenter(new Vector3());
    const result = world.sweep(center.clone().add(new Vector3(-400, 0, 0)), center.clone().add(new Vector3(400, 0, 0)), true);
    assert.ok(result.destroyed > 0);
    assert.ok(world.buildings.some(building => building.destroyed && !building.group.visible));
    world.reset();
    assert.ok(world.buildings.every(building => !building.destroyed && building.group.visible && !building.rubble.visible));
    world.setQuality(true);
    world.update(0.25, new Vector3(0, 145, 920), 0.5, false);
    assert.ok(world.buildings.every(building => building.group.visible), 'Performance mode retains every solid tower');
    world.dispose();
  } finally {
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
    else Reflect.deleteProperty(globalThis, 'document');
  }
});
