import { WebSocket } from "ws";

export interface Session {
  streamSid: string;

  twilioConn?: WebSocket;
  modelConn?: WebSocket;
  frontendConn?: WebSocket;

  openAIApiKey: string;

  latestMediaTimestamp?: number;

  hasUserSpoken?: boolean;
  hasAssistantSpoken?: boolean;
  greetingTimer?: NodeJS.Timeout;

  // 🔴 REQUIRED for interruption
  lastAssistantItemId?: string;
  responseStartTimestamp?: number;
}

export interface FunctionSchema {
  name: string;
  type: "function";
  description?: string;
  parameters: any;
}

export interface FunctionHandler {
  schema: FunctionSchema;
  handler: (args: any) => Promise<string>;
}
