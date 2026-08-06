import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { GoalArtifact, GoalConfig, GoalRun } from '../types/goal-run.js';
export class GoalVerifier {
  constructor(private readonly config: GoalConfig) {}
  async verify(run: GoalRun): Promise<{ passed: boolean; results: Array<{ checkId: string; passed: boolean; duration: number; output: string; error?: string }>; artifacts: GoalArtifact[] }> {
    const results: Array<{ checkId: string; passed: boolean; duration: number; output: string; error?: string }> = []; const artifacts: GoalArtifact[] = [];
    for (const check of run.acceptanceChecks) { const started = Date.now(); let output = ''; let error: string | undefined; let passed = false; try { output = await this.executeCheck(check.command, check.timeoutMs || this.config.checkTimeoutMs, run.repo); passed = true; } catch (cause) { error = cause instanceof Error ? cause.message : String(cause); output = error; } const duration = Date.now() - started; results.push({ checkId: check.id, passed, duration, output, error }); artifacts.push({ id: randomUUID(), type: 'stdout', content: output, timestamp: new Date().toISOString(), metadata: { checkId: check.id, duration, passed } }); if (!passed && check.required) break; }
    return { passed: results.every(result => !run.acceptanceChecks.find(check => check.id === result.checkId)?.required || result.passed), results, artifacts };
  }
  private executeCheck(command: string[], timeoutMs: number, cwd: string): Promise<string> { if (!command.length) return Promise.reject(new Error('Acceptance check command is empty')); return new Promise((resolve, reject) => { const child = spawn(command[0], command.slice(1), { cwd, stdio: ['ignore', 'pipe', 'pipe'] }); let stdout = ''; let stderr = ''; const timeout = setTimeout(() => { child.kill('SIGTERM'); reject(new Error(`Acceptance check timed out after ${timeoutMs}ms: ${command.join(' ')}`)); }, timeoutMs); child.stdout.on('data', data => { stdout += String(data); }); child.stderr.on('data', data => { stderr += String(data); }); child.on('error', error => { clearTimeout(timeout); reject(error); }); child.on('close', code => { clearTimeout(timeout); if (code === 0) resolve(stdout + stderr); else reject(new Error(`Acceptance check failed (${code}): ${stderr || stdout}`)); }); }); }
}
