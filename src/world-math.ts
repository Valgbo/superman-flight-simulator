export interface Point3 {
  x: number;
  y: number;
  z: number;
}

/** First intersection along an entire movement segment, including both endpoints. */
export function segmentBoxFraction(
  from: Point3,
  to: Point3,
  min: Point3,
  max: Point3,
  padding = 0,
): number | null {
  let enter = 0;
  let leave = 1;

  for (const axis of ['x', 'y', 'z'] as const) {
    const delta = to[axis] - from[axis];
    const lower = min[axis] - padding;
    const upper = max[axis] + padding;

    if (Math.abs(delta) < Number.EPSILON) {
      if (from[axis] < lower || from[axis] > upper) return null;
      continue;
    }

    let near = (lower - from[axis]) / delta;
    let far = (upper - from[axis]) / delta;
    if (near > far) [near, far] = [far, near];
    enter = Math.max(enter, near);
    leave = Math.min(leave, far);
    if (enter > leave) return null;
  }

  return enter;
}
