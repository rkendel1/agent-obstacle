// Adapter registry. Controls are labelled `control: true` and are never reported as agents.
import { stackAgentAdapter } from './stack-agent.mjs';
import { patchAgent } from './patch-agent.mjs';
import { referenceControl, nullControl } from './controls.mjs';

export const ADAPTERS = {
  'stack-agent': stackAgentAdapter,
  'patch-agent': patchAgent,
  'reference-control': referenceControl,
  'null-control': nullControl,
};

export function getAdapter(id, registry = ADAPTERS) {
  const a = registry[id];
  if (!a) throw Object.assign(new Error(`unknown agent adapter "${id}"`), { failureClass: 'harness' });
  return a;
}
