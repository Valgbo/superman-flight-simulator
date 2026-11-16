import test from 'node:test';
import assert from 'node:assert/strict';
import { FlightSimulation, type FlightInput } from '../src/flight';
import { EARTH_SPEED_LIMIT, SPACE_ALTITUDE, SUN_POSITION, SUN_RADIUS, SPAWN_POSITION } from '../src/config';

const idle: FlightInput = { forward: 0, strafe: 0, vertical: 0, boost: false, brake: false, lookX: 0, lookY: 0 };
function advance(flight: FlightSimulation, seconds: number, input: Partial<FlightInput> = {}) {
  const events = { sonicBoom: 0, enteredSpace: 0, charged: 0 };
  for (let i = 0; i < Math.ceil(seconds * 60); i++) {
    const frame = flight.update(1 / 60, { ...idle, ...input });
    for (const key of Object.keys(events) as (keyof typeof events)[]) events[key] += Number(frame[key]);
  }
  return events;
}

test('turbo reaches Mach 2 and diagonal input cannot exceed its atmospheric cap', () => {
  const sim = new FlightSimulation();
  const events = advance(sim, 10, { boost: true, strafe: 1, vertical: 1 });
  assert.ok(sim.speed > EARTH_SPEED_LIMIT - 1);
  assert.ok(sim.speed <= EARTH_SPEED_LIMIT + 1e-8);
  assert.equal(events.sonicBoom, 1);
  assert.ok(sim.position.x > 100);
  assert.ok(sim.position.y > SPAWN_POSITION.y);
});

test('space hyperspeed is locked on Earth and unlocks at orbit', () => {
  const sim = new FlightSimulation();
  assert.equal(sim.toggleHyper(), false);
  assert.equal(sim.hyper, false);
  sim.position.y = SPACE_ALTITUDE;
  assert.equal(sim.toggleHyper(), true);
  advance(sim, 7);
  assert.equal(sim.mode, 'HYPERSPEED');
  assert.ok(sim.speed > 89000);
});

test('turbo ascent crosses into space once in a practical play time', () => {
  const sim = new FlightSimulation();
  sim.pitch = Math.PI * 0.49;
  const events = advance(sim, 22, { boost: true, vertical: 1 });
  assert.equal(events.enteredSpace, 1);
  assert.equal(sim.inSpace, true);
});

test('reentry clears hyperspeed and caps atmospheric velocity', () => {
  const sim = new FlightSimulation();
  sim.position.set(0, SPACE_ALTITUDE + 100, 0);
  sim.velocity.set(0, -90000, 0);
  sim.hyper = true;
  sim.pitch = -Math.PI * 0.49;
  sim.update(1 / 60, idle);
  assert.equal(sim.inSpace, false);
  assert.equal(sim.hyper, false);
  assert.ok(sim.speed <= EARTH_SPEED_LIMIT + 1e-8);
});

test('hover and brake stop movement, with a floor beneath the hero', () => {
  const sim = new FlightSimulation();
  advance(sim, 3, { forward: 1 });
  assert.ok(sim.speed > 140);
  advance(sim, 3, { brake: true });
  assert.ok(sim.speed < 0.001);
  sim.position.y = 8;
  advance(sim, 3, { vertical: -1 });
  assert.equal(sim.position.y, 8);
  assert.equal(sim.velocity.y, 0);
});

test('held turbo ends on release while the toggle persists', () => {
  const sim = new FlightSimulation();
  advance(sim, 1, { boost: true });
  assert.equal(sim.mode, 'TURBO');
  advance(sim, 3);
  assert.equal(sim.mode, 'HOVER');
  sim.toggleTurbo();
  advance(sim, 1);
  assert.equal(sim.mode, 'TURBO');
  assert.equal(sim.turbo, true);
});

test('the Sun fills solar charge and prevents entry into its core', () => {
  const sim = new FlightSimulation();
  sim.position.copy(SUN_POSITION).addScalar(0).x += SUN_RADIUS * 1.1;
  const events = advance(sim, 4.1);
  assert.equal(sim.solarCharge, 1);
  assert.equal(events.charged, 1);
  assert.equal(sim.mode, 'SOLAR CHARGE');
  sim.position.copy(SUN_POSITION);
  sim.update(1 / 60, idle);
  assert.ok(sim.position.distanceTo(SUN_POSITION) >= SUN_RADIUS * 0.9849);
});

