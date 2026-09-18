import type {
  DuoEvent,
  DuoInput,
  DuoLobbyState,
  DuoPlayerId,
  DuoSnapshot,
} from './protocol';
import { DEFAULT_PLAYER_SKIN_ID } from './playerSkins';

const SIGNAL_POLL_MS = 650;
const SESSION_TIMEOUT_MS = 120000;
const PING_INTERVAL_MS = 1000;
const HEARTBEAT_TIMEOUT_MS = 10000;
const RECONNECT_GRACE_MS = 20000;
const ICE_GATHERING_TIMEOUT_MS = 8000;
const DEFAULT_ICE_SERVERS: RTCIceServer[] = [{
  urls: [
    'stun:stun.l.google.com:19302',
    'stun:stun1.l.google.com:19302',
    'stun:stun2.l.google.com:19302',
  ],
}];
const STATE_CHANNEL_LABEL = 'state';
const INPUT_CHANNEL_LABEL = 'input';
const EVENTS_CHANNEL_LABEL = 'events';
const DEFAULT_LOBBY_AIM = -Math.PI / 2;

interface SessionMessage {
  type: string;
  [key: string]: unknown;
}

interface RoomResponse {
  roomCode: string;
  hostToken: string;
}

interface OfferResponse {
  offers: Array<{
    peerId: string;
    callsign: string;
    offer: RTCSessionDescriptionInit;
  }>;
}

interface AnswerResponse {
  answer?: RTCSessionDescriptionInit;
  error?: string;
}

interface RestartDescriptionResponse {
  peerId?: string;
  generation?: number;
  description?: RTCSessionDescriptionInit;
}

export interface DuoSessionCallbacks {
  lobby?: (state: DuoLobbyState) => void;
  input?: (input: DuoInput) => void;
  snapshot?: (snapshot: DuoSnapshot) => void;
  started?: () => void;
  ready?: () => void;
  redeploy?: () => void;
  paused?: (paused: boolean) => void;
  event?: (event: DuoEvent) => void;
  kicked?: (reason: string) => void;
  ping?: (milliseconds: number | null) => void;
  connection?: (state: 'connected' | 'reconnecting' | 'failed') => void;
  disconnected?: (reason: string) => void;
  gameOver?: (message: string) => void;
  leaderboardResult?: (result: DuoLeaderboardResult) => void;
}

export interface DuoLeaderboardResult {
  rank: number | null;
  newRecord: boolean;
  available: boolean;
}

export type DuoSessionRole = 'host' | 'guest';

export class DuoSession {
  readonly role: DuoSessionRole;
  readonly localPlayerId: DuoPlayerId;
  readonly roomCode: string;

  private readonly callbacks: DuoSessionCallbacks;
  private runtimeCallbacks: Pick<
    DuoSessionCallbacks,
    'input' | 'snapshot' | 'ready' | 'redeploy' | 'paused' | 'event'
  > = {};
  private readonly hostToken?: string;
  private readonly localCallsign: string;
  private readonly peerId?: string;
  private peer?: RTCPeerConnection;
  private channel?: RTCDataChannel;
  private stateChannel?: RTCDataChannel;
  private inputChannel?: RTCDataChannel;
  private eventsChannel?: RTCDataChannel;
  private pendingEvents: DuoEvent[] = [];
  private reconnectTimer?: number;
  private reconnecting = false;
  private offerPoll?: number;
  private answerPoll?: number;
  private restartAnswerPoll?: number;
  private pingTimer?: number;
  private pingStartedAt = 0;
  private lastMessageAt = 0;
  private lastGameplayMessageAt = 0;
  private closed = false;
  private started = false;
  private peerReady = false;
  private remotePaused = false;
  private localPaused = false;
  private lastInputSequence = -1;
  private restartGeneration = 0;
  private handledRestartGeneration = 0;
  private restartInProgress = false;
  private leaderboardPolling = false;
  private leaderboardDelivered = false;
  private lobby: DuoLobbyState;

  private constructor(options: {
    role: DuoSessionRole;
    roomCode: string;
    localCallsign: string;
    skinId: string;
    hostToken?: string;
    peerId?: string;
    callbacks?: DuoSessionCallbacks;
  }) {
    this.role = options.role;
    this.localPlayerId = options.role;
    this.roomCode = options.roomCode;
    this.localCallsign = options.localCallsign;
    this.hostToken = options.hostToken;
    this.peerId = options.peerId;
    this.callbacks = options.callbacks ?? {};
    this.lobby = {
      roomCode: options.roomCode,
      hostCallsign: options.role === 'host' ? options.localCallsign : '',
      guestCallsign: options.role === 'guest' ? options.localCallsign : '',
      hostSkinId: options.role === 'host' ? options.skinId : DEFAULT_PLAYER_SKIN_ID,
      guestSkinId: options.role === 'guest' ? options.skinId : DEFAULT_PLAYER_SKIN_ID,
      hostAim: DEFAULT_LOBBY_AIM,
      guestAim: DEFAULT_LOBBY_AIM,
      guestConnected: false,
      started: false,
    };
  }

