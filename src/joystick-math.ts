export interface JoystickAxes {
  /** Right is positive. */
  x: number;
  /** Up (forward) is positive. */
  y: number;
  magnitude: number;
  /** Screen-space knob displacement, clamped to the circular gate. */
  thumbX: number;
  thumbY: number;
}

/** A circular gate prevents diagonal speed boosts; a remapped deadzone avoids drift. */
export function joystickAxes(dx: number, dy: number, radius: number, deadzone = 0.12): JoystickAxes {
  const neutral: JoystickAxes = { x: 0, y: 0, magnitude: 0, thumbX: 0, thumbY: 0 };
  if (![dx, dy, radius].every(Number.isFinite) || radius <= 0) return neutral;
  const distance = Math.hypot(dx, dy);
  if (distance === 0) return neutral;
  const travel = Math.min(distance, radius);
  const ux = dx / distance;
  const uy = dy / distance;
  const rawMagnitude = travel / radius;
  const zone = Number.isFinite(deadzone) ? Math.min(0.95, Math.max(0, deadzone)) : 0.12;
  const magnitude = Math.max(0, (rawMagnitude - zone) / (1 - zone));
  return { x: ux * magnitude || 0, y: -uy * magnitude || 0, magnitude, thumbX: ux * travel, thumbY: uy * travel };
}
