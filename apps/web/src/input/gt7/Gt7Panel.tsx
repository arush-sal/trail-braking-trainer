import { useEffect, useRef, useState } from 'react';
import type { InputFrame } from '../types';
import { createGt7Client, queryLnaPermission, type Gt7Client, type Gt7ClientOptions, type Gt7Counters, type Gt7Status } from './gt7Client';
import { DEFAULT_URL, PROTOCOL, browserWarnings, lnaPermissionFor, rejectionHint, sourceIdFor, unavailableFrame, type Hello } from './protocol';

const origin = () => globalThis.location?.origin ?? 'http://localhost:5173';
const pct = (v: number | null | undefined) => (v == null ? 'n/a' : `${Math.round(v * 100)}%`);

type Props = {
  /** Called once per accepted sample; epoch changes on every (re)connect - never merge across epochs. */
  onFrame?: (frame: InputFrame, epoch: number) => void;
  createClient?: (o: Gt7ClientOptions) => Gt7Client;
};

export function Gt7Panel({ onFrame, createClient = createGt7Client }: Props) {
  const [url, setUrl] = useState(DEFAULT_URL);
  const [token, setToken] = useState(''); // in memory only; offered as a subprotocol, never persisted or put in the URL
  const [status, setStatus] = useState<Gt7Status | 'idle'>('idle');
  const [hello, setHello] = useState<Hello | null>(null);
  const [error, setError] = useState('');
  const [lna, setLna] = useState('');
  const [warnings, setWarnings] = useState<string[]>([]);
  const [view, setView] = useState<{ frame: InputFrame | null; counters: Gt7Counters | null }>({ frame: null, counters: null });
  const client = useRef<Gt7Client | null>(null);
  const latest = useRef<InputFrame | null>(null);
  const live = useRef<{ live: boolean; sourceId: string }>({ live: false, sourceId: 'gt7' });
  const onFrameRef = useRef(onFrame);
  // Bumped by every Connect, Disconnect and unmount: a stale async connect must not open a socket.
  const gen = useRef(0);
  useEffect(() => {
    onFrameRef.current = onFrame;
  });

  // Sample-rate data goes to refs; the UI refreshes at 4 Hz (spec 4.1: no re-render per sample).
  useEffect(() => {
    if (status === 'idle' || status === 'closed') return;
    const id = setInterval(() => setView({ frame: latest.current, counters: client.current?.counters() ?? null }), 250);
    return () => clearInterval(id);
  }, [status]);
  useEffect(
    () => () => {
      gen.current++;
      client.current?.close();
      client.current = null;
    },
    [],
  );

  // Only ever called from the Connect click: LNA prompts must come from a user gesture.
  const connect = async () => {
    const mine = ++gen.current;
    client.current?.close();
    client.current = null;
    setError('');
    setWarnings(browserWarnings(url, globalThis.location?.protocol ?? 'http:', globalThis.navigator?.userAgent ?? ''));
    const perm = lnaPermissionFor(url);
    const state = await queryLnaPermission(url);
    if (mine !== gen.current) return; // superseded by Disconnect, unmount or a later Connect
    setLna(perm ? `${perm}: ${state}` : '');
    if (state === 'denied') {
      setError(rejectionHint(state, origin()));
      return;
    }
    setHello(null);
    latest.current = null;
    client.current = createClient({
      url,
      token: token || undefined,
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
          if (e.status === 'live') setError('');
          setStatus(e.status);
        } else if (e.type === 'hello') {
          live.current.sourceId = sourceIdFor(e.hello.sessionId);
          setHello(e.hello);
        } else if (e.type === 'error') setError(e.code === 'unreachable' ? rejectionHint(state, origin()) : e.message);
        else if (e.type === 'source-lost')
          setError(`Collector reports the GT7 source stale (${e.reason}): no accepted packets within its --ws-source-timeout. Samples are invalid until it resumes (GT7 paused, in menus, or PS5 unreachable).`);
      },
    });
  };
  const disconnect = () => {
    gen.current++;
    client.current?.close();
    client.current = null;
    setStatus('closed');
  };

  const f = view.frame;
  const c = view.counters;
  const caps = hello?.capabilities;
  return (
    <section aria-label="GT7 collector">
      <h2>GT7 collector ({PROTOCOL})</h2>
      <p>
        Needs gt7-telemetry-collector v0.3.0 or later running on this computer, for example:{' '}
        <code data-testid="run-cmd">{`gt7-collector --ps5=<ps5-ip> --rtps=none --ws-listen=127.0.0.1:8765 --ws-origin=${origin()}`}</code>. Not yet
        verified with a live PS5 from this app. Steering is never available from GT7.
      </p>
      <label>
        Collector URL <input value={url} onChange={(e) => setUrl(e.target.value)} />
      </label>
      <label>
        Token (optional) <input type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} />
      </label>
      <button onClick={() => void connect()}>Connect</button>
      <button onClick={disconnect}>Disconnect</button>
      <p>
        Status: <strong>{status}</strong>
        {status === 'waiting' && ' (collector connected, no GT7 packets yet: check --ps5 and that GT7 is running)'}
        {hello && ` (collector ${hello.collectorVersion}, ${PROTOCOL}, session ${hello.sessionId.slice(0, 8)})`}
      </p>
      {lna && <p data-testid="lna">Local network permission: {lna}</p>}
      {warnings.map((w) => (
        <p key={w}>{w}</p>
      ))}
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
                <td>{caps[k].available ? `${caps[k].unit} 0-100` : caps[k].reason ?? 'unavailable'}</td>
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
        frames {c?.frames ?? 0} | gaps {c?.gaps ?? 0} (missing {c?.missing ?? 0}) | source gaps {c?.sourceGaps ?? 0} | dups {c?.duplicates ?? 0} | out-of-order {c?.outOfOrder ?? 0} | reconnects {c?.reconnects ?? 0}
      </p>
    </section>
  );
}
