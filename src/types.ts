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
  // Greeting Handling
  greetingTimer?: NodeJS.Timeout;
  // Silence Handling
  idleTimer?: NodeJS.Timeout;
  silenceTimer?: NodeJS.Timeout;

  // 🔴 REQUIRED for interruption
  lastAssistantItemId?: string;
  responseStartTimestamp?: number;

  // Escalation
  escalationTriggered?: boolean;
  negativeEmotionCount?: number;

  isModelErr?: boolean;
  callerState?: string;

  // Call metadata
  callSid?: string;
  fromPhoneNumber?: string;
  toPhoneNumber?: string;
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


// State Handler 

export interface StateHandler {
  turn: string,
  callState: string
}