import { RawData, WebSocket } from "ws";
import functions from "./functionHandlers";
import { Session } from "./types";

const sessions = new Map<string, Session>();

export function handleCallConnection(ws: WebSocket, openAIApiKey: string) {
  ws.on("message", (data) => handleTwilioMessage(ws, data, openAIApiKey));
  ws.on("close", () => cleanupByTwilio(ws));
}

export function handleFrontendConnection(ws: WebSocket) {
  ws.on("message", (data) => {
    const msg = parse(data);
    if (!msg?.streamSid) return;
    const session = sessions.get(msg.streamSid);
    if (session) session.frontendConn = ws;
  });
}

// ------------------------ Core Logic ------------------------

function handleTwilioMessage(
  ws: WebSocket,
  data: RawData,
  openAIApiKey: string
) {
  const msg = parse(data);
  if (!msg) return;

  switch (msg.event) {
    case "start": {
      const streamSid = msg.start.streamSid;

      const session: Session = {
        streamSid,
        twilioConn: ws,
        latestMediaTimestamp: 0,
        hasUserSpoken: false,
        hasAssistantSpoken: false,
        state: "connected",
        functionCalls: 0,
        interrupts: 0,
        startedAt: Date.now(),
        fallbackCount: 0,
      };

      sessions.set(streamSid, session);
      connectModel(session, openAIApiKey);

      // Greeting / idle timer
      session.greetingTimer = setTimeout(() => {
        if (!session.hasUserSpoken && !session.hasAssistantSpoken) {
          sendGreeting(session);
        }
      }, 1000);

      break;
    }

    case "media": {
      const session = sessions.get(msg.streamSid);
      if (!session || !session.modelConn) return;

      if (!msg.media.payload) {
        sendFallback(session, "I didn’t hear anything. Could you repeat?");
        return;
      }

      session.latestMediaTimestamp = msg.media.timestamp;

      send(session.modelConn, {
        type: "input_audio_buffer.append",
        audio: msg.media.payload,
      });
      break;
    }

    case "close":
      closeSession(msg.streamSid);
      break;
  }
}

// ------------------------ AI Model Connection ------------------------

function connectModel(session: Session, openAIApiKey: string) {
  session.modelConn = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17",
    {
      headers: {
        Authorization: `Bearer ${openAIApiKey}`,
        "OpenAI-Beta": "realtime=v1",
      },
    }
  );

  session.modelConn.on("open", () => {
    send(session.modelConn!, {
      type: "session.update",
      session: {
        modalities: ["audio", "text"],
        voice: "ash",
        turn_detection: { type: "server_vad" },
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        input_audio_transcription: { model: "whisper-1" },
        instructions:
          "You are a professional AI voice assistant. Speak only English.",
      },
    });
  });

  session.modelConn.on("message", (data) => handleModelMessage(session, data));

  session.modelConn.on("error", () => sendFallback(session));
  session.modelConn.on("close", () => closeSession(session.streamSid));
}

// ------------------------ Model Event Handling ------------------------

function handleModelMessage(session: Session, data: RawData) {
  const event = parse(data);
  if (!event) return;

  if (event.type === "input_audio_buffer.speech_started") {
    session.hasUserSpoken = true;
    if (session.greetingTimer) {
      clearTimeout(session.greetingTimer);
      session.greetingTimer = undefined;
    }
    interruptAssistant(session);
  }

  if (event.type === "response.audio.delta") {
    session.hasAssistantSpoken = true;

    if (!session.responseStartTimestamp) {
      session.responseStartTimestamp = session.latestMediaTimestamp;
    }

    if (event.item_id) session.lastAssistantItemId = event.item_id;

    send(session.twilioConn!, {
      event: "media",
      streamSid: session.streamSid,
      media: { payload: event.delta },
    });
  }

  if (event.type === "response.output_item.done") {
    const item = event.item;
    if (item.type === "function_call") {
      safeRunFunction(item, session);
    }
  }

  session.frontendConn && send(session.frontendConn, event);
}

// ------------------------ Helper Functions ------------------------

function interruptAssistant(session: Session) {
  if (!session.lastAssistantItemId || session.responseStartTimestamp === undefined)
    return;

  const elapsedMs =
    (session.latestMediaTimestamp ?? 0) - (session.responseStartTimestamp ?? 0);

  send(session.modelConn!, {
    type: "conversation.item.truncate",
    item_id: session.lastAssistantItemId,
    content_index: 0,
    audio_end_ms: Math.max(0, elapsedMs),
  });

  send(session.twilioConn!, {
    event: "clear",
    streamSid: session.streamSid,
  });

  session.lastAssistantItemId = undefined;
  session.responseStartTimestamp = undefined;
  session.hasAssistantSpoken = false;
}

// Greeting
function sendGreeting(session: Session) {
  if (!session.modelConn || session.hasAssistantSpoken) return;

  session.hasAssistantSpoken = true;

  send(session.modelConn, {
    type: "conversation.item.create",
    item: {
      type: "message",
      role: "assistant",
      content: [
        {
          type: "output_text",
          text: "Hello, nice to meet you. What can I help you with?",
        },
      ],
    },
  });

  send(session.modelConn, { type: "response.create" });
}

// ------------------------ Fallback Feature ------------------------

function sendFallback(session: Session, message = "I’m sorry, I didn’t understand that.") {
  if (!session.modelConn || session.hasAssistantSpoken) return;

  session.fallbackCount = (session.fallbackCount || 0) + 1;

  if (session.fallbackCount >= 3) {
    escalateToHuman(session);
    return;
  }

  send(session.modelConn, {
    type: "conversation.item.create",
    item: {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: message }],
    },
  });
  send(session.modelConn, { type: "response.create" });

  session.hasAssistantSpoken = true;
}

// ------------------------ Human Escalation ------------------------

function escalateToHuman(session: Session) {
  const agentNumber = "+12702017480"; // Replace with your real agent number
  const twiml = `
    <Response>
      <Say>Sorry, I’m unable to help. Connecting you to a support agent now.</Say>
      <Dial>${agentNumber}</Dial>
    </Response>
  `;

  send(session.twilioConn!, {
    event: "transfer",
    streamSid: session.streamSid,
    twiml: twiml,
  });

  closeSession(session.streamSid);
}

// ------------------------ Function Call Wrapper ------------------------

async function safeRunFunction(item: any, session: Session) {
  try {
    const fn = functions.find((f) => f.schema.name === item.name);
    if (!fn) {
      sendFallback(session, "Unknown function requested.");
      return;
    }

    const output = await fn.handler(JSON.parse(item.arguments));
    send(session.modelConn!, {
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: item.call_id,
        output,
      },
    });
    send(session.modelConn!, { type: "response.create" });
  } catch (err: any) {
    console.error("Function call failed:", err);
    sendFallback(session, "Sorry, I couldn’t complete that task.");
  }
}

// ------------------------ Session Cleanup ------------------------

function closeSession(streamSid: string) {
  const session = sessions.get(streamSid);
  if (!session) return;

  session.twilioConn?.close();
  session.modelConn?.close();
  session.frontendConn?.close();

  if (session.greetingTimer) clearTimeout(session.greetingTimer);

  sessions.delete(streamSid);
}

function cleanupByTwilio(ws: WebSocket) {
  for (const [sid, session] of sessions) {
    if (session.twilioConn === ws) {
      closeSession(sid);
      break;
    }
  }
}

// ------------------------ Utility ------------------------

function send(ws: WebSocket, payload: any) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function parse(data: RawData) {
  try {
    return JSON.parse(data.toString());
  } catch {
    return null;
  }
}
