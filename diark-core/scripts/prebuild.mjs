import { execSync } from 'node:child_process';

// Close any running instance of diark-core to prevent "Access is denied (os error 5)" on Windows
try {
  if (process.platform === 'win32') {
    execSync('taskkill /F /IM diark-core.exe', { stdio: 'ignore' });
  } else {
    execSync('pkill -f diark-core', { stdio: 'ignore' });
  }
} catch {
  // Not running, perfectly normal
}
