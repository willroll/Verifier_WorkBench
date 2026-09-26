// Records real CBMC/ESBMC runs for the replay tests. Needs both engines, z3
// and bitwuzla-capable ESBMC installed. Run from the repo root:
//   npm run record-fixtures
import fs from 'node:fs';
import { Detector, LocalRunner, checkEquivalence, loadConfig, repair, verify } from '@verifier/core';
import { RecordingRunner, saveRecording } from '@verifier/core/testing';
import {
  EQ_CHECKS,
  EQ_SCENARIOS,
  REPAIR_SCENARIOS,
  SCENARIOS,
  ScriptedProposer,
  applyEdits,
  recordingPath,
  sourcePath,
} from '../test/scenarios';

// Defaults only (no environment overrides), so recorded command lines match
// what the tests replay. The repair limit does not change any command line.
const config = loadConfig({ REPAIR_MAX_ITERS: '6' });
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

const save = (name: string, runner: RecordingRunner, summary: string) => {
  saveRecording(recordingPath(name), { scenario: name, engines, runs: runner.runs });
  const size = fs.statSync(recordingPath(name)).size;
  console.log(`${name.padEnd(24)} ${summary} ${runner.runs.length} runs, ${Math.round(size / 1024)} KB`);
};

for (const s of EQ_SCENARIOS) {
  const runner = new RecordingRunner(new LocalRunner(1));
  const original = fs.readFileSync(sourcePath(s.file), 'utf8');
  const report = await checkEquivalence(
    {
      original,
      candidate: applyEdits(original, s.edits),
      fileName: s.file,
      checks: [...EQ_CHECKS],
      unwind: config.defaultUnwind,
      solver: s.solver,
    },
    { config, runner, detector },
  );
  const summary = report.rejection
    ? `rejected (${report.rejection.guard})`
    : report.results.map((r) => `${r.function}:${r.status}`).join(' ') || 'nothing to prove';
  save(s.name, runner, summary);
}

for (const s of REPAIR_SCENARIOS.filter((x) => !x.recording)) {
  const runner = new RecordingRunner(new LocalRunner(1));
  const code = fs.readFileSync(sourcePath(s.file), 'utf8');
  const proposer = new ScriptedProposer(code, s.answers);
  const result = await repair(
    { ...s.request, code, fileName: s.file },
    { config, runner, detector, proposer },
  );
  save(s.name, runner, `${result.status} [${result.iterations.map((i) => i.outcome).join(', ')}]`);
}
