/**
 * OpenConduit Relay Server
 *
 * V1 — Shared conversation snapshots
 *   POST   /share       → store snapshot in SQLite, return { id, url }
 *   GET    /share/:id   → serve HTML page (or JSON if Accept: application/json)
 *   DELETE /share/:id   → delete by machineId
 *
 * V2 — Live collaboration rooms
 *   POST /rooms         → create room, return { roomId, wsUrl, inviteUrl }
 *   GET  /rooms/:id     → WebSocket upgrade or invite landing page
 */

import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { WebSocketServer } from 'ws';
import { initDb, createShare, getShare, deleteShare, cleanupExpiredShares } from './db';
import { RoomManager } from './room';
import { renderConversationHtml } from './html';
import type { HtmlConversation } from './html';
import type { RelayMessage } from './types';

// ─── Config ───────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT ?? '3000', 10);
const BASE_URL = (process.env.BASE_URL ?? `http://localhost:${PORT}`).replace(/\/$/, '');
const WS_BASE = BASE_URL.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');

// ─── Setup ────────────────────────────────────────────────────────────────────

initDb();

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });
const rooms = new RoomManager();

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Machine-Id',
};

app.use(express.json({ limit: '10mb' }));
app.use((_req, res, next) => {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  next();
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sanitise(conv: HtmlConversation): HtmlConversation {
  return {
    ...conv,
    messages: conv.messages.map((m) => ({ ...m, attachments: undefined })),
  };
}

// ─── OPTIONS preflight ────────────────────────────────────────────────────────

app.options('*', (_req, res) => res.status(204).end());

// ─── V1: Shared conversation snapshots ────────────────────────────────────────

app.post('/share', (req, res) => {
  const body = req.body as { conversation?: HtmlConversation; machineId?: string; title?: string };
  if (!body?.conversation?.messages) {
    res.status(400).json({ error: 'conversation.messages is required' });
    return;
  }

  const id = randomUUID();
  const clean = sanitise(body.conversation);
  createShare(id, { conversation: clean, machineId: body.machineId ?? null, title: body.title ?? null }, body.machineId);
  res.json({ id, url: `${BASE_URL}/share/${id}` });
});

app.get('/share/:id', (req, res) => {
  const { id } = req.params;
  const row = getShare(id);

  if (!row) {
    if (req.headers.accept?.includes('application/json')) {
      res.status(404).json({ error: 'Share not found or expired' });
    } else {
      res.status(404).set('Content-Type', 'text/html;charset=utf-8').send(notFoundHtml(id));
    }
    return;
  }

  const parsed = row as { conversation?: HtmlConversation } | HtmlConversation;
  const conv: HtmlConversation = 'conversation' in parsed && parsed.conversation
    ? parsed.conversation
    : parsed as HtmlConversation;

  if (req.headers.accept?.includes('application/json')) {
    res.json(conv);
    return;
  }

  res
    .set('Content-Type', 'text/html;charset=utf-8')
    .set('Cache-Control', 'public, max-age=300')
    .send(renderConversationHtml(conv));
});

app.delete('/share/:id', (req, res) => {
  const { id } = req.params;
  const machineId = req.headers['x-machine-id'];
  if (!machineId || typeof machineId !== 'string') {
    res.status(400).json({ error: 'X-Machine-Id header required' });
    return;
  }

  const result = deleteShare(id, machineId);
  if (result === 'not_found') { res.status(404).json({ error: 'Share not found' }); return; }
  if (result === 'forbidden')  { res.status(403).json({ error: 'Forbidden' }); return; }
  res.json({ deleted: true });
});

// ─── V2: Live collaboration rooms ─────────────────────────────────────────────

app.post('/rooms', (req, res) => {
  const roomId = randomUUID();
  rooms.createRoom(roomId);

  const body = req.body as { messages?: RelayMessage[]; aiMode?: 'own' | 'host' } | undefined;
  if (body?.messages) {
    rooms.seedRoom(roomId, body.messages, body.aiMode);
  }

  res.json({
    roomId,
    wsUrl: `${WS_BASE}/rooms/${roomId}`,
    inviteUrl: `${BASE_URL}/rooms/${roomId}`,
  });
});

app.get('/rooms/:id', (req, res) => {
  // Non-WS browser visits get the invite landing page
  res.set('Content-Type', 'text/html;charset=utf-8').send(roomInviteHtml(req.params.id));
});

// ─── Health ───────────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  if (req.headers.accept?.includes('application/json')) {
    res.json({ ok: true, service: 'openconduit-relay', version: '1.0.0' });
    return;
  }
  res.redirect(301, 'https://openconduit.ai');
});

