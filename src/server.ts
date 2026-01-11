import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import { IncomingMessage } from "http";
import dotenv from "dotenv";
import http from "http";
import { readFileSync } from "fs";
import { join } from "path";
import cors from "cors";
import {
  escalationTem,
  handleCallConnection,
  handleFrontendConnection,
  storeCallInfo
} from "./sessionManager";

import { connectDatabase, closePool } from "./dbManager";
import { getConversationHistory } from "./conversationRoutes";
import functions from "./functionHandlers";
import { scheduleRetry, clearRetry } from "./retryManager";
import { registerCustomerAsync, initializeCustomerAPI } from "./customerRegistration";

dotenv.config();

const callerId = "+12025550123";
const toPhoneNumber = "+12025550123";

const PORT = Number(process.env.PORT || 8081);
const PUBLIC_URL = process.env.PUBLIC_URL!;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY!;

if (!PUBLIC_URL || !OPENAI_API_KEY) {
  throw new Error("Missing required environment variables");
}

const app = express();
app.use(cors());
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const twimlTemplate = readFileSync(
  join(__dirname, "twiml.xml"),
  "utf-8"
);

export const escalationTemplate = readFileSync(
  join(__dirname, "escalation.xml"),
  "utf-8"
);

const humanAgent = readFileSync(
  join(__dirname, "human_agent.xml"),
  "utf-8"
)

/* ===========================
   Twilio Status Callback
   =========================== */
app.post("/twilio/status", (req, res) => {
  const { CallStatus, To, From } = req.body;

  console.log("📡📡📡📡📡📡📡📡📡 Twilio status:", CallStatus, To);

  if (CallStatus === "busy") {
    scheduleRetry(To, From);
  }

  if (CallStatus === "completed") {
    clearRetry(To);
  }

  res.sendStatus(200);
});

/* ===========================
    TwiML
   =========================== */
app.all("/twiml", (req, res) => {
  const wsUrl = new URL(PUBLIC_URL);
  wsUrl.protocol = "wss:";
  wsUrl.pathname = "/call";

  // Call Status logging
  const { CallStatus, To, From } = req.body;
  console.log(CallStatus);

  console.log("📡📡📡📡📡📡📡📡📡 Twilio status:", CallStatus, To);


  // Extract call information from Twilio webhook
  const callSid = req.body?.CallSid || req.query?.CallSid;
  const fromPhoneNumber = req.body?.From || req.query?.From;
  const toPhoneNumber = req.body?.To || req.query?.To;

  console.log("📞 TwiML webhook received:", {
    CallSid: callSid,
    From: fromPhoneNumber,
    To: toPhoneNumber,
    body: req.body,
  });

  // Store call info for later retrieval when WebSocket connects
  if (callSid && fromPhoneNumber) {
    storeCallInfo(callSid, fromPhoneNumber, toPhoneNumber || "");

    // Also pass CallSid as query parameter in WebSocket URL as fallback
    wsUrl.searchParams.set("CallSid", callSid);

    // Register customer asynchronously (fire-and-forget)
    // This runs in the background without blocking the response
    registerCustomerAsync(fromPhoneNumber);
  }

  res
    .type("text/xml")
    .send(twimlTemplate.replace("{{WS_URL}}", wsUrl.toString()));
});

app.get("/tools", (_, res) => {
  res.json(functions.map((f) => f.schema));
});

// Conversation history endpoint with pagination
app.get("/api/conversations/history", getConversationHistory);

app.get("/public-url", (req, res) => {
  res.json({ publicUrl: PUBLIC_URL });
});

// Escalation
app.post("/escalate", (_, res) => {
  // let escalTemp = `<Response><Say>Please hold while we are connecting you to human agent</Say><Dial callerId = "${callerId}"><Number>${toPhoneNumber}</Number></Dial></Response>`;
  // res.type("text/xml").send(escalTemp);
  res.type("text/xml").send(escalationTem);

});

// human agent

app.post("/human_agent", (_, res) => {
  res.type("text/xml").send(humanAgent);
})


wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
  try {
    const url = new URL(req.url || "", `http://${req.headers.host}`);
    const path = url.pathname.replace("/", "");

    if (path === "call") {
      const callSidFromUrl = url.searchParams.get("CallSid") || undefined;
      handleCallConnection(ws, OPENAI_API_KEY, callSidFromUrl);
    } else if (path === "logs") {
      handleFrontendConnection(ws);
    } else {
      ws.close();
    }
  }
  catch { }
});

async function startServer() {
  try {
    // Connect to database
    await connectDatabase();

    // Initialize customer API authentication (obtain token on startup)
    initializeCustomerAPI();

    // Start HTTP server
    server.listen(PORT, () => {
      console.log(`🚀 Server running on http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error("❌ Failed to start server:", error);
  }
}

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("\n🛑 Shutting down server...");
  await closePool();
  server.close(() => {
    console.log("✅ Server closed");
    process.exit(0);
  });
});

process.on("SIGTERM", async () => {
  console.log("\n🛑 Shutting down server...");
  await closePool();
  server.close(() => {
    console.log("✅ Server closed");
    process.exit(0);
  });
});

startServer();

exports.module = app;