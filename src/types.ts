/** Participant in a live collaboration room. */
export interface CollabParticipant {
  id: string;
  name: string;
  color: string;
}

/** Minimal message shape — mirrors core's Message type without importing it. */
export interface RelayMessage {
  id: string;
  role: string;
  content: string;
  timestamp: number;
  thinking?: string;
  toolCalls?: unknown[];
  usage?: unknown;
  model?: string;
  providerId?: string;
  [key: string]: unknown;
}

// ─── Wire protocol ─────────────────────────────────────────────────────────────

export type ClientEvent =
  | { type: 'join'; name: string; color: string }
  | { type: 'leave' }
  | { type: 'lock_request' }
  | { type: 'lock_release' }
  | { type: 'message_add'; message: RelayMessage }
  | { type: 'stream_start'; messageId: string }
  | { type: 'stream_chunk'; messageId: string; delta: string }
  | { type: 'stream_end'; messageId: string; message: RelayMessage }
  | { type: 'typing'; isTyping: boolean }
  | { type: 'set_ai_mode'; mode: 'own' | 'host' };

export type ServerEvent =
  | { type: 'sync'; messages: RelayMessage[]; participants: CollabParticipant[]; lockHolder: string | null; yourId: string; aiMode: 'own' | 'host'; hostId: string | null }
  | { type: 'participant_joined'; participant: CollabParticipant }
  | { type: 'participant_left'; participantId: string }
  | { type: 'lock_granted'; participantId: string }
  | { type: 'lock_denied'; reason: string }
  | { type: 'lock_released'; nextHolder: string | null }
  | { type: 'message_add'; message: RelayMessage; participantId: string }
  | { type: 'stream_start'; messageId: string; participantId: string }
  | { type: 'stream_chunk'; messageId: string; delta: string; participantId: string }
  | { type: 'stream_end'; messageId: string; message: RelayMessage; participantId: string }
  | { type: 'typing'; participantId: string; isTyping: boolean }
  | { type: 'settings_update'; aiMode: 'own' | 'host'; hostId: string | null }
  | { type: 'error'; message: string };
