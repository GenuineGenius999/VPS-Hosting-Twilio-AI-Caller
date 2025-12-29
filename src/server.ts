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

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const twimlTemplate = readFileSync(
  join(__dirname, "twiml.xml"),
  "utf-8"
);

app.all("/twiml", (_, res) => {
  const wsUrl = new URL(PUBLIC_URL);
  wsUrl.protocol = "wss:";
  wsUrl.pathname = "/call";

  res
    .type("text/xml")
    .send(twimlTemplate.replace("{{WS_URL}}", wsUrl.toString()));
});

app.get("/tools", (_, res) => {
  res.json(functions.map((f) => f.schema));
});

wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
  const url = new URL(req.url || "", `http://${req.headers.host}`);
  const path = url.pathname.replace("/", "");

  if (path === "call") {
    handleCallConnection(ws, OPENAI_API_KEY);
  } else if (path === "logs") {
    handleFrontendConnection(ws);
  } else {
    ws.close();
  }
});

server.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
