// Direct (non-durable) execution of one run: the same stage pipeline, with checkpoints in a local
// file and a FileSink instead of the app. Used by `harness:run` and by unit tests of stage logic.
import { join } from 'node:path';
import { runsDir } from '../lib/paths.mjs';
import { readJSON, writeJSON, nowIso } from '../lib/util.mjs';
import { FileSink, Recorder } from './recorder.mjs';
import { runStages } from './stages.mjs';

export async function runDirect({ runId, input, adapters, sink, log = () => {}, runsRoot, signal }) {
  const runDir = join(runsRoot ?? runsDir(), runId);
  sink ??= new FileSink(runDir);
  const recorder = new Recorder(runId, runDir, sink, log);
  const cpPath = join(runDir, 'checkpoints.json');
  const done = new Map(Object.entries(readJSON(cpPath, {})));
  const out = await runStages({ runId, workloadId: null, input, runDir, recorder, done, attemptNumber: 1, sink, adapters, signal }, {
    checkpoint: async (stage, data) => { const all = readJSON(cpPath, {}); all[stage] = data; writeJSON(cpPath, all); },
    stageReport: (stage, status, detail) => sink.stage({ runId, workloadId: null, attemptNumber: 1, fencingToken: null, stage, status, at: nowIso(), ...(detail ? { detail } : {}) }),
  });
  return { ...out, runDir, result: readJSON(join(runDir, 'result.json'), null) };
}
