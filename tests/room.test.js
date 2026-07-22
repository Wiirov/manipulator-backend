import test from 'node:test';
import assert from 'node:assert/strict';
import { Room } from '../game/Room.js';

test('role distribution matches the requested table', () => {
  const expected = {
    5: { innocent: 3, thief: 1, assistant: 1 },
    6: { innocent: 4, thief: 1, assistant: 1 },
    7: { innocent: 4, thief: 1, assistant: 2 },
    8: { innocent: 5, thief: 2, assistant: 1 },
    9: { innocent: 5, thief: 2, assistant: 2 },
    10: { innocent: 6, thief: 2, assistant: 2 },
    11: { innocent: 6, thief: 2, assistant: 3 },
    12: { innocent: 7, thief: 2, assistant: 3 },
    13: { innocent: 7, thief: 3, assistant: 3 },
    14: { innocent: 8, thief: 3, assistant: 3 },
    15: { innocent: 8, thief: 3, assistant: 4 },
  };

  for (const [playerCount, counts] of Object.entries(expected)) {
    assert.deepEqual(Room.getRoleDistribution(Number(playerCount)), counts);
  }
});
