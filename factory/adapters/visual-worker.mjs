import { preflight, invokeRole } from '../cli.mjs';

// A separate process makes CLI inspection, inference and all descendants cancellable.
async function main() {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk.toString('utf8');
    if (input.length > 128 * 1024) throw new Error('INPUT_LIMIT');
  }
  const request = JSON.parse(input);
  if (!request || !['preflight', 'evaluate'].includes(request.operation)) throw new Error('INVALID_OPERATION');
  const result = request.operation === 'preflight'
    ? await preflight({ ...request.options, roles: ['visual'] })
    : await invokeRole({ ...request.options, role: 'visual' });
  process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`);
}

main().catch((error) => {
  process.stdout.write(`${JSON.stringify({ ok: false, code: error.code ?? 'INFERENCE_UNAVAILABLE' })}\n`);
});
