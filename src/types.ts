import { WebSocket } from "ws";

export type SessionState =
  | "connected"
  | "greeting"
  | "listening"
  | "speaking"
  | "closed";

export interface Session {
  streamSid: string;

  // Connections
  twilioConn: WebSocket;
  modelConn?: WebSocket;
  frontendConn?: WebSocket;

  // Timing & state
  latestMediaTimestamp: number;
  state: SessionState;
  hasUserSpoken: boolean;
  hasAssistantSpoken: boolean;
  greetingTimer?: NodeJS.Timeout;

  // Interrupts
  lastAssistantItemId?: string;
  responseStartTimestamp?: number;

  // Limits & tracking
  functionCalls: number;
  interrupts: number;
  startedAt: number;
  fallbackCount: number;
}

export interface FunctionSchema<T = any> {
  name: string;
  type: "function";
  description?: string;
  parameters: T;
}

export interface FunctionHandler<TArgs = any> {
  schema: FunctionSchema;
  handler: (args: TArgs) => Promise<string>;
}
