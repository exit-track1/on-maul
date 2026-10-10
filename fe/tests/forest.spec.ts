import { expect, test } from '@playwright/test';
import {
  forestPropagation,
  forestFrame,
  houseBurned,
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

test('only houses touched by the current fire fringe char, and time zero restores every building', () => {
  const spread = forestPropagation(map);
  const north = bundle.households.find((h) => h.id === 'H011')!.demoPosition;
  const south = bundle.households.find((h) => h.id === 'H009')!.demoPosition;
  expect(houseBurned(spread, north, 0)).toBe(false);
  expect(houseBurned(spread, north, 8)).toBe(false);
  expect(houseBurned(spread, north, 18)).toBe(true);
  expect(houseBurned(spread, north, 80)).toBe(true);
  expect(houseBurned(spread, south, 80)).toBe(false);
  expect(
    bundle.households.every((h) => !houseBurned(spread, h.demoPosition, 0)),
  ).toBe(true);
});

test('cleared homes never become fuel', () => {
  const spread = forestPropagation(map, [{ x: 120, y: 60 }]);
  expect(spread.fuel[cellAt(120, 60)]).toBe(0);
  expect(forestFrame(spread, 80).cells).toEqual([]);
});
