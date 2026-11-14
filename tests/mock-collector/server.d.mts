// Types for the MOCK collector (server.mjs), used by TypeScript integration tests.
import type { WebSocket } from 'ws';

export type MockCollectorOptions = {
  host?: string;
  port?: number;
  origins?: string[];
  /** Like the collector's GT7_WS_TOKEN: offered by clients as the `gt7.token.<token>` subprotocol. */
  token?: string;
  maxClients?: number;
  hz?: number;
  queueMax?: number;
  highWaterBytes?: number;
  sourceTimeoutMs?: number;
  /** Start in waiting_for_source with no frames until setPaused(false). */
  startPaused?: boolean;
  isSlow?: (ws: WebSocket) => boolean;
  log?: (msg: string) => void;
};
export type MockCollector = {
  port: number;
  sessionId: string;
  url: string;
  clientCount(): number;
  received(): number;
  setPaused(paused: boolean): void;
  close(): Promise<void>;
};
export function startMockCollector(opts?: MockCollectorOptions): Promise<MockCollector>;
export function syntheticSample(ms: number): { brake: number; throttle: number };
