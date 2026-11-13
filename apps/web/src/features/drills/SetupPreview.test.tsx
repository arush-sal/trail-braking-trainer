import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { SetupPreview, type PreviewData } from './SetupPreview';
import { PRESETS } from './presets';

afterEach(cleanup);
const def = PRESETS.find((p) => p.id === 'hold-brake-40')!.def;
const sp = PRESETS.find((p) => p.id === 'hold-brake-40-sp')!.def;
const data = (timed: boolean): PreviewData => ({ apiVersion: 1, timed, x: timed ? [0, 3000, 6000] : [0, 0.5, 1], values: { brake: [0.4, 0.4, 0.4] }, phases: [{ index: 0, startX: 0 }] });

describe('SetupPreview', () => {
  it('draws one polyline per control from injected samples (timed: seconds axis)', () => {
    render(<SetupPreview def={def} previewSamples={() => data(true)} />);
    expect(screen.getByRole('img').getAttribute('aria-label')).toMatch(/brake/i);
    expect(document.querySelectorAll('polyline')).toHaveLength(1);
    expect(screen.getByText(/Time \(s\)/)).toBeTruthy();
  });

  it('self-paced is labelled as normalized progress with no live target', () => {
    render(<SetupPreview def={sp} previewSamples={() => data(false)} />);
    expect(screen.getByText(/Normalized progress/)).toBeTruthy();
    expect(screen.getByText(/no live desired target/i)).toBeTruthy();
  });

  it('without a sampler, says the preview is unavailable and draws nothing', () => {
    render(<SetupPreview def={def} />);
    expect(document.querySelectorAll('polyline')).toHaveLength(0);
    expect(screen.getByText(/preview unavailable/i)).toBeTruthy();
  });
});
