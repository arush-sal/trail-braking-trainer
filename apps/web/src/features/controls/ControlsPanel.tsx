import { memo, useEffect, useReducer, useState } from 'react';
import { ACTIONS, ACTION_LABEL, type Action, type Bindings } from '../../controls/bindings';
import type { Voice } from '../../controls/voice';
import { TOGGLEABLE, type Announcer, type Toggleable } from '../../audio/speech/announcer';

const TOGGLE_LABEL: Record<Toggleable, string> = {
  instructions: 'Exercise instructions', countdown: 'Countdown', roundSummary: 'Round summaries', sessionSummary: 'Session summary',
};
const MIC_TEXT: Record<Voice['status'], string> = {
  idle: 'Voice commands off.',
  listening: 'Listening for commands.',
  denied: 'Microphone permission denied. Allow it in the browser site settings, or use keys and buttons.',
  unsupported: 'Voice commands are not supported in this browser. Use keys and buttons.',
  error: 'Microphone or recognition error. Use keys and buttons.',
  network: 'Speech service unreachable. Use keys and buttons.',
};

export type ControlsPanelProps = { bindings: Bindings; voice: Voice; announcer: Announcer };

// memo: props are stable page services, so the App's 10 Hz readout tick does not re-render (and
// re-reconcile a possibly >10k-entry voice <select>) here; updates arrive via the subscriptions below.
export const ControlsPanel = memo(function ControlsPanel({ bindings, voice, announcer }: ControlsPanelProps) {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const [ack, setAck] = useState(false);
  const [enabled, setEnabled] = useState(() => Object.fromEntries(TOGGLEABLE.map((c) => [c, announcer.isEnabled(c)])) as Record<Toggleable, boolean>);
  const [rate, setRate] = useState(announcer.rate);
  const [voiceName, setVoiceName] = useState('');
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    const offs = [bindings.subscribe(bump), voice.subscribe(bump), announcer.onVoicesChanged(bump)];
    return () => offs.forEach((f) => f());
  }, [bindings, voice, announcer]);

  const { keys, buttons } = bindings.list();
  const { learning, message } = bindings.state();
  const on = voice.status === 'listening';
  const ranked = announcer.rankedVoices();
  const prefix = announcer.lang.toLowerCase().split('-')[0]!;
  // Some browsers expose thousands of voices: keep the DOM bounded (page-language voices first, then capped "all").
  const pool = showAll ? ranked : ranked.filter((v) => v.lang.toLowerCase().replace('_', '-').split('-')[0] === prefix);
  const voices = pool.slice(0, showAll ? 200 : 50);
  const chosen = voiceName && !voices.some((v) => v.name === voiceName) ? ranked.find((v) => v.name === voiceName) : undefined;
  if (chosen) voices.push(chosen);
  const hidden = ranked.length - voices.length;
  const auto = announcer.activeVoice();

  return (
    <section aria-labelledby="controls-h">
      <h2 id="controls-h">Controls</h2>

      <div role="status" aria-live="polite">
        {learning ? (learning.kind === 'keyboard' ? 'Press a key to bind' : 'Press a gamepad button to bind') + ` for ${ACTION_LABEL[learning.action]}.` : message}
        {learning && <button type="button" onClick={() => bindings.cancelLearn()}>Cancel</button>}
      </div>

      <table>
        <caption>Command bindings (training inputs are never usable as command buttons)</caption>
        <thead><tr><th scope="col">Command</th><th scope="col">Keys</th><th scope="col">Gamepad buttons</th></tr></thead>
        <tbody>
          {ACTIONS.map((a: Action) => (
            <tr key={a}>
              <th scope="row">{ACTION_LABEL[a]}</th>
              <td>
                {keys.filter((k) => k.action === a).map((k) => (
                  <span key={k.code}>
                    <kbd>{k.code.replace(/^Key/, '')}</kbd>
                    <button type="button" aria-label={`Clear key ${k.code.replace(/^Key/, '')}`} onClick={() => bindings.unbindKey(k.code)}>x</button>{' '}
                  </span>
                ))}
                <button type="button" aria-label={`Learn key for ${ACTION_LABEL[a]}`} onClick={() => bindings.learn(a, 'keyboard')}>Learn key</button>
              </td>
              <td>
                {buttons.filter((b) => b.action === a).map((b) => (
                  <span key={`${b.deviceId}:${b.index}`}>
                    <span>{b.deviceId} button {b.index}</span>
                    <button type="button" aria-label={`Clear button ${b.index} on ${b.deviceId}`} onClick={() => bindings.unbindButton(b.deviceId, b.index)}>x</button>{' '}
                  </span>
                ))}
                <button type="button" aria-label={`Learn button for ${ACTION_LABEL[a]}`} onClick={() => bindings.learn(a, 'gamepad')}>Learn button</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3>Voice commands</h3>
      <p>
        Voice recognition is done by your browser and may be sent to a remote service, depending on the browser
        and its settings. It is not guaranteed to work offline or in every browser. Commands: start, pause, resume,
        done, skip, stop (say stop twice to confirm). Keys and buttons always work.
      </p>
      {voice.supported && (voice.locality === 'on-device-requested' ? (
        <p>On-device recognition is requested for the active recognizer. Your browser decides the final processing; this is not an offline guarantee.</p>
      ) : (
        <p><strong>Voice audio may be processed remotely by your browser&apos;s speech service.</strong> On-device speech is used only if it is installed and the active recognizer reports it.</p>
      ))}
      {voice.supported && (
        <button type="button" onClick={() => void voice.refreshOnDevice()}>Check on-device speech</button>
      )}
      {voice.supported && voice.onDevice === 'downloadable' && (
        <button type="button" onClick={() => void voice.installOnDevice()}>Install on-device speech</button>
      )}
      {voice.supported && voice.onDevice === 'downloading' && <p>On-device speech is downloading.</p>}
      <p role="status" aria-label="Microphone status">
        {MIC_TEXT[voice.status]}
        {voice.status === 'listening' && (voice.locality === 'on-device-requested' ? ' On-device recognition requested.' : ' Recognition may use a remote service.')}
        {voice.suppressed && ' Paused while the app speaks.'}
      </p>
      {voice.supported && (
        <>
          {!on && (
            <label>
              <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> I have read the privacy notice
            </label>
          )}{' '}
          {on ? (
            <button type="button" onClick={() => voice.disable()}>Disable voice commands</button>
          ) : (
            <button type="button" disabled={!ack} onClick={() => void voice.enable({ privacyAcknowledged: ack })}>Enable voice commands</button>
          )}
        </>
      )}

      <h3>Spoken feedback</h3>
      {!announcer.supported && <p role="status">Speech output is not available in this browser. Audio tones still work.</p>}
      {TOGGLEABLE.map((c) => (
        <div key={c}>
          <label>
            <input
              type="checkbox" checked={enabled[c]}
              onChange={(e) => { announcer.setEnabled(c, e.target.checked); setEnabled({ ...enabled, [c]: e.target.checked }); }}
            />{' '}{TOGGLE_LABEL[c]}
          </label>
        </div>
      ))}
      <p>Source loss, errors and command rejections are always spoken.</p>
      {announcer.supported && (
        <>
          <label>
            Speech rate {rate.toFixed(1)}{' '}
            <input type="range" min={0.5} max={2} step={0.1} value={rate} onChange={(e) => { const r = Number(e.target.value); announcer.setRate(r); setRate(announcer.rate); }} />
          </label>{' '}
          <div>
            <label>
              <input
                type="checkbox" checked={announcer.allowNetwork}
                onChange={(e) => { announcer.setAllowNetwork(e.target.checked); if (!e.target.checked) { setVoiceName(''); announcer.setVoice(null); } }}
              />{' '}Allow network voices: spoken text, including your results, may be sent to the browser vendor&apos;s speech service
            </label>
          </div>
          {announcer.networkOnly && (
            <p role="status">No local voice is installed. Round and session summaries are not spoken. Countdown and alerts use the browser default voice, which may be a network voice.</p>
          )}
          {ranked.length > 0 && (
            <label>
              Voice{' '}
              <select value={voiceName} onChange={(e) => { setVoiceName(e.target.value); announcer.setVoice(e.target.value || null); }}>
                <option value=''>Automatic{auto && voiceName === '' ? ` (${auto.name})` : ''}</option>
                {voices.map((v) => <option key={v.name} value={v.name} disabled={v.localService !== true && !announcer.allowNetwork}>{v.name} ({v.lang}, {v.localService === undefined ? 'unknown' : v.localService ? 'local' : 'network'})</option>)}
              </select>
            </label>
          )}{' '}
          {ranked.length > 0 && (
            <>
              <label>
                <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> Show all languages
              </label>
              {hidden > 0 && <span> {hidden} voices hidden.</span>}{' '}
            </>
          )}
          <button type="button" onClick={() => announcer.test()}>Test voice</button>
        </>
      )}
    </section>
  );
});
