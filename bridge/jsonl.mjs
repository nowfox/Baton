import fs from 'fs';
import { StringDecoder } from 'string_decoder';

const DEFAULT_CHUNK_SIZE = 64 * 1024;

export function scanJsonlLines(filePath, onLine, options = {}) {
  const chunkSize = options.chunkSize || DEFAULT_CHUNK_SIZE;
  const buffer = Buffer.allocUnsafe(chunkSize);
  const decoder = new StringDecoder('utf8');
  const fd = fs.openSync(filePath, 'r');
  let pending = [];
  let lineNumber = 0;

  try {
    while (true) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      const text = decoder.write(buffer.subarray(0, bytesRead));
      let start = 0;
      let newline;
      while ((newline = text.indexOf('\n', start)) !== -1) {
        pending.push(text.slice(start, newline));
        let line = pending.length === 1 ? pending[0] : pending.join('');
        if (line.endsWith('\r')) line = line.slice(0, -1);
        onLine(line, lineNumber++);
        pending = [];
        start = newline + 1;
      }
      if (start < text.length) pending.push(text.slice(start));
    }

    const tail = decoder.end();
    if (tail) pending.push(tail);
    if (pending.length > 0) {
      let line = pending.length === 1 ? pending[0] : pending.join('');
      if (line.endsWith('\r')) line = line.slice(0, -1);
      onLine(line, lineNumber++);
    }
    return lineNumber;
  } finally {
    fs.closeSync(fd);
  }
}

const SDK_ENTRYPOINT = Buffer.from('"entrypoint":"sdk-cli"');
const CLI_ENTRYPOINT = Buffer.from('"entrypoint":"cli"    ');
const ENTRYPOINT_KEY = '"entrypoint":"';
const RESUME_WINDOW_BYTES = 64 * 1024;

// CC's /resume picker hides a session whose head entrypoint is sdk-cli; with no
// entrypoint in the head (e.g. a huge first image line) it uses the tail's last one.
// Rewrite that one value in place at equal length; CC's O_APPEND writes are unaffected.
export function exposeToResumePicker(filePath) {
  const fd = fs.openSync(filePath, 'r+');
  try {
    const buffer = Buffer.alloc(RESUME_WINDOW_BYTES);
    const headRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
    let start = 0;
    let offset = buffer.subarray(0, headRead).indexOf(ENTRYPOINT_KEY);
    if (offset < 0) {
      const size = fs.fstatSync(fd).size;
      if (size <= RESUME_WINDOW_BYTES) return false;
      start = size - RESUME_WINDOW_BYTES;
      const tailRead = fs.readSync(fd, buffer, 0, buffer.length, start);
      offset = buffer.subarray(0, tailRead).lastIndexOf(ENTRYPOINT_KEY);
    }
    if (offset < 0 || buffer.indexOf(SDK_ENTRYPOINT, offset) !== offset) return false;
    fs.writeSync(fd, CLI_ENTRYPOINT, 0, CLI_ENTRYPOINT.length, start + offset);
    return true;
  } finally {
    fs.closeSync(fd);
  }
}
