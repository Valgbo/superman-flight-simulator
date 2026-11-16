import './style.css';
import { ACESFilmicToneMapping, Clock, Euler, MathUtils, PerspectiveCamera, Scene, Vector3, WebGLRenderer } from 'three';
import { FlightSimulation, type FlightInput } from './flight';
import { Hero } from './hero';
import { World } from './world';
import { FlightAudio } from './audio';
import { EARTH_SPEED_LIMIT, MACH_ONE, SPACE_ALTITUDE, SUN_POSITION, SUN_RADIUS } from './config';

const element = <T extends HTMLElement = HTMLElement>(id: string) => {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing application element: ${id}`);
  return found as T;
};

interface Settings { sensitivity: number; lowQuality: boolean; reducedMotion: boolean }
function loadSettings(): Settings {
  const defaults = { sensitivity: 1, lowQuality: false, reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches };
  try {
    const saved = JSON.parse(localStorage.getItem('metropolis-flight-settings') || '{}');
    return { sensitivity: MathUtils.clamp(Number(saved.sensitivity) || 1, 0.3, 2), lowQuality: saved.lowQuality === true, reducedMotion: typeof saved.reducedMotion === 'boolean' ? saved.reducedMotion : defaults.reducedMotion };
  } catch { return defaults; }
}

function init() {
  const canvas = element<HTMLCanvasElement>('world');
  const renderer = new WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true, powerPreference: 'high-performance' });
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.08;
  const scene = new Scene();
  const camera = new PerspectiveCamera(62, innerWidth / innerHeight, 0.5, 6000000);
  const world = new World(scene);
  const hero = new Hero(scene);
  hero.group.scale.setScalar(1.65);
  const flight = new FlightSimulation();
  const audio = new FlightAudio();
  const settings = loadSettings();
  const dialog = element<HTMLDialogElement>('settings-dialog');
  const keys = new Set<string>();
  const touchKeys = new Set<string>();
  const coarsePointer = matchMedia('(pointer: coarse)').matches;
  const input: FlightInput = { forward: 0, strafe: 0, vertical: 0, boost: false, brake: false, lookX: 0, lookY: 0 };
  const direction = new Vector3(), right = new Vector3(), localUp = new Vector3();
  const previous = new Vector3(), movement = new Vector3(), cameraGoal = new Vector3(), cameraTarget = new Vector3(), projection = new Vector3();
  const orientation = new Euler(0, 0, 0, 'YXZ');
  const up = new Vector3(0, 1, 0);
  const clock = new Clock();
  let started = false, paused = false, dragging = false, locked = false, returningLock = false;
  let lastPointerX = 0, lastPointerY = 0, pendingLookX = 0, pendingLookY = 0;
  let time = 0, lastHud = 0, lastCollisionToast = -10, destroyed = 0, shake = 0;
  let route: 'free' | 'orbit' | 'sun' = 'free';
  let sunAfterOrbit = false;
  let toastTimer: ReturnType<typeof setTimeout>;

  const hud = {
    speed: element('speed'), unit: element('speed-unit'), mode: element('flight-mode'), altitude: element('altitude'), mach: element('mach'),
    fill: element('speed-fill'), world: element('world-label'), location: element('location-name'), heading: element('heading'),
    turbo: element<HTMLButtonElement>('turbo-button'), hyper: element<HTMLButtonElement>('hyper-button'), hyperCaption: element('hyper-caption'),
    speedLines: element('speed-lines'), waypoint: element('waypoint'), waypointName: element('waypoint-name'), waypointDistance: element('waypoint-distance'),
  };

  function notify(message: string, duration = 3800) {
    clearTimeout(toastTimer);
    const toast = element('toast'); toast.textContent = message; toast.classList.add('visible');
    toastTimer = setTimeout(() => toast.classList.remove('visible'), duration);
  }
  function saveSettings() {
    try { localStorage.setItem('metropolis-flight-settings', JSON.stringify(settings)); } catch { /* Storage is optional. */ }
  }
  function resize() {
    camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
    renderer.setPixelRatio(Math.min(devicePixelRatio, settings.lowQuality ? 1 : 1.7));
    renderer.setSize(innerWidth, innerHeight);
    world.setQuality(settings.lowQuality);
  }
  resize(); window.addEventListener('resize', resize);
  camera.position.copy(flight.position).add(new Vector3(19, 8, 29));

  function beginFlight(captureMouse = false) {
    if (!started) {
      started = true;
      element('app').classList.add('started');
      element('intro').classList.add('exiting');
      setTimeout(() => { element('intro').hidden = true; }, 550);
      element('reticle').hidden = false;
      element('pause-button').hidden = false;
      element('touch-controls').hidden = !coarsePointer;
      element('control-hint').textContent = 'WASD TO FLY · SPACE TO RISE · DRAG TO STEER · ESC TO PAUSE';
      notify(coarsePointer ? 'Drag the sky to steer. Use the flight buttons to move.' : 'W to fly · Space to rise · Hold Shift for Mach 2', 5000);
    }
    paused = false;
    canvas.focus({ preventScroll: true });
    if (captureMouse && !coarsePointer && canvas.requestPointerLock) {
      try {
        const lockRequest = canvas.requestPointerLock() as Promise<void> | undefined;
        lockRequest?.catch(() => notify('Mouse capture unavailable. Drag the sky or use arrow keys to steer.'));
      } catch { notify('Drag the sky or use arrow keys to steer.'); }
    }
  }

  function clearInput() { keys.clear(); touchKeys.clear(); pendingLookX = 0; pendingLookY = 0; dragging = false; }
  function openSettings() {
    if (dialog.open) return;
    paused = true; clearInput();
    returningLock = document.pointerLockElement === canvas;
    if (returningLock) document.exitPointerLock();
    element('dialog-title').textContent = started ? 'Take a breath.' : 'Make yourself at home.';
    dialog.showModal();
  }
  function closeSettings() {
    if (dialog.open) dialog.close();
    paused = false;
    if (started) beginFlight(returningLock);
    returningLock = false;
  }
  element('start-button').addEventListener('click', () => beginFlight(true));
  element('help-button').addEventListener('click', openSettings);
  element('pause-button').addEventListener('click', openSettings);
  element('close-settings').addEventListener('click', closeSettings);
  element('resume-button').addEventListener('click', closeSettings);
  dialog.addEventListener('cancel', event => { event.preventDefault(); closeSettings(); });
  dialog.addEventListener('click', event => { if (event.target === dialog) { const r = dialog.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) closeSettings(); } });
  document.querySelector('.brand')?.addEventListener('click', event => { event.preventDefault(); openSettings(); });

  function toggleTurbo() {
    beginFlight(); route = 'free'; sunAfterOrbit = false;
    flight.toggleTurbo();
    notify(flight.turbo ? 'Turbo engaged. Skyscrapers will break on impact.' : 'Turbo disengaged.');
  }
  function toggleHyper() {
    beginFlight(); route = 'free'; sunAfterOrbit = false;
    if (!flight.toggleHyper()) notify('Fly above the atmosphere to unlock hyperspeed.');
    else notify(flight.hyper ? 'Hyperspeed engaged. The Sun is within reach.' : 'Hyperspeed disengaged.');
  }
  hud.turbo.addEventListener('click', toggleTurbo);
  hud.hyper.addEventListener('click', toggleHyper);
  element('reset-button').addEventListener('click', () => { world.reset(); destroyed = 0; notify('Metropolis restored. Every skyline is yours again.'); });
  element('city-route').addEventListener('click', () => {
    beginFlight(); flight.travelToEarth(); route = 'free'; sunAfterOrbit = false; clearInput();
    camera.position.copy(flight.position).add(new Vector3(4, 6, 20));
    notify('Welcome back to Metropolis.');
  });
  function selectOrbit(toSun = false) {
    if (flight.inSpace && !toSun) {
      beginFlight(); clearInput(); route = 'free'; sunAfterOrbit = false;
      flight.position.set(0, SPACE_ALTITUDE + 900, 4500);
      flight.velocity.set(0, 0, 0); flight.turbo = false; flight.hyper = false;
      flight.yaw = 0; flight.pitch = -0.6;
      camera.position.copy(flight.position).add(new Vector3(4, 8, 25));
      notify('Back in Earth orbit. Metropolis is one flight away.');
      return;
    }
    beginFlight(); route = 'orbit'; sunAfterOrbit = toSun;
    flight.turbo = true; flight.hyper = false;
    notify(toSun ? 'Course set for the Sun. Climbing through the atmosphere.' : 'Assisted ascent engaged. Steer at any time to take control.', 4500);
  }
  element('orbit-route').addEventListener('click', () => selectOrbit());
  element('sun-route').addEventListener('click', () => {
    if (!flight.inSpace) selectOrbit(true);
    else { beginFlight(); route = 'sun'; flight.aimAtSun(); flight.turbo = false; flight.hyper = true; notify('Solar course set. Hyperspeed engaged.'); }
  });

  element('sound-button').addEventListener('click', async () => {
    try {
      const enabled = await audio.toggle();
      element('sound-button').innerHTML = `${enabled ? 'SOUND ON' : 'SOUND OFF'} <span aria-hidden="true">◖</span>`;
      element('sound-button').setAttribute('aria-pressed', String(enabled));
    } catch { notify('Audio is unavailable in this browser.'); }
  });
  const sensitivity = element<HTMLInputElement>('sensitivity'); sensitivity.value = String(settings.sensitivity);
  sensitivity.addEventListener('input', () => { settings.sensitivity = Number(sensitivity.value); saveSettings(); });
  const quality = element<HTMLSelectElement>('quality'); quality.value = settings.lowQuality ? 'low' : 'high';
  quality.addEventListener('change', () => { settings.lowQuality = quality.value === 'low'; resize(); saveSettings(); });
  const reduce = element<HTMLInputElement>('reduced-motion'); reduce.checked = settings.reducedMotion;
  reduce.addEventListener('change', () => { settings.reducedMotion = reduce.checked; saveSettings(); });

  const movementKeys = new Set(['KeyW','KeyS','KeyA','KeyD','Space','ControlLeft','ControlRight','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','ShiftLeft','ShiftRight']);
  window.addEventListener('keydown', event => {
    if (event.code === 'Escape') { if (started && !dialog.open) { event.preventDefault(); openSettings(); } return; }
    if (!started || dialog.open || (event.target instanceof HTMLElement && event.target.closest('button,a,input,select,textarea,[contenteditable]'))) return;
    if (movementKeys.has(event.code) || event.code === 'KeyH') event.preventDefault();
    if (event.code === 'KeyH' && !event.repeat) toggleHyper();
    keys.add(event.code);
    if (movementKeys.has(event.code) && !event.code.startsWith('Shift')) { route = 'free'; sunAfterOrbit = false; }
  });
  window.addEventListener('keyup', event => keys.delete(event.code));
  window.addEventListener('blur', () => { clearInput(); if (started && !dialog.open) openSettings(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden && started && !dialog.open) openSettings(); });
  document.addEventListener('pointerlockchange', () => {
    const wasLocked = locked; locked = document.pointerLockElement === canvas;
    if (wasLocked && !locked && started && !dialog.open) openSettings();
  });
  document.addEventListener('pointerlockerror', () => notify('Drag the sky or use arrow keys to steer.'));
  canvas.addEventListener('pointerdown', event => {
    if (!started || paused) return;
    dragging = true; lastPointerX = event.clientX; lastPointerY = event.clientY;
    canvas.setPointerCapture(event.pointerId); canvas.focus({ preventScroll: true });
  });
  function steer(dx: number, dy: number) {
    pendingLookX += dx * 0.0022 * settings.sensitivity;
    pendingLookY -= dy * 0.0022 * settings.sensitivity;
    if (Math.abs(dx) + Math.abs(dy) > 1) { route = 'free'; sunAfterOrbit = false; }
  }
  document.addEventListener('pointermove', event => {
    if (!started || paused) return;
    if (locked) steer(event.movementX, event.movementY);
    else if (dragging) { steer(event.clientX - lastPointerX, event.clientY - lastPointerY); lastPointerX = event.clientX; lastPointerY = event.clientY; }
  });
  canvas.addEventListener('pointerup', () => { dragging = false; });
  canvas.addEventListener('pointercancel', () => { dragging = false; });
  canvas.addEventListener('lostpointercapture', () => { dragging = false; });
  document.querySelectorAll<HTMLButtonElement>('[data-key]').forEach(button => {
    const code = button.dataset.key!;
    button.addEventListener('pointerdown', event => {
      event.preventDefault(); button.setPointerCapture(event.pointerId); touchKeys.add(code); route = 'free'; sunAfterOrbit = false;
    });
    for (const event of ['pointerup','pointercancel','lostpointercapture']) button.addEventListener(event, () => touchKeys.delete(code));
  });

  function pressed(...codes: string[]) { return codes.some(code => keys.has(code) || touchKeys.has(code)); }
  function flash() {
    if (settings.reducedMotion) return;
    const overlay = element('flash'); overlay.classList.add('active');
    setTimeout(() => overlay.classList.remove('active'), 60);
  }
  function updateFlight(dt: number) {
    input.forward = Number(pressed('KeyW'));
    input.strafe = Number(pressed('KeyD')) - Number(pressed('KeyA'));
    input.vertical = Number(pressed('Space')) - Number(pressed('ControlLeft','ControlRight'));
    input.boost = pressed('ShiftLeft','ShiftRight'); input.brake = pressed('KeyS');
    input.lookX = pendingLookX + (Number(pressed('ArrowRight')) - Number(pressed('ArrowLeft'))) * dt * settings.sensitivity;
    input.lookY = pendingLookY + (Number(pressed('ArrowUp')) - Number(pressed('ArrowDown'))) * dt * settings.sensitivity;
    pendingLookX = 0; pendingLookY = 0;
    if (route === 'orbit') {
      input.lookY += (Math.PI * 0.48 - flight.pitch) * Math.min(1, dt * 2);
      input.forward = 1;
      if (flight.inSpace) {
        flight.turbo = false;
        if (sunAfterOrbit) { route = 'sun'; flight.aimAtSun(); flight.hyper = true; }
        else { route = 'free'; flight.velocity.multiplyScalar(0.05); flight.pitch = 0.05; }
      }
    }
    if (route === 'sun') {
      flight.aimAtSun(); flight.hyper = true; flight.turbo = false;
      if (flight.position.distanceTo(SUN_POSITION) < SUN_RADIUS * 1.2) {
        flight.hyper = false; input.brake = true; route = 'free';
        notify('You reached the Sun. Stay in the corona to absorb solar energy.', 5500); flash();
      }
    }
    previous.copy(flight.position);
    const events = flight.update(dt, input);
    const collision = world.sweep(previous, flight.position, flight.turbo || input.boost);
    if (collision.hit && collision.destroyed === 0 && collision.point) {
      movement.copy(flight.position).sub(previous).normalize();
      flight.position.copy(collision.point).addScaledVector(movement, -3);
      flight.position.y = Math.max(8, flight.position.y);
      flight.velocity.set(0, 0, 0);
      if (time - lastCollisionToast > 3) { notify('Hold Shift or engage Turbo to break through buildings.'); lastCollisionToast = time; }
    }
    if (collision.destroyed > 0) {
      destroyed += collision.destroyed; shake = settings.reducedMotion ? 0 : 0.22; audio.boom(true);
      if (time - lastCollisionToast > 0.7) { notify(`${destroyed} ${destroyed === 1 ? 'skyscraper' : 'skyscrapers'} breached. Nothing can stop you.`, 2400); lastCollisionToast = time; }
    }
    if (events.sonicBoom) { audio.boom(); shake = settings.reducedMotion ? 0 : 0.3; notify('Sonic boom. You broke the sound barrier.', 2600); }
    if (events.enteredSpace) { notify('Welcome to space. Hyperspeed is now available.', 4500); flash(); }
    if (events.charged) { notify('Solar charge complete. Return to Metropolis whenever you’re ready.', 6500); flash(); }
    // Follow translation directly; smoothing only the camera offset keeps the hero
    // visible even when hyperspeed covers thousands of metres in one frame.
    camera.position.add(movement.copy(flight.position).sub(previous));
  }

  function updateHud() {
    const speed = flight.speed;
    const isHyper = flight.hyper && flight.inSpace;
    hud.speed.textContent = isHyper ? (speed / 1000).toFixed(1) : Math.round(speed * 3.6).toLocaleString();
    hud.unit.textContent = isHyper ? 'KM/S' : 'KM/H';
    hud.mode.textContent = route === 'orbit' ? 'ASCENDING' : flight.mode;
    hud.altitude.textContent = flight.position.y > 1000 ? `${(flight.position.y / 1000).toFixed(1)} KM` : `${Math.round(flight.position.y)} M`;
    hud.mach.textContent = flight.inSpace ? `${Math.round(flight.solarCharge * 100)}% SOLAR` : `M ${(speed / MACH_ONE).toFixed(2)}`;
    hud.fill.style.width = `${Math.min(100, speed / (flight.inSpace ? 90000 : EARTH_SPEED_LIMIT) * 100)}%`;
    hud.world.textContent = flight.inSpace ? 'BEYOND EARTH' : 'METROPOLIS, EARTH';
    hud.location.textContent = flight.mode === 'SOLAR CHARGE' ? 'In the solar corona' : flight.inSpace ? 'Beyond the atmosphere' : flight.position.y > 2200 ? 'At the edge of the sky' : 'Above Metropolis';
    const heading = ((MathUtils.radToDeg(flight.yaw) % 360) + 360) % 360;
    hud.heading.textContent = `${['N','NE','E','SE','S','SW','W','NW'][Math.round(heading / 45) % 8]}  ·  ${String(Math.round(heading)).padStart(3,'0')}°`;
    hud.turbo.setAttribute('aria-pressed', String(flight.turbo || input.boost));
    hud.hyper.disabled = !flight.inSpace;
    hud.hyper.setAttribute('aria-pressed', String(isHyper));
    hud.hyperCaption.textContent = flight.inSpace ? 'THE UNIVERSE AWAITS' : 'UNLOCKS IN SPACE';
    hud.speedLines.style.opacity = settings.reducedMotion || !started ? '0' : isHyper ? '0.9' : String(Math.min(0.55, speed / 1300));
    document.querySelectorAll('.destination').forEach(e => e.classList.remove('selected'));
    element(route === 'sun' || flight.mode === 'SOLAR CHARGE' ? 'sun-route' : flight.inSpace || route === 'orbit' ? 'orbit-route' : 'city-route').classList.add('selected');
    hud.waypoint.hidden = !started;
    if (started) {
      const target = flight.solarCharge >= 1 ? new Vector3(0, 145, 920) : SUN_POSITION;
      projection.copy(target).project(camera);
      const ahead = direction.dot(movement.copy(target).sub(camera.position)) > 0;
      hud.waypoint.style.left = `${ahead ? MathUtils.clamp((projection.x * 0.5 + 0.5) * 100, 12, 88) : 50}%`;
      hud.waypoint.style.top = `${ahead ? MathUtils.clamp((-projection.y * 0.5 + 0.5) * 100, 19, 64) : 19}%`;
      hud.waypointName.textContent = flight.solarCharge >= 1 ? 'METROPOLIS · RETURN HOME' : 'THE SUN';
      hud.waypointDistance.textContent = `${(flight.position.distanceTo(target) / 1000).toLocaleString(undefined,{maximumFractionDigits:0})} KM · ${ahead ? 'GAME SCALE' : 'BEHIND YOU'}`;
    }
  }

  canvas.addEventListener('webglcontextlost', event => {
    event.preventDefault(); paused = true; clearInput();
    element('error-detail').textContent = 'The graphics connection was lost. Reload to restart the simulator, or try Performance graphics in settings after reloading.';
    element('fatal-error').hidden = false;
  });
  function animate() {
    const dt = Math.min(clock.getDelta(), 0.05);
    if (!paused) time += dt;
    if (started && !paused) updateFlight(dt);
    flight.direction(direction); right.crossVectors(direction, up).normalize(); localUp.crossVectors(right, direction).normalize();
    hero.group.position.copy(flight.position);
    if (!started && !settings.reducedMotion) hero.group.position.y += Math.sin(time * 1.4) * 0.5;
    orientation.set(flight.pitch, -flight.yaw, started ? -input.strafe * 0.15 : 0, 'YXZ');
    hero.group.quaternion.setFromEuler(orientation);
    hero.update(time, flight.speed, flight.turbo || input.boost || flight.hyper, settings.reducedMotion);
    const chaseDistance = flight.hyper ? 27 : 18 + Math.min(10, flight.speed / 100);
    cameraGoal.copy(flight.position).addScaledVector(direction, -chaseDistance).addScaledVector(localUp, 5.4);
    cameraTarget.copy(flight.position).addScaledVector(direction, 24).addScaledVector(localUp, 1.8);
    if (!started) { cameraGoal.addScaledVector(right, 17); cameraTarget.addScaledVector(right, -11); }
    camera.position.lerp(cameraGoal, 1 - Math.exp(-dt * (settings.reducedMotion ? 10 : 5)));
    camera.position.y = Math.max(3, camera.position.y);
    camera.lookAt(cameraTarget);
    if (shake > 0 && !paused) { camera.position.x += (Math.random() - 0.5) * shake; camera.position.y += (Math.random() - 0.5) * shake; shake *= Math.exp(-dt * 5); }
    const goalFov = settings.reducedMotion ? 62 : flight.hyper ? 88 : 62 + Math.min(13, flight.speed / 53);
    camera.fov = MathUtils.lerp(camera.fov, goalFov, 1 - Math.exp(-dt * 2)); camera.updateProjectionMatrix();
    world.update(paused ? 0 : dt, flight.position, time, settings.reducedMotion);
    audio.update(flight.speed, flight.inSpace, flight.hyper, paused || !started);
    if (time - lastHud > 0.075 || paused) { updateHud(); lastHud = time; }
    renderer.render(scene, camera);
  }
  renderer.setAnimationLoop(animate);
  updateHud();
}

try { init(); }
catch (error) {
  console.error('Flight systems could not initialize.', error);
  element('fatal-error').hidden = false;
}