  static async createHost(
    callsign: string,
    callbacks?: DuoSessionCallbacks,
    skinId = DEFAULT_PLAYER_SKIN_ID,
  ): Promise<DuoSession> {
    const response = await request<RoomResponse>('/api/private-rooms', {
      method: 'POST',
      body: JSON.stringify({ callsign }),
    });
    const session = new DuoSession({
      role: 'host',
      roomCode: response.roomCode,
      localCallsign: callsign,
      skinId,
      hostToken: response.hostToken,
      callbacks,
    });
    session.startHostPolling();
    return session;
  }

  static async join(
    roomCode: string,
    callsign: string,
    callbacks?: DuoSessionCallbacks,
    skinId = DEFAULT_PLAYER_SKIN_ID,
  ): Promise<DuoSession> {
    const normalizedCode = normalizeRoomCode(roomCode);
    const peerId = crypto.randomUUID();
    const session = new DuoSession({
      role: 'guest',
      roomCode: normalizedCode,
      localCallsign: callsign,
      skinId,
      peerId,
      callbacks,
    });
    await session.startGuestConnection();
    return session;
  }

  get isConnected(): boolean {
    return this.channel?.readyState === 'open';
  }

  get isStarted(): boolean {
    return this.started;
  }

  get lastProcessedInput(): number {
    return this.lastInputSequence;
  }

  getLeaderboardAuthorization(): { roomCode: string; hostToken: string } | undefined {
    if (this.role !== 'host' || !this.hostToken) return undefined;
    return { roomCode: this.roomCode, hostToken: this.hostToken };
  }

  setRuntimeCallbacks(
    callbacks: Pick<
      DuoSessionCallbacks,
      'input' | 'snapshot' | 'ready' | 'redeploy' | 'paused' | 'event'
    >,
  ): void {
    this.runtimeCallbacks = { ...callbacks };
    if (this.peerReady) callbacks.ready?.();
    if (this.remotePaused) callbacks.paused?.(true);
  }

  updateCallsign(callsign: string): void {
    const normalized = callsign.trim().slice(0, 18);
    if (!normalized) return;
    if (this.role === 'host') this.lobby.hostCallsign = normalized;
    else this.lobby.guestCallsign = normalized;
    this.emitLobby();
    this.send({ type: 'callsign', callsign: normalized });
  }

  updateSkin(skinId: string): void {
    if (this.started) return;
    const normalized = skinId.trim().slice(0, 64);
    if (!normalized) return;
    if (this.role === 'host') this.lobby.hostSkinId = normalized;
    else this.lobby.guestSkinId = normalized;
    this.emitLobby();
    this.send({ type: 'skin', skinId: normalized });
  }

  updateLobbyAim(aim: number): void {
    if (this.started || !Number.isFinite(aim)) return;
    const normalized = normalizeLobbyAim(aim);
    if (this.role === 'host') this.lobby.hostAim = normalized;
    else this.lobby.guestAim = normalized;
    this.emitLobby();
    this.send({ type: 'aim', aim: normalized });
  }

  startGame(): boolean {
    if (this.role !== 'host' || !this.isConnected || !this.lobby.guestCallsign || this.started) return false;
    this.started = true;
    this.lobby.started = true;
    this.send({
      type: 'start',
      hostCallsign: this.lobby.hostCallsign,
      guestCallsign: this.lobby.guestCallsign,
      hostSkinId: this.lobby.hostSkinId,
      guestSkinId: this.lobby.guestSkinId,
      hostAim: this.lobby.hostAim,
      guestAim: this.lobby.guestAim,
    });
    this.emitLobby();
    this.callbacks.started?.();
    return true;
  }

  sendInput(input: DuoInput): void {
    if (this.role !== 'guest' || !this.isConnected || this.started === false) return;
    if (this.inputChannel?.readyState !== 'open') return;
    if (this.inputChannel.bufferedAmount > 64 * 1024) return;
    try {
      this.inputChannel.send(JSON.stringify({ type: 'input', input }));
    } catch {
      this.beginReconnectGrace('The multiplayer input connection was lost.');
    }
  }

  sendEvent(event: DuoEvent): void {
    if (this.role !== 'host' || this.closed) return;
    if (this.eventsChannel?.readyState !== 'open') {
      this.pendingEvents.push(event);
      if (this.pendingEvents.length > 128) this.pendingEvents.shift();
      return;
    }
    if (this.eventsChannel.bufferedAmount > 256 * 1024) return;
    try {
      this.eventsChannel.send(JSON.stringify({ type: 'event', event }));
    } catch {
      this.beginReconnectGrace('The multiplayer events connection was lost.');
    }
  }

