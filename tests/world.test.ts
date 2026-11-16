import assert from 'node:assert/strict';
import test from 'node:test';
import { segmentBoxFraction } from '../src/world-math';

const min = { x: 10, y: 0, z: -5 };
const max = { x: 20, y: 100, z: 5 };

test('swept collision catches a skyscraper completely crossed between frames', () => {
  assert.equal(segmentBoxFraction({ x: -1000, y: 50, z: 0 }, { x: 1000, y: 50, z: 0 }, min, max), 0.505);
});

test('starting inside returns an immediate hit', () => {
  assert.equal(segmentBoxFraction({ x: 15, y: 50, z: 0 }, { x: 100, y: 50, z: 0 }, min, max), 0);
});

test('parallel movement outside a box misses', () => {
  assert.equal(segmentBoxFraction({ x: 15, y: 200, z: -10 }, { x: 15, y: 200, z: 10 }, min, max), null);
});

test('touching a face and stopping counts as a hit', () => {
  assert.equal(segmentBoxFraction({ x: 0, y: 100, z: 5 }, { x: 10, y: 100, z: 5 }, min, max), 1);
});

test('zero length movement only hits when inside the box', () => {
  assert.equal(segmentBoxFraction({ x: 15, y: 50, z: 0 }, { x: 15, y: 50, z: 0 }, min, max), 0);
  assert.equal(segmentBoxFraction({ x: 5, y: 50, z: 0 }, { x: 5, y: 50, z: 0 }, min, max), null);
});

test('vertical movement finds the roof regardless of travel direction', () => {
  assert.equal(segmentBoxFraction({ x: 15, y: 150, z: 0 }, { x: 15, y: 50, z: 0 }, min, max), 0.5);
  assert.equal(segmentBoxFraction({ x: 15, y: -100, z: 0 }, { x: 15, y: 50, z: 0 }, min, max), 2 / 3);
});

test('padding accounts for the hero radius near a wall', () => {
  assert.equal(segmentBoxFraction({ x: 0, y: 50, z: 7 }, { x: 30, y: 50, z: 7 }, min, max), null);
  assert.equal(segmentBoxFraction({ x: 0, y: 50, z: 7 }, { x: 30, y: 50, z: 7 }, min, max, 2), 8 / 30);
});

test('a box behind or beyond the complete segment does not collide', () => {
  assert.equal(segmentBoxFraction({ x: 30, y: 50, z: 0 }, { x: 40, y: 50, z: 0 }, min, max), null);
  assert.equal(segmentBoxFraction({ x: -10, y: 50, z: 0 }, { x: 0, y: 50, z: 0 }, min, max), null);
});
