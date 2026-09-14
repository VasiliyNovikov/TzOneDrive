import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { mkdir, open, readFile, readdir, rename, rm, rmdir, stat, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export class StateLockedError extends Error {
  constructor(message = 'Factory state is locked by another process') {
    super(message);
    this.name = 'StateLockedError';
  }
}

export async function atomicWriteJson(path, value) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.new`;
  let file;
  try {
    file = await open(temporary, 'wx', 0o600);
    await file.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await file.sync();
    await file.close();
    file = null;
    await rename(temporary, path);
    const directory = await open(resolve(path, '..'), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    if (file) await file.close();
    await rm(temporary, { force: true });
  }
}

function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}

async function acquire(directory) {
  const token = randomUUID();
  const ownerName = `${process.pid}-${token}.json`;
  const candidate = join(directory, `.lock-candidate-${token}`);
  const lock = join(directory, '.lock');
  await mkdir(candidate, { mode: 0o700 });
  try {
    await atomicWriteJson(join(candidate, ownerName), { pid: process.pid, host: hostname(), token });
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        // A fully populated directory is published atomically, with no ownerless window.
        await rename(candidate, lock);
        return async () => {
          await unlink(join(lock, ownerName));
          await rmdir(lock).catch((error) => {
            if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
          });
        };
      } catch (error) {
        if (!['ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
      }
      const names = await readdir(lock).catch((error) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      });
      if (names.length !== 1) throw new StateLockedError('Factory lock has an unknown owner; refusing takeover');
      const ownerPath = join(lock, names[0]);
      let owner;
      try { owner = JSON.parse(await readFile(ownerPath, 'utf8')); } catch {
        throw new StateLockedError('Factory lock is unreadable; refusing takeover');
      }
      if (owner.host !== hostname() || alive(owner.pid)) throw new StateLockedError();
      // Delete only the dead owner's unique file. Concurrent reclaimers cannot remove a new owner.
      try {
        await unlink(ownerPath);
        await rmdir(lock).catch((error) => {
          if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
        });
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    throw new StateLockedError();
  } finally {
    await rm(candidate, { recursive: true, force: true });
  }
}

export async function withStore(stateDir, callback) {
  const directory = resolve(stateDir);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const release = await acquire(directory);
  const statePath = join(directory, 'state.json');
  let locked = true;
  const store = {
    directory,
    async load() {
      try { return JSON.parse(await readFile(statePath, 'utf8')); } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
      }
    },
    save: (state) => {
      if (!locked) throw new StateLockedError('Cannot save after releasing the factory lock');
      return atomicWriteJson(statePath, state);
    },
    async shouldStop() {
      if (process.env.FACTORY_STOP && !['0', 'false'].includes(process.env.FACTORY_STOP.toLowerCase())) return true;
      try { await stat(join(directory, 'STOP')); return true; } catch (error) {
        if (error.code === 'ENOENT') return false;
        throw error;
      }
    },
  };
  try { return await callback(store); } finally { locked = false; await release(); }
}
