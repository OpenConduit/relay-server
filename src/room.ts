import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import type { ClientEvent, ServerEvent, CollabParticipant, RelayMessage } from './types';

const COLORS = [
  '#3B82F6', '#8B5CF6', '#10B981', '#F59E0B',
  '#EF4444', '#06B6D4', '#EC4899', '#84CC16',
];

/** Heartbeat interval — sockets that don't respond within this window are terminated. */
const HEARTBEAT_MS = 30_000;

/** Empty rooms are destroyed after this many ms with no participants. */
const IDLE_ROOM_TTL_MS = 5 * 60 * 1000;

interface Room {
  hostId: string | null;
  aiMode: 'own' | 'host';
  messages: RelayMessage[];
  participants: Map<string, CollabParticipant>;
  lockHolder: string | null;
  lockQueue: string[];
}

type TrackedSocket = WebSocket & { _alive: boolean };

export class RoomManager {
  private readonly rooms = new Map<string, Room>();
  /** participantId → WebSocket */
  private readonly sockets = new Map<string, TrackedSocket>();
  /** participantId → roomId */
  private readonly participantRoom = new Map<string, string>();

  constructor() {
    this.startHeartbeat();
  }

  createRoom(roomId: string): void {
    this.rooms.set(roomId, {
      hostId: null,
      aiMode: 'own',
      messages: [],
      participants: new Map(),
      lockHolder: null,
      lockQueue: [],
    });
  }

