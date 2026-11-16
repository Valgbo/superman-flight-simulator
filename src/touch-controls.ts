import { joystickAxes } from './joystick-math';

export interface TouchState {
  forward: number;
  strafe: number;
  vertical: number;
  brake: boolean;
  /** Pending turn right / pitch up, in radians. Prefer consumeLook() once per frame. */
  lookX: number;
  lookY: number;
}

interface TouchOptions {
  stick: HTMLElement;
  thumb: HTMLElement;
  lookSurface: HTMLElement;
  canInteract: () => boolean;
  onActivity: () => void;
  root?: HTMLElement;
  /** Allows deterministic lifecycle testing without a browser window. */
  lifecycleTarget?: EventTarget;
}

type TouchAction = 'ascend' | 'descend' | 'brake';
interface HeldAction { action: TouchAction; element: HTMLElement }

/** Independent pointer owners let the left thumb move while the right thumb steers. */
export class TouchControls {
  private readonly values: TouchState = { forward: 0, strafe: 0, vertical: 0, brake: false, lookX: 0, lookY: 0 };
  private stickPointer: number | null = null;
  private stickGeometry: { centerX: number; centerY: number; radius: number } | null = null;
  private lookPointer: number | null = null;
  private lookX = 0;
  private lookY = 0;
  private readonly heldActions = new Map<number, HeldAction>();
  private readonly keyboardActions = new Map<HTMLElement, TouchAction>();
  private readonly removers: (() => void)[] = [];
  private readonly actionElements: HTMLElement[];
  private disposed = false;

