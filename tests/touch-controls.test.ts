import test from 'node:test';
import assert from 'node:assert/strict';
import { joystickAxes } from '../src/joystick-math';
import { TouchControls } from '../src/touch-controls';

class FakeElement extends EventTarget {
  readonly dataset: Record<string, string> = {};
  readonly css = new Map<string, string>();
  readonly style = { setProperty: (name: string, value: string) => this.css.set(name, value) };
  readonly classes = new Set<string>();
  readonly classList = {
    add: (...names: string[]) => names.forEach(name => this.classes.add(name)),
    remove: (...names: string[]) => names.forEach(name => this.classes.delete(name)),
  };
  readonly captures = new Set<number>();
  children: FakeElement[] = [];
  geometryReads = 0;
  rect = { left: 20, top: 100, width: 144, height: 144 };
  getBoundingClientRect() { this.geometryReads++; return this.rect; }
  closest() { return null; }
  querySelectorAll() { return this.children; }
  setPointerCapture(pointerId: number) { this.captures.add(pointerId); }
  hasPointerCapture(pointerId: number) { return this.captures.has(pointerId); }
  releasePointerCapture(pointerId: number) {
    if (this.captures.delete(pointerId)) this.dispatchEvent(pointer('lostpointercapture', pointerId));
  }
  asElement() { return this as unknown as HTMLElement; }
}

function pointer(type: string, pointerId: number, clientX = 92, clientY = 172, pointerType = 'touch') {
  return Object.assign(new Event(type, { cancelable: true }), { pointerId, clientX, clientY, pointerType });
}
function key(type: string, code: string) { return Object.assign(new Event(type, { cancelable: true }), { code, repeat: false }); }
function fixture() {
  const stick = new FakeElement(), thumb = new FakeElement(), surface = new FakeElement(), root = new FakeElement();
  const up = new FakeElement(), down = new FakeElement(), brake = new FakeElement();
  thumb.rect = { left: 64, top: 144, width: 56, height: 56 };
  up.dataset.touchAction = 'ascend'; down.dataset.touchAction = 'descend'; brake.dataset.touchAction = 'brake';
  root.children = [up, down, brake];
  const lifecycle = new EventTarget();
  const context = { interactive: true, activity: 0 };
  const control = new TouchControls({
    stick: stick.asElement(), thumb: thumb.asElement(), lookSurface: surface.asElement(), root: root.asElement(), lifecycleTarget: lifecycle,
    canInteract: () => context.interactive, onActivity: () => context.activity++,
  });
  return { control, stick, thumb, surface, up, down, brake, lifecycle, context };
}

test('joystick deadzone removes drift and remaps the remaining travel continuously', () => {
  const dead = joystickAxes(4, 0, 44);
  assert.equal(dead.x, 0); assert.equal(dead.y, 0);
  const half = joystickAxes(22, 0, 44);
  assert.ok(Math.abs(half.x - (0.5 - 0.12) / 0.88) < 1e-9);
  assert.equal(half.thumbX, 22);
  assert.ok(joystickAxes(6, 0, 44).x > 0);
});

test('joystick circular gate clamps diagonal speed and preserves forward/backward direction', () => {
  const diagonal = joystickAxes(200, -200, 44);
  assert.ok(Math.abs(Math.hypot(diagonal.x, diagonal.y) - 1) < 1e-9);
  assert.ok(diagonal.x > 0 && diagonal.y > 0);
  assert.ok(Math.abs(Math.hypot(diagonal.thumbX, diagonal.thumbY) - 44) < 1e-9);
  assert.equal(joystickAxes(0, 100, 44).y, -1);
  assert.equal(joystickAxes(0, -100, 44).y, 1);
});

test('invalid joystick dimensions never produce unusable movement values', () => {
  for (const [dx, dy, radius] of [[NaN, 1, 44], [1, Infinity, 44], [1, 1, 0], [1, 1, -10]]) {
    const axes = joystickAxes(dx, dy, radius);
    assert.deepEqual(axes, { x: 0, y: 0, magnitude: 0, thumbX: 0, thumbY: 0 });
  }
});