  seedRoom(roomId: string, messages: RelayMessage[], aiMode?: 'own' | 'host'): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    room.messages = messages;
    if (aiMode) room.aiMode = aiMode;
  }

  handleConnection(roomId: string, ws: WebSocket): void {
    const participantId = randomUUID();
    const tracked = ws as TrackedSocket;
    tracked._alive = true;

    // Auto-create room if it doesn't exist (e.g. rejoining after a restart)
    if (!this.rooms.has(roomId)) this.createRoom(roomId);

    this.sockets.set(participantId, tracked);
    this.participantRoom.set(participantId, roomId);

    ws.on('pong', () => { tracked._alive = true; });

    ws.on('message', (raw) => {
      let event: ClientEvent;
      try {
        const str = typeof raw === 'string' ? raw : raw.toString();
        event = JSON.parse(str) as ClientEvent;
      } catch {
        this.sendTo(ws, { type: 'error', message: 'Invalid JSON' });
        return;
      }
      this.handleEvent(roomId, participantId, ws, event);
    });

    ws.on('close', () => this.handleLeave(roomId, participantId));
    ws.on('error', () => this.handleLeave(roomId, participantId));
  }

  private handleEvent(
    roomId: string,
    participantId: string,
    ws: WebSocket,
    event: ClientEvent,
  ): void {
    switch (event.type) {
      case 'join':
        return this.handleJoin(roomId, participantId, ws, event.name, event.color);
      case 'leave':
        return this.handleLeave(roomId, participantId);
      case 'lock_request':
        return this.handleLockRequest(roomId, participantId, ws);
      case 'lock_release':
        return this.handleLockRelease(roomId, participantId);
      case 'message_add':
        return this.handleMessageAdd(roomId, participantId, event.message);
      case 'stream_start':
        return this.handleStreamStart(roomId, participantId, event.messageId);
      case 'stream_chunk':
        return this.handleStreamChunk(roomId, participantId, event.messageId, event.delta);
      case 'stream_end':
        return this.handleStreamEnd(roomId, participantId, event.messageId, event.message);
      case 'typing':
        return this.broadcastExcept(roomId, participantId, {
          type: 'typing', participantId, isTyping: event.isTyping,
        });
      case 'set_ai_mode':
        return this.handleSetAiMode(roomId, participantId, ws, event.mode);
    }
  }

  // ─── Handlers ───────────────────────────────────────────────────────────────

  private handleJoin(
    roomId: string,
    participantId: string,
    ws: WebSocket,
    name: string,
    color: string,
  ): void {
    const room = this.rooms.get(roomId);
    if (!room) {
      this.sendTo(ws, { type: 'error', message: 'Room not found' });
      return;
    }

    const participant: CollabParticipant = {
      id: participantId,
      name: name?.trim() || 'Guest',
      color: color || COLORS[room.participants.size % COLORS.length],
    };

    // First joiner becomes host
    if (!room.hostId) room.hostId = participantId;
    room.participants.set(participantId, participant);

    this.sendTo(ws, {
      type: 'sync',
      messages: room.messages,
      participants: Array.from(room.participants.values()),
      lockHolder: room.lockHolder,
      yourId: participantId,
      aiMode: room.aiMode,
      hostId: room.hostId,
    });

    this.broadcastExcept(roomId, participantId, { type: 'participant_joined', participant });
  }

  private handleLeave(roomId: string, participantId: string): void {
    this.sockets.delete(participantId);
    this.participantRoom.delete(participantId);

    const room = this.rooms.get(roomId);
    if (!room) return;

    // Guard against double-leave (socket close after explicit leave message)
    if (!room.participants.has(participantId)) return;

    room.participants.delete(participantId);

    if (room.lockHolder === participantId) {
      this.advanceLock(room, roomId);
    }

    this.broadcastAll(roomId, { type: 'participant_left', participantId });

    // Schedule empty-room cleanup
    if (room.participants.size === 0) {
      setTimeout(() => {
        const r = this.rooms.get(roomId);
        if (r && r.participants.size === 0) this.rooms.delete(roomId);
      }, IDLE_ROOM_TTL_MS);
    }
  }

  private handleLockRequest(roomId: string, participantId: string, ws: WebSocket): void {
    const room = this.rooms.get(roomId);
    if (!room) return;

    if (!room.lockHolder) {
      room.lockHolder = participantId;
      const ev = { type: 'lock_granted' as const, participantId };
      this.sendTo(ws, ev);
      this.broadcastExcept(roomId, participantId, ev);
      return;
    }

    if (room.lockHolder === participantId) {
      this.sendTo(ws, { type: 'lock_granted', participantId });
      return;
    }

    if (!room.lockQueue.includes(participantId)) room.lockQueue.push(participantId);
    this.sendTo(ws, { type: 'lock_denied', reason: 'Another participant is sending' });
  }

  private handleLockRelease(roomId: string, participantId: string): void {
    const room = this.rooms.get(roomId);
    if (!room || room.lockHolder !== participantId) return;
    this.advanceLock(room, roomId);
  }

  private advanceLock(room: Room, roomId: string): void {
    const next = room.lockQueue.shift() ?? null;
    room.lockHolder = next;
    if (next) {
      this.broadcastTo(next, { type: 'lock_granted', participantId: next });
    }
    this.broadcastAll(roomId, { type: 'lock_released', nextHolder: next });
  }

  private handleMessageAdd(
    roomId: string,
    participantId: string,
    message: RelayMessage,
  ): void {
    const room = this.rooms.get(roomId);
    if (!room || !this.assertLock(room, participantId)) return;
    room.messages.push(message);
    this.broadcastExcept(roomId, participantId, { type: 'message_add', message, participantId });
  }

  private handleStreamStart(roomId: string, participantId: string, messageId: string): void {
    const room = this.rooms.get(roomId);
    if (!room || !this.assertLock(room, participantId)) return;
    this.broadcastExcept(roomId, participantId, { type: 'stream_start', messageId, participantId });
  }

  private handleStreamChunk(
    roomId: string,
    participantId: string,
    messageId: string,
    delta: string,
  ): void {
    const room = this.rooms.get(roomId);
    if (!room || !this.assertLock(room, participantId)) return;
    this.broadcastExcept(roomId, participantId, { type: 'stream_chunk', messageId, delta, participantId });
  }

  private handleStreamEnd(
    roomId: string,
    participantId: string,
    messageId: string,
    message: RelayMessage,
  ): void {
    const room = this.rooms.get(roomId);
    if (!room || !this.assertLock(room, participantId)) return;

    const idx = room.messages.findIndex((m) => m.id === messageId);
    if (idx >= 0) room.messages[idx] = message;
    else room.messages.push(message);

    this.broadcastExcept(roomId, participantId, {
      type: 'stream_end', messageId, message, participantId,
    });
  }

  private handleSetAiMode(
    roomId: string,
    participantId: string,
    ws: WebSocket,
    mode: 'own' | 'host',
  ): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    if (room.hostId && participantId !== room.hostId) {
      this.sendTo(ws, { type: 'error', message: 'Only the host can change room settings' });
      return;
    }
    room.aiMode = mode;
    this.broadcastAll(roomId, { type: 'settings_update', aiMode: mode, hostId: room.hostId });
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  private assertLock(room: Room, participantId: string): boolean {
    if (room.lockHolder !== null && room.lockHolder !== participantId) {
      this.broadcastTo(participantId, { type: 'error', message: 'You do not hold the send lock' });
      return false;
    }
    return true;
  }

  private sendTo(ws: WebSocket, event: ServerEvent): void {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify(event)); } catch { /* socket closed */ }
    }
  }

  private broadcastAll(roomId: string, event: ServerEvent): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    for (const [pid] of room.participants) {
      const sock = this.sockets.get(pid);
      if (sock) this.sendTo(sock, event);
    }
  }

  private broadcastExcept(roomId: string, excludeId: string, event: ServerEvent): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    for (const [pid] of room.participants) {
      if (pid !== excludeId) {
        const sock = this.sockets.get(pid);
        if (sock) this.sendTo(sock, event);
      }
    }
  }

  private broadcastTo(participantId: string, event: ServerEvent): void {
    const sock = this.sockets.get(participantId);
    if (sock) this.sendTo(sock, event);
  }

  private startHeartbeat(): void {
    setInterval(() => {
      for (const [pid, ws] of this.sockets) {
        if (!ws._alive) {
          ws.terminate();
          const roomId = this.participantRoom.get(pid);
          if (roomId) this.handleLeave(roomId, pid);
          continue;
        }
        ws._alive = false;
        ws.ping();
      }
    }, HEARTBEAT_MS);
  }
}
