import { useEffect, useState } from 'react';
import { AXES, createGamepadAdapter, type DeviceInfo, type Mappings, type PadLike } from '../../input/gamepad/adapter';
import { suggestionFor, applySuggestion } from '../../input/gamepad/suggestions';
import { detectCapabilities } from '../../input/gamepad/capabilities';
import { defaultMapping, type Kind, type Mapping } from '../../input/gamepad/normalize';
import type { Axis, InputFrame } from '../../input/types';

const DISPLAY_MS = 100; // ~10 Hz UI refresh; polls never trigger renders
const LABEL: Record<Axis, string> = { brake: 'Brake', steering: 'Steering', throttle: 'Throttle' };
const fmt = (v: number | null | undefined, d = 3) => (v === null || v === undefined ? 'n/a' : v.toFixed(d));
const pct = (v: number | null, signed: boolean) =>
  v === null ? 'n/a' : `${signed && v > 0 ? '+' : ''}${Math.round(v * 100)}%`;
const ms = (v: number | null) => (v === null ? 'n/a' : `${v.toFixed(1)} ms`);

export type DevicesPanelProps = {
  /** Receives every polled InputFrame (not rate-limited); route to audio/WASM. */
  onFrame?: (frame: InputFrame) => void;
  getGamepads?: () => readonly (PadLike | null)[];
  /** Every poll: device button values and the training-input mappings (App uses the mappings to keep training inputs out of command bindings). */
  onPads?: (pads: readonly DeviceInfo[], mappings: Mappings) => void;
};

