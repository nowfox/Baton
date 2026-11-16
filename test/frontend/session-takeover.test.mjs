import assert from 'node:assert/strict';
import test from 'node:test';

import { makeHarness, resetSession } from './harness.mjs';

function conflict(turnId, writer) {
  return {
    action: 'send_message_result',
    turnId,
    ok: false,
    error: 'Claude Code in VS Code is using this session',
    errorCode: 'claude_active_writer',
    writer: { pid: 4242, label: 'Claude Code in VS Code', canTerminate: true, ...writer },
  };
}

test('a Claude writer conflict asks before taking over, and can be cancelled', async () => {
  const h = await makeHarness();
  resetSession(h, { sessionId: 'claude-takeover' });
  const sent = [];
  h.state.ws = { readyState: WebSocket.OPEN, send(payload) { sent.push(JSON.parse(payload)); } };

  h.window.doSend('choose A', 'choose A', []);
  const pending = h.state.pendingSentMessages[0];
  h.hooks.handleWsMessage(conflict(pending.id, { status: 'needs_input' }));
  await h.tick(0);

  const modal = h.document.getElementById('sessionTakeoverModal');
  assert.notEqual(modal.style.display, 'none');
  assert.equal(h.document.getElementById('sessionTakeoverTitle').textContent, 'Claude Code session is active');
  assert.match(h.document.getElementById('sessionTakeoverDesc').textContent, /waiting for input/);
  assert.equal(pending.delivered, undefined);

  h.window.confirmSessionTakeover();
  const sends = sent.filter((frame) => frame.action === 'send_message');
  const retry = sends[sends.length - 1];
  assert.equal(retry.turnId, sends[0].turnId);
  assert.equal(retry.takeover, true);
  assert.equal(retry.expectedWriterPid, 4242);

  h.hooks.handleWsMessage({ action: 'send_message_result', turnId: pending.id, ok: true, sessionId: 'claude-takeover' });
  await h.tick(0);
  assert.equal(modal.style.display, 'none');
  assert.equal(pending.failed, false);

  resetSession(h, { sessionId: 'claude-cancel' });
  h.window.doSend('hello', 'hello', []);
  const cancelled = h.state.pendingSentMessages[0];
  h.hooks.handleWsMessage(conflict(cancelled.id, { status: 'running' }));
  await h.tick(0);
  assert.match(h.document.getElementById('sessionTakeoverDesc').textContent, /stop that turn/);

  h.window.closeSessionTakeoverModal();
  assert.equal(cancelled.failed, true);
});
