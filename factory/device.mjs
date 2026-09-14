import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runAcceptance, acceptanceLimits, validateExpectedBuild } from './acceptance.mjs';
import { createMockAdapters } from './adapters/mock.mjs';
import { createRealAdapters } from './adapters/real.mjs';
import { AdapterError, exactKeys } from './adapters/process.mjs';

export const EXIT_CODES = Object.freeze({ PASS: 0, FAIL: 1, INCONCLUSIVE: 2 });

async function readBoundedJson(path, maxBytes = 1024 * 1024) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 2 || info.size > maxBytes) {
    throw new AdapterError('INVALID_CONFIG', 'JSON input must be a bounded regular file, not a symlink');
  }
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch { throw new AdapterError('INVALID_CONFIG', 'JSON input could not be parsed'); }
}

async function listAssets(directory, prefix = '') {
  const files = [];
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.length > 2000) throw new AdapterError('INVALID_MANIFEST', 'Too many application assets');
  for (const entry of entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (name.split('/').length > 20) throw new AdapterError('INVALID_MANIFEST', 'Application assets are nested too deeply');
    if (entry.isSymbolicLink()) throw new AdapterError('INVALID_MANIFEST', 'Application assets must not contain symlinks');
    if (entry.isDirectory()) files.push(...await listAssets(join(directory, entry.name), name));
    else if (entry.isFile()) files.push(name);
    else throw new AdapterError('INVALID_MANIFEST', 'Application assets must be regular files');
    if (files.length > 2000) throw new AdapterError('INVALID_MANIFEST', 'Too many application assets');
  }
  return files;
}

export async function verifyBuildManifest(config, expectedBuild = config.expectedBuild) {
  const expected = validateExpectedBuild(expectedBuild);
  const root = resolve(config.projectRoot ?? process.cwd());
  const appDir = await realpath(resolve(root, config.appDir ?? 'dist/app'));
  const manifestPath = resolve(root, config.manifestPath ?? 'dist/manifest.json');
  const manifest = await readBoundedJson(manifestPath);
  if (!exactKeys(manifest, ['schemaVersion', 'version', 'commit', 'buildId', 'mode', 'appId', 'packageId', 'treeHash', 'files'])
      || manifest.schemaVersion !== 1 || manifest.mode !== 'production'
      || manifest.appId !== 'TzOneDrive.PhotoViewer' || manifest.packageId !== 'TzOneDrive'
      || typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+$/u.test(manifest.version)
      || typeof manifest.treeHash !== 'string' || !/^[a-f0-9]{64}$/u.test(manifest.treeHash)
      || !Array.isArray(manifest.files) || manifest.files.length < 1 || manifest.files.length > 2000) {
    throw new AdapterError('INVALID_MANIFEST', 'Build manifest is incomplete or is not the production TzOneDrive package');
  }
  if (manifest.commit !== expected.commit || manifest.buildId !== expected.buildId) {
    throw new AdapterError('BUILD_MISMATCH', 'Build manifest differs from the independently requested commit and build ID');
  }
  const paths = new Set();
  let totalBytes = 0;
  for (const file of manifest.files) {
    if (!exactKeys(file, ['path', 'size', 'sha256']) || typeof file.path !== 'string'
        || !file.path.startsWith('app/') || file.path.split('/').some((part) => !part || part === '.' || part === '..')
        || file.path.includes('\\') || file.path.includes('\0') || paths.has(file.path)
        || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > 20 * 1024 * 1024
        || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(file.sha256)) {
      throw new AdapterError('INVALID_MANIFEST', 'Manifest contains an invalid, duplicate or unbounded asset');
    }
    paths.add(file.path);
    totalBytes += file.size;
    if (totalBytes > 128 * 1024 * 1024) throw new AdapterError('INVALID_MANIFEST', 'Application exceeds the total size limit');
    const assetPath = resolve(appDir, file.path.slice(4));
    if (!assetPath.startsWith(`${appDir}${sep}`)) throw new AdapterError('INVALID_MANIFEST', 'Asset escapes the application directory');
    const info = await lstat(assetPath);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== file.size) throw new AdapterError('ARTIFACT_MISMATCH', 'Application file size or type differs from its manifest');
    const digest = createHash('sha256').update(await readFile(assetPath)).digest('hex');
    if (digest !== file.sha256) throw new AdapterError('ARTIFACT_MISMATCH', 'Application bytes differ from their manifest hash');
  }
  const actualFiles = (await listAssets(appDir)).map((file) => `app/${file}`);
  if (actualFiles.length !== paths.size || actualFiles.some((file) => !paths.has(file))) {
    throw new AdapterError('ARTIFACT_MISMATCH', 'Unmanifested application assets are present');
  }
  const treeHash = createHash('sha256').update(manifest.files.map((file) => `${file.path}\0${file.sha256}\n`).join('')).digest('hex');
  if (treeHash !== manifest.treeHash) throw new AdapterError('ARTIFACT_MISMATCH', 'Manifest tree hash does not match');
  const identity = await readBoundedJson(join(appDir, 'build.json'));
  if (identity.commit !== expected.commit || identity.buildId !== expected.buildId || identity.mode !== 'production') {
    throw new AdapterError('BUILD_MISMATCH', 'Packaged build identity differs from the requested build');
  }
  return manifest;
}

