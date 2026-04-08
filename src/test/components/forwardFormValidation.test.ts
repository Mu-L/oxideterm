import { describe, expect, it } from 'vitest';
import { validateForwardForm } from '@/components/forwards/forwardFormValidation';

describe('validateForwardForm', () => {
  it('requires a bind port', () => {
    expect(
      validateForwardForm({
        forwardType: 'local',
        bindPort: '',
        targetPort: '8080',
      }),
    ).toEqual({ errorKey: 'forwards.form.port_required' });
  });

  it('rejects non-numeric bind ports', () => {
    expect(
      validateForwardForm({
        forwardType: 'local',
        bindPort: 'abc',
        targetPort: '8080',
      }),
    ).toEqual({ errorKey: 'forwards.form.port_invalid' });
  });

  it('rejects out-of-range bind ports', () => {
    expect(
      validateForwardForm({
        forwardType: 'local',
        bindPort: '70000',
        targetPort: '8080',
      }),
    ).toEqual({ errorKey: 'forwards.form.port_invalid' });
  });

  it('requires a target port for non-dynamic forwards', () => {
    expect(
      validateForwardForm({
        forwardType: 'remote',
        bindPort: '8080',
        targetPort: '',
      }),
    ).toEqual({ errorKey: 'forwards.form.port_required' });
  });

  it('ignores target port requirements for dynamic forwards', () => {
    expect(
      validateForwardForm({
        forwardType: 'dynamic',
        bindPort: '1080',
        targetPort: '',
      }),
    ).toEqual({ bindPort: 1080 });
  });

  it('returns parsed ports for valid local forwards', () => {
    expect(
      validateForwardForm({
        forwardType: 'local',
        bindPort: '8080',
        targetPort: '3000',
      }),
    ).toEqual({ bindPort: 8080, targetPort: 3000 });
  });
});