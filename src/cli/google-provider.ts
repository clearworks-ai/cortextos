import { Command } from 'commander';
import { homedir } from 'os';
import { join } from 'path';
import { acquireGoogleDwdToken } from './google-dwd-credential.js';
import {
  calendarRegister, calendarRenew, calendarStatus, calendarStop,
  createDefaultGoogleProviderDependencies, gmailRenew, gmailStatus, gmailStop, gmailWatch,
  GoogleProviderLifecycleError, type CalendarIngressLifecycle, type GoogleProviderDependencies,
} from './google-provider-lifecycle.js';

type IngressModule = {
  writePendingCalendarShadowChannel: CalendarIngressLifecycle['writePending'];
  reconcileCalendarShadowChannel: CalendarIngressLifecycle['reconcile'];
  markCalendarShadowChannelCleanupRequired: CalendarIngressLifecycle['markCleanupRequired'];
  markCalendarShadowChannelStopped?: CalendarIngressLifecycle['markStopped'];
};

async function defaultDependencies(): Promise<GoogleProviderDependencies> {
  const root = process.env.CTX_ROOT || join(homedir(), '.cortextos', process.env.CTX_INSTANCE_ID || 'cortextos1');
  const frameworkRoot = process.env.CTX_FRAMEWORK_ROOT || process.cwd();
  const module = await import('./provider-shadow-ingress.js') as unknown as IngressModule;
  if (!module.writePendingCalendarShadowChannel || !module.reconcileCalendarShadowChannel || !module.markCalendarShadowChannelCleanupRequired || !module.markCalendarShadowChannelStopped) throw new GoogleProviderLifecycleError('calendar_ingress_unavailable');
  return createDefaultGoogleProviderDependencies(join(root, 'state', 'pa'), () => acquireGoogleDwdToken(frameworkRoot), {
    writePending: module.writePendingCalendarShadowChannel,
    reconcile: module.reconcileCalendarShadowChannel,
    markCleanupRequired: module.markCalendarShadowChannelCleanupRequired,
    markStopped: module.markCalendarShadowChannelStopped,
  });
}

function mutationOptions(command: Command): { apply?: boolean; approval?: string } {
  const options = command.opts<{ apply?: boolean; dryRun?: boolean; approval?: string }>();
  if (options.apply && options.dryRun) throw new GoogleProviderLifecycleError('provider_mode_conflict');
  return { apply: options.apply, approval: options.approval };
}
function addMutationOptions(command: Command): Command {
  return command.option('--dry-run', 'show the deterministic plan without provider calls (default)')
    .option('--apply', 'perform the provider mutation')
    .option('--approval <reference>', 'approval or runbook reference required with --apply');
}
function print(value: unknown): void { process.stdout.write(`${JSON.stringify(value)}\n`); }
export function createGoogleProviderCommand(loadDependencies: () => Promise<GoogleProviderDependencies> = defaultDependencies): Command {
  const root = new Command('google-provider').description('Deterministic Google provider lease lifecycle (read-only by default)');
  const gmail = new Command('gmail'); const calendar = new Command('calendar');
  const execute = (action: (deps: GoogleProviderDependencies) => unknown | Promise<unknown>) => async () => {
    try { print(await action(await loadDependencies())); }
    catch (error) { const code = error instanceof GoogleProviderLifecycleError ? error.code : 'provider_operation_failed'; process.stderr.write(`${code}\n`); process.exitCode = 1; }
  };
  gmail.addCommand(new Command('status').description('show redacted Gmail lease status').action(execute(gmailStatus)));
  gmail.addCommand(addMutationOptions(new Command('watch').description('create or replace the Gmail watch')).action((_options, command) => execute((deps) => gmailWatch(deps, mutationOptions(command)))()));
  gmail.addCommand(addMutationOptions(new Command('renew').description('renew Gmail watch when due')).action((_options, command) => execute((deps) => gmailRenew(deps, mutationOptions(command)))()));
  gmail.addCommand(addMutationOptions(new Command('stop').description('stop mailbox-wide Gmail notifications')).action((_options, command) => execute((deps) => gmailStop(deps, mutationOptions(command)))()));
  calendar.addCommand(new Command('status').description('show redacted Calendar channel status').action(execute(calendarStatus)));
  calendar.addCommand(addMutationOptions(new Command('register').description('register an overlapping Calendar channel')).action((_options, command) => execute((deps) => calendarRegister(deps, mutationOptions(command)))()));
  calendar.addCommand(addMutationOptions(new Command('renew').description('renew Calendar channels due within 24 hours')).action((_options, command) => execute((deps) => calendarRenew(deps, mutationOptions(command)))()));
  calendar.addCommand(addMutationOptions(new Command('stop').requiredOption('--channel <handle>', 'opaque local channel handle')).action((_options, command) => execute((deps) => calendarStop(deps, (command as Command).opts<{ channel: string }>().channel, mutationOptions(command as Command)))()));
  root.addCommand(gmail); root.addCommand(calendar); return root;
}

export const googleProviderCommand = createGoogleProviderCommand();