  sendReady(): void {
    if (this.role !== 'guest' || !this.isConnected || !this.started) return;
    this.send({ type: 'ready' });
  }

  sendSnapshot(snapshot: DuoSnapshot): void {
    if (this.role !== 'host' || !this.isConnected || this.closed || this.stateChannel?.readyState !== 'open') return;
    // State is intentionally sent on an unordered, non-retransmitting channel.
    // A current snapshot is useful; a queue of stale snapshots is not.
    if (this.stateChannel.bufferedAmount > 128 * 1024) return;
    try {
      this.stateChannel.send(JSON.stringify({ type: 'snapshot', snapshot }));
    } catch {
      this.beginReconnectGrace('The multiplayer state connection was lost.');
    }
  }

  sendGameOver(message: string): void {
    if (this.role !== 'host' || !this.isConnected) return;
    this.send({ type: 'game-over', message });
  }

  sendLeaderboardResult(result: DuoLeaderboardResult): void {
    if (this.role !== 'host') return;
    this.send({ type: 'leaderboard-result', result });
    void request(`/api/private-rooms/${encodeURIComponent(this.roomCode)}/result`, {
      method: 'POST',
      headers: this.hostHeaders(),
      body: JSON.stringify({ result }),
    }).catch(() => undefined);
  }

  sendRedeploy(): void {
    if (this.role !== 'host' || !this.isConnected) return;
    this.peerReady = false;
    // Scene restart resets the guest's input sequence. Accept its new
    // sequence numbers after a redeploy instead of treating them as stale.
    this.lastInputSequence = -1;
    this.send({ type: 'redeploy' });
  }

  sendPause(paused: boolean): void {
    if (this.role !== 'host' || !this.isConnected) return;
    this.localPaused = paused;
    this.send({ type: 'pause', paused });
  }

  async kickGuest(): Promise<void> {
    if (this.role !== 'host' || !this.isConnected || this.closed) return;
    this.send({ type: 'kick', message: 'THE HOST REMOVED YOU FROM THE DUO LOBBY.' });
    await request(`/api/private-rooms/${encodeURIComponent(this.roomCode)}/guest`, {
      method: 'POST',
      headers: this.hostHeaders(),
      body: '{}',
    });
    if (this.pingTimer !== undefined) {
      window.clearInterval(this.pingTimer);
      this.pingTimer = undefined;
    }
    this.teardownPeer();
    this.peerReady = false;
    this.remotePaused = false;
    this.lastInputSequence = -1;
    this.started = false;
    this.lobby.guestCallsign = '';
    this.lobby.guestAim = DEFAULT_LOBBY_AIM;
    this.lobby.guestConnected = false;
    this.lobby.started = false;
    this.emitLobby();
  }

  close(reason = 'Session closed.'): void {
    if (this.closed) return;
    if (this.role === 'guest' && this.started && reason !== 'Session closed.') {
      this.pollLeaderboardResult();
    }
    this.closed = true;
    if (this.reconnectTimer !== undefined) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    if (this.offerPoll !== undefined) window.clearInterval(this.offerPoll);
    if (this.answerPoll !== undefined) window.clearInterval(this.answerPoll);
    if (this.restartAnswerPoll !== undefined) window.clearInterval(this.restartAnswerPoll);
    if (this.pingTimer !== undefined) window.clearInterval(this.pingTimer);
    this.teardownPeer();
    if (reason !== 'Session closed.') this.callbacks.disconnected?.(reason);
  }

  private startHostPolling(): void {
    this.pollOffers();
    this.offerPoll = window.setInterval(() => {
      void this.pollOffers();
      if (this.peer && this.started) void this.pollRestartOffer();
    }, SIGNAL_POLL_MS);
  }

  private async pollOffers(): Promise<void> {
    if (this.closed || this.role !== 'host') return;
    try {
      const response = await request<OfferResponse>(
        `/api/private-rooms/${encodeURIComponent(this.roomCode)}/offers`,
        { headers: this.hostHeaders() },
      );
      const offer = response.offers[0];
      if (!offer || this.peer) return;
      await this.acceptOffer(offer);
    } catch (error) {
      // Once WebRTC exists, this poll only keeps the room alive. A transient
      // API/proxy outage must not end an otherwise healthy P2P match.
      if (!this.closed && !this.peer) this.callbacks.disconnected?.(messageFromError(error));
    }
  }

