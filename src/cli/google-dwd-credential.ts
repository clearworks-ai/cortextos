import { spawn } from 'child_process';
import { join } from 'path';

export async function acquireGoogleDwdToken(frameworkRoot: string): Promise<string> {
  const helper = join(frameworkRoot, 'orgs', 'clearworksai', 'agents', 'pa', 'scripts', 'google_dwd_credentials.py');
  return new Promise((resolve, reject) => {
    const child = spawn('python3', [helper, '--print-token'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'PYTHONPATH')),
    });
    let stdout = ''; let stderrBytes = 0;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { if (stdout.length <= 16_384) stdout += chunk; });
    child.stderr.on('data', (chunk: Buffer) => { stderrBytes += chunk.length; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000); timer.unref();
    child.once('error', () => { clearTimeout(timer); reject(new Error('provider_credential_unavailable')); });
    child.once('close', (code) => {
      clearTimeout(timer); const token = stdout.trim();
      if (code !== 0 || stderrBytes > 8_192 || !token || token.length > 16_384 || /[\r\n]/.test(token)) reject(new Error('provider_credential_unavailable'));
      else resolve(token);
    });
  });
}
