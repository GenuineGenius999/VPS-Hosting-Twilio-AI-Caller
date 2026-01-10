import { RawData, WebSocket } from "ws";
import functions from "./functionHandlers";
import { Session } from "./types";
import { escalationTemplate } from "./server";
import { conversationDB } from "./dbManager";

export let escalationTem: any = escalationTemplate;


const sessions = new Map<string, Session>();

// Keep track of all frontend connections
const frontendConnections = new Set<WebSocket>();

// Temporary storage for call info from webhook before WebSocket connects
// Key: CallSid, Value: { from, to }
const pendingCallInfo = new Map<string, { from: string; to: string }>();

// Export function to store call info from webhook
export function storeCallInfo(callSid: string, from: string, to: string) {
  pendingCallInfo.set(callSid, { from, to });
  console.log(`📞 Stored call info for CallSid ${callSid}: From=${from}, To=${to}`);
}

// Helper to retrieve and remove call info
function retrieveCallInfo(callSid: string | undefined): { from?: string; to?: string } | null {
  if (!callSid) return null;
  const info = pendingCallInfo.get(callSid);
  if (info) {
    pendingCallInfo.delete(callSid); // Clean up after retrieval
    return info;
  }
  return null;
}

export function handleCallConnection(ws: WebSocket, openAIApiKey: string, callSidFromUrl?: string) {
  ws.on("message", (data) =>
    handleTwilioMessage(ws, data, openAIApiKey, callSidFromUrl)
  );
  ws.on("close", () => cleanupByTwilio(ws));
}

export function handleFrontendConnection(ws: WebSocket) {
  // Add frontend connection to the set
  frontendConnections.add(ws);
  console.log(`Frontend connected. Total frontend connections: ${frontendConnections.size}`);

  // Handle messages from frontend (e.g., session updates)
  ws.on("message", (data) => {
    const msg = parse(data);
    if (!msg) return;

    // Handle session.update messages - forward to all active sessions
    if (msg.type === "session.update") {
      console.log("Received session.update from frontend");
      // Forward to all active sessions
      for (const session of sessions.values()) {
        if (session.modelConn && session.modelConn.readyState === WebSocket.OPEN) {
          send(session.modelConn, msg);
        }
      }
      return;
    }

    // Legacy support: if frontend sends streamSid, associate with that session
    if (msg.streamSid) {
      const session = sessions.get(msg.streamSid);
      if (session) {
        session.frontendConn = ws;
        console.log(`Frontend associated with session ${msg.streamSid}`);
      }
    }
  });

  // Remove from set when disconnected
  ws.on("close", () => {
    frontendConnections.delete(ws);
    console.log(`Frontend disconnected. Total frontend connections: ${frontendConnections.size}`);

    // Also remove from any sessions that reference it
    for (const session of sessions.values()) {
      if (session.frontendConn === ws) {
        session.frontendConn = undefined;
      }
    }
  });

  ws.on("error", (error) => {
    console.error("Frontend WebSocket error:", error);
    frontendConnections.delete(ws);
  });
}

