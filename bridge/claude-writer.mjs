import fs from 'fs';
import {
  listClaudePids,
  liveSessionStatus,
  processStartTime,
  readLiveSessionRecords,
} from './session.mjs';

const EXIT_TIMEOUT_MS = 5000;
const EXIT_POLL_MS = 50;
// Most likely to write first: a running turn, then a pending question.
const STATUS_RANK = { busy: 0, waiting: 1, shell: 2, idle: 3 };
const CLIENT_LABELS = {
  'claude-vscode': 'Claude Code in VS Code',
  cli: 'A Claude Code terminal',
};

// A Claude Code process outside Baton's pool that currently holds this session.
export function describeClaudeWriter(sessionId, options = {}) {
  if (!sessionId) return null;
  const exclude = options.excludePids || new Set();
  const pids = options.claudePids || listClaudePids();
  const records = (options.readRecords || readLiveSessionRecords)(pids, options.sessionsDir)
    .filter((record) => record.sessionId === sessionId && !exclude.has(record.pid))
    .sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status]);
  const record = records[0];
  if (!record) return null;
  return {
    pid: record.pid,
    procStart: record.procStart === undefined ? '' : String(record.procStart),
    status: liveSessionStatus(record),
    idle: record.status === 'idle',
    client: record.entrypoint || '',
    label: CLIENT_LABELS[record.entrypoint] || 'Another Claude Code client',
    canTerminate: true,
  };
}

function processGone(pid, procStart) {
  try {
    process.kill(pid, 0);
  } catch (error) {
    return error.code === 'ESRCH';
  }
  if (process.platform !== 'linux') return false;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    if (stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z')) return true;
    return !!procStart && processStartTime(pid) !== procStart;
  } catch {
    return true;
  }
}

export async function terminateClaudeWriter(writer, options = {}) {
  const kill = options.kill || process.kill;
  const gone = options.processGone || processGone;
  const timeoutMs = options.timeoutMs ?? EXIT_TIMEOUT_MS;
  try {
    kill(writer.pid, 'SIGTERM');
  } catch (error) {
    if (error.code === 'ESRCH') return writer;
    throw writerError('Could not stop the local Claude Code process', 'CLAUDE_WRITER_UNSAFE', writer);
  }
  const deadline = Date.now() + timeoutMs;
  while (!gone(writer.pid, writer.procStart)) {
    if (Date.now() >= deadline) {
      throw writerError('The local Claude Code process did not exit', 'CLAUDE_WRITER_UNSAFE', writer);
    }
    await new Promise((resolve) => setTimeout(resolve, EXIT_POLL_MS));
  }
  return writer;
}

function writerError(message, code, writer) {
  const error = new Error(message);
  error.code = code;
  error.writer = writer;
  return error;
}

// Decide how a Baton send may take over: idle writers are released automatically,
// busy or waiting ones only with the user's confirmation for that exact pid.
export async function releaseClaudeWriter(sessionId, options = {}) {
  const describe = options.describe || describeClaudeWriter;
  const terminate = options.terminate || terminateClaudeWriter;
  let confirmedPid = options.takeover ? Number(options.expectedWriterPid) : 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    const writer = describe(sessionId, options);
    if (!writer) return null;
    if (!writer.idle && writer.pid !== confirmedPid) {
      throw writerError(
        `${writer.label} is using this session`,
        'CLAUDE_ACTIVE_WRITER',
        writer,
      );
    }
    await terminate(writer, options);
    confirmedPid = 0;
  }
  const remaining = describe(sessionId, options);
  if (remaining) {
    throw writerError(`${remaining.label} is using this session`, 'CLAUDE_ACTIVE_WRITER', remaining);
  }
  return null;
}
