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

test('publicState exposes partner names to thief and assistant', () => {
  const room = new Room('TEST1', 'p1');
  room.addPlayer('p1', 'Alice');
  room.addPlayer('p2', 'Bob');
  room.addPlayer('p3', 'Carol');
  room.addPlayer('p4', 'Dave');
  room.addPlayer('p5', 'Eve');
  room.phase = 'night';
  room.thiefId = 'p1';
  room.assistantId = 'p3';
  room.players.get('p1').role = 'thief';
  room.players.get('p3').role = 'assistant';
  room.players.get('p1').hour = 2;
  room.players.get('p3').hour = 4;

  const thiefView = room.publicState('p1');
  assert.deepEqual(thiefView.partner, { id: 'p3', role: 'assistant', name: 'Carol' });

  const assistantView = room.publicState('p3');
  assert.deepEqual(assistantView.partner, { id: 'p1', role: 'thief', name: 'Alice' });
});

test('publicState exposes same-hour player names in HUD data', () => {
  const room = new Room('TEST2', 'p1');
  room.addPlayer('p1', 'Alice');
  room.addPlayer('p2', 'Bob');
  room.addPlayer('p3', 'Carol');
  room.addPlayer('p4', 'Dave');
  room.addPlayer('p5', 'Eve');
  room.phase = 'night';
  for (const player of room.activePlayers) {
    player.hasRolled = true;
  }
  room.players.get('p1').hour = 3;
  room.players.get('p2').hour = 3;
  room.players.get('p3').hour = 5;
  room.players.get('p4').hour = 3;
  room.players.get('p5').hour = 7;

  const aliceView = room.publicState('p1');
  assert.deepEqual(aliceView.sameHourPlayers, [
    { id: 'p2', name: 'Bob' },
    { id: 'p4', name: 'Dave' },
  ]);

  room.phase = 'rolling';
  room.players.get('p4').hasRolled = false;
  const rollingView = room.publicState('p1');
  assert.deepEqual(rollingView.sameHourPlayers, [{ id: 'p2', name: 'Bob' }]);
});

test('publicState exposes jewel memory at the player hour for the HUD', () => {
  const room = new Room('TEST3', 'p1');
  room.addPlayer('p1', 'Alice');
  room.addPlayer('p2', 'Bob');
  room.addPlayer('p3', 'Carol');
  room.addPlayer('p4', 'Dave');
  room.addPlayer('p5', 'Eve');
  room.phase = 'night';
  room.currentHour = 2;
  room.players.get('p1').hour = 2;
  room.players.get('p1').hasRolled = true;
  room.players.get('p1').jewelObservationAtHour = 'present';
  room.players.get('p2').hour = 4;
  room.players.get('p2').hasRolled = true;

  assert.equal(room.publicState('p1').jewelAtMyHour, 'present');
  assert.equal(room.publicState('p2').jewelAtMyHour, null);

  room.players.get('p2').jewelObservationAtHour = 'gone';
  room.currentHour = 4;
  assert.equal(room.publicState('p2').jewelAtMyHour, 'gone');
});
