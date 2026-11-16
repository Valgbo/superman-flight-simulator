import { BoxGeometry } from 'three';

/**
 * Tile a facade in metres instead of stretching one image over every tower.
 * Shared facade materials can therefore keep the same floor/window spacing on
 * buildings with very different heights and footprints.
 */
export function buildingBoxGeometry(
  width: number,
  height: number,
  depth: number,
  tileWidth = 64,
  tileHeight = 64,
): BoxGeometry {
  if (![width, height, depth, tileWidth, tileHeight].every(value => Number.isFinite(value) && value > 0)) {
    throw new RangeError('Building dimensions and facade tile sizes must be positive finite numbers.');
  }
  const geometry = new BoxGeometry(width, height, depth);
  const positions = geometry.getAttribute('position');
  const normals = geometry.getAttribute('normal');
  const uv = geometry.getAttribute('uv');
  for (let i = 0; i < positions.count; i++) {
    const x = positions.getX(i), y = positions.getY(i), z = positions.getZ(i);
    const nx = normals.getX(i), ny = normals.getY(i), nz = normals.getZ(i);
    let u: number;
    let v = (y + height / 2) / tileHeight;
    if (nx > 0.5) u = (depth / 2 - z) / tileWidth;
    else if (nx < -0.5) u = (z + depth / 2) / tileWidth;
    else if (nz > 0.5) u = (x + width / 2) / tileWidth;
    else if (nz < -0.5) u = (width / 2 - x) / tileWidth;
    else {
      u = (x + width / 2) / tileWidth;
      v = (depth / 2 + (ny > 0 ? -z : z)) / tileHeight;
    }
    uv.setXY(i, u, v);
  }
  uv.needsUpdate = true;
  return geometry;
}
