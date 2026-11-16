import test from 'node:test';
import assert from 'node:assert/strict';
import { type BufferGeometry } from 'three';
import { buildingBoxGeometry } from '../src/building-geometry';

function faceUv(geometry: BufferGeometry, axis: 'x' | 'y' | 'z', sign = 1) {
  const normal = geometry.getAttribute('normal');
  const uv = geometry.getAttribute('uv');
  const component = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
  const values: [number, number][] = [];
  for (let i = 0; i < normal.count; i++) {
    if (normal.getComponent(i, component) === sign) values.push([uv.getX(i), uv.getY(i)]);
  }
  return values;
}
function span(values: [number, number][], component: 0 | 1) {
  const coordinates = values.map(value => value[component]);
  return Math.max(...coordinates) - Math.min(...coordinates);
}
const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-6, `${a} should equal ${b}`);

test('towers of different heights preserve the same number of facade tiles per metre', () => {
  const short = buildingBoxGeometry(96, 80, 48);
  const tall = buildingBoxGeometry(96, 320, 48);
  for (const side of [-1, 1]) {
    const shortV = span(faceUv(short, 'z', side), 1);
    const tallV = span(faceUv(tall, 'z', side), 1);
    close(shortV / 80, tallV / 320);
    close(tallV / shortV, 4);
    close(Math.min(...faceUv(short, 'z', side).map(value => value[1])), 0);
  }
  short.dispose(); tall.dispose();
});

test('wide and narrow faces tile according to their real width, with upright walls', () => {
  const geometry = buildingBoxGeometry(192, 128, 64);
  for (const side of [-1, 1]) {
    close(span(faceUv(geometry, 'z', side), 0), 3);
    close(span(faceUv(geometry, 'x', side), 0), 1);
    close(span(faceUv(geometry, 'x', side), 1), 2);
    const positions = geometry.getAttribute('position');
    const normals = geometry.getAttribute('normal');
    const uv = geometry.getAttribute('uv');
    for (let i = 0; i < positions.count; i++) {
      if (Math.abs(normals.getY(i)) < 0.5) {
        if (positions.getY(i) < 0) close(uv.getY(i), 0);
        else close(uv.getY(i), 2);
      }
    }
  }
  geometry.dispose();
});

test('custom facade tile dimensions are supported and roofs have finite UVs', () => {
  const geometry = buildingBoxGeometry(100, 240, 60, 20, 30);
  close(span(faceUv(geometry, 'z'), 0), 5);
  close(span(faceUv(geometry, 'z'), 1), 8);
  close(span(faceUv(geometry, 'x'), 0), 3);
  const uv = geometry.getAttribute('uv');
  for (let i = 0; i < uv.count; i++) {
    assert.ok(Number.isFinite(uv.getX(i)) && Number.isFinite(uv.getY(i)));
  }
  geometry.dispose();
});

test('invalid dimensions cannot introduce NaNs into rendering geometry', () => {
  assert.throws(() => buildingBoxGeometry(0, 10, 10), RangeError);
  assert.throws(() => buildingBoxGeometry(10, NaN, 10), RangeError);
  assert.throws(() => buildingBoxGeometry(10, 10, 10, Infinity), RangeError);
});
