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
  
  // Escalation
  escalationTriggered?: boolean;
  negativeEmotionCount?: number;

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