export async function runDevice({ operation, config, expectedBuild = config?.expectedBuild, dependencies = {} }) {
  const report = {
    schemaVersion: 1, operation, mode: config?.mode ?? 'unknown',
    status: 'INCONCLUSIVE', reasonCode: 'NOT_RUN', reason: 'Device operation has not completed',
    expectedBuild: null, observedBuild: null, gateEligible: false,
    publicArtifactsAllowed: config?.mode === 'mock',
    startedAt: new Date().toISOString(), completedAt: null,
    checks: {}, steps: [], evidence: [], diagnostics: null, artifact: null,
  };
  let timer;
  const controller = new AbortController();
  try {
    if (!['diagnostics', 'deploy', 'accept'].includes(operation) || !['real', 'mock'].includes(config?.mode)) {
      throw new AdapterError('INVALID_CONFIG', 'Select diagnostics, deploy or accept and explicit real or mock mode');
    }
    const actualConfig = { ...config, expectedBuild };
    const adapters = dependencies.adapters ?? (config.mode === 'real' ? createRealAdapters(actualConfig) : createMockAdapters(actualConfig));
    if (adapters.mode !== config.mode || (config.mode === 'real' && adapters.synthetic !== false)) {
      throw new AdapterError('MODE_MISMATCH', 'Mock adapters cannot satisfy a real device operation');
    }
    if (operation === 'accept') return await runAcceptance({ config: actualConfig, adapters, expectedBuild });
    const limits = acceptanceLimits(config);
    const deadline = Date.now() + limits.totalMs;
    const bounded = async (fn, maximum = limits.operationMs) => {
      const remaining = Math.min(maximum, deadline - Date.now());
      if (remaining <= 0) throw new AdapterError('TIMEOUT', 'Device operation deadline exceeded');
      try {
        return await Promise.race([
          Promise.resolve().then(() => fn(controller.signal)),
          new Promise((_, reject) => {
            timer = setTimeout(() => {
              controller.abort();
              reject(new AdapterError('TIMEOUT', 'Device operation deadline exceeded'));
            }, remaining);
          }),
        ]);
      } finally { clearTimeout(timer); }
    };
    if (operation === 'diagnostics') {
      report.diagnostics = await bounded((signal) => adapters.diagnostics({ signal }), Math.min(limits.totalMs, 120_000));
      const ready = config.mode === 'mock' || [
        'sdkAvailable', 'sdbAvailable', 'ffmpegAvailable', 'cameraAvailable', 'remoteAvailable', 'detectorAvailable',
      ].every((key) => report.diagnostics[key] === true);
      report.status = ready ? 'PASS' : 'INCONCLUSIVE';
      report.reasonCode = ready ? 'DIAGNOSTICS_READY' : 'BOOTSTRAP_REQUIRED';
      report.reason = ready ? 'Local adapter prerequisites found; no physical acceptance was performed' : 'Install/configure the missing local SDK, camera, or operator-owned bridge/decoder';
      return report;
    }
    report.expectedBuild = validateExpectedBuild(expectedBuild);
    if (config.mode === 'real') await bounded(() => verifyBuildManifest(actualConfig));
    report.checks.manifest = 'PASS';
    if (await bounded((signal) => adapters.connect({ signal })) !== true) throw new AdapterError('DISCONNECTED', 'SDB did not report the configured device as connected');
    report.checks.connected = 'PASS';
    const artifact = await bounded((signal) => adapters.preparePackage({ signal }), 120_000);
    if (!artifact || typeof artifact.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(artifact.sha256)
        || artifact.synthetic !== (config.mode === 'mock')) {
      throw new AdapterError('INVALID_PACKAGE', 'Package metadata is invalid or synthetic');
    }
    report.artifact = { name: artifact.name, sha256: artifact.sha256, synthetic: artifact.synthetic };
    report.checks.signedPackage = 'PASS';
    if (await bounded((signal) => adapters.install({ artifact, signal }), 120_000) !== true) throw new AdapterError('INSTALL_FAILED', 'The widget could not be installed');
    report.checks.installed = 'PASS';
    if (await bounded((signal) => adapters.launch({ signal })) !== true) throw new AdapterError('LAUNCH_FAILED', 'The widget could not be launched');
    report.checks.launched = 'PASS';
    report.status = 'PASS';
    report.reasonCode = 'DEPLOYED_NOT_ACCEPTED';
    report.reason = 'Package preparation, install and launch completed; independent camera acceptance is still required';
    return report;
  } catch (error) {
    report.status = ['BUILD_MISMATCH', 'ARTIFACT_MISMATCH'].includes(error.code) ? 'FAIL' : 'INCONCLUSIVE';
    report.reasonCode = typeof error.code === 'string' ? error.code : 'UNAVAILABLE';
    report.reason = error instanceof AdapterError ? error.message : 'Required configuration, build files or adapters are unavailable';
    return report;
  } finally {
    clearTimeout(timer);
    controller.abort();
    report.completedAt = new Date().toISOString();
  }
}