  constructor(private readonly options: TouchOptions) {
    const { stick, lookSurface } = options;
    const root = options.root ?? stick.closest<HTMLElement>('#touch-controls');
    this.actionElements = root ? Array.from(root.querySelectorAll<HTMLElement>('[data-touch-action]')) : [];

    this.pointer(stick, 'pointerdown', event => this.startStick(event));
    this.pointer(stick, 'pointermove', event => this.moveStick(event));
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      this.pointer(stick, type, event => this.endStick(event));
    }
    this.pointer(lookSurface, 'pointerdown', event => this.startLook(event));
    this.pointer(lookSurface, 'pointermove', event => this.moveLook(event));
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      this.pointer(lookSurface, type, event => this.endLook(event));
    }
    for (const element of this.actionElements) {
      this.pointer(element, 'pointerdown', event => this.startAction(event, element));
      for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
        this.pointer(element, type, event => this.endAction(event));
      }
      this.listen(element, 'keydown', event => {
        const key = event as KeyboardEvent;
        const action = element.dataset.touchAction;
        if (!this.interact() || (key.code !== 'Space' && key.code !== 'Enter')) return;
        if (action !== 'ascend' && action !== 'descend' && action !== 'brake') return;
        key.preventDefault();
        this.keyboardActions.set(element, action);
        element.classList.add('is-active');
        this.updateActions();
        if (!key.repeat) this.options.onActivity();
      });
      this.listen(element, 'keyup', event => {
        const key = event as KeyboardEvent;
        if (key.code !== 'Space' && key.code !== 'Enter') return;
        key.preventDefault();
        this.endKeyboardAction(element);
      });
      this.listen(element, 'blur', () => this.endKeyboardAction(element));
    }
    for (const element of [stick, lookSurface, ...this.actionElements]) {
      this.listen(element, 'contextmenu', event => { if (this.options.canInteract()) event.preventDefault(); });
    }
    const lifecycle = options.lifecycleTarget ?? (typeof window === 'undefined' ? undefined : window);
    if (lifecycle) {
      for (const type of ['blur', 'resize', 'orientationchange', 'pagehide']) this.listen(lifecycle, type, () => this.reset());
    }
    this.renderStick(0, 0);
  }

  get state(): Readonly<TouchState> { return this.values; }

  consumeLook(): { x: number; y: number } {
    const delta = { x: this.values.lookX, y: this.values.lookY };
    this.values.lookX = 0;
    this.values.lookY = 0;
    return delta;
  }

  reset(): void {
    const stickPointer = this.stickPointer;
    const lookPointer = this.lookPointer;
    const actions = [...this.heldActions.entries()];
    // Clear owners first: releasing capture can synchronously dispatch a lost event.
    this.stickPointer = null;
    this.stickGeometry = null;
    this.lookPointer = null;
    this.heldActions.clear();
    this.keyboardActions.clear();
    Object.assign(this.values, { forward: 0, strafe: 0, vertical: 0, brake: false, lookX: 0, lookY: 0 });
    this.options.stick.classList.remove('is-active');
    this.actionElements.forEach(element => element.classList.remove('is-active'));
    this.renderStick(0, 0);
    this.release(this.options.stick, stickPointer);
    this.release(this.options.lookSurface, lookPointer);
    for (const [pointerId, held] of actions) this.release(held.element, pointerId);
  }

  dispose(): void {
    if (this.disposed) return;
    this.reset();
    this.removers.forEach(remove => remove());
    this.removers.length = 0;
    this.disposed = true;
  }

  private listen(target: EventTarget, type: string, listener: EventListener, options?: AddEventListenerOptions) {
    target.addEventListener(type, listener, options);
    this.removers.push(() => target.removeEventListener(type, listener, options));
  }

  private pointer(target: HTMLElement, type: string, listener: (event: PointerEvent) => void) {
    this.listen(target, type, listener as EventListener, { passive: false });
  }

  private interact(): boolean { return !this.disposed && this.options.canInteract(); }
  private stop(event: Event) { event.preventDefault(); event.stopPropagation(); }
  private capture(target: HTMLElement, pointerId: number) {
    try { target.setPointerCapture(pointerId); } catch { /* A detached/suspended pointer may already be gone. */ }
  }
  private release(target: HTMLElement, pointerId: number | null) {
    if (pointerId === null) return;
    try { if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId); } catch { /* Already released by the browser. */ }
  }
  private isOwned(pointerId: number) {
    return pointerId === this.stickPointer || pointerId === this.lookPointer || this.heldActions.has(pointerId);
  }

  private startStick(event: PointerEvent) {
    if (!this.interact() || this.stickPointer !== null || this.isOwned(event.pointerId)) return;
    this.stop(event);
    // Geometry stays fixed for a captured gesture; resize/orientation resets it.
    // Avoid forcing layout at the phone's pointer-event frequency.
    const rect = this.options.stick.getBoundingClientRect();
    const knob = this.options.thumb.getBoundingClientRect();
    const size = Math.min(rect.width, rect.height);
    if (size <= 0) return;
    const knobSize = Math.max(knob.width, knob.height) || size * 0.4;
    this.stickGeometry = { centerX: rect.left + rect.width * 0.5, centerY: rect.top + rect.height * 0.5, radius: Math.max(1, (size - knobSize) * 0.5) };
    this.stickPointer = event.pointerId;
    this.options.stick.classList.add('is-active');
    this.capture(this.options.stick, event.pointerId);
    this.updateStick(event.clientX, event.clientY);
  }
  private moveStick(event: PointerEvent) {
    if (event.pointerId !== this.stickPointer) return;
    if (!this.interact()) { this.reset(); return; }
    this.stop(event);
    this.updateStick(event.clientX, event.clientY);
  }
  private updateStick(clientX: number, clientY: number) {
    const geometry = this.stickGeometry;
    if (!geometry) return;
    const axes = joystickAxes(clientX - geometry.centerX, clientY - geometry.centerY, geometry.radius);
    this.values.forward = axes.y;
    this.values.strafe = axes.x;
    this.renderStick(axes.thumbX, axes.thumbY);
    if (axes.magnitude > 0) this.options.onActivity();
  }
  private renderStick(x: number, y: number) {
    this.options.thumb.style.setProperty('--stick-x', `${x.toFixed(2)}px`);
    this.options.thumb.style.setProperty('--stick-y', `${y.toFixed(2)}px`);
  }
  private endStick(event: PointerEvent) {
    if (event.pointerId !== this.stickPointer) return;
    this.stop(event);
    const pointerId = this.stickPointer;
    this.stickPointer = null;
    this.stickGeometry = null;
    this.values.forward = 0;
    this.values.strafe = 0;
    this.options.stick.classList.remove('is-active');
    this.renderStick(0, 0);
    this.release(this.options.stick, pointerId);
  }

  private startLook(event: PointerEvent) {
    if (event.pointerType !== 'touch' && event.pointerType !== 'pen') return;
    if (!this.interact() || this.lookPointer !== null || this.isOwned(event.pointerId)) return;
    this.stop(event);
    this.lookPointer = event.pointerId;
    this.lookX = event.clientX;
    this.lookY = event.clientY;
    this.capture(this.options.lookSurface, event.pointerId);
  }
  private moveLook(event: PointerEvent) {
    if (event.pointerId !== this.lookPointer) return;
    if (!this.interact()) { this.reset(); return; }
    this.stop(event);
    const dx = event.clientX - this.lookX;
    const dy = event.clientY - this.lookY;
    this.lookX = event.clientX;
    this.lookY = event.clientY;
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
    this.values.lookX += dx * 0.0022;
    this.values.lookY -= dy * 0.0022;
    if (Math.abs(dx) + Math.abs(dy) > 0) this.options.onActivity();
  }
  private endLook(event: PointerEvent) {
    if (event.pointerId !== this.lookPointer) return;
    this.stop(event);
    const pointerId = this.lookPointer;
    this.lookPointer = null;
    this.release(this.options.lookSurface, pointerId);
  }

  private startAction(event: PointerEvent, element: HTMLElement) {
    if (!this.interact() || this.isOwned(event.pointerId)) return;
    const action = element.dataset.touchAction;
    if (action !== 'ascend' && action !== 'descend' && action !== 'brake') return;
    this.stop(event);
    this.heldActions.set(event.pointerId, { action, element });
    element.classList.add('is-active');
    this.capture(element, event.pointerId);
    this.updateActions();
    this.options.onActivity();
  }
  private endAction(event: PointerEvent) {
    const held = this.heldActions.get(event.pointerId);
    if (!held) return;
    this.stop(event);
    this.heldActions.delete(event.pointerId);
    if (![...this.heldActions.values()].some(action => action.element === held.element) && !this.keyboardActions.has(held.element)) held.element.classList.remove('is-active');
    this.updateActions();
    this.release(held.element, event.pointerId);
  }
  private updateActions() {
    const held = [...this.heldActions.values()].map(a => a.action).concat([...this.keyboardActions.values()]);
    this.values.vertical = Number(held.includes('ascend')) - Number(held.includes('descend'));
    this.values.brake = held.includes('brake');
  }
  private endKeyboardAction(element: HTMLElement) {
    if (!this.keyboardActions.delete(element)) return;
    if (![...this.heldActions.values()].some(action => action.element === element)) element.classList.remove('is-active');
    this.updateActions();
  }
}