  private async acceptOffer(offer: OfferResponse['offers'][number]): Promise<void> {
    const peer = this.makePeer();
    this.peer = peer;
    this.attachStateChannel(peer.createDataChannel(STATE_CHANNEL_LABEL, {
      ordered: false,
      maxRetransmits: 0,
    }));
    this.attachEventsChannel(peer.createDataChannel(EVENTS_CHANNEL_LABEL));
    await peer.setRemoteDescription(offer.offer);
    const answer = await peer.createAnswer();
    await peer.setLocalDescription(answer);
    await waitForIceGathering(peer);
    await request(`/api/private-rooms/${encodeURIComponent(this.roomCode)}/answers`, {
      method: 'POST',
      headers: this.hostHeaders(),
      body: JSON.stringify({
        peerId: offer.peerId,
        answer: peer.localDescription,
      }),
    });
    this.lobby.guestCallsign = offer.callsign;
    this.emitLobby();
  }

  private async startGuestConnection(): Promise<void> {
    const peer = this.makePeer();
    this.peer = peer;
    const channel = peer.createDataChannel('game');
    this.attachChannel(channel);
    this.attachInputChannel(peer.createDataChannel(INPUT_CHANNEL_LABEL, {
      ordered: false,
      maxRetransmits: 0,
    }));
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    await waitForIceGathering(peer);
    await request(`/api/private-rooms/${encodeURIComponent(this.roomCode)}/offers`, {
      method: 'POST',
      body: JSON.stringify({
        peerId: this.peerId,
        callsign: this.localCallsign,
        offer: peer.localDescription,
      }),
    });
    this.waitForAnswer();
  }

  private async startIceRestart(): Promise<void> {
    const peer = this.peer;
    if (this.role !== 'guest' || this.closed || this.restartInProgress || !peer
      || peer.signalingState !== 'stable') return;
    this.restartInProgress = true;
    const generation = ++this.restartGeneration;
    try {
      peer.restartIce();
      const offer = await peer.createOffer({ iceRestart: true });
      await peer.setLocalDescription(offer);
      await waitForIceGathering(peer);
      if (this.closed || generation !== this.restartGeneration || !peer.localDescription) return;
      await request(`/api/private-rooms/${encodeURIComponent(this.roomCode)}/restart-offer`, {
        method: 'POST',
        body: JSON.stringify({
          peerId: this.peerId,
          generation,
          description: peer.localDescription,
        }),
      });
      this.startRestartAnswerPolling(generation);
    } catch {
      this.restartInProgress = false;
    }
  }

  private startRestartAnswerPolling(generation: number): void {
    if (this.restartAnswerPoll !== undefined) window.clearInterval(this.restartAnswerPoll);
    this.restartAnswerPoll = window.setInterval(() => {
      if (this.closed || generation !== this.restartGeneration || !this.restartInProgress) return;
      const query = new URLSearchParams({
        peerId: this.peerId ?? '',
        generation: String(generation),
      });
      void request<RestartDescriptionResponse>(
        `/api/private-rooms/${encodeURIComponent(this.roomCode)}/restart-answer?${query}`,
      ).then(async (response) => {
        if (!response.description || response.generation !== generation || this.closed) return;
        const peer = this.peer;
        if (!peer || peer.signalingState !== 'have-local-offer') return;
        await peer.setRemoteDescription(response.description);
        this.restartInProgress = false;
        if (this.restartAnswerPoll !== undefined) window.clearInterval(this.restartAnswerPoll);
        this.restartAnswerPoll = undefined;
        this.markConnected(true);
      }).catch(() => undefined);
    }, SIGNAL_POLL_MS);
  }

  private async pollRestartOffer(): Promise<void> {
    if (this.closed || this.role !== 'host' || !this.peer || !this.started || this.restartInProgress) return;
    try {
      const response = await request<RestartDescriptionResponse>(
        `/api/private-rooms/${encodeURIComponent(this.roomCode)}/restart-offer`,
        { headers: this.hostHeaders() },
      );
      const generation = Number(response.generation);
      if (!response.description || !response.peerId || !Number.isInteger(generation)
        || generation <= this.handledRestartGeneration) return;
      this.restartInProgress = true;
      await this.answerRestartOffer(response.peerId, generation, response.description);
      this.handledRestartGeneration = generation;
    } catch {
      // The reconnect deadline remains responsible for surfacing failure.
    } finally {
      this.restartInProgress = false;
    }
  }

  private async answerRestartOffer(
    peerId: string,
    generation: number,
    description: RTCSessionDescriptionInit,
  ): Promise<void> {
    const peer = this.peer;
    if (!peer || peer.signalingState !== 'stable') return;
    await peer.setRemoteDescription(description);
    const answer = await peer.createAnswer();
    await peer.setLocalDescription(answer);
    await waitForIceGathering(peer);
    if (this.closed || !peer.localDescription) return;
    await request(`/api/private-rooms/${encodeURIComponent(this.roomCode)}/restart-answer`, {
      method: 'POST',
      headers: this.hostHeaders(),
      body: JSON.stringify({
        peerId,
        generation,
        description: peer.localDescription,
      }),
    });
  }

  private waitForAnswer(): void {
    const startedAt = Date.now();
    this.answerPoll = window.setInterval(() => {
      if (this.closed || this.peer?.remoteDescription) return;
      if (Date.now() - startedAt > SESSION_TIMEOUT_MS) {
        this.close('The host did not respond in time.');
        return;
      }
      void request<AnswerResponse>(
        `/api/private-rooms/${encodeURIComponent(this.roomCode)}/answers/${encodeURIComponent(this.peerId ?? '')}`,
      ).then(async (response) => {
        if (this.closed || this.peer?.remoteDescription) return;
        if (response.error) throw new Error(response.error);
        if (!response.answer) return;
        if (this.answerPoll !== undefined) window.clearInterval(this.answerPoll);
        await this.peer?.setRemoteDescription(response.answer);
      }).catch((error) => {
        if (!this.closed) this.callbacks.disconnected?.(messageFromError(error));
      });
    }, SIGNAL_POLL_MS);
  }

  private makePeer(): RTCPeerConnection {
    const peer = new RTCPeerConnection({
      iceServers: DEFAULT_ICE_SERVERS,
      iceCandidatePoolSize: 10,
      bundlePolicy: 'max-bundle',
    });
    peer.ondatachannel = (event) => {
      if (event.channel.label === 'game') this.attachChannel(event.channel);
      if (event.channel.label === STATE_CHANNEL_LABEL) this.attachStateChannel(event.channel);
      if (event.channel.label === INPUT_CHANNEL_LABEL) this.attachInputChannel(event.channel);
      if (event.channel.label === EVENTS_CHANNEL_LABEL) this.attachEventsChannel(event.channel);
    };
    peer.onconnectionstatechange = () => {
      if (this.closed) return;
      if (peer.connectionState === 'connected') this.markConnected(true);
      else if (peer.connectionState === 'failed' || peer.connectionState === 'closed') {
        this.beginReconnectGrace('The multiplayer connection failed.');
      } else if (peer.connectionState === 'disconnected') {
        this.beginReconnectGrace('The multiplayer connection was lost.');
      }
    };
    peer.oniceconnectionstatechange = () => {
      if (this.closed) return;
      if (peer.iceConnectionState === 'connected' || peer.iceConnectionState === 'completed') {
        this.markConnected(true);
      } else if (peer.iceConnectionState === 'failed' || peer.iceConnectionState === 'closed') {
        this.beginReconnectGrace('The multiplayer connection failed.');
      } else if (peer.iceConnectionState === 'disconnected') {
        this.beginReconnectGrace('The multiplayer connection was lost.');
      }
    };
    return peer;
  }

  private attachChannel(channel: RTCDataChannel): void {
    if (channel.label !== 'game') return;
    this.channel?.close();
    this.channel = channel;
    channel.onopen = () => {
      this.lastMessageAt = performance.now();
      this.lastGameplayMessageAt = this.lastMessageAt;
      this.markConnected();
      this.startPing();
      if (this.role === 'guest') {
        this.send({ type: 'callsign', callsign: this.localCallsign });
        this.send({ type: 'skin', skinId: this.lobby.guestSkinId });
        this.send({ type: 'aim', aim: this.lobby.guestAim });
      } else {
        this.lobby.guestConnected = true;
        this.emitLobby();
        this.broadcastLobby();
      }
    };
    channel.onclose = () => {
      if (!this.closed) this.beginReconnectGrace('The multiplayer connection was lost.');
    };
    channel.onerror = () => {
      if (!this.closed) this.beginReconnectGrace('The multiplayer connection encountered an error.');
    };
    channel.onmessage = (event) => this.handleMessage(event.data);
  }

  private attachStateChannel(channel: RTCDataChannel): void {
    if (channel.label !== STATE_CHANNEL_LABEL) return;
    this.stateChannel?.close();
    this.stateChannel = channel;
    channel.binaryType = 'arraybuffer';
    channel.onopen = () => this.markConnected();
    channel.onmessage = (event) => this.handleStateMessage(event.data);
    channel.onclose = () => {
      if (!this.closed) this.beginReconnectGrace('The multiplayer state connection was lost.');
    };
    channel.onerror = () => {
      if (!this.closed) this.beginReconnectGrace('The multiplayer state connection encountered an error.');
    };
  }

  private attachInputChannel(channel: RTCDataChannel): void {
    if (channel.label !== INPUT_CHANNEL_LABEL) return;
    this.inputChannel?.close();
    this.inputChannel = channel;
    channel.onopen = () => this.markConnected();
    channel.onmessage = (event) => this.handleInputMessage(event.data);
    channel.onclose = () => {
      if (!this.closed) this.beginReconnectGrace('The multiplayer input connection was lost.');
    };
    channel.onerror = () => {
      if (!this.closed) this.beginReconnectGrace('The multiplayer input connection encountered an error.');
    };
  }

  private attachEventsChannel(channel: RTCDataChannel): void {
    if (channel.label !== EVENTS_CHANNEL_LABEL) return;
    this.eventsChannel?.close();
    this.eventsChannel = channel;
    channel.onopen = () => {
      this.markConnected();
      this.flushPendingEvents();
    };
    channel.onmessage = (event) => this.handleEventMessage(event.data);
    channel.onclose = () => {
      if (!this.closed) this.beginReconnectGrace('The multiplayer events connection was lost.');
    };
    channel.onerror = () => {
      if (!this.closed) this.beginReconnectGrace('The multiplayer events connection encountered an error.');
    };
  }

  private handleStateMessage(raw: unknown): void {
    this.lastGameplayMessageAt = performance.now();
    this.noteMessageReceived();
    let message: SessionMessage;
    try {
      message = JSON.parse(String(raw)) as SessionMessage;
    } catch {
      return;
    }
    if (message.type !== 'snapshot' || this.role !== 'guest') return;
    this.runtimeCallbacks.snapshot?.(message.snapshot as DuoSnapshot);
  }

  private handleInputMessage(raw: unknown): void {
    if (this.role !== 'host') return;
    this.lastGameplayMessageAt = performance.now();
    this.noteMessageReceived();
    let message: SessionMessage;
    try {
      message = JSON.parse(String(raw)) as SessionMessage;
    } catch {
      return;
    }
    if (message.type !== 'input') return;
    const input = message.input as DuoInput;
    if (!input || !Number.isInteger(input.sequence) || input.sequence <= this.lastInputSequence) return;
    this.lastInputSequence = input.sequence;
    this.runtimeCallbacks.input?.(input);
  }

  private handleEventMessage(raw: unknown): void {
    if (this.role !== 'guest') return;
    this.noteMessageReceived();
    let message: SessionMessage;
    try {
      message = JSON.parse(String(raw)) as SessionMessage;
    } catch {
      return;
    }
    if (message.type !== 'event' || !message.event) return;
    this.runtimeCallbacks.event?.(message.event as DuoEvent);
  }

  private handleMessage(raw: unknown): void {
    this.noteMessageReceived();
    let message: SessionMessage;
    try {
      message = JSON.parse(String(raw)) as SessionMessage;
    } catch {
      return;
    }
    if (!message || typeof message.type !== 'string') return;

    if (message.type === 'ping') {
      this.send({ type: 'pong', sentAt: message.sentAt });
      return;
    }
    if (message.type === 'pong') {
      const sentAt = Number(message.sentAt);
      if (Number.isFinite(sentAt)) {
        const milliseconds = Math.max(0, Math.round(performance.now() - sentAt));
        this.callbacks.ping?.(milliseconds);
      }
      return;
    }
    if (message.type === 'restart-request' && this.role === 'guest') {
      void this.startIceRestart();
      return;
    }
    if (message.type === 'callsign' && this.role === 'host') {
      const callsign = String(message.callsign ?? '').trim().slice(0, 18);
      if (callsign) {
        this.lobby.guestCallsign = callsign;
        this.emitLobby();
        this.broadcastLobby();
      }
      return;
    }
    if (message.type === 'skin' && this.role === 'host' && !this.started) {
      const skinId = String(message.skinId ?? '').trim().slice(0, 64);
      if (skinId) {
        this.lobby.guestSkinId = skinId;
        this.emitLobby();
        this.broadcastLobby();
      }
      return;
    }
    if (message.type === 'aim' && !this.started) {
      const aim = Number(message.aim);
      if (!Number.isFinite(aim)) return;
      if (this.role === 'host') {
        this.lobby.guestAim = normalizeLobbyAim(aim);
        this.emitLobby();
        this.broadcastLobby();
      } else {
        this.lobby.hostAim = normalizeLobbyAim(aim);
        this.emitLobby();
      }
      return;
    }
    if (message.type === 'start' && this.role === 'guest') {
      this.lobby.hostCallsign = String(message.hostCallsign ?? '').slice(0, 18);
      this.lobby.guestCallsign = String(message.guestCallsign ?? '').slice(0, 18);
      this.lobby.hostSkinId = String(message.hostSkinId ?? this.lobby.hostSkinId);
      this.lobby.guestSkinId = String(message.guestSkinId ?? this.lobby.guestSkinId);
      this.lobby.hostAim = normalizeLobbyAim(Number(message.hostAim ?? this.lobby.hostAim));
      this.lobby.guestAim = normalizeLobbyAim(Number(message.guestAim ?? this.lobby.guestAim));
      this.lobby.started = true;
      this.started = true;
      this.emitLobby();
      this.callbacks.started?.();
      return;
    }
    if (message.type === 'lobby' && this.role === 'guest') {
      const state = message.state as Partial<DuoLobbyState>;
      this.lobby = {
        ...this.lobby,
        hostCallsign: String(state.hostCallsign ?? this.lobby.hostCallsign),
        guestCallsign: String(state.guestCallsign ?? this.lobby.guestCallsign),
        hostSkinId: String(state.hostSkinId ?? this.lobby.hostSkinId),
        guestSkinId: String(state.guestSkinId ?? this.lobby.guestSkinId),
        hostAim: normalizeLobbyAim(Number(state.hostAim ?? this.lobby.hostAim)),
        guestAim: normalizeLobbyAim(Number(state.guestAim ?? this.lobby.guestAim)),
        guestConnected: Boolean(state.guestConnected),
        started: Boolean(state.started),
      };
      this.emitLobby();
      return;
    }
    if (message.type === 'input' && this.role === 'host') {
      const input = message.input as DuoInput;
      if (!input || !Number.isInteger(input.sequence) || input.sequence <= this.lastInputSequence) return;
      this.lastInputSequence = input.sequence;
      this.runtimeCallbacks.input?.(input);
      return;
    }
    if (message.type === 'ready' && this.role === 'host') {
      this.peerReady = true;
      this.runtimeCallbacks.ready?.();
      return;
    }
    if (message.type === 'redeploy' && this.role === 'guest') {
      this.runtimeCallbacks.redeploy?.();
      return;
    }
    if (message.type === 'pause' && this.role === 'guest') {
      this.remotePaused = Boolean(message.paused);
      this.runtimeCallbacks.paused?.(this.remotePaused);
      return;
    }
    if (message.type === 'kick' && this.role === 'guest') {
      this.callbacks.kicked?.(String(message.message ?? 'THE HOST REMOVED YOU FROM THE DUO LOBBY.'));
      this.close();
      return;
    }
    if (message.type === 'game-over') {
      this.callbacks.gameOver?.(String(message.message ?? 'OPERATION ENDED // BOTH SURVIVORS DOWN'));
      if (this.role === 'guest') this.pollLeaderboardResult();
      return;
    }
    if (message.type === 'leaderboard-result' && this.role === 'guest') {
      this.leaderboardDelivered = true;
      this.callbacks.leaderboardResult?.(message.result as DuoLeaderboardResult);
    }
  }

