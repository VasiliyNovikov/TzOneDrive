import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertState, createState, runLoop } from './controller.mjs';
import { atomicWriteJson, withStore } from './store.mjs';

export { runLoop } from './controller.mjs';
const hash = (value) => createHash('sha256').update(value).digest('hex');
export const MOCK_SCENARIOS = ['pass', 'navigation-failure', 'missing-camera', 'fallback', 'transient', 'crash', 'no-progress'];

export async function createMockAdapter({ stateDir, scenario = 'pass' } = {}) {
  if (!MOCK_SCENARIOS.includes(scenario)) throw new Error(`Unknown mock scenario: ${scenario}`);
  const ledgerPath = stateDir ? join(stateDir, 'mock-effects.json') : null;
  let ledger = { scenario, effects: {}, calls: {}, transientDone: false, crashed: false };
  if (ledgerPath) {
    try { ledger = JSON.parse(await readFile(ledgerPath, 'utf8')); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (ledger.scenario !== scenario) throw new Error('Cannot change the scenario of an existing mock run');
  }
  const save = async () => { if (ledgerPath) await atomicWriteJson(ledgerPath, ledger); };
  return {
    ledger,
    async execute(action, task, context) {
      const key = context.idempotencyKey;
      ledger.calls[key] = (ledger.calls[key] ?? 0) + 1;
      if (ledger.effects[key]) { await save(); return structuredClone(ledger.effects[key]); }
      if (scenario === 'transient' && action === 'implement' && !ledger.transientDone) {
        ledger.transientDone = true;
        await save();
        return { transient: true, message: 'SIMULATED rate limit' };
      }
      if (scenario === 'no-progress' && action === 'implement') {
        await save();
        return { pending: true, simulated: true, nextPollAt: context.now + 1000, jobId: 'SIMULATED-stuck-job' };
      }
      const evidence = context.evidence;
      const result = { verdict: 'PASS', simulated: true, label: 'SIMULATED — NOT PHYSICAL ACCEPTANCE' };
      switch (action) {
        case 'plan':
          result.plan = 'SIMULATED plan for the trusted goal; no commands are executed.';
          break;
        case 'implement':
        case 'repair':
          result.headSha = hash(key).slice(0, 40);
          if (action === 'repair') result.prNumber = evidence.pr.prNumber;
          break;
        case 'pr':
          result.prNumber = 100 + Object.values(ledger.effects).filter((item) => item.prNumber).length;
          result.headSha = evidence.implement.headSha;
          result.url = `https://example.invalid/SIMULATED/pull/${result.prNumber}`;
          break;
        case 'validate':
          result.headSha = evidence.pr.headSha;
          result.testedSha = result.headSha;
          result.ciPassed = true;
          result.independentReview = { verdict: 'PASS', independent: true, reviewer: 'SIMULATED-validator' };
          result.package = {
            headSha: result.headSha,
            buildId: `SIMULATED-build-${result.headSha.slice(0, 12)}`,
            sha256: hash(`SIMULATED-package-${result.headSha}`),
          };
          break;
        case 'merge':
          result.merged = true;
          result.headSha = evidence.validate.testedSha;
          result.mergeSha = hash(`SIMULATED-merge-${result.headSha}`).slice(0, 40);
          break;
        case 'deploy':
          if (context.completionTarget === 'browser-preview') {
            Object.assign(result, {
              target: 'browser-preview',
              result: 'browser-preview-complete',
              headSha: evidence.validate.testedSha,
              candidateHeadSha: evidence.validate.testedSha,
              mergeSha: evidence.merge.mergeSha,
              buildId: evidence.merge.mergeSha,
              publishedBuildId: evidence.merge.mergeSha,
              artifactBuildId: evidence.merge.mergeSha,
              packageSha256: evidence.validate.package.sha256,
              testedPackageSha256: evidence.validate.package.sha256,
              workflow: 'web-preview.yml',
              workflowRunId: 101,
              artifactId: 202,
              deploymentId: 303,
              environment: 'github-pages',
              url: 'https://vasiliynovikov.github.io/TzOneDrive/',
              testedTree: hash(`SIMULATED-tree-${evidence.validate.testedSha}`).slice(0, 40),
              mergedTree: hash(`SIMULATED-tree-${evidence.validate.testedSha}`).slice(0, 40),
              label: 'SIMULATED browser preview — NOT PHYSICAL ACCEPTANCE',
            });
          } else {
            Object.assign(result, {
              headSha: evidence.validate.testedSha,
              buildId: evidence.validate.package.buildId,
              packageSha256: evidence.validate.package.sha256,
              deviceMode: scenario === 'fallback' ? 'emulator' : 'mock',
              deviceId: 'SIMULATED-TV',
              installed: true,
              launched: true,
            });
          }
          break;
        case 'accept':
          for (const field of ['headSha', 'buildId', 'packageSha256', 'deviceMode', 'deviceId']) result[field] = evidence.deploy[field];
          result.navigation = { verdict: 'PASS' };
          result.camera = { verdict: 'PASS', source: 'SIMULATED', artifact: 'SIMULATED-camera-frame' };
          if (scenario === 'missing-camera') {
            result.verdict = 'INCONCLUSIVE';
            result.camera = { verdict: 'INCONCLUSIVE', reason: 'SIMULATED camera unavailable' };
          } else if (scenario === 'navigation-failure' && !task.sourceTaskId) {
            result.verdict = 'FAIL';
            result.navigation = { verdict: 'FAIL', reason: 'SIMULATED Back navigation failed' };
          }
          break;
        default: throw new Error(`Unknown action: ${action}`);
      }
      ledger.effects[key] = structuredClone(result);
      if (scenario === 'crash' && action === 'implement' && !ledger.crashed) {
        ledger.crashed = true;
        await save();
        throw new Error('SIMULATED crash after side effect; restart the same command to recover the intent');
      }
      await save();
      return result;
    },
  };
}

function parseArgs(argv) {
  const [command = 'mock', ...rest] = argv;
  if (!['mock', 'real'].includes(command)) throw new Error('Usage: node factory/main.mjs mock|real [--state-dir PATH] [--goal TEXT] [--tasks FILE] [--completion-target physical-tv|browser-preview]');
  const options = { command, stateDir: resolve('.factory-local'), completionTarget: 'physical-tv' };
  const names = {
    '--state-dir': 'stateDir', '--scenario': 'scenario', '--goal': 'goal',
    '--tasks': 'tasksFile', '--max-actions': 'maxActions', '--experiment-ms': 'experimentMs',
    '--completion-target': 'completionTarget',
  };
  for (let i = 0; i < rest.length; i += 2) {
    const name = names[rest[i]];
    if (!name || rest[i + 1] === undefined) throw new Error(`Unknown option or missing value: ${rest[i]}`);
    options[name] = rest[i + 1];
  }
  if (options.goal && options.tasksFile) throw new Error('Use either --goal or --tasks, not both');
  if (options.scenario && command !== 'mock') throw new Error('--scenario is only valid for mock runs');
  if (!['physical-tv', 'browser-preview'].includes(options.completionTarget)) throw new Error('Invalid completion target');
  options.stateDir = resolve(options.stateDir);
  return options;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  return withStore(options.stateDir, async (store) => {
    let state = await store.load();
    if (state) {
      assertState(state);
      if (state.mode !== options.command) throw new Error('Cannot reuse mock state for real execution, or vice versa');
      if ((state.completionTarget ?? 'physical-tv') !== options.completionTarget) throw new Error('Existing completion target is immutable');
      if (options.goal || options.tasksFile) {
        const proposed = options.tasksFile ? JSON.parse(await readFile(resolve(options.tasksFile), 'utf8')) :
          [{ id: 'goal', goal: options.goal }];
        const identity = ({ id, goal, dependsOn }) => ({ id, goal, dependsOn });
        const normalized = createState(proposed, {
          now: state.createdAt, mode: state.mode, limits: state.limits,
          completionTarget: state.completionTarget ?? 'physical-tv',
        });
        if (JSON.stringify(normalized.tasks.map(identity)) !==
            JSON.stringify(state.tasks.filter((task) => !task.sourceTaskId).map(identity))) {
          throw new Error('Existing trusted backlog is immutable');
        }
      }
      for (const name of ['maxActions', 'experimentMs']) {
        if (options[name] !== undefined && Number(options[name]) !== state.limits[name]) {
          throw new Error('Existing run limits are immutable');
        }
      }
      if (options.scenario && options.scenario !== (state.mockScenario ?? 'pass')) {
        throw new Error('Cannot change the scenario of an existing mock run');
      }
    } else {
      let tasks;
      if (options.tasksFile) tasks = JSON.parse(await readFile(resolve(options.tasksFile), 'utf8'));
      else if (options.goal) tasks = [{ id: 'goal', goal: options.goal }];
      else if (options.command === 'mock') tasks = [{ id: 'demo', goal: 'Verify the SIMULATED TV factory lifecycle.' }];
      else throw new Error('A new real run requires --goal TEXT or --tasks trusted-backlog.json');
      const limits = {};
      if (options.maxActions !== undefined) limits.maxActions = Number(options.maxActions);
      if (options.experimentMs !== undefined) limits.experimentMs = Number(options.experimentMs);
      state = createState(tasks, { mode: options.command, limits, completionTarget: options.completionTarget });
      if (options.command === 'mock') state.mockScenario = options.scenario ?? 'pass';
      await store.save(state);
    }
    let adapter;
    if (['delivered', 'blocked'].includes(state.status) || await store.shouldStop()) {
      adapter = { execute() { throw new Error('A stopped or completed run cannot dispatch actions'); } };
    } else if (options.command === 'mock') {
      adapter = await createMockAdapter({ stateDir: store.directory, scenario: state.mockScenario ?? 'pass' });
    }
    else {
      const module = await import('./github-adapter.mjs');
      if (typeof module.createAdapter !== 'function') throw new Error('github-adapter.mjs must export createAdapter(options)');
      adapter = await module.createAdapter({ ...options, stateDir: store.directory, mode: 'real' });
    }
    if (typeof adapter?.execute !== 'function') throw new Error('Adapter must expose execute(action, task, context)');
    state = await runLoop(state, adapter, {
      persist: store.save,
      stop: store.shouldStop,
      virtualTime: options.command === 'mock',
    });
    console.log(JSON.stringify({
      status: state.status,
      mode: state.mode,
      completionTarget: state.completionTarget ?? 'physical-tv',
      simulated: state.simulated,
      notice: state.simulated ? 'SIMULATED ONLY: does not prove real-device or live browser publication' :
        (state.completionTarget === 'browser-preview' ? 'Browser preview publication evidence required' : 'Physical evidence required'),
      stateDir: store.directory,
      actionCount: state.actionCount,
      nextWakeAt: state.nextWakeAt,
      tasks: state.tasks.map(({ id, status, stage, blockedReason, delivery, result }) => ({ id, status, stage, blockedReason, delivery, result })),
    }, null, 2));
    return state;
  });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
