import { spawn } from 'node:child_process';
const children = [
  spawn('npm', ['run', 'dev', '-w', 'server'], { stdio: 'inherit' }),
  spawn('npm', ['run', 'dev', '-w', 'fe', '--', '--host', '127.0.0.1'], { stdio: 'inherit' }),
];
const stop = () => children.forEach((c) => c.kill('SIGTERM'));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const child of children)
  child.on('exit', (code) => {
    if (code) {
      process.exitCode = code;
      stop();
    }
  });
