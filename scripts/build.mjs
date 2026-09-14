import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
export const APP_ID = 'TzOneDrive.PhotoViewer';
export const PACKAGE_ID = 'TzOneDrive';

export async function getBuildIdentity({ root = projectRoot, env = process.env, mode = 'production' } = {}) {
  const metadata = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  if (!/^\d+\.\d+\.\d+$/.test(metadata.version)) {
    throw new Error('Application version must be a three-part numeric Tizen widget version.');
  }
  let commit = env.BUILD_ID;
  if (!commit) {
    try {
      commit = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    } catch {
      throw new Error('Cannot identify this build. Set BUILD_ID to the full 40-character commit SHA.');
    }
  }
  if (!/^[a-fA-F0-9]{40}$/.test(commit)) {
    throw new Error('BUILD_ID must be a full 40-character hexadecimal commit SHA, not a branch or short hash.');
  }
  commit = commit.toLowerCase();
  return {
    schemaVersion: 1, version: metadata.version, commit, buildId: commit, mode,
  };
}

export function buildModule(identity) {
  return `export const BUILD = Object.freeze(${JSON.stringify(identity, null, 2)});\n`;
}

export function stampIndex(source, identity) {
  return source.replace('data-build-commit="UNSTAMPED"', `data-build-commit="${identity.commit}"`)
    .replace('SOURCE · UNSTAMPED', `v${identity.version} · ${identity.commit.slice(0, 12)}`);
}

async function listFiles(directory, prefix = '') {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Symbolic links are not allowed in application assets: ${relative}`);
    if (entry.isDirectory()) files.push(...await listFiles(path.join(directory, entry.name), relative));
    else if (entry.isFile()) files.push(relative);
    else throw new Error(`Unsupported application asset: ${relative}`);
  }
  return files;
}

export async function buildApp({ root = projectRoot, env = process.env } = {}) {
  const identity = await getBuildIdentity({ root, env });
  const source = path.join(root, 'app');
  const output = path.join(root, 'dist', 'app');
  await listFiles(source);
  await mkdir(path.join(root, 'dist'), { recursive: true });
  await rm(output, { force: true, recursive: true });
  await cp(source, output, { recursive: true });
  await writeFile(path.join(output, 'build.json'), `${JSON.stringify(identity, null, 2)}\n`);
  await writeFile(path.join(output, 'build.js'), buildModule(identity));
  const index = await readFile(path.join(output, 'index.html'), 'utf8');
  await writeFile(path.join(output, 'index.html'), stampIndex(index, identity));
  const config = await readFile(path.join(output, 'config.xml'), 'utf8');
  await writeFile(path.join(output, 'config.xml'), config.replace(/(<widget\b[\s\S]*?\bversion=")[^"]+"/, `$1${identity.version}"`));
  const files = [];
  for (const relative of await listFiles(output)) {
    const content = await readFile(path.join(output, relative));
    files.push({
      path: `app/${relative}`, size: content.byteLength,
      sha256: createHash('sha256').update(content).digest('hex'),
    });
  }
  const treeHash = createHash('sha256')
    .update(files.map((file) => `${file.path}\0${file.sha256}\n`).join('')).digest('hex');
  const manifest = { ...identity, appId: APP_ID, packageId: PACKAGE_ID, treeHash, files };
  await writeFile(path.join(root, 'dist', 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const manifest = await buildApp();
    console.log(`Built ${manifest.appId} v${manifest.version}\nCommit ${manifest.commit}\nTree ${manifest.treeHash}\n${manifest.files.length} files → dist/app; identity → dist/manifest.json`);
  } catch (error) {
    console.error(`Build failed: ${error.message}`);
    process.exitCode = 1;
  }
}
