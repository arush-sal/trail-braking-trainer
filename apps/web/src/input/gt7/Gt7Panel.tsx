import { useEffect, useRef, useState } from 'react';
import type { InputFrame } from '../types';
import { createGt7Client, type Gt7Client, type Gt7ClientOptions, type Gt7Counters, type Gt7Status } from './gt7Client';
import { unavailableFrame, type Welcome } from './protocol';

const DEFAULT_URL = 'ws://127.0.0.1:8787/v1/inputs';
const pct = (v: number | null | undefined) => (v == null ? 'n/a' : `${Math.round(v * 100)}%`);

type Props = {
  /** Called once per accepted sample; epoch changes on every (re)connect - never merge across epochs. */
  onFrame?: (frame: InputFrame, epoch: number) => void;
  createClient?: (o: Gt7ClientOptions) => Gt7Client;
};

export function Gt7Panel({ onFrame, createClient = createGt7Client }: Props) {
  const [url, setUrl] = useState(DEFAULT_URL);
  const [token, setToken] = useState(''); // in memory only; never persisted or put in the URL
  const [status, setStatus] = useState<Gt7Status | 'idle'>('idle');
  const [welcome, setWelcome] = useState<Welcome | null>(null);
  const [error, setError] = useState('');
  const [view, setView] = useState<{ frame: InputFrame | null; counters: Gt7Counters | null }>({ frame: null, counters: null });
  const client = useRef<Gt7Client | null>(null);
  const latest = useRef<InputFrame | null>(null);
  const live = useRef<{ live: boolean; sourceId: string }>({ live: false, sourceId: 'gt7' });
  const onFrameRef = useRef(onFrame);
  useEffect(() => {
    onFrameRef.current = onFrame;
  });

  // Sample-rate data goes to refs; the UI refreshes at 4 Hz (spec 4.1: no re-render per sample).
  useEffect(() => {
    if (status === 'idle' || status === 'closed') return;
    const id = setInterval(() => setView({ frame: latest.current, counters: client.current?.counters() ?? null }), 250);
    return () => clearInterval(id);
  }, [status]);
  useEffect(() => () => client.current?.close(), []);

  const connect = () => {
    client.current?.close();
    setError('');
    setWelcome(null);
    latest.current = null;
    client.current = createClient({
      url,
      pairingToken: token || undefined,
      onEvent: (e) => {
        if (e.type === 'frame') {
          latest.current = e.frame;
          onFrameRef.current?.(e.frame, e.epoch);
        } else if (e.type === 'status') {
          // Leaving 'live' (stale/reconnecting/error/closed): retract the last sample so consumers silence.
          if (live.current.live && e.status !== 'live') {
            const f = unavailableFrame(live.current.sourceId, performance.now());
            latest.current = f;
            onFrameRef.current?.(f, e.epoch);
          }
          live.current.live = e.status === 'live';
          setStatus(e.status);
        } else if (e.type === 'welcome') {
          live.current.sourceId = e.welcome.sourceId;
          setWelcome(e.welcome);
        }
        else if (e.type === 'error') setError(e.message);
        else if (e.type === 'source-lost') setError('Collector went silent (heartbeat timeout); samples are stale and invalid until reconnected.');
      },
    });
  };
  const disconnect = () => {
    client.current?.close();
    client.current = null;
    setStatus('closed');
  };

  const f = view.frame;
  const c = view.counters;
  const caps = welcome?.capabilities;
  return (
    <section aria-label="GT7 collector">
      <h2>GT7 collector (prototype)</h2>
      <label>
        Collector URL <input value={url} onChange={(e) => setUrl(e.target.value)} />
      </label>
      <label>
        Pairing token <input type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} />
      </label>
      <button onClick={connect}>Connect</button>
      <button onClick={disconnect}>Disconnect</button>
      <p>
        Status: <strong>{status}</strong>
        {welcome && ` (collector ${welcome.collectorVersion}, protocol v${welcome.version}, ${welcome.sourceId})`}
      </p>
      {error && <p role="alert">{error}</p>}
      {caps && (
        <table>
          <thead>
            <tr>
              <th>Channel</th>
              <th>Available</th>
              <th>Unit / note</th>
            </tr>
          </thead>
          <tbody>
            {(['brake', 'steering', 'throttle'] as const).map((k) => (
              <tr key={k}>
                <td>{k}</td>
                <td>{caps[k].available ? 'yes' : 'no'}</td>
                <td>{caps[k].available ? caps[k].rawUnit : caps[k].reason ?? 'unavailable'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p>
        B <span data-testid="brake">{pct(f?.brake.normalized)}</span> | S <span data-testid="steering">{pct(f?.steering.normalized)}</span> | T{' '}
        <span data-testid="throttle">{pct(f?.throttle.normalized)}</span>
      </p>
      <p data-testid="counters">
        frames {c?.frames ?? 0} | gaps {c?.gaps ?? 0} (missing {c?.missing ?? 0}) | dups {c?.duplicates ?? 0} | out-of-order {c?.outOfOrder ?? 0} | reconnects {c?.reconnects ?? 0}
      </p>
    </section>
  );
}
