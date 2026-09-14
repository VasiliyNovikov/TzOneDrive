import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';

export class AdapterError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AdapterError';
    this.code = code;
  }
}

export function boundedInteger(value, fallback, min, max, name) {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < min || result > max) {
    throw new AdapterError('INVALID_CONFIG', `${name} must be an integer from ${min} to ${max}`);
  }
  return result;
}

export function trustedExecutable(value, pathName) {
  if (typeof value !== 'string' || !value || /[\0\r\n]/u.test(value)
      || (!isAbsolute(value) && value !== pathName)) {
    throw new AdapterError('INVALID_CONFIG', `${pathName ?? 'Operator executable'} must be an absolute trusted executable path`);
  }
  return value;
}

// Configuration and executable paths belong to the local operator, never a PR.
export function runCommand(executable, args, options = {}) {
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string' || arg.includes('\0'))) {
    throw new AdapterError('INVALID_ARGUMENT', 'Commands require a string argument array');
  }
  const timeoutMs = boundedInteger(options.timeoutMs, 15_000, 1, 120_000, 'command timeout');
  const maxOutputBytes = boundedInteger(options.maxOutputBytes, 256 * 1024, 1, 1024 * 1024, 'output limit');
  return new Promise((resolve, reject) => {
    let settled = false;
    let bytes = 0;
    let stdout = '';
    let stderr = '';
    let timer;
    const child = spawn(executable, args, {
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: options.env ?? process.env,
      cwd: options.cwd,
      windowsHide: true,
    });
    const kill = (signal) => {
      if (!child.pid) return;
      try {
        if (process.platform === 'win32') child.kill(signal);
        else process.kill(-child.pid, signal);
      } catch (error) {
        if (error.code !== 'ESRCH') child.kill(signal);
      }
    };
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      if (error) {
        kill('SIGKILL');
        reject(error);
      } else resolve(result);
    };
    const abort = () => finish(new AdapterError('TIMEOUT', 'Operation cancelled or timed out'));
    const collect = (kind, data) => {
      bytes += data.length;
      if (bytes > maxOutputBytes) {
        finish(new AdapterError('OUTPUT_LIMIT', 'Executable exceeded its output limit'));
        return;
      }
      if (kind === 'stdout') stdout += data.toString('utf8');
      else stderr += data.toString('utf8');
    };
    child.stdout.on('data', (data) => collect('stdout', data));
    child.stderr.on('data', (data) => collect('stderr', data));
    child.stdin.on('error', () => {});
    child.on('error', (error) => finish(new AdapterError('UNAVAILABLE', `Executable unavailable: ${error.code ?? 'UNKNOWN'}`)));
    child.on('close', (code, signal) => {
      if (settled) return;
      if (code !== 0) finish(new AdapterError('COMMAND_FAILED', `Executable failed (${code ?? signal})`));
      else finish(null, { stdout, stderr, code });
    });
    timer = setTimeout(abort, timeoutMs);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    child.stdin.end(options.input ?? '');
  });
}

export async function runJsonCommand(executable, args, input, options = {}) {
  const { stdout } = await runCommand(executable, args, {
    ...options, input: `${JSON.stringify(input)}\n`,
  });
  try {
    return JSON.parse(stdout);
  } catch {
    throw new AdapterError('INVALID_RESPONSE', 'Executable must emit exactly one JSON object');
  }
}

export function exactKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}
