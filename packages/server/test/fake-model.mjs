// A stand-in for an OpenAI-compatible model server, for smoke tests of the
// repair loop without a model API key (CI runs it next to the Docker image).
// It patches the sample: first by gutting store (which the behavior proof
// must reject), then with the honest fix (which must be accepted).
//
//   node packages/server/test/fake-model.mjs packages/core/test/fixtures/c/arith.c 4011
import fs from 'node:fs';
import http from 'node:http';
import process from 'node:process';

const [file, port = '4011'] = process.argv.slice(2);
const original = fs.readFileSync(file, 'utf8');
const avg = (c) => c.replace('return (a + b) / 2;', 'return (int32_t)(((int64_t)a + b) / 2);');
const answers = [
  avg(original).replace('if (idx <= 16) {\n        buf[idx] = v;\n    }', '(void)idx;\n    (void)v;'),
  avg(original).replace('idx <= 16', 'idx < 16'),
];

let n = 0;
http
  .createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const code = answers[Math.min(n++, answers.length - 1)];
      const content = JSON.stringify({ rationale: `Scripted answer ${n}.`, code });
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({ model: 'fake-model', choices: [{ finish_reason: 'stop', message: { content } }] }),
      );
    });
  })
  .listen(Number(port), '127.0.0.1');