function handleTwilioMessage(
  ws: WebSocket,
  data: RawData,
  openAIApiKey: string,
  callSidFromUrl?: string
) {
  const msg = parse(data);
  if (!msg) return;

  switch (msg.event) {
    case "start": {
      const streamSid = msg.start.streamSid;

      // Try to get callSid from start event, URL query param, or start event metadata
      const callSid = msg.start.callSid ||
        callSidFromUrl ||
        msg.start.start?.callSid ||
        msg.start.metadata?.callSid;

      console.log(`📞 Call started - StreamSid: ${streamSid}, CallSid: ${callSid}`);
      console.log(`📞 Start event structure:`, JSON.stringify(msg.start, null, 2));

      // Retrieve call info from webhook (if available)
      const callInfo = retrieveCallInfo(callSid) || {};

      if (callInfo.from) {
        console.log(`📞 Retrieved call info - From: ${callInfo.from}, To: ${callInfo.to}`);
      } else if (callSid) {
        console.log(`⚠️  No call info found for CallSid: ${callSid}`);
      }

      const session: Session = {
        streamSid,
        callSid,
        twilioConn: ws,
        openAIApiKey,
        latestMediaTimestamp: 0,
        hasAssistantSpoken: false,
        isModelErr: false,
        callerState: "idle",
        fromPhoneNumber: callInfo.from,
        toPhoneNumber: callInfo.to,
        isSpeechStopped: false,
        isBargeInAvailable: false,
        isAiSpeaking: false
      };

      sessions.set(streamSid, session);

      // Notify frontend that a call has started with phone number info
      broadcastToFrontend({
        type: "call.started",
        streamSid: streamSid,
        callSid: callSid,
        fromPhoneNumber: callInfo.from,
        toPhoneNumber: callInfo.to,
      });

      connectModel(session);

      console.log("model connected...");
      console.log("greeted!!");

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

    case "mark": {
      const session = sessions.get(msg.streamSid);
      if (!session || !session.modelConn) return;
      session.isAiSpeaking = false;

      // Handle mark event in AI finished speaking situation
      if (msg.mark.name === "ai_done") {

        console.log("AI has finished speaking...");
        session.isBargeInAvailable = false;
        if (session.silenceTimer) {
          clearTimeout(session.silenceTimer);
          session.silenceTimer = undefined;
        }

        session.silenceTimer = setTimeout(() => {
          switch (session.callerState) {
            case "idle": {
              if (!session.isAiSpeaking) {
                console.log("Silence Detected");
                handleSilence(session);
              }
              break;
            }
            case "silence": {
              console.log("Silence Detected Again, need end call.");
              endCall(session);
              break;
            }
            case "speaking": {
              session.callerState = "idle";
              break;
            }
          }
        }, 8000);
      }

      // Handle "mark" event for End Call
      if (msg.mark.name == "end_call_triggered") {
        console.log("🔚Finish Call Triggered🔚 for 5s⏲");
        setTimeout(() => {
          if (session.callerState != "speaking") {
            endCall(session);
          }
        }, 5000);
      }
      // Handle "mark" event for Escalation Trigger
      if (msg.mark.name == "trigger_escalation") {
        console.log("🚨Escalation Triggered🚨 for 1s⏲");
        setTimeout(() => {
          if (session.callerState != "speaking") {
            triggerEscalation(session);
          }
        }, 800);
      }
      break;
    }


    case "close":
      closeSession(msg.streamSid);
      break;
  }
}

function connectModel(session: Session) {
  try {
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
          turn_detection: {
            type: "server_vad",
            silence_duration_ms: 800,
            threshold: 0.7,
          },
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          input_audio_transcription: { model: "whisper-1" },
          instructions:
            `
          You are a professional AI voice assistant. Speak only English.
          Followings are important rules you must keep for every response. Please note them in your long-term & short-term memory.

          Conversation rules (IMPORTANT! Don't forget):
          1. If the caller expresses frustration, apologize and offer help.
          2. If frustration happens again, please ask him if it would be helpful to escalate to human agent.
          3. If the caller repeats the same question twice or three times, please ask him if it would be helpful to escalate to human agent.
          4. If the caller asks for escalation, please just say "ok no problem, I will connect you." and add ///// at the end of the transcription.
          5. And in some other cases like when the bot has low confidence and when emotion state is very bad upon the result of sentimental analysis, it should ask a caller if it would be helpful to connect the human agent.
          6. And only when caller asks to end the call or agree to finish the call, please add /?/ at the end of the transcription.
          7. If the caller sends "<<Silence>>", please say "It seems that we are not in the session. How about we end the call?".
          8. If the caller sends "<<Greeting>>", please say "Hello, Nice to meet you, How can I assist you today?".
          Please NEVER forget the rules. Specially never say caller's Emotion!.
          Please give concise answers within 20 words.
          `

        },
      });

      session.greetingTimer = setTimeout(() => {
        if (session.callerState == "idle" && !session.hasAssistantSpoken) {
          sendGreeting(session);
          console.log("sent-first for model connected");
        }
      }, 100);

      // Notify frontend that a new session was created with phone number info
      broadcastToFrontend({
        type: "session.created",
        session_id: session.streamSid,
        callSid: session.callSid,
        fromPhoneNumber: session.fromPhoneNumber,
        toPhoneNumber: session.toPhoneNumber,
      });
    });


    session.modelConn.on("message", (data) =>
      handleModelMessage(session, data)
    );

    session.modelConn.on("error", (error) => {
      console.error(`OpenAI Realtime API error for session ${session.streamSid}:`, error);
      session.isModelErr = true;
      triggerEscalation(session);
      broadcastToFrontend({
        type: "error",
        session_id: session.streamSid,
        error: error.message || "Connection error",
      });
    });

    session.modelConn.on("close", () => {
      console.log(`OpenAI Realtime API disconnected for session ${session.streamSid}`);
      // session.isModelErr = true;
      // triggerEscalation(session);
      broadcastToFrontend({
        type: "session.disconnected",
        session_id: session.streamSid,
      });
    });
  } catch { }
}