  private broadcastLobby(): void {
    this.send({ type: 'lobby', state: this.lobby });
  }

  private flushPendingEvents(): void {
    if (this.role !== 'host' || this.eventsChannel?.readyState !== 'open') return;
    const pending = this.pendingEvents.splice(0);
    for (const event of pending) this.sendEvent(event);
  }

  private markConnected(transportRecovered = false): void {
    if (this.closed) return;
    if (!this.requiredChannelsOpen()) return;
    if (this.peer?.signalingState !== 'stable') return;
    if (transportRecovered && this.peer?.connectionState !== 'connected'
      && this.peer?.iceConnectionState !== 'connected'
      && this.peer?.iceConnectionState !== 'completed') return;
    const intentionallyPaused = this.role === 'host' ? this.localPaused : this.remotePaused;
    if (!transportRecovered && this.started && !intentionallyPaused
      && performance.now() - this.lastGameplayMessageAt > HEARTBEAT_TIMEOUT_MS) return;
    if (this.reconnectTimer !== undefined) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    const wasReconnecting = this.reconnecting;
    this.reconnecting = false;
    this.restartInProgress = false;
    if (this.restartAnswerPoll !== undefined) window.clearInterval(this.restartAnswerPoll);
    this.restartAnswerPoll = undefined;
    if (wasReconnecting || this.callbacks.connection) this.callbacks.connection?.('connected');
  }

