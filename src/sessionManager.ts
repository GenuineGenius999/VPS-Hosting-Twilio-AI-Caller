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
          `
          You are a professional AI voice assistant. Speak only English.
          Followings are important rules you must keep for every response. Please note them in your long-term & short-term memory.
          IMPORTANT RESPONSE RULES:
          1. The SPOKEN response must be natural and helpful.
          2. At the END of the TEXT response, append an emotion analysis block.
          3. NEVER speak the emotion analysis.
          4. Format emotion analysis EXACTLY as JSON inside <emotion></emotion> tags. It's the thing you have to keep in silence.

          Emotion JSON format:
          {
            "emotion": "<one_of: calm | frustrated | angry | confused | happy | sad | neutral>",
            "confidence": <number between 0 and 1>
          }

          Conversation rules (IMPORTANT! Don't forget):
          1. If the caller expresses frustration, apologize and offer help.
          2. If frustration happens again, please ask him if it would be helpful to escalate to human agent.
          3. If the caller repeats the same question twice or three times, please ask him if it would be helpful to escalate to human agent.
          4. If the caller asks for escalation, please say ok and //escalation// at the end of the transcription.
          5. And in some other cases like when the bot has low confidence and when emotion state is very bad upon the result of sentimental analysis, it should ask a caller if it would be helpful to connect the human agent.
 
          Please NEVER forget the rules. Specially never say caller's Emotion!.
          `,
        // instructions:
        //   `
        //   You are a professional AI voice assistant. Speak only English.

        //   Conversation rules (IMPORTANT! Don't forget):
        //   4. If the caller asks for escalation, please say ok and //escalation// at the end of the transcription.
 
        //   Please NEVER forget the rules.
        //   `
      },
    });
  });

  session.modelConn.on("message", (data) =>
    handleModelMessage(session, data)
  );
}


// Escalation HanldeR

function triggerEscalation(session: Session) {
  if (session.escalationTriggered) return;

  session.escalationTriggered = true;
  console.log("🚨 Escalation triggered for", session.streamSid);

  // Stop AI immediately
  try {
    session.modelConn?.close();
  } catch { }

  // Clear any buffered audio on Twilio
  try {
    send(session.twilioConn!, {
      event: "clear",
      streamSid: session.streamSid,
    });
  } catch { }

  // Close Twilio stream (this triggers /escalate via <Connect action>)
  setTimeout(() => {
    try {
      session.twilioConn?.close();
    } catch { }
  }, 2500); // small delay = more reliable redirect
}






function handleModelMessage(session: Session, data: RawData) {
  const event = parse(data);
  // console.log("Model Event:", event);

  if (!event) return;

  if (event.type === "input_audio_buffer.speech_started") { // Incoming voice from Twilio to OpenAI Realtime
    session.hasUserSpoken = true;
    if (session.greetingTimer) {
      clearTimeout(session.greetingTimer);
      session.greetingTimer = undefined;
    }
    interruptAssistant(session);
  }

  if (event.type === "response.audio.delta") { // Outgoing voice from OpenAI Realtime to Twilio
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

  if (event.type === "response.output_item.done") { // Function call handling
    const item = event.item;

    // console.log("Text => ", item);
    // updated part

    if (item && item.content) {
      if (item.content[0].transcript) {
        const text: string = item.content[0].transcript;
        if (item.type == "message" && text) {
          console.log("🎭 Text:", text);

          // Escalation

          if (text.includes("//escalation//")) {
            triggerEscalation(session);
            return;
          }

          const emotionMatch = text.match(
            /<emotion>(.*?)<\/emotion>/
          );
          let emotionAnalysis = null;
          if (emotionMatch) {
            try {
              emotionAnalysis = JSON.parse(emotionMatch[1]);
              console.log("🎭 Caller Emotion:", emotionAnalysis);
            } catch { }
          }
        }
        else {
          console.log("No result!");
        }
      }
    }
    // send(session.frontendConn!, {
    //   type: "assistant_message",
    //   text: text.replace(/<emotion>.*?<\/emotion>/, "").trim(),
    //   emotion: emotionAnalysis,
    // });


    if (item.type === "function_call") {
      console.log("Function Call");
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