test('Sun navigation points to target and hyperspeed arrival eases into corona', () => {
  const sim = new FlightSimulation();
  sim.position.set(0, SPACE_ALTITUDE + 100, 0);
  sim.aimAtSun();
  const expected = SUN_POSITION.clone().sub(sim.position).normalize();
  assert.ok(sim.direction().dot(expected) > 0.99999);
  sim.toggleHyper();
  advance(sim, 35);
  assert.ok(sim.position.distanceTo(SUN_POSITION) < SUN_RADIUS * 1.25);
  assert.ok(sim.position.distanceTo(SUN_POSITION) > SUN_RADIUS * 0.98);
  assert.ok(sim.solarCharge > 0);
});

test('return preserves solar power, reset clears all flight state', () => {
  const sim = new FlightSimulation();
  sim.solarCharge = 0.7;
  sim.travelToEarth();
  assert.ok(sim.position.equals(SPAWN_POSITION));
  assert.equal(sim.solarCharge, 0.7);
  sim.turbo = true;
  sim.reset();
  assert.equal(sim.solarCharge, 0);
  assert.equal(sim.turbo, false);
  assert.equal(sim.hyper, false);
  assert.equal(sim.speed, 0);
});

test('invalid and suspended frame input does not corrupt simulation', () => {
  const sim = new FlightSimulation();
  sim.update(NaN, idle);
  sim.update(3000, { ...idle, forward: NaN, strafe: Infinity, lookX: NaN });
  assert.ok(Number.isFinite(sim.position.length()));
  assert.ok(Number.isFinite(sim.velocity.length()));
  assert.ok(sim.position.distanceTo(SPAWN_POSITION) < 100);
});

test('complete 30fps journey breaches a thin tower, reaches and charges at the Sun, then returns safely', async () => {
  const { segmentBoxFraction } = await import('../src/world-math');
  const { Vector3 } = await import('three');
  const sim = new FlightSimulation();
  const towerMin = new Vector3(-20, 100, -500.1);
  const towerMax = new Vector3(20, 200, -500);
  let towerDestroyed = false;
  let crossedEntireTowerInOneFrame = false;
  let sonicBooms = 0;
  const dt = 1 / 30;
  sim.toggleTurbo();
  for (let i = 0; i < 120; i++) {
    const previous = sim.position.clone();
    const events = sim.update(dt, idle);
    sonicBooms += Number(events.sonicBoom);
    if (!towerDestroyed && segmentBoxFraction(previous, sim.position, towerMin, towerMax, 2.5) !== null) {
      crossedEntireTowerInOneFrame = previous.z > towerMax.z && sim.position.z < towerMin.z;
      towerDestroyed = sim.turbo;
    }
  }
  assert.equal(towerDestroyed, true, 'turbo must breach the narrow tower');
  assert.equal(crossedEntireTowerInOneFrame, true, 'collision must catch a whole tower crossed between frames');
  assert.equal(sonicBooms, 1);
  assert.ok(sim.speed <= EARTH_SPEED_LIMIT + 1e-8);

  let spaceEntries = 0;
  for (let i = 0; i < 750 && !sim.inSpace; i++) {
    const events = sim.update(dt, {
      ...idle,
      forward: 1,
      lookY: (Math.PI * 0.48 - sim.pitch) * Math.min(1, dt * 2),
    });
    spaceEntries += Number(events.enteredSpace);
  }
  assert.equal(spaceEntries, 1);
  assert.equal(sim.inSpace, true, 'assisted ascent must unlock space');
  sim.turbo = false;
  sim.aimAtSun();
  assert.equal(sim.toggleHyper(), true);
  let arrived = false;
  let chargeEvents = 0;
  for (let i = 0; i < 1500 && sim.solarCharge < 1; i++) {
    let brake = false;
    if (!arrived) {
      sim.aimAtSun();
      sim.hyper = true;
      if (sim.position.distanceTo(SUN_POSITION) < SUN_RADIUS * 1.2) {
        arrived = true;
        sim.hyper = false;
        brake = true;
      }
    }
    chargeEvents += Number(sim.update(dt, { ...idle, brake }).charged);
  }
  assert.equal(arrived, true, 'hyperspeed must reach the solar corona');
  assert.equal(chargeEvents, 1);
  assert.equal(sim.solarCharge, 1);
  assert.ok(sim.position.distanceTo(SUN_POSITION) >= SUN_RADIUS * 0.985 - 0.001);

  sim.travelToEarth();
  assert.ok(sim.position.equals(SPAWN_POSITION));
  assert.equal(sim.solarCharge, 1, 'returning should retain solar power');
  assert.equal(sim.speed, 0);
  assert.equal(sim.turbo, false);
  assert.equal(sim.hyper, false);
  assert.equal(sim.toggleHyper(), false, 'hyperspeed must relock on return to Earth');
  advance(sim, 3, { boost: true, strafe: 1 });
  assert.ok(sim.speed <= EARTH_SPEED_LIMIT + 1e-8, 'Earth speed cap must still hold after space travel');
});