app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

// ─── WebSocket upgrade ────────────────────────────────────────────────────────

server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url ?? '/', `http://localhost`);
  const match = url.pathname.match(/^\/rooms\/([a-f0-9-]{36})$/);
  if (!match) { socket.destroy(); return; }

  wss.handleUpgrade(request, socket, head, (ws) => {
    rooms.handleConnection(match[1], ws);
  });
});

// ─── Periodic cleanup ─────────────────────────────────────────────────────────

setInterval(() => cleanupExpiredShares(), 60 * 60 * 1000);

// ─── HTML pages ───────────────────────────────────────────────────────────────

function notFoundHtml(id: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Share not found — OpenConduit</title>
  <style>
    body { background:#0f172a; color:#f8fafc; font-family:-apple-system,sans-serif; display:flex; align-items:center; justify-content:center; min-height:100vh; margin:0; }
    .box { text-align:center; max-width:420px; padding:40px 24px; }
    h1 { font-size:2rem; margin-bottom:12px; }
    p { color:#94a3b8; margin-bottom:24px; font-size:15px; line-height:1.6; }
    a { color:#3b82f6; text-decoration:none; }
    code { background:#1e293b; border-radius:4px; padding:2px 6px; font-size:13px; color:#94a3b8; }
  </style>
</head>
<body>
  <div class="box">
    <h1>Share not found</h1>
    <p>The link <code>${id}</code> has expired or never existed. Shared conversations are kept for 30 days.</p>
    <a href="https://openconduit.ai">← Back to OpenConduit</a>
  </div>
</body>
</html>`;
}

function roomInviteHtml(roomId: string): string {
  const deepLink = `openconduit://join?roomId=${roomId}`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Join live room — OpenConduit</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{background:#0f172a;color:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh}
    .card{max-width:440px;width:100%;padding:40px 32px;background:#1e293b;border-radius:16px;border:1px solid #334155;text-align:center}
    .icon{width:56px;height:56px;background:linear-gradient(135deg,#3b82f6,#8b5cf6);border-radius:14px;display:flex;align-items:center;justify-content:center;margin:0 auto 20px}
    .icon svg{width:28px;height:28px;stroke:#fff;fill:none;stroke-width:1.8;stroke-linecap:round}
    h1{font-size:1.4rem;font-weight:700;margin-bottom:8px}
    p{color:#94a3b8;font-size:.9rem;line-height:1.6;margin-bottom:24px}
    .btn{display:inline-flex;align-items:center;gap:8px;background:linear-gradient(135deg,#3b82f6,#8b5cf6);color:#fff;font-weight:600;font-size:.95rem;padding:12px 24px;border-radius:10px;text-decoration:none;border:none;cursor:pointer;transition:opacity .15s}
    .btn:hover{opacity:.9}
    .divider{display:flex;align-items:center;gap:12px;margin:20px 0;color:#475569;font-size:.8rem}
    .divider::before,.divider::after{content:'';flex:1;height:1px;background:#334155}
    .room-id{background:#0f172a;border:1px solid #334155;border-radius:8px;padding:10px 14px;font-family:monospace;font-size:.8rem;color:#64748b;word-break:break-all;text-align:left}
    .room-id span{color:#94a3b8}
    .sub{margin-top:20px;font-size:.78rem;color:#475569}
    .sub a{color:#3b82f6;text-decoration:none}
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">
      <svg viewBox="0 0 24 24"><circle cx="9" cy="7" r="3"/><path d="M3 21v-2a4 4 0 014-4h4a4 4 0 014 4v2"/><circle cx="19" cy="7" r="3"/><path d="M17 21v-1a4 4 0 014-4"/></svg>
    </div>
    <h1>You've been invited to a live room</h1>
    <p>Someone shared a live OpenConduit collaboration session with you. Open the app to join and chat together in real time.</p>
    <a class="btn" href="${deepLink}">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
      Open in OpenConduit
    </a>
    <div class="divider">or join manually</div>
    <div class="room-id">Room ID: <span>${roomId}</span></div>
    <p class="sub">Don't have OpenConduit? <a href="https://openconduit.ai/download">Download it free</a></p>
  </div>
  <script>
    window.addEventListener('load', () => {
      const a = document.querySelector('.btn');
      setTimeout(() => { try { window.location.href = a.href; } catch(e){} }, 400);
    });
  </script>
</body>
</html>`;
}

// ─── Start ────────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`OpenConduit Relay Server  port=${PORT}  base=${BASE_URL}`);
});
