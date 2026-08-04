const { spawn } = require('child_process');

const fs = require('fs');

let goPath = 'go';
if (process.platform === 'win32') {
  const winDefault = "C:\\Program Files\\Go\\bin\\go.exe";
  if (fs.existsSync(winDefault)) {
    goPath = winDefault;
  }
} else {
  const path = require('path');
  const linuxCandidates = [
    '/usr/local/go/bin/go',
    '/usr/bin/go',
    path.join(process.env.HOME || '', 'go', 'bin', 'go')
  ];
  for (const candidate of linuxCandidates) {
    if (fs.existsSync(candidate)) {
      goPath = candidate;
      break;
    }
  }
}

console.log(`Starting TCP Gateway using Go binary (${goPath})...`);

const child = spawn(goPath, ['run', '.'], {
  stdio: 'inherit',
  shell: true
});

child.on('error', (err) => {
  console.error("Failed to start Go:", err);
});
