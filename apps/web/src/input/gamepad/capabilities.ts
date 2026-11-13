export type Capabilities = {
  gamepadApi: boolean;
  speechRecognition: boolean; // detection only; behavior unverified
  audioContext: boolean;
  secureContext: boolean;
};

export function detectCapabilities(g: Record<string, unknown> = globalThis as unknown as Record<string, unknown>): Capabilities {
  const nav = g.navigator as { getGamepads?: unknown } | undefined;
  return {
    gamepadApi: typeof nav?.getGamepads === 'function',
    speechRecognition: 'SpeechRecognition' in g || 'webkitSpeechRecognition' in g,
    audioContext: 'AudioContext' in g || 'webkitAudioContext' in g,
    secureContext: g.isSecureContext === true,
  };
}