test('joystick and camera use separate pointers so movement and steering work together', () => {
  const f = fixture();
  f.stick.dispatchEvent(pointer('pointerdown', 1));
  f.stick.dispatchEvent(pointer('pointermove', 1, 200, 172));
  assert.equal(f.control.state.strafe, 1);
  f.surface.dispatchEvent(pointer('pointerdown', 2, 300, 250));
  f.surface.dispatchEvent(pointer('pointermove', 2, 320, 240));
  assert.equal(f.control.state.strafe, 1);
  const look = f.control.consumeLook();
  assert.ok(Math.abs(look.x - 0.044) < 1e-9);
  assert.ok(Math.abs(look.y - 0.022) < 1e-9);
  assert.deepEqual(f.control.consumeLook(), { x: 0, y: 0 });
  assert.equal(f.stick.captures.has(1), true);
  assert.equal(f.surface.captures.has(2), true);
  f.control.dispose();
});

test('unrelated fingers cannot steal, move, or release the active joystick or look owner', () => {
  const f = fixture();
  f.stick.dispatchEvent(pointer('pointerdown', 1, 92, 100));
  f.stick.dispatchEvent(pointer('pointerdown', 3, 0, 172));
  f.stick.dispatchEvent(pointer('pointermove', 3, 92, 300));
  f.stick.dispatchEvent(pointer('pointerup', 3));
  assert.equal(f.control.state.forward, 1);
  f.surface.dispatchEvent(pointer('pointerdown', 2, 300, 250));
  f.surface.dispatchEvent(pointer('pointerdown', 4, 5, 5));
  f.surface.dispatchEvent(pointer('pointermove', 4, 999, 999));
  f.surface.dispatchEvent(pointer('pointerup', 4));
  f.surface.dispatchEvent(pointer('pointermove', 2, 310, 250));
  assert.ok(Math.abs(f.control.consumeLook().x - 0.022) < 1e-9);
  f.stick.dispatchEvent(pointer('pointerup', 1));
  assert.equal(f.control.state.forward, 0);
  assert.equal(f.thumb.css.get('--stick-x'), '0.00px');
  assert.equal(f.thumb.css.get('--stick-y'), '0.00px');
  f.control.dispose();
});

test('joystick caches its gesture geometry instead of reading layout on every move', () => {
  const f = fixture();
  f.stick.dispatchEvent(pointer('pointerdown', 1));
  for (let x = 100; x < 200; x += 5) f.stick.dispatchEvent(pointer('pointermove', 1, x, 172));
  assert.equal(f.stick.geometryReads, 1);
  assert.equal(f.thumb.geometryReads, 1);
  f.lifecycle.dispatchEvent(new Event('resize'));
  assert.equal(f.control.state.strafe, 0);
  f.stick.dispatchEvent(pointer('pointerdown', 2));
  assert.equal(f.stick.geometryReads, 2);
  f.control.dispose();
});

test('altitude and hover buttons support simultaneous fingers and independent releases', () => {
  const f = fixture();
  f.up.dispatchEvent(pointer('pointerdown', 1));
  f.up.dispatchEvent(pointer('pointerdown', 2));
  f.up.dispatchEvent(pointer('pointerup', 1));
  assert.equal(f.control.state.vertical, 1);
  assert.ok(f.up.classes.has('is-active'));
  f.down.dispatchEvent(pointer('pointerdown', 3));
  assert.equal(f.control.state.vertical, 0);
  f.brake.dispatchEvent(pointer('pointerdown', 4));
  assert.equal(f.control.state.brake, true);
  f.down.dispatchEvent(pointer('pointercancel', 3));
  assert.equal(f.control.state.vertical, 1);
  f.up.dispatchEvent(pointer('pointerup', 2));
  assert.equal(f.control.state.vertical, 0);
  f.brake.dispatchEvent(pointer('pointerup', 4));
  assert.equal(f.control.state.brake, false);
  f.control.dispose();
});

