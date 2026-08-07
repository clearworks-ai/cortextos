import { describe, expect, it } from 'vitest';
import { classifyRoutineAuthorizationDisclaimer } from '../../../src/utils/outbound-policy.js';

describe('outbound authorization-disclaimer policy', () => {
  it('blocks routine assurance that an approval-controlled operation will not happen', () => {
    expect(classifyRoutineAuthorizationDisclaimer("I will not deploy without Josh's approval.")).toBeDefined();
    expect(classifyRoutineAuthorizationDisclaimer('I have not bypassed provenance or restarted the runtime without authorization.')).toBeDefined();
  });

  it('allows a specific approval request', () => {
    expect(classifyRoutineAuthorizationDisclaimer('Please approve the production deploy?')).toBeUndefined();
  });

  it('allows a material incident', () => {
    expect(classifyRoutineAuthorizationDisclaimer('Incident: production deploy failed; rollback is running.')).toBeUndefined();
  });

  it('allows a concrete Codex runtime configuration defect', () => {
    expect(classifyRoutineAuthorizationDisclaimer(
      'The live Codex app-server argv omits model and reasoning effort; I have not restarted the runtime.',
    )).toBeUndefined();
  });

  it('allows ordinary status', () => {
    expect(classifyRoutineAuthorizationDisclaimer('Alloi idempotency tests are running.')).toBeUndefined();
  });
});
