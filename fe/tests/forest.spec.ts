import { expect, test } from '@playwright/test';
import {
  forestPropagation,
  forestFrame,
  smokePlume,
} from '../src/components/map/forest';
import cover from '../src/components/map/forest-fuel.json' with { type: 'json' };
import bundle from '../../fixtures/bundle.json' with { type: 'json' };
import type { Fixtures } from '../../shared/src/types';

const map = (bundle as Fixtures).map;
const columns = cover.width / cover.cellSize;
const cellAt = (x: number, y: number) =>
  Math.floor(y / cover.cellSize) * columns + Math.floor(x / cover.cellSize);

test('forest fire stays on connected fuel, stops at cleared land, and cannot jump to the isolated grove', () => {
  const spread = forestPropagation(map);
  const field = cellAt(660, 640);
  const grove = cellAt(485, 505);
  expect(spread.fuel[cellAt(120, 60)]).toBe(1);
  expect(spread.fuel[field]).toBe(0);
  expect(spread.arrival[field]).toBe(Infinity);
  expect(spread.fuel[grove]).toBe(1);
  expect(spread.arrival[grove]).toBe(Infinity);
  const early = forestFrame(spread, 8),
    later = forestFrame(spread, 18),
    long = forestFrame(spread, 80);
  expect(early.cells.length).toBeGreaterThan(0);
  expect(later.cells.length).toBeGreaterThan(early.cells.length);
  const laterCells = new Set(later.cells);
  expect(early.cells.every((i) => laterCells.has(i))).toBe(true);
  expect(long.cells.every((i) => spread.fuel[i] === 1)).toBe(true);
  expect(forestFrame(spread, 0).cells).toEqual([]);
});

test('cleared homes never become fuel and smoke crosses open land downwind toward the village', () => {
  const spread = forestPropagation(map, [{ x: 120, y: 60 }]);
  expect(spread.fuel[cellAt(120, 60)]).toBe(0);
  expect(forestFrame(spread, 80).cells).toEqual([]);
  const connected = forestPropagation(map);
  const smoke = smokePlume(map, forestFrame(connected, 18), 18);
  expect(smoke.length).toBeGreaterThan(0);
  expect(
    smoke.some((p) => p.x > 300 && p.x < 1000 && p.y > 200 && p.y < 650),
  ).toBe(true);
  expect(
    smoke.some(
      (p) =>
        p.x >= 0 &&
        p.x < cover.width &&
        p.y >= 0 &&
        p.y < cover.height &&
        !connected.fuel[cellAt(p.x, p.y)],
    ),
  ).toBe(true);
  const firstLane = smoke.slice(0, 14);
  expect(firstLane.at(-1)!.x).toBeGreaterThan(firstLane[0].x);
  expect(firstLane.at(-1)!.y).toBeGreaterThan(firstLane[0].y);
  expect(smokePlume(map, forestFrame(connected, 0), 0)).toEqual([]);
});
