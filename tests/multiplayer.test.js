'use strict';

const assert = require('node:assert/strict');
const { once } = require('node:events');
const test = require('node:test');
const WebSocket = require('ws');
const { createMultiplayerServer } = require('../server');
const answerKey = require('../answer-key');

function receive(socket, type, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off('message', onMessage);
      reject(new Error(`Timed out waiting for ${type}`));
    }, timeoutMs);
    function onMessage(buffer) {
      const message = JSON.parse(buffer.toString());
      if (message.type !== type) return;
      clearTimeout(timeout);
      socket.off('message', onMessage);
      resolve(message);
    }
    socket.on('message', onMessage);
  });
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { origin: 'http://localhost:3000' });
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}

test('players can join, use lifelines, and finish the shared ten-question game', async t => {
  const app = createMultiplayerServer({
    allowedOrigins: ['http://localhost:3000'],
    questionDurationMs: 2000,
    feedbackDurationMs: 20,
    random: () => 0
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const address = app.server.address();
  const url = `ws://127.0.0.1:${address.port}/ws`;
  const host = await connect(url);
  const guest = await connect(url);
  t.after(async () => {
    host.close();
    guest.close();
    await Promise.all([once(host, 'close'), once(guest, 'close')]);
    await new Promise(resolve => app.close(resolve));
  });

  const hostJoined = receive(host, 'room_joined');
  host.send(JSON.stringify({ type: 'create', name: 'Host' }));
  const room = await hostJoined;
  const guestJoined = receive(guest, 'room_joined');
  guest.send(JSON.stringify({ type: 'join', name: 'Invitado', code: room.roomCode }));
  await guestJoined;

  const hostQuestion = receive(host, 'question');
  const guestQuestion = receive(guest, 'question');
  host.send(JSON.stringify({ type: 'start' }));
  const [hostPrompt, guestPrompt] = await Promise.all([hostQuestion, guestQuestion]);
  assert.equal(hostPrompt.questionIndex, guestPrompt.questionIndex);
  assert.equal(hostPrompt.total, 10);

  const hostAnswer = receive(host, 'answer_result');
  const guestAnswer = receive(guest, 'answer_result');
  const hostReveal = receive(host, 'round_reveal');
  const guestReveal = receive(guest, 'round_reveal');
  const correctOption = answerKey[hostPrompt.questionIndex];
  host.send(JSON.stringify({ type: 'answer', selected: correctOption }));
  guest.send(JSON.stringify({ type: 'lifeline', name: 'shield' }));
  const shield = await receive(guest, 'lifeline_result');
  assert.equal(shield.armed, true);
  guest.send(JSON.stringify({ type: 'answer', selected: (correctOption + 1) % 4 }));

  const [hostResult, guestResult] = await Promise.all([hostAnswer, guestAnswer]);
  assert.equal(hostResult.correct, true);
  assert.equal(hostResult.score, 2);
  assert.equal(guestResult.shieldSaved, true);
  assert.equal(guestResult.score, 0);
  assert.equal(guestResult.lives, 3);

  const [hostRound, guestRound] = await Promise.all([hostReveal, guestReveal]);
  assert.equal(hostRound.correctOption, correctOption);
  assert.equal(guestRound.current, hostRound.current);

  for (let round = 1; round < answerKey.length; round += 1) {
    const nextHostQuestion = receive(host, 'question');
    const nextGuestQuestion = receive(guest, 'question');
    const [nextHostPrompt, nextGuestPrompt] = await Promise.all([nextHostQuestion, nextGuestQuestion]);
    assert.equal(nextHostPrompt.current, round);
    assert.equal(nextGuestPrompt.questionIndex, nextHostPrompt.questionIndex);

    const nextHostAnswer = receive(host, 'answer_result');
    const nextGuestAnswer = receive(guest, 'answer_result');
    const nextHostReveal = receive(host, 'round_reveal');
    const nextGuestReveal = receive(guest, 'round_reveal');
    const hostGameOver = round === answerKey.length - 1 ? receive(host, 'game_over') : null;
    const guestGameOver = round === answerKey.length - 1 ? receive(guest, 'game_over') : null;
    const correct = answerKey[nextHostPrompt.questionIndex];
    host.send(JSON.stringify({ type: 'answer', selected: correct }));
    guest.send(JSON.stringify({ type: 'answer', selected: correct }));
    const [hostRoundAnswer, guestRoundAnswer] = await Promise.all([nextHostAnswer, nextGuestAnswer]);
    assert.equal(hostRoundAnswer.correct, true);
    assert.equal(guestRoundAnswer.correct, true);
    await Promise.all([nextHostReveal, nextGuestReveal]);

    if (round === answerKey.length - 1) {
      const [hostFinal, guestFinal] = await Promise.all([hostGameOver, guestGameOver]);
      assert.equal(hostFinal.players[0].score, 20);
      assert.equal(guestFinal.players.find(player => player.name === 'Invitado').score, 18);
    }
  }
});

test('websocket connections from unapproved origins are rejected', async () => {
  const app = createMultiplayerServer({ allowedOrigins: ['https://example.test'] });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const address = app.server.address();
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws`, {
    origin: 'https://other.example'
  });
  const [error] = await once(socket, 'error');
  assert.match(error.message, /Unexpected server response: 403/);
  await new Promise(resolve => app.close(resolve));
});

test('unanswered questions cost one life when the timer expires', async t => {
  const app = createMultiplayerServer({
    allowedOrigins: ['http://localhost:3000'],
    questionDurationMs: 200,
    feedbackDurationMs: 10
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const address = app.server.address();
  const url = `ws://127.0.0.1:${address.port}/ws`;
  const host = await connect(url);
  const guest = await connect(url);
  t.after(async () => {
    host.close();
    guest.close();
    await Promise.all([once(host, 'close'), once(guest, 'close')]);
    await new Promise(resolve => app.close(resolve));
  });

  const roomJoined = receive(host, 'room_joined');
  host.send(JSON.stringify({ type: 'create', name: 'Host' }));
  const room = await roomJoined;
  const guestJoined = receive(guest, 'room_joined');
  guest.send(JSON.stringify({ type: 'join', name: 'Invitado', code: room.roomCode }));
  await guestJoined;

  const hostQuestion = receive(host, 'question');
  const guestQuestion = receive(guest, 'question');
  const hostTimeout = receive(host, 'answer_result');
  const guestTimeout = receive(guest, 'answer_result');
  host.send(JSON.stringify({ type: 'start' }));
  const [prompt, guestPrompt] = await Promise.all([hostQuestion, guestQuestion]);
  assert.equal(prompt.questionIndex, guestPrompt.questionIndex);
  const [hostResult, guestResult] = await Promise.all([hostTimeout, guestTimeout]);
  assert.equal(hostResult.timeout, true);
  assert.equal(hostResult.lives, 2);
  assert.equal(guestResult.timeout, true);
  assert.equal(guestResult.lives, 2);
});
