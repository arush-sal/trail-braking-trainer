export type VoiceInfo = { name: string; lang: string; localService?: boolean; default?: boolean };

const NOVELTY = /\b(albert|bad news|bahh|bells|boing|bubbles|cellos|deranged|good news|hysterical|organ|trinoids|whisper|zarvox|jester|superstar|wobble)\b/i;
const ROBOTIC = /espeak|festival|flite|mbrola/i;
const OLD_DESKTOP = /microsoft (david|zira|mark|hazel|james|george)\b.*desktop|\bdesktop\b/i;

/** Heuristic naturalness score from voice name/flags; higher is better. Names vary by OS/browser, so this is best-effort. */
function score(v: VoiceInfo, lang: string): number {
  const want = lang.toLowerCase();
  const have = v.lang.toLowerCase().replace('_', '-');
  let s = 0;
  if (have.split('-')[0] === want.split('-')[0]) s += 1000;
  if (have === want) s += 50;
  if (/natural|neural/i.test(v.name)) s += 300;
  else if (/premium|enhanced/i.test(v.name)) s += 250;
  else if (/google/i.test(v.name)) s += 200;
  else if (/microsoft|apple/i.test(v.name)) s += 100;
  if (/compact/i.test(v.name)) s -= 40;
  if (OLD_DESKTOP.test(v.name)) s -= 150;
  if (ROBOTIC.test(v.name)) s -= 400;
  if (NOVELTY.test(v.name)) s -= 500;
  return s;
}

export function rankVoices<T extends VoiceInfo>(voices: readonly T[], lang: string): T[] {
  return voices.map((v, i) => ({ v, i, s: score(v, lang) })).sort((a, b) => b.s - a.s || a.i - b.i).map((x) => x.v);
}
export const pickBest = <T extends VoiceInfo>(voices: readonly T[], lang: string): T | null => rankVoices(voices, lang)[0] ?? null;