// Escalation Handler

function triggerEscalation(session: Session) {
  if (session.escalationTriggered) return;

  session.escalationTriggered = true;
  console.log("🚨 Escalation triggered for", session.streamSid);

  console.log(session.isModelErr);

  if (session.isModelErr) {
    escalationTem = escalationTemplate.replace("{{REASON}}", "Sorry. Our AI Voice Assistant is not available now. I will connect you to human agent.");
  }

  else {
    escalationTem = escalationTemplate.replace("{{REASON}}", "Please hold while I connect you to a human agent.");
  }


  // Close Twilio stream (this triggers /escalate via <Connect action>)
  // setTimeout(() => {
  try {
    // Clear any buffered audio on Twilio
    send(session.twilioConn!, {
      event: "clear",
      streamSid: session.streamSid,
    });

    session.twilioConn?.close();
    session.modelConn?.close();
  } catch { }
  // }, 2500); // small delay = more reliable redirect
}

// end call

function endCall(session: Session) {
  try {
    // session.silenceTimer = setTimeout(() => {
    if (session.callerState == "silence") {
      escalationTem = `<Response><Say>Sorry, we're not hearing from you. So I'm going to end the call now. Good bye!</Say></Response>`;
      // Sorry, we're not hearing from you. So I'm going to end the call now. Good bye!
    }
    // }, 4000);
    if (session.callerState == "idle") {
      escalationTem = `<Response><Say>Thank you for calling. I'm going to end the call now. Goodbye!.</Say></Response>`;
      // Thank you for calling. I'm going to end the call now. Goodbye!
    }

    // Close Twilio stream (this triggers /escalate via <Connect action>)
    // setTimeout(() => {
    try {
      // Clear any buffered audio on Twilio
      send(session.twilioConn!, {
        event: "clear",
        streamSid: session.streamSid,
      });
      session.twilioConn?.close();
      session.modelConn?.close();
    } catch { }
    // }, 2500); // small delay = more reliable redirect
  } catch { }
}

