import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import { IncomingMessage } from "http";
import dotenv from "dotenv";
import http from "http";
import { readFileSync } from "fs";
import { join } from "path";
import cors from "cors";
import {
  handleCallConnection,
  handleFrontendConnection,
  storeCallInfo,
} from "./sessionManager";
import functions from "./functionHandlers";

dotenv.config();

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

const escalationTemplate = readFileSync(
  join(__dirname, "escalation.xml"),
);

const humanAgent = readFileSync(
  join(__dirname, "human_agent.xml"),
)

app.get("/public-url", (req, res) => {
  res.json({ publicUrl: PUBLIC_URL });
});

app.all("/twiml", (req, res) => {
  const wsUrl = new URL(PUBLIC_URL);
  wsUrl.protocol = "wss:";
  wsUrl.pathname = "/call";
  
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
  }

  res
    .type("text/xml")
    .send(twimlTemplate.replace("{{WS_URL}}", wsUrl.toString()));
});

app.get("/tools", (_, res) => {
  res.json(functions.map((f) => f.schema));
});

// Escalation
app.post("/escalate", (_, res) => {
  res.type("text/xml").send(escalationTemplate);
});

// human agent

app.post("/human_agent", (_, res) => {
  res.type("text/xml").send(humanAgent);
})


wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
  const url = new URL(req.url || "", `http://${req.headers.host}`);
  const path = url.pathname.replace("/", "");

  if (path === "call") {
    // Extract CallSid from query parameters if present
    const callSidFromUrl = url.searchParams.get("CallSid") || undefined;
    handleCallConnection(ws, OPENAI_API_KEY, callSidFromUrl);
  } else if (path === "logs") {
    handleFrontendConnection(ws);
  } else {
    ws.close();
  }
});

server.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});

exports.module = app;