import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
async function files(directory) {
  const result = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const name = path.join(directory, item.name);
    if (item.isDirectory()) result.push(...await files(name));
    else if (item.isFile()) result.push(name);
  }
  return result;
}

let checked = 0;
for (const directory of ['app', 'factory', 'scripts', 'tests']) {
  for (const file of await files(path.join(root, directory))) {
    if (!/\.(mjs|js)$/.test(file)) continue;
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr || `Syntax check failed: ${file}`);
    checked++;
  }
}
for (const file of await files(path.join(root, '.github/workflows'))) {
  const source = await readFile(file, 'utf8');
  for (const match of source.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)) {
    if (!/^[\w-]+\/[\w./-]+@[a-f0-9]{40}$/.test(match[1])) {
      throw new Error(`Action must use a full commit SHA: ${file}: ${match[1]}`);
    }
  }
  if (source.includes('pull_request_target')) throw new Error(`Privileged PR trigger prohibited: ${file}`);
  if (/\$\{\{\s*(?:github\.event\.(?:issue|pull_request|comment)|inputs\.)/.test(
    source.split('\n').filter(line => /^\s*run:/.test(line)).join('\n'),
  )) throw new Error(`Do not interpolate external input into shell: ${file}`);
}
console.log(`Syntax checked ${checked} JavaScript files; Action pins and trigger guardrails checked.`);
