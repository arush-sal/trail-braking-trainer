// Types for the MOCK collector (server.mjs), used by TypeScript integration tests.
import type { WebSocket } from 'ws';

export type MockCollectorOptions = {
  host?: string;
  port?: number;
  path?: string;
  origins?: string[];
  token?: string;
  maxClients?: number;
  maxInboundBytes?: number;
  maxFrameBytes?: number;
  hz?: number;
  heartbeatMs?: number;
  queueMax?: number;
  highWaterBytes?: number;
  helloTimeoutMs?: number;
  rateLimitPerSec?: number;
  isSlow?: (ws: WebSocket) => boolean;
  log?: (msg: string) => void;
};
export type MockCollector = {
  port: number;
  url: string;
  clientCount(): number;
  setPaused(paused: boolean): void;
  close(): Promise<void>;
};
export function startMockCollector(opts?: MockCollectorOptions): Promise<MockCollector>;
export function syntheticSample(ms: number): { brake: number; throttle: number };
