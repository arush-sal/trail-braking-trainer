// Explicit, reasoned skips for engines (never silent). Each reason points at docs/validation-log.md.
export const FIREFOX_VOICE_DOM =
  'Firefox headless on Linux exposes ~13k speech-dispatcher voices. The voice picker is now capped (<=~200 options), which fixed the recovery spec, but the eyes-free MOCK specs still lose the 60 Hz source mid-session on Firefox (alert/overlap assertions fail, 2/2 runs); cause not yet isolated (voice ranking of 13k voices or harness load). See docs/validation-log.md.';
export const FIREFOX_PW_CRASH =
  'Playwright Firefox build 1572: the content process SIGSEGVs when a role locator evaluates the results Round <select> after a source-gap retry (the same DOM reads fine via page.evaluate). Engine/harness crash, not app code. See docs/validation-log.md.';
export const WEBKIT_CSP =
  'WebKit (WPE build): securitypolicyviolation events were not observed for the route-injected CSP header, so the violation assertions cannot run; CSP enforcement is validated on Chromium and Firefox only. See docs/validation-log.md.';
