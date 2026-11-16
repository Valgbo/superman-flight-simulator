import { Vector3 } from 'three';
import { EARTH_SPEED_LIMIT, MACH_ONE, SPACE_ALTITUDE, SPAWN_POSITION, SUN_POSITION, SUN_RADIUS } from './config';

export interface FlightInput {
  forward: number;
  strafe: number;
  vertical: number;
  boost: boolean;
  brake: boolean;
  /** Turn right, in radians for this frame. */
  lookX: number;
  /** Pitch up, in radians for this frame. */
  lookY: number;
}

export interface FlightEvents {
  sonicBoom: boolean;
  enteredSpace: boolean;
  charged: boolean;
}

export type FlightMode = 'HOVER' | 'CRUISE' | 'TURBO' | 'HYPERSPEED' | 'SOLAR CHARGE';
const UP = new Vector3(0, 1, 0);
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const finite = (v: number) => Number.isFinite(v) ? v : 0;

/** Game-scale flight: local distances are metres, with compressed space travel. */
export class FlightSimulation {
  position = SPAWN_POSITION.clone();
  velocity = new Vector3();
  yaw = 0;
  pitch = 0;
  turbo = false;
  hyper = false;
  solarCharge = 0;
  private boosting = false;
  private inCorona = false;
  private forwardVector = new Vector3();
  private rightVector = new Vector3();
  private desiredVelocity = new Vector3();
  private radial = new Vector3();

  get speed(): number { return this.velocity.length(); }
  get inSpace(): boolean { return this.position.y >= SPACE_ALTITUDE; }
  get mode(): FlightMode {
    if (this.inCorona) return 'SOLAR CHARGE';
    if (this.hyper && this.inSpace) return 'HYPERSPEED';
    if (this.turbo || this.boosting) return 'TURBO';
    return this.speed > 8 ? 'CRUISE' : 'HOVER';
  }

  direction(out = new Vector3()): Vector3 {
    const cp = Math.cos(this.pitch);
    return out.set(Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp).normalize();
  }

  toggleTurbo(): void {
    this.turbo = !this.turbo;
    if (this.turbo) this.hyper = false;
  }

  toggleHyper(): boolean {
    if (!this.inSpace) {
      this.hyper = false;
      return false;
    }
    this.hyper = !this.hyper;
    if (this.hyper) this.turbo = false;
    return true;
  }

  aimAtSun(): void {
    this.radial.copy(SUN_POSITION).sub(this.position).normalize();
    this.yaw = Math.atan2(this.radial.x, -this.radial.z);
    this.pitch = Math.asin(clamp(this.radial.y, -1, 1));
  }

  reset(): void {
    this.position.copy(SPAWN_POSITION);
    this.velocity.set(0, 0, 0);
    this.yaw = 0;
    this.pitch = 0;
    this.turbo = false;
    this.hyper = false;
    this.solarCharge = 0;
    this.boosting = false;
    this.inCorona = false;
  }

  travelToEarth(): void {
    const retainedCharge = this.solarCharge;
    this.reset();
    this.solarCharge = retainedCharge;
  }

  update(delta: number, input: FlightInput): FlightEvents {
    const events: FlightEvents = { sonicBoom: false, enteredSpace: false, charged: false };
    if (!Number.isFinite(delta) || delta <= 0) return events;
    // Tab suspension cannot advance the hero through an entire city in one frame.
    const dt = Math.min(delta, 0.1);
    if (![this.position.x, this.position.y, this.position.z, this.velocity.x, this.velocity.y, this.velocity.z].every(Number.isFinite)) this.reset();
    this.yaw = finite(this.yaw) + finite(input.lookX);
    this.pitch = clamp(finite(this.pitch) + finite(input.lookY), -Math.PI * 0.49, Math.PI * 0.49);
    this.boosting = !!input.boost;
    const f = clamp(finite(input.forward), -1, 1);
    const s = clamp(finite(input.strafe), -1, 1);
    const v = clamp(finite(input.vertical), -1, 1);
    const wasSupersonic = this.speed >= MACH_ONE;
    const wasInSpace = this.inSpace;
    const wasCharged = this.solarCharge >= 1;
    const steps = Math.ceil(dt / (1 / 60));
    const step = dt / steps;

    for (let i = 0; i < steps; i++) {
      const space = this.inSpace;
      if (!space) this.hyper = false;
      const boosted = this.turbo || this.boosting;
      const hyper = this.hyper && space;
      this.direction(this.forwardVector);
      this.rightVector.crossVectors(this.forwardVector, UP).normalize();
      const forwardInput = input.brake ? 0 : ((hyper || boosted) ? Math.max(1, f) : f);
      this.desiredVelocity.copy(this.forwardVector).multiplyScalar(forwardInput);
      this.desiredVelocity.addScaledVector(this.rightVector, input.brake ? 0 : s);
      this.desiredVelocity.y += input.brake ? 0 : v;
      if (this.desiredVelocity.lengthSq() > 1) this.desiredVelocity.normalize();
      let maxSpeed = space ? (hyper ? 90000 : boosted ? 4200 : 1500) : boosted ? EARTH_SPEED_LIMIT : 145;
      const sunDistance = this.position.distanceTo(SUN_POSITION);
      if (hyper) {
        // Ease into the corona rather than jumping straight through the Sun.
        maxSpeed = Math.min(maxSpeed, Math.max(350, (sunDistance - SUN_RADIUS * 0.99) / 1.1));
      }
      this.desiredVelocity.multiplyScalar(maxSpeed);
      const response = input.brake ? 9 : hyper ? 1.6 : boosted ? 2.2 : 3.8;
      this.velocity.lerp(this.desiredVelocity, 1 - Math.exp(-response * step));
      if (!space && this.speed > EARTH_SPEED_LIMIT) this.velocity.setLength(EARTH_SPEED_LIMIT);
      this.position.addScaledVector(this.velocity, step);
      // Descending from hyperspeed must never carry space speed into the city.
      if (!this.inSpace) {
        this.hyper = false;
        if (this.speed > EARTH_SPEED_LIMIT) this.velocity.setLength(EARTH_SPEED_LIMIT);
      }
      if (this.position.y < 8) {
        this.position.y = 8;
        this.velocity.y = Math.max(0, this.velocity.y);
      }
      this.radial.copy(this.position).sub(SUN_POSITION);
      const radius = this.radial.length();
      if (radius < SUN_RADIUS * 0.985) {
        if (radius < 0.001) this.radial.set(0, 1, 0); else this.radial.divideScalar(radius);
        this.position.copy(SUN_POSITION).addScaledVector(this.radial, SUN_RADIUS * 0.985);
        const inward = this.velocity.dot(this.radial);
        if (inward < 0) this.velocity.addScaledVector(this.radial, -inward);
        this.hyper = false;
      }
      this.inCorona = this.position.distanceTo(SUN_POSITION) <= SUN_RADIUS * 1.25;
      if (this.inCorona) this.solarCharge = Math.min(1, this.solarCharge + step / 4);
    }
    events.sonicBoom = !wasSupersonic && this.speed >= MACH_ONE && !this.inSpace;
    events.enteredSpace = !wasInSpace && this.inSpace;
    events.charged = !wasCharged && this.solarCharge >= 1;
    return events;
  }
}
