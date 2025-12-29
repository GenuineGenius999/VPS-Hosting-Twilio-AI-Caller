import { RawData, WebSocket } from "ws";
import functions from "./functionHandlers";
import { Session } from "./types";

const sessions = new Map<string, Session>();

export function handleCallConnection(ws: WebSocket, openAIApiKey: string) {
  ws.on("message", (data) =>
    handleTwilioMessage(ws, data, openAIApiKey)
  );
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
        openAIApiKey,
        latestMediaTimestamp: 0,
        hasUserSpoken: false,
        hasAssistantSpoken: false,
      };

      sessions.set(streamSid, session);
      connectModel(session);

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

function connectModel(session: Session) {
  session.modelConn = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17",
    {
      headers: {
        Authorization: `Bearer ${session.openAIApiKey}`,
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

  session.modelConn.on("message", (data) =>
    handleModelMessage(session, data)
  );
}

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

    if (event.item_id) {
      session.lastAssistantItemId = event.item_id;
    }

    send(session.twilioConn!, {
      event: "media",
      streamSid: session.streamSid,
      media: { payload: event.delta },
    });
  }

  if (event.type === "response.output_item.done") {
    const item = event.item;
    if (item.type === "function_call") {
      runFunction(item).then((output) => {
        send(session.modelConn!, {
          type: "conversation.item.create",
          item: {
            type: "function_call_output",
            call_id: item.call_id,
            output,
          },
        });
        send(session.modelConn!, { type: "response.create" });
      });
    }
  }

  session.frontendConn && send(session.frontendConn, event);
}

function interruptAssistant(session: Session) {
  if (
    !session.lastAssistantItemId ||
    session.responseStartTimestamp === undefined
  )
    return;

  const elapsedMs =
    (session.latestMediaTimestamp ?? 0) -
    (session.responseStartTimestamp ?? 0);

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

async function runFunction(item: any): Promise<string> {
  const fn = functions.find((f) => f.schema.name === item.name);
  if (!fn) return JSON.stringify({ error: "Unknown function" });

  try {
    return await fn.handler(JSON.parse(item.arguments));
  } catch (e: any) {
    return JSON.stringify({ error: e.message });
  }
}

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
