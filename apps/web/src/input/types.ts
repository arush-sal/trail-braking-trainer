export type Axis = 'brake' | 'steering' | 'throttle';
export type InputSource = 'gamepad' | 'gt7' | 'mock';

export type Measurement = {
  available: boolean;
  rawValue: number | null;
  rawUnit: string;
  normalized: number | null;
  calibrationId?: string;
};

export type InputFrame = {
  schemaVersion: 1;
  source: InputSource;
  sourceId: string;
  sequence?: number;
  receivedMonoMs: number;
  sourceTimestampMs?: number;
  brake: Measurement; // normalized [0,1] when supported
  steering: Measurement; // signed; unit semantics unresolved until live validation
  throttle: Measurement; // normalized [0,1] when supported
  quality: { gap: boolean; stale: boolean; calibrated: boolean };
};