export function parseDeviceArguments(argv) {
  const [operation, ...args] = argv;
  if (!['deploy', 'accept', 'diagnostics'].includes(operation)) throw new AdapterError('USAGE', 'Use deploy|accept|diagnostics --config FILE [--report FILE] [--expected-commit SHA --expected-build-id ID]');
  const options = { operation };
  const names = { '--config': 'configPath', '--report': 'reportPath', '--expected-commit': 'commit', '--expected-build-id': 'buildId' };
  for (let index = 0; index < args.length; index += 2) {
    const name = names[args[index]];
    const value = args[index + 1];
    if (!name || Object.hasOwn(options, name) || !value || value.startsWith('--')) throw new AdapterError('USAGE', 'Unknown, duplicate or incomplete device option');
    options[name] = value;
  }
  if (!options.configPath || Boolean(options.commit) !== Boolean(options.buildId)) throw new AdapterError('USAGE', 'Explicit --config and a complete expected build override are required');
  return options;
}

async function writeLocalReport(path, report) {
  const root = await realpath(process.cwd());
  const destination = resolve(path);
  if (!destination.startsWith(`${root}${sep}`)) throw new AdapterError('INVALID_CONFIG', 'Report must remain in a local project subdirectory');
  const directory = dirname(destination);
  let current = root;
  for (const segment of relative(root, directory).split(sep).filter(Boolean)) {
    current = join(current, segment);
    await mkdir(current, { recursive: true, mode: 0o700 });
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new AdapterError('INVALID_CONFIG', 'Report directory must not contain symlinks');
  }
  await writeFile(destination, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  await chmod(destination, 0o600);
}

async function main() {
  let report;
  try {
    const options = parseDeviceArguments(process.argv.slice(2));
    const config = await readBoundedJson(resolve(options.configPath));
    if (config.mode === 'real' && !isAbsolute(options.configPath)) {
      throw new AdapterError('INVALID_CONFIG', 'Real mode requires an explicit absolute operator-owned config path');
    }
    const expectedBuild = options.commit ? { commit: options.commit, buildId: options.buildId } : config.expectedBuild;
    report = await runDevice({ operation: options.operation, config, expectedBuild });
    if (options.reportPath) await writeLocalReport(options.reportPath, report);
  } catch (error) {
    report = {
      schemaVersion: 1, operation: 'invalid', mode: 'unknown', status: 'INCONCLUSIVE',
      reasonCode: error.code ?? 'UNAVAILABLE', reason: error instanceof AdapterError ? error.message : 'Local device invocation failed',
      gateEligible: false, publicArtifactsAllowed: false,
    };
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = EXIT_CODES[report.status];
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
