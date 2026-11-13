// Test double for the Web Audio surface used by SonifyEngine.
import type { CtxLike } from '../synth/ToneEngine';

export class FakeParam {
  value = 0;
  calls: Array<[string, number]> = [];
  setTargetAtTime(v: number) { this.value = v; this.calls.push(['target', v]); return this; }
  setValueAtTime(v: number) { this.value = v; this.calls.push(['set', v]); return this; }
  linearRampToValueAtTime(v: number) { this.calls.push(['ramp', v]); return this; }
  cancelScheduledValues() { return this; }
}
export class FakeNode {
  id: number;
  type = 'sine';
  frequency = new FakeParam();
  gain = new FakeParam();
  out: FakeNode[] = [];
  started: number[] = [];
  stopped: number[] = [];
  onended: (() => void) | null = null;
  constructor(public kind: 'osc' | 'gain' | 'dest', id: number) { this.id = id; }
  connect(n: FakeNode) { this.out.push(n); return n; }
  disconnect() { this.out = []; }
  start(t = 0) { this.started.push(t); }
  stop(t = 0) { this.stopped.push(t); }
  /** True if `target` is reachable downstream of this node. */
  reaches(target: FakeNode, seen = new Set<FakeNode>()): boolean {
    if (this === target) return true;
    if (seen.has(this)) return false;
    seen.add(this);
    return this.out.some((n) => n.reaches(target, seen));
  }
}
export function fakeCtx() {
  const nodes: FakeNode[] = [];
  const mk = (k: 'osc' | 'gain' | 'dest') => { const n = new FakeNode(k, nodes.length); nodes.push(n); return n; };
  const dest = mk('dest');
  const ctx = {
    state: 'suspended' as string, currentTime: 1, baseLatency: 0.01, destination: dest,
    onstatechange: null as null | (() => void),
    resume: async () => { ctx.state = 'running'; ctx.onstatechange?.(); },
    close: async () => { ctx.state = 'closed'; ctx.onstatechange?.(); },
    createOscillator: () => mk('osc'),
    createGain: () => mk('gain'),
  };
  return { ctx: ctx as unknown as CtxLike, raw: ctx, nodes, dest };
}
