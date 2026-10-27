import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';
import { handleInboundCall, handleMenu, handleCallAnswered, handleCallStatus } from './routes/call.js';
import { handleMediaStream } from './routes/stream.js';
import { sessionStore } from './services/sessionStore.js';
import audioRouter from './routes/audio.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/media-stream' });

app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

app.use(audioRouter);
app.post('/call/inbound', handleInboundCall);
app.post('/call/menu/:step', handleMenu);
app.post('/call/target-answered', handleCallAnswered);
app.post('/call/status', handleCallStatus);

app.get('/api/sessions', (req, res) => {
  res.json(Array.from(sessionStore.values()));
});

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

// Startup self-test: verifies OpenAI key/quota/connectivity independent of the SDK
(async () => {
  const key = process.env.OPENAI_API_KEY || '';
  if (!key) return console.error('[SELFTEST] OPENAI_API_KEY is not set');
  if (key !== key.trim() || /["'\s]/.test(key)) console.error('[SELFTEST] OPENAI_API_KEY contains whitespace or quotes');
  try {
    const r = await fetch('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${key.trim()}` } });
    const body = r.ok ? '' : (await r.text()).slice(0, 300);
    console.log(`[SELFTEST] OpenAI /v1/models -> ${r.status} ${body}`);
  } catch (err) {
    console.error(`[SELFTEST] OpenAI unreachable: ${err.message} ${err.cause?.code || ''}`);
  }
})();
