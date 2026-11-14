import { describe, expect, it } from 'vitest';
import { LOW_HZ, audioHelp, commandFailed, coreLoadHelp, slowInputHelp, startHelp } from './recovery';

describe('recovery texts (spec 8 error handling)', () => {
  it('core load failure: says what is affected and how to recover', () => {
    const net = coreLoadHelp('Failed to fetch core.wasm: HTTP 404');
    expect(net).toMatch(/HTTP 404/);
    expect(net).toMatch(/Retry/);
    expect(net).toMatch(/reload/i);
    expect(net).toMatch(/diagnostics/);
    const unsupported = coreLoadHelp('This browser does not support WebAssembly; the core cannot run.');
    expect(unsupported).toMatch(/current Chrome, Edge, Firefox or Safari/);
    expect(unsupported).not.toMatch(/Retry/);
  });

  it('slow input warns below the proposed threshold only while input arrives', () => {
    expect(slowInputHelp(0)).toBeNull(); // no input is a different state (source lost / stopped)
    expect(slowInputHelp(LOW_HZ)).toBeNull();
    expect(slowInputHelp(60)).toBeNull();
    expect(slowInputHelp(12)).toMatch(/12 Hz.*visible/);
  });

  it('audio suspended / interrupted / closed have a recovery path; running and locked do not warn', () => {
    expect(audioHelp('running')).toBeNull();
    expect(audioHelp('locked')).toBeNull();
    expect(audioHelp('suspended')).toMatch(/suspended.*Enable session audio/);
    expect(audioHelp('suspended', true)).toMatch(/interrupted.*Enable session audio/);
    expect(audioHelp('closed')).toMatch(/Reload/);
  });

  it('start failures: missing channel and missing source are explained with a fix', () => {
    const s = startHelp('controls: steering: not available from the current source');
    expect(s).toMatch(/Steering is not available/);
    expect(s).toMatch(/GT7/);
    expect(s).toMatch(/without steering/);
    expect(startHelp('controls: brake: not available from the current source')).not.toMatch(/GT7/);
    expect(startHelp('no live input source')).toMatch(/Start the MOCK input.*Input devices.*collector/);
    expect(startHelp('something else')).toBe('something else');
  });

  it('spoken command failures are short and name the missing channel', () => {
    expect(commandFailed('start', 'controls: steering: not available from the current source')).toBe('Cannot start. Steering not available from this source.');
    expect(commandFailed('start', 'no live input source')).toBe('Cannot start. No live input.');
    expect(commandFailed('complete', 'nope')).toBe('Cannot complete now.');
  });
});