  private beginReconnectGrace(reason: string): void {
    if (this.closed || this.reconnectTimer !== undefined) return;
    this.reconnecting = true;
    this.callbacks.connection?.('reconnecting');
    if (this.role === 'host') this.send({ type: 'restart-request' });
    else void this.startIceRestart();
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.closed) return;
      this.callbacks.connection?.('failed');
      this.close(reason);
    }, RECONNECT_GRACE_MS);
  }

  private noteMessageReceived(): void {
    this.lastMessageAt = performance.now();
    if (this.reconnecting) this.markConnected();
  }

  private requiredChannelsOpen(): boolean {
    return this.channel?.readyState === 'open'
      && this.stateChannel?.readyState === 'open'
      && this.inputChannel?.readyState === 'open'
      && this.eventsChannel?.readyState === 'open';
  }

  private pollLeaderboardResult(attempt = 0): void {
    if (this.role !== 'guest' || !this.peerId || this.leaderboardDelivered) return;
    if (attempt >= 30) {
      this.leaderboardPolling = false;
      this.leaderboardDelivered = true;
      this.callbacks.leaderboardResult?.({ rank: null, newRecord: false, available: false });
      return;
    }
    if (attempt === 0) {
      if (this.leaderboardPolling) return;
      this.leaderboardPolling = true;
    }
    const query = new URLSearchParams({ peerId: this.peerId });
    void request<{ result?: DuoLeaderboardResult | null }>(
      `/api/private-rooms/${encodeURIComponent(this.roomCode)}/result?${query}`,
    ).then((response) => {
      if (this.leaderboardDelivered) return;
      if (response.result) {
        this.leaderboardDelivered = true;
        this.leaderboardPolling = false;
        this.callbacks.leaderboardResult?.(response.result);
        return;
      }
      window.setTimeout(() => this.pollLeaderboardResult(attempt + 1), SIGNAL_POLL_MS);
    }).catch(() => {
      window.setTimeout(() => this.pollLeaderboardResult(attempt + 1), SIGNAL_POLL_MS);
    });
  }

  private emitLobby(): void {
    this.callbacks.lobby?.({ ...this.lobby });
  }

  private send(message: SessionMessage): void {
    if (this.channel?.readyState !== 'open') return;
    try {
      this.channel.send(JSON.stringify(message));
    } catch {
      this.beginReconnectGrace('The multiplayer connection was lost.');
    }
  }

  private hostHeaders(): HeadersInit {
    return this.hostToken ? { 'x-duo-host-token': this.hostToken } : {};
  }

  private teardownPeer(): void {
    const channel = this.channel;
    const stateChannel = this.stateChannel;
    const inputChannel = this.inputChannel;
    const eventsChannel = this.eventsChannel;
    const peer = this.peer;
    this.channel = undefined;
    this.stateChannel = undefined;
    this.inputChannel = undefined;
    this.eventsChannel = undefined;
    this.peer = undefined;
    if (channel) {
      channel.onopen = null;
      channel.onclose = null;
      channel.onerror = null;
      channel.onmessage = null;
      channel.close();
    }
    if (stateChannel) {
      stateChannel.onopen = null;
      stateChannel.onclose = null;
      stateChannel.onerror = null;
      stateChannel.onmessage = null;
      stateChannel.close();
    }
    for (const dataChannel of [inputChannel, eventsChannel]) {
      if (!dataChannel) continue;
      dataChannel.onopen = null;
      dataChannel.onclose = null;
      dataChannel.onerror = null;
      dataChannel.onmessage = null;
      dataChannel.close();
    }
    if (peer) {
      peer.ondatachannel = null;
      peer.onconnectionstatechange = null;
      peer.oniceconnectionstatechange = null;
      peer.close();
    }
  }

  private startPing(): void {
    if (this.pingTimer !== undefined) window.clearInterval(this.pingTimer);
    this.pingTimer = window.setInterval(() => {
      if (!this.isConnected) return;
      if (this.started && performance.now() - this.lastMessageAt > HEARTBEAT_TIMEOUT_MS) {
        this.beginReconnectGrace('The multiplayer connection stopped responding.');
        return;
      }
      const intentionallyPaused = this.role === 'host' ? this.localPaused : this.remotePaused;
      if (this.started && !intentionallyPaused
        && performance.now() - this.lastGameplayMessageAt > HEARTBEAT_TIMEOUT_MS) {
        this.beginReconnectGrace('The multiplayer gameplay connection stopped responding.');
        return;
      }
      this.pingStartedAt = performance.now();
      this.send({ type: 'ping', sentAt: this.pingStartedAt });
    }, PING_INTERVAL_MS);
  }
}

async function request<T = unknown>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: { 'content-type': 'application/json', ...options?.headers },
  });
  const body = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`);
  return body;
}

async function waitForIceGathering(peer: RTCPeerConnection): Promise<void> {
  if (peer.iceGatheringState === 'complete') return;
  await new Promise<void>((resolve) => {
    let finished = false;
    const onStateChange = () => {
      if (peer.iceGatheringState === 'complete') complete();
    };
    const complete = () => {
      if (finished) return;
      finished = true;
      window.clearTimeout(timeout);
      peer.removeEventListener('icegatheringstatechange', onStateChange);
      resolve();
    };
    const timeout = window.setTimeout(complete, ICE_GATHERING_TIMEOUT_MS);
    peer.addEventListener('icegatheringstatechange', onStateChange);
  });
}

function normalizeRoomCode(value: string): string {
  return value.trim().replace(/[^a-z0-9]/gi, '').toUpperCase().slice(0, 6);
}

function normalizeLobbyAim(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_LOBBY_AIM;
  const fullTurn = Math.PI * 2;
  return ((value + Math.PI) % fullTurn + fullTurn) % fullTurn - Math.PI;
}

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
