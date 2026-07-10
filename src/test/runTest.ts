import * as cp from 'child_process';
import * as path from 'path';
import { downloadAndUnzipVSCode } from '@vscode/test-electron';

function testRunnerEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.VSCODE_IPC_HOOK;
  delete env.VSCODE_IPC_HOOK_CLI;
  return env;
}

async function main(): Promise<void> {
  const extensionDevelopmentPath = path.resolve(__dirname, '../..');
  const extensionTestsPath = path.resolve(__dirname, './suite/index');
  const cachePath = path.resolve(extensionDevelopmentPath, '.vscode-test');

  const vscodeExecutablePath = await downloadAndUnzipVSCode({ version: '1.95.0' });

  const args = [
    '--no-sandbox',
    '--disable-gpu-sandbox',
    '--disable-updates',
    '--skip-welcome',
    '--skip-release-notes',
    '--disable-workspace-trust',
    `--extensionTestsPath=${extensionTestsPath}`,
    `--extensionDevelopmentPath=${extensionDevelopmentPath}`,
    `--extensions-dir=${path.join(cachePath, 'extensions')}`,
    `--user-data-dir=${path.join(cachePath, 'user-data')}`,
  ];

  const exitCode = await new Promise<number>((resolve, reject) => {
    const child = cp.spawn(vscodeExecutablePath, args, {
      stdio: 'inherit',
      env: testRunnerEnv(),
    });
    child.on('error', reject);
    child.on('exit', (code) => resolve(code ?? 1));
  });

  if (exitCode !== 0) {
    throw new Error(`Integration tests failed with exit code ${exitCode}`);
  }
}

void main().catch((err) => {
  console.error('Integration tests failed:', err);
  process.exit(1);
});