function handleModelMessage(session: Session, data: RawData) {

  const event = parse(data);

  // console.log("Model Event:", event);
  // if (JSON.stringify(event).includes("error") || JSON.stringify(event).includes("fail")) {
  //   console.log("Error from model:", event);
  //   triggerEscalation(session);
  //   return;
  // }

  switch (event.type) {
    case "error":
      console.log("Error from model:", event);
      // session.isModelErr = true;
      // triggerEscalation(session);
      break;
    case "response.done":
      if (event.response.output.length == 0 || event.response.status == "failed") {
        console.log("response failed:", event);
        // session.isModelErr = true;
        // triggerEscalation(session);
      }
      break;
    case "conversation.item.input_audio_transcription.failed":
      console.log("conversation.item.input_audio_transcription.failed:", event);
      if (event.error) {
        if (event.error.message.includes("Too Many Requests")) {
          session.isModelErr = true;
          triggerEscalation(session);
        }
      }
      // session.isModelErr = true;
      break;
  }

  if (!event) return;

  if (event.type == "input_audio_buffer.speech_stopped") {
    session.isSpeechStopped = true;

  }

  if (event.type === "input_audio_buffer.speech_started") { // Incoming voice from Twilio to OpenAI Realtime

    // Remove silenceTimer and greetingTimer once a caller starts speaking
    session.isSpeechStopped = false;

    if (session.speechTimer) {
      clearTimeout(session.speechTimer);
      session.speechTimer = undefined;
    }

    session.speechTimer = setTimeout(() => {

      if (!session.isSpeechStopped) {
        console.log("Caller started speaking, interrupting assistant...", session.isSpeechStopped);
        if (session.silenceTimer) {
          clearTimeout(session.silenceTimer);
          session.silenceTimer = undefined;
        }
        if (session.greetingTimer) {
          clearTimeout(session.greetingTimer);
          session.greetingTimer = undefined;
        }
        session.isBargeInAvailable = true;
        interruptAssistant(session);
      }
    }, 300)
  }

  if (event.type === "response.audio.delta") { // Outgoing voice from OpenAI Realtime to Twilio

    //ignore/disable barge-in 400ms-600ms
    session.hasAssistantSpoken = true;
    session.isAiSpeaking = true;

    if (!session.responseStartTimestamp) {
      session.responseStartTimestamp = session.latestMediaTimestamp;
      // it's just the starting point of assistant speaking
      setTimeout(() => {
        session.isBargeInAvailable = true;
      }, 400);
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


  if (event.type === "response.audio.done") {
    send(session.twilioConn!, {
      event: "mark",
      streamSid: session.streamSid,
      mark: { name: "ai_done" }
    });

    if (session.callerState == "speaking") {
      console.log("Making caller state to idle");
      session.callerState = "idle";
    }
  }



  if (event.type === "response.output_item.done") { // Function call handling
    const item = event.item;

    if (item && item.content) {
      if (item.content[0]?.transcript) {
        const text: string = item.content[0].transcript;

        if (item.type == "message" && text) {
          console.log("🎭 Text:", text, "---", session.streamSid);

          // Escalation
          if (text.includes("/////")) {
            send(session.twilioConn!, {
              event: "mark",
              streamSid: session.streamSid,
              mark: { name: "trigger_escalation" }
            });

            if (session.callerState == "speaking") {
              console.log("Making caller state to idle");
              session.callerState = "idle";
            }
            return;
          }

          if (text.includes("/?/") && session.callerState != "silence") {
            send(session.twilioConn!, {
              event: "mark",
              streamSid: session.streamSid,
              mark: { name: "end_call_triggered" }
            });

            if (session.callerState == "speaking") {
              console.log("Making caller state to idle");
              session.callerState = "idle";
            }
          }

          // const emotionMatch = text.match(
          //   /<emotion>(.*?)<\/emotion>/
          // );
          // let emotionAnalysis = null;
          // if (emotionMatch) {
          //   try {
          //     emotionAnalysis = JSON.parse(emotionMatch[1]);
          //     console.log("🎭 Caller Emotion:", emotionAnalysis);
          //   } catch { }
          // }
        }
        else {
          console.log("No result!");
        }
      }
    }


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
    // session.frontendConn && send(session.frontendConn, event);
  }

  // Broadcast event to all frontend connections with phone number context
  const eventWithPhoneInfo = {
    ...event,
    // Include phone numbers if available in session
    ...(session.fromPhoneNumber && { fromPhoneNumber: session.fromPhoneNumber }),
    ...(session.toPhoneNumber && { toPhoneNumber: session.toPhoneNumber }),
    ...(session.callSid && { callSid: session.callSid }),
  };
  broadcastToFrontend(eventWithPhoneInfo);
}


function interruptAssistant(session: Session) {
  if (
    !session.lastAssistantItemId ||
    session.responseStartTimestamp === undefined
  )
    return;

  if (!session.isBargeInAvailable) return;

  const elapsedMs =
    (session.latestMediaTimestamp ?? 0) -
    (session.responseStartTimestamp ?? 0);

  session.callerState = "speaking";

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
}

function handleSilence(session: Session) {

  if (!session.modelConn) return;

  session.callerState = "silence";

  console.log("CallerState changed to", session.callerState);
  console.log("Suggesting end call...", session.callerState);

  send(session.modelConn, {
    type: "conversation.item.create",
    item: {
      type: "message",
      role: "user",
      content: [
        {
          type: "input_text",
          text: "<<Silence>>",
        },
      ],
    },
  });

  send(session.modelConn, {
    type: "response.create",
  });
}

function sendGreeting(session: Session) {
  if (!session.modelConn || session.hasAssistantSpoken) return;

  session.hasAssistantSpoken = true;

  console.log("Auto-Greeting...");
  send(session.modelConn, {
    type: "conversation.item.create",
    item: {
      type: "message",
      role: "user",
      content: [
        {
          type: "input_text",
          text: "<<Greeting>>",
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

  console.log(`📞 Call ended - StreamSid: ${streamSid}`);

  // Notify frontend that call has ended with phone number info
  broadcastToFrontend({
    type: "call.ended",
    streamSid: streamSid,
    callSid: session.callSid,
    fromPhoneNumber: session.fromPhoneNumber,
    toPhoneNumber: session.toPhoneNumber,
  });

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


function broadcastToFrontend(event: any) {
  // Broadcast to all connected frontend clients
  const eventJson = JSON.stringify(event);
  let sentCount = 0;

  // Insert conversation data into database when response content part is done
  if (event["type"] === "response.content_part.done" && event["part"]?.transcript) {
    const conversation = {
      companyPhone: event["toPhoneNumber"] || "+19514660649",
      callerPhone: event["fromPhoneNumber"] || "",
      status: "AI",
      context: event["part"]["transcript"],
      conversationId: event["callSid"] || "",
    };
    // Insert into database asynchronously (don't block the broadcast)
    conversationDB
      .insert(
        conversation.companyPhone,
        conversation.callerPhone,
        conversation.status,
        conversation.context,
        conversation.conversationId
      )
      .then((result) => {
        console.log("✅ Conversation inserted into database:", result.id);
      })
      .catch((error) => {
        console.error("❌ Failed to insert conversation into database:", error);
      });
  }

  // Insert conversation data into database when response content part is done
  if (event["type"] === "conversation.item.input_audio_transcription.delta") {
    const conversation = {
      companyPhone: event["toPhoneNumber"] || "+19514660649",
      callerPhone: event["fromPhoneNumber"] || "",
      status: "caller",
      context: event["delta"],
      conversationId: event["callSid"] || "",
    };
    // Insert into database asynchronously (don't block the broadcast)
    conversationDB
      .insert(
        conversation.companyPhone,
        conversation.callerPhone,
        conversation.status,
        conversation.context,
        conversation.conversationId
      )
      .then((result) => {
        console.log("✅ Conversation inserted into database:", result.id);
      })
      .catch((error) => {
        console.error("❌ Failed to insert conversation into database:", error);
      });
  }

  for (const frontendWs of frontendConnections) {
    if (frontendWs.readyState === WebSocket.OPEN) {
      try {
        frontendWs.send(eventJson);
        sentCount++;
      } catch (error) {
        console.error("Error sending to frontend:", error);
        frontendConnections.delete(frontendWs);
      }
    } else {
      // Remove closed connections
      frontendConnections.delete(frontendWs);
    }
  }

  // if (sentCount > 0) {
  //   console.log(`Broadcasted event ${event.type} to ${sentCount} frontend connection(s)`);
  // }
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