test('pointer cancellation and lost capture spring controls back without clearing another finger', () => {
  const f = fixture();
  f.stick.dispatchEvent(pointer('pointerdown', 1, 92, 100));
  f.up.dispatchEvent(pointer('pointerdown', 2));
  f.stick.dispatchEvent(pointer('pointercancel', 1));
  assert.equal(f.control.state.forward, 0);
  assert.equal(f.control.state.vertical, 1);
  f.up.releasePointerCapture(2);
  assert.equal(f.control.state.vertical, 0);
  f.control.dispose();
});

test('blur, orientation changes, and inactive gameplay clear every captured input', () => {
  const f = fixture();
  for (const lifecycleEvent of ['blur', 'orientationchange', 'pagehide']) {
    f.stick.dispatchEvent(pointer('pointerdown', 1, 200, 100));
    f.up.dispatchEvent(pointer('pointerdown', 2));
    f.surface.dispatchEvent(pointer('pointerdown', 3, 300, 200));
    f.surface.dispatchEvent(pointer('pointermove', 3, 320, 180));
    f.lifecycle.dispatchEvent(new Event(lifecycleEvent));
    assert.deepEqual(f.control.state, { forward: 0, strafe: 0, vertical: 0, brake: false, lookX: 0, lookY: 0 });
    assert.equal(f.stick.captures.size + f.up.captures.size + f.surface.captures.size, 0);
  }
  f.context.interactive = false;
  f.stick.dispatchEvent(pointer('pointerdown', 1, 92, 100));
  assert.equal(f.control.state.forward, 0);
  f.context.interactive = true;
  f.stick.dispatchEvent(pointer('pointerdown', 1, 92, 100));
  f.context.interactive = false;
  f.stick.dispatchEvent(pointer('pointermove', 1, 92, 90));
  assert.equal(f.control.state.forward, 0);
  f.control.dispose();
});

test('touch camera ignores desktop mouse movement and neutral contact does not cancel navigation', () => {
  const f = fixture();
  f.surface.dispatchEvent(pointer('pointerdown', 1, 300, 250, 'mouse'));
  f.surface.dispatchEvent(pointer('pointermove', 1, 400, 350, 'mouse'));
  assert.deepEqual(f.control.consumeLook(), { x: 0, y: 0 });
  f.stick.dispatchEvent(pointer('pointerdown', 2));
  f.stick.dispatchEvent(pointer('pointermove', 2, 94, 172));
  assert.equal(f.context.activity, 0);
  f.stick.dispatchEvent(pointer('pointermove', 2, 120, 172));
  assert.equal(f.context.activity, 1);
  f.control.dispose();
});

test('altitude and hover buttons work with held Space or Enter and release on keyboard blur', () => {
  const f = fixture();
  f.up.dispatchEvent(key('keydown', 'Space'));
  assert.equal(f.control.state.vertical, 1);
  f.up.dispatchEvent(key('keyup', 'Space'));
  assert.equal(f.control.state.vertical, 0);
  f.brake.dispatchEvent(key('keydown', 'Enter'));
  assert.equal(f.control.state.brake, true);
  f.brake.dispatchEvent(new Event('blur'));
  assert.equal(f.control.state.brake, false);
  f.control.dispose();
});

test('disposing input releases captures and detaches handlers', () => {
  const f = fixture();
  f.stick.dispatchEvent(pointer('pointerdown', 1, 92, 100));
  f.control.dispose();
  f.control.dispose();
  f.stick.dispatchEvent(pointer('pointerdown', 2, 92, 100));
  f.up.dispatchEvent(pointer('pointerdown', 3));
  assert.equal(f.control.state.forward, 0);
  assert.equal(f.control.state.vertical, 0);
  assert.equal(f.stick.captures.size, 0);
});
