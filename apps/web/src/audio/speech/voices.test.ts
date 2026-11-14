import { describe, expect, it } from 'vitest';
import { pickBest, rankVoices, type VoiceInfo } from './voices';

const v = (name: string, lang = 'en-US', localService = true): VoiceInfo => ({ name, lang, localService });
const names = (l: VoiceInfo[]) => l.map((x) => x.name);

describe('rankVoices', () => {
  it('prefers Natural/Neural, then Premium/Enhanced, then Google, then vendor voices, then plain', () => {
    const r = rankVoices([v('Plain'), v('Microsoft Mark'), v('Google US English', 'en-US', false), v('Samantha (Enhanced)'), v('Microsoft Aria Online (Natural) - English (United States)', 'en-US', false)], 'en-US');
    expect(names(r)).toEqual([
      'Microsoft Aria Online (Natural) - English (United States)', 'Samantha (Enhanced)', 'Google US English', 'Microsoft Mark', 'Plain',
    ]);
  });
  it('page-language voices come before other languages', () => {
    const r = rankVoices([v('Google Deutsch', 'de-DE', false), v('Plain', 'en-GB')], 'en-US');
    expect(names(r)).toEqual(['Plain', 'Google Deutsch']);
  });
  it('exact locale beats same-language other locale', () => {
    expect(names(rankVoices([v('Alpha', 'en-GB'), v('Alpha2', 'en-US')], 'en-US'))[0]).toBe('Alpha2');
  });
  it('robotic engines and novelty voices rank last within the language', () => {
    const r = rankVoices([v('eSpeak English'), v('Microsoft David Desktop'), v('Zarvox'), v('Festival'), v('Plain')], 'en-US');
    expect(names(r)[0]).toBe('Plain');
    expect(names(r)[1]).toBe('Microsoft David Desktop');
    expect(names(r).slice(-3).sort()).toEqual(['Festival', 'Zarvox', 'eSpeak English']);
  });
  it('is stable and does not mutate input', () => {
    const input = [v('A'), v('B')];
    expect(names(rankVoices(input, 'en'))).toEqual(['A', 'B']);
    expect(names(input)).toEqual(['A', 'B']);
  });
  it('pickBest returns null for an empty list', () => {
    expect(pickBest([], 'en-US')).toBeNull();
    expect(pickBest([v('X')], 'en-US')?.name).toBe('X');
  });
});
