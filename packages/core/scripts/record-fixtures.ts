// Records real CBMC/ESBMC runs for the replay tests. Needs both engines, z3
// and bitwuzla-capable ESBMC installed. Run from the repo root:
//   npm run record-fixtures
import fs from 'node:fs';
import { Detector, LocalRunner, loadConfig, verify } from '@verifier/core';
import { RecordingRunner, saveRecording } from '@verifier/core/testing';
import { SCENARIOS, recordingPath, sourcePath } from '../test/scenarios';

// Defaults only (no environment overrides), so recorded command lines match
// what the tests replay.
const config = loadConfig({});
const detector = new Detector(config);
const engines = await detector.get();
for (const e of Object.values(engines)) {
  if (!e.available) throw new Error(`${e.label} is not installed; recording needs both engines`);
}

for (const s of SCENARIOS) {
  const runner = new RecordingRunner(new LocalRunner(1));
  const code = fs.readFileSync(sourcePath(s.file), 'utf8');
  const result = await verify({ ...s.request, code, fileName: s.file }, { config, runner, detector });
  saveRecording(recordingPath(s.name), { scenario: s.name, engines, runs: runner.runs });
  const size = fs.statSync(recordingPath(s.name)).size;
  console.log(
    `${s.name.padEnd(20)} ${result.status.padEnd(12)} ${JSON.stringify(result.counts)} ${runner.runs.length} runs, ${Math.round(size / 1024)} KB`,
  );
}
