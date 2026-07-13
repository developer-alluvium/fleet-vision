const { spawn } = require('child_process');

const goPath = "C:\\Program Files\\Go\\bin\\go.exe";

console.log("Starting TCP Gateway using absolute Go path...");

const child = spawn(goPath, ['run', '.'], {
  stdio: 'inherit',
  shell: false
});

child.on('error', (err) => {
  console.error("Failed to start Go:", err);
});
