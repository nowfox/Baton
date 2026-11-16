import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  describeClaudeWriter,
  releaseClaudeWriter,
  terminateClaudeWriter,
} from '../../bridge/claude-writer.mjs';

const SID = '50505050-5050-4505-8505-505050505050';

function writer(fields = {}) {
  return { pid: 10, procStart: '', status: 'needs_input', idle: false, label: 'VS', canTerminate: true, ...fields };
}

test('describe finds the external record, skipping pool pids and other sessions', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-claude-writer-'));
  const pid = String(process.pid);
  const write = (fields) => fs.writeFileSync(
    path.join(dir, `${pid}.json`),
    JSON.stringify({ pid: process.pid, sessionId: SID, ...fields }),
  );
  const describe = (options = {}) => describeClaudeWriter(SID, {
    claudePids: new Set([pid]), sessionsDir: dir, ...options,
  });
  try {
    write({ status: 'waiting', entrypoint: 'claude-vscode' });
    assert.deepEqual(describe(), {
      pid: process.pid,
      procStart: '',
      status: 'needs_input',
      idle: false,
      client: 'claude-vscode',
      label: 'Claude Code in VS Code',
      canTerminate: true,
    });
    write({ status: 'idle', entrypoint: 'cli' });
    assert.equal(describe().idle, true);
    assert.equal(describe().label, 'A Claude Code terminal');
    // Baton's own headless process and dead pids are not external writers.
    assert.equal(describe({ excludePids: new Set([process.pid]) }), null);
    assert.equal(describe({ claudePids: new Set() }), null);
    assert.equal(describeClaudeWriter('other', { claudePids: new Set([pid]), sessionsDir: dir }), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('describe prefers the busiest of several writers', () => {
  const readRecords = () => [
    { pid: 1, sessionId: SID, status: 'idle' },
    { pid: 2, sessionId: SID, status: 'busy' },
    { pid: 3, sessionId: SID, status: 'waiting' },
  ];
  const found = describeClaudeWriter(SID, { claudePids: new Set(), readRecords });
  assert.equal(found.pid, 2);
  assert.equal(found.status, 'running');
});

test('release asks before stopping a waiting or busy writer', async () => {
  const killed = [];
  let current = writer();
  const options = {
    describe: () => current,
    terminate: async (w) => { killed.push(w.pid); current = null; },
  };
  await assert.rejects(releaseClaudeWriter(SID, options), (error) => {
    assert.equal(error.code, 'CLAUDE_ACTIVE_WRITER');
    assert.equal(error.writer.pid, 10);
    return true;
  });
  // A confirmation for a different pid is not a confirmation for this writer.
  await assert.rejects(releaseClaudeWriter(SID, { ...options, takeover: true, expectedWriterPid: 11 }));
  assert.deepEqual(killed, []);

  await releaseClaudeWriter(SID, { ...options, takeover: true, expectedWriterPid: 10 });
  assert.deepEqual(killed, [10]);
});

test('release stops an idle writer without asking and re-checks for another one', async () => {
  const queue = [writer({ pid: 20, idle: true, status: 'completed' }), writer({ pid: 21, status: 'running' })];
  const killed = [];
  const options = {
    describe: () => queue[0] || null,
    terminate: async (w) => { killed.push(w.pid); queue.shift(); },
  };
  await assert.rejects(releaseClaudeWriter(SID, options), (error) => error.writer.pid === 21);
  assert.deepEqual(killed, [20]);
  assert.equal(await releaseClaudeWriter(SID, { describe: () => null }), null);
});

test('terminate sends SIGTERM and waits for the exit', async () => {
  const signals = [];
  let polls = 0;
  await terminateClaudeWriter(writer(), {
    kill: (pid, signal) => signals.push([pid, signal]),
    processGone: () => ++polls > 2,
  });
  assert.deepEqual(signals, [[10, 'SIGTERM']]);
  assert.equal(polls, 3);

  const missing = Object.assign(new Error('gone'), { code: 'ESRCH' });
  await terminateClaudeWriter(writer(), { kill: () => { throw missing; }, processGone: () => false });

  await assert.rejects(
    terminateClaudeWriter(writer(), { kill: () => {}, processGone: () => false, timeoutMs: 20 }),
    (error) => error.code === 'CLAUDE_WRITER_UNSAFE',
  );
});

test('terminate really stops a child process', async () => {
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  await new Promise((resolve) => child.once('spawn', resolve));
  const exited = new Promise((resolve) => child.once('exit', resolve));
  await terminateClaudeWriter(writer({ pid: child.pid }), { timeoutMs: 3000 });
  assert.equal(await exited, null);
});