export function DevicesPanel({ onFrame, getGamepads, onPads }: DevicesPanelProps) {
  const [adapter] = useState(() =>
    createGamepadAdapter({
      getGamepads: getGamepads ?? (() => (navigator.getGamepads ? navigator.getGamepads() : [])),
    }),
  );
  const [view, setView] = useState(() => ({ ...adapter.snapshot(), stats: adapter.stats() }));
  const [detecting, setDetecting] = useState<Axis | null>(null);
  const [report, setReport] = useState('');
  const caps = detectCapabilities();

  useEffect(() => {
    adapter.setOnFrame((f) => {
      onFrame?.(f);
      if (onPads) {
        const s = adapter.snapshot();
        onPads(s.devices, s.mappings);
      }
    });
  }, [adapter, onFrame, onPads]);

  useEffect(() => {
    adapter.start();
    const id = setInterval(() => setView({ ...adapter.snapshot(), stats: adapter.stats() }), DISPLAY_MS);
    return () => {
      clearInterval(id);
      adapter.stop();
    };
  }, [adapter]);

  const edit = (axis: Axis, patch: Partial<Mapping>) => {
    const cur = view.mappings[axis];
    if (cur) adapter.setMapping(axis, { ...cur, ...patch });
  };
  const detect = (axis: Axis) => {
    setDetecting(axis);
    adapter.startDetect((d) => {
      adapter.setMapping(axis, defaultMapping(d.deviceId, d.kind, d.index));
      setDetecting(null);
    });
  };
  const copy = () => {
    const text = JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        userAgent: navigator.userAgent,
        capabilities: caps,
        devices: view.devices,
        mappings: view.mappings,
        stats: { ...view.stats, visibilityLog: undefined },
        visibilityLog: view.stats.visibilityLog,
        events: view.stats.events,
      },
      null,
      2,
    );
    setReport(text);
    navigator.clipboard?.writeText(text).catch(() => undefined); // best effort; <pre> is the fallback
  };

  const st = view.stats;
  return (
    <section aria-labelledby="devices-h">
      <h2 id="devices-h">Input devices (diagnostics)</h2>
      <p role="note">Hardware behavior here is unverified until recorded in docs/validation-log.md.</p>

      {view.stats.error && (
        <p role="alert">
          Cannot read gamepads ({view.stats.error}). Check that the page is allowed to use gamepads (secure context, browser
          permissions policy, not in a restricted iframe), then reload. Polling continues and will recover automatically.
        </p>
      )}

      <h3>Devices</h3>
      {view.devices.length === 0 && <p>No gamepads detected. Press a button or move a control on the device.</p>}
      {view.devices.map((d) => (
        <article key={d.key} aria-label={d.key}>
          <h4>
            {d.id} (index {d.index}, mapping &quot;{d.mapping || 'none'}&quot;)
          </h4>
          <p>
            {d.axes.length} axes, {d.buttons.length} buttons - {d.hz} Hz (value changes), {d.unchanged} unchanged polls, timestamp {d.timestamp} (diagnostic only)
          </p>
          <p>
            Raw id: <code>{d.id}</code> - VID:PID {d.vid ? `${d.vid}:${d.pid}` : 'unknown'}
          </p>
          {(() => {
            const sg = suggestionFor(d.vid ? { vid: d.vid, pid: d.pid! } : null);
            if (!sg) return null;
            return (
              <div>
                <p>
                  {sg.label}. {sg.note} <a href={sg.source}>source</a>
                </p>
                {sg.pedalInvert && (
                  <button
                    type="button"
                    onClick={() => {
                      const out = applySuggestion(sg, view.mappings, d.key);
                      for (const a of AXES) if (out[a] !== view.mappings[a]) adapter.setMapping(a, out[a] ?? null);
                    }}
                  >
                    Apply suggestion (invert mapped pedal axes)
                  </button>
                )}
              </div>
            );
          })()}
          <table>
            <tbody>
              <tr>
                {d.axes.map((v, i) => (
                  <td key={i}>
                    A{i}: <span data-testid={`raw-axis-${i}`}>{fmt(v)}</span>
                  </td>
                ))}
              </tr>
              <tr>
                {d.buttons.map((v, i) => (
                  <td key={i}>
                    B{i}: <span data-testid={`raw-button-${i}`}>{fmt(v)}</span>
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </article>
      ))}

      <h3>Mapping</h3>
      {AXES.map((axis) => {
        const m = view.mappings[axis];
        const pads = view.devices.map((d) => d.key);
        const L = LABEL[axis];
        const capturing = adapter.isCapturing(axis);
        return (
          <fieldset key={axis}>
            <legend>{L}</legend>
            <label>
              {L} device{' '}
              <select
                value={m?.deviceId ?? ''}
                onChange={(e) =>
                  e.target.value ? adapter.setMapping(axis, defaultMapping(e.target.value, 'axis', 0)) : adapter.setMapping(axis, null)
                }
              >
                <option value="">(unmapped)</option>
                {m && !pads.includes(m.deviceId) && <option value={m.deviceId}>{m.deviceId} (disconnected)</option>}
                {pads.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
            </label>
            {m && (
              <>
                <label>
                  {L} kind{' '}
                  <select value={m.kind} onChange={(e) => adapter.setMapping(axis, defaultMapping(m.deviceId, e.target.value as Kind, m.index))}>
                    <option value="axis">axis</option>
                    <option value="button">button (analog)</option>
                  </select>
                </label>
                <label>
                  {L} index{' '}
                  <input type="number" min={0} value={m.index} onChange={(e) => edit(axis, { index: Math.max(0, Number(e.target.value) || 0) })} />
                </label>
                <label>
                  <input type="checkbox" aria-label={`${L} invert`} checked={m.invert} onChange={(e) => edit(axis, { invert: e.target.checked })} /> Invert
                </label>
                <label>
                  {L} deadzone (0-0.9){' '}
                  <input type="number" min={0} max={0.9} step={0.01} value={m.deadzone} onChange={(e) => edit(axis, { deadzone: Math.min(0.9, Math.max(0, Number(e.target.value) || 0)) })} />
                </label>
                <p>
                  range {fmt(m.min, 2)}..{fmt(m.max, 2)}, center {fmt(m.center, 2)}, {m.calibrated ? 'calibrated' : 'uncalibrated (defaults, unverified)'}
                </p>
                <button type="button" onClick={() => (capturing ? adapter.stopRangeCapture(axis) : adapter.startRangeCapture(axis))}>
                  {capturing ? `Stop range capture (${L})` : `Calibrate range (${L})`}
                </button>
                {axis === 'steering' && (
                  <button type="button" onClick={() => adapter.setCenterFromCurrent(axis)}>
                    Set center (hold wheel straight)
                  </button>
                )}
              </>
            )}
            <button type="button" onClick={() => detect(axis)} disabled={detecting === axis}>
              {detecting === axis ? `Move the ${L.toLowerCase()} control now...` : `Detect ${L} control`}
            </button>
          </fieldset>
        );
      })}

      <h3>Normalized</h3>
      <dl>
        {AXES.map((a) => (
          <div key={a}>
            <dt>{LABEL[a]}</dt>
            <dd data-testid={`norm-${a}`}>{pct(view.frame?.[a].normalized ?? null, a === 'steering')}</dd>
          </div>
        ))}
      </dl>

      <h3>Polling</h3>
      <p>
        {st.polls} polls, {st.missedPolls} missed (interval gaps). Visible interval p50 {ms(st.visibleIntervals.p50)} / p95 {ms(st.visibleIntervals.p95)} / max {ms(st.visibleIntervals.max)}. Hidden interval p50 {ms(st.hiddenIntervals.p50)} / p95 {ms(st.hiddenIntervals.p95)} / max {ms(st.hiddenIntervals.max)} ({st.hiddenIntervals.count} samples).
      </p>
      <h3>Visibility log</h3>
      <ul>
        {st.visibilityLog.map((v, i) => (
          <li key={i}>
            {v.atMs.toFixed(0)} ms: {v.state}
          </li>
        ))}
      </ul>
      <p>Gaps while hidden: {st.gaps.filter((g) => g.hidden).length}</p>
      <h3>Source events</h3>
      {st.events.length === 0 && <p>none</p>}
      <ul role="log">
        {st.events.map((e, i) => (
          <li key={i}>
            {e.atMs.toFixed(0)} ms: {e.type} {e.axis ?? ''} {e.deviceId ?? e.message ?? ''}{e.type === 'source-ambiguous' ? ' - identical controllers, reselect the device in Mapping' : ''}
          </li>
        ))}
      </ul>

      <h3>Capabilities</h3>
      <ul>
        <li>Gamepad API: {caps.gamepadApi ? 'present' : 'absent'}</li>
        <li>SpeechRecognition / webkitSpeechRecognition: {caps.speechRecognition ? 'present (detection only)' : 'absent'}</li>
        <li>AudioContext: {caps.audioContext ? 'present' : 'absent'}</li>
        <li>Secure context: {caps.secureContext ? 'yes' : 'no'}</li>
      </ul>

      <button type="button" onClick={copy}>
        Copy diagnostics report
      </button>
      {report && <pre data-testid="report">{report}</pre>}
    </section>
  );
}
