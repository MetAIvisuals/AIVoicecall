import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import twilio from 'twilio';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { handleInboundCall, handleCallStatus } from './routes/call.js';
import { handleMediaStream } from './routes/stream.js';
import { sessionStore } from './services/sessionStore.js';

dotenv.config();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/media-stream' });

app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Twilio webhook: inbound call arrives
app.post('/call/inbound', handleInboundCall);

// Twilio webhook: call status updates
app.post('/call/status', handleCallStatus);

// Dashboard API: get all active sessions
app.get('/api/sessions', (req, res) => {
  res.json(Array.from(sessionStore.values()));
});

// WebSocket: Twilio Media Streams connects here
wss.on('connection', (ws, req) => {
  console.log('[WS] Twilio media stream connected');
  handleMediaStream(ws, req);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🌐 Call Translator running on port ${PORT}`);
  console.log(`📞 Twilio webhook: POST /call/inbound`);
  console.log(`🔌 Media stream:   ws://localhost:${PORT}/media-stream\n`);
});
