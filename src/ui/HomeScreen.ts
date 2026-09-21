import {
  CallsignUnavailableError,
  checkPlayerName,
  claimPlayerName,
  flushPendingScores,
  getChangelog,
  getLeaderboard,
  getStatus,
  type ChangelogEntry,
  type LeaderboardEntry,
  type LeaderboardMode,
} from '../api/client';
import { hasTouchControls } from '../config/controls';
import lastNightAliveUrl from '../assets/audio/Last Night Alive.mp3';
import { validatePlayerName } from '../shared/nameValidator';
import { DuoSession } from '../network/duoSession';
import {
  DEFAULT_PLAYER_SKIN_ID,
  getAvailablePlayerSkins,
  getDefaultPlayerSkin,
  getPlayerSkin,
  getPlayerSkinPreviewUrl,
  preloadPlayerSkinPreviews,
} from '../network/playerSkins';
import type { DuoLobbyState, DuoPlayerId } from '../network/protocol';
import type { GameLaunchOptions } from '../network/gameLaunch';

interface HomeScreenOptions {
  onDeploy: (options: GameLaunchOptions) => Promise<void>;
}

const CALLSIGN_KEY = 'the-last-light-callsign';
const SKIN_KEY = 'the-last-light-skin';
const HOME_MUSIC_VOLUME = 0.16;
const HOME_MUSIC_TRACKS = [lastNightAliveUrl];
const DEFAULT_LOBBY_AIM = -Math.PI / 2;

export class HomeScreen {
  private readonly callsign = element<HTMLInputElement>('callsign');
  private readonly skinButton = element<HTMLButtonElement>('skin-button');
  private readonly duoToggleButton = element<HTMLButtonElement>('duo-toggle-button');
  private readonly duoQuickActions = element<HTMLElement>('duo-quick-actions');
  private readonly playButton = element<HTMLButtonElement>('play-button');
  private readonly soloSkinPicker = element<HTMLElement>('solo-skin-picker');
  private readonly soloSkinSelector = element<HTMLElement>('solo-skin-selector');
  private readonly soloSkinPreview = element<HTMLImageElement>('solo-skin-preview');
  private readonly soloSkinName = element<HTMLElement>('solo-skin-name');
  private readonly notice = element<HTMLElement>('home-notice');
  private readonly duoModal = element<HTMLElement>('duo-modal');
  private readonly skinModal = element<HTMLElement>('skin-modal');
  private readonly duoContent = element<HTMLElement>('duo-content');
  private menuMusic?: HTMLAudioElement;
  private menuUnlockHandler?: (event: Event) => void;
  private deploying = false;
  private callsignCheckTimer?: number;
  private callsignCheckGeneration = 0;
  private callsignAvailable = false;
  private duoSession?: DuoSession;
  private duoLobbyState?: DuoLobbyState;
  private duoBusy = false;
  private lobbyAimFrame?: number;
  private lobbyAimAnimationFrame?: number;
  private pendingLobbyAim?: number;
  private lastLobbyAimSentAt = 0;
  private readonly lobbyAimVisual = new Map<DuoPlayerId, number>();
  private readonly lobbyAimTargets = new Map<DuoPlayerId, number>();
  private soloSkinId = DEFAULT_PLAYER_SKIN_ID;
  private lastSoloCallsign = '';
  private pendingInviteCode?: string;
  private duoModeSelected = false;
  private leaderboardMode: LeaderboardMode = 'solo';

  constructor(private readonly options: HomeScreenOptions) {
    document.documentElement.classList.toggle('touch-controls-available', hasTouchControls());
    this.callsign.value = localStorage.getItem(CALLSIGN_KEY) ?? '';
    const savedSkinId = localStorage.getItem(SKIN_KEY);
    this.soloSkinId = savedSkinId
      ? savedSkinId
      : getDefaultPlayerSkin(this.callsign.value).id;
    this.lastSoloCallsign = '';
    this.updateSoloSkinForCallsign();
    void preloadPlayerSkinPreviews();
    this.callsign.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      this.callsign.blur();
    });
    element<HTMLFormElement>('deploy-form').addEventListener('submit', (event) => void this.deploy(event));
    this.skinButton.addEventListener('click', () => {
      if (!this.callsignAvailable) return;
      this.renderSoloSkin();
      this.openModal('skin-modal');
    });
    this.duoToggleButton.addEventListener('click', () => this.toggleDuoMode());
    element('create-duos-button').addEventListener('click', () => void this.openCreateDuo());
    element('join-duos-button').addEventListener('click', () => this.openJoinDuo());
    this.callsign.addEventListener('input', () => this.updateSoloSkinForCallsign());
    this.soloSkinSelector.querySelectorAll<HTMLButtonElement>('[data-solo-skin-direction]').forEach((button) => {
      button.addEventListener('click', () => {
        const direction = Number(button.dataset.soloSkinDirection);
        if (Number.isFinite(direction)) this.cycleSoloSkin(direction);
      });
    });
    window.addEventListener('pointermove', (event) => {
      this.updateSoloAimFromPointer(event);
      this.updateDuoAimFromPointer(event);
    });
    element('how-to-button').addEventListener('click', () => this.openModal('how-to-modal'));
    element('leaderboard-button').addEventListener('click', () => void this.openLeaderboard());
    document.querySelectorAll<HTMLButtonElement>('[data-leaderboard-mode]').forEach((button) => {
      button.addEventListener('click', () => {
        const mode = button.dataset.leaderboardMode;
        if (mode !== 'solo' && mode !== 'duos') return;
        this.leaderboardMode = mode;
        this.updateLeaderboardModeButtons();
        void this.loadLeaderboard();
      });
    });
    element('changelog-button').addEventListener('click', () => void this.openChangelog());
    document.querySelectorAll<HTMLElement>('[data-close-modal]').forEach((button) => {
      button.addEventListener('click', () => {
        const modal = button.closest('.modal');
        if (modal?.id === 'duo-modal') this.closeDuoLobby();
        modal?.classList.add('hidden');
      });
    });
    document.querySelectorAll<HTMLElement>('.modal').forEach((modal) => {
      modal.addEventListener('pointerdown', (event) => {
        if (event.target !== modal) return;
        if (modal.id === 'duo-modal') this.closeDuoLobby();
        modal.classList.add('hidden');
      });
    });
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      if (!this.duoModal.classList.contains('hidden')) this.closeDuoLobby();
      document.querySelectorAll('.modal').forEach((modal) => modal.classList.add('hidden'));
    });
    void this.refreshStatus();
    this.renderDeployMode();
    this.startMenuMusic();
    const inviteCode = readInviteCode();
    if (inviteCode) {
      this.pendingInviteCode = inviteCode;
      const url = new URL(window.location.href);
      url.searchParams.delete('duo');
      window.history.replaceState({}, document.title, `${url.pathname}${url.search}${url.hash}`);
      window.setTimeout(() => void this.openJoinDuo(), 0);
    }
  }

  show(): void {
    this.closeDuoLobby();
    this.notice.textContent = '';
    this.duoModeSelected = false;
    this.renderDeployMode();
    this.updateSoloSkinForCallsign();
    document.querySelectorAll('.modal').forEach((modal) => modal.classList.add('hidden'));
    void this.refreshStatus();
    this.startMenuMusic();
  }

  private toggleDuoMode(): void {
    if (this.deploying || this.duoBusy) return;
    this.duoModeSelected = !this.duoModeSelected;
    this.renderDeployMode();
  }

  private renderDeployMode(): void {
    this.duoToggleButton.setAttribute('aria-pressed', String(this.duoModeSelected));
    this.duoToggleButton.setAttribute(
      'aria-label',
      this.duoModeSelected ? 'Exit duo mode' : 'Select duo mode',
    );
    this.duoQuickActions.classList.toggle('hidden', !this.duoModeSelected);
    this.playButton.classList.toggle('hidden', this.duoModeSelected);
  }

  private async deploy(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (this.deploying || this.duoModeSelected) return;
    const result = validatePlayerName(this.callsign.value);
    if (!result.ok) {
      this.notice.textContent = result.reason.toUpperCase();
      this.callsign.focus();
      return;
    }
    let callsign = result.name;
    this.deploying = true;
    this.notice.textContent = 'VERIFYING CALLSIGN...';
    try {
      callsign = await claimPlayerName(callsign);
      this.callsignAvailable = true;
    } catch (error) {
      if (error instanceof CallsignUnavailableError) {
        this.callsignAvailable = false;
        this.renderSoloSkin(callsign);
        this.notice.textContent = 'CALLSIGN ALREADY IN USE';
        this.callsign.focus();
        return;
      }
      // Preserve offline play. The score submission will establish the browser profile when connectivity returns.
    } finally {
      this.deploying = false;
    }
    this.callsign.value = callsign;
    const soloSkin = this.callsignAvailable
      ? this.resolveSkin(callsign, this.soloSkinId)
      : this.resolveSkin('', this.soloSkinId);
    this.soloSkinId = soloSkin.id;
    this.persistSkinPreference(soloSkin.id);
    this.renderSoloSkin(callsign);
    this.notice.textContent = '';
    localStorage.setItem(CALLSIGN_KEY, callsign);
    this.fadeOutMenuMusic();
    this.deploying = true;
    this.notice.textContent = 'PREPARING DEPLOYMENT...';
    try {
      await this.options.onDeploy({ mode: 'solo', callsign, skinId: soloSkin.id });
    } catch {
      this.notice.textContent = 'DEPLOYMENT FAILED — TRY AGAIN';
      this.startMenuMusic();
    } finally {
      this.deploying = false;
    }
  }

  private async openCreateDuo(): Promise<void> {
    if (this.duoBusy || this.deploying) return;
    const result = validatePlayerName(this.callsign.value);
    if (!result.ok) {
      this.notice.textContent = result.reason.toUpperCase();
      this.callsign.focus();
      return;
    }
    this.duoBusy = true;
    this.notice.textContent = 'VERIFYING CALLSIGN...';
    let callsign: string;
    try {
      callsign = await claimDuoCallsign(result.name);
    } catch (error) {
      this.showDuoCallsignError(error, result.name);
      this.duoBusy = false;
      return;
    }
    this.callsign.value = callsign;
    this.callsignAvailable = true;
    this.renderSoloSkin(callsign);
    this.notice.textContent = '';
    this.openModal('duo-modal');
    this.renderDuoLoading('ESTABLISHING PRIVATE LINK...');
    try {
      const skinId = this.selectSkinForCallsign(callsign);
      const session = await DuoSession.createHost(callsign, this.duoCallbacks(), skinId);
      this.duoSession = session;
      this.duoLobbyState = {
        roomCode: session.roomCode,
        hostCallsign: callsign,
        guestCallsign: '',
        hostSkinId: skinId,
        guestSkinId: DEFAULT_PLAYER_SKIN_ID,
        hostAim: DEFAULT_LOBBY_AIM,
        guestAim: DEFAULT_LOBBY_AIM,
        guestConnected: false,
        started: false,
      };
      this.renderHostLobby();
    } catch (error) {
      this.renderDuoError(messageFromError(error));
    } finally {
      this.duoBusy = false;
    }
  }

  private async openJoinDuo(prefillCode = this.pendingInviteCode ?? ''): Promise<void> {
    if (this.duoBusy || this.deploying) return;
    if (!this.hasSavedCallsign()) {
      this.renderJoinDuoForm(prefillCode, true);
      return;
    }
    const result = validatePlayerName(this.callsign.value);
    if (!result.ok) {
      this.notice.textContent = result.reason.toUpperCase();
      this.callsign.focus();
      return;
    }
    this.duoBusy = true;
    this.notice.textContent = 'VERIFYING CALLSIGN...';
    let callsign: string;
    try {
      callsign = await claimDuoCallsign(result.name);
    } catch (error) {
      this.showDuoCallsignError(error, result.name);
      this.duoBusy = false;
      return;
    }
    this.callsign.value = callsign;
    this.callsignAvailable = true;
    this.renderSoloSkin(callsign);
    this.notice.textContent = '';
    this.duoBusy = false;
    this.renderJoinDuoForm(prefillCode, false);
  }

  private hasSavedCallsign(): boolean {
    return Boolean(localStorage.getItem(CALLSIGN_KEY)?.trim());
  }

  private renderJoinDuoForm(prefillCode: string, includeCallsign: boolean): void {
    this.openModal('duo-modal');
    const wrapper = document.createElement('div');
    wrapper.className = 'duo-lobby';
    const copy = text('p', includeCallsign
      ? 'Enter your callsign and the private code from the host. Your browser will connect directly to theirs.'
      : 'Enter the private code from the host. Your browser will connect directly to theirs.');
    copy.className = 'duo-lobby-copy';

    const form = document.createElement('form');
    form.className = 'duo-form';
    let callsignInput: HTMLInputElement | undefined;
    if (includeCallsign) {
      const callsignLabel = document.createElement('label');
      callsignLabel.textContent = 'YOUR CALLSIGN';
      callsignInput = document.createElement('input');
      callsignInput.id = 'duo-join-callsign';
      callsignInput.maxLength = 18;
      callsignInput.autocomplete = 'off';
      callsignInput.spellcheck = false;
      callsignInput.value = this.callsign.value;
      callsignLabel.append(callsignInput);
      form.append(callsignLabel);
    }
    const codeLabel = document.createElement('label');
    codeLabel.textContent = 'INVITE CODE';
    const codeInput = document.createElement('input');
    codeInput.id = 'duo-room-code';
    codeInput.maxLength = 6;
    codeInput.autocomplete = 'off';
    codeInput.spellcheck = false;
    codeInput.placeholder = 'ENTER CODE';
    codeInput.inputMode = 'text';
    codeInput.value = prefillCode;
    codeInput.addEventListener('input', () => {
      codeInput.value = codeInput.value.replace(/[^a-z0-9]/gi, '').toUpperCase();
      this.pendingInviteCode = codeInput.value || undefined;
    });
    codeLabel.append(codeInput);

    const actions = document.createElement('div');
    actions.className = 'duo-form-actions';
    const cancel = document.createElement('button');
    cancel.className = 'menu-button';
    cancel.type = 'button';
    cancel.textContent = 'CANCEL';
    cancel.addEventListener('click', () => {
      this.closeDuoLobby();
      this.duoModal.classList.add('hidden');
    });
    const join = document.createElement('button');
    join.className = 'menu-button menu-button-primary';
    join.type = 'submit';
    join.textContent = 'JOIN DUOS';
    actions.append(cancel, join);
    form.append(codeLabel, actions);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      void this.joinDuo(codeInput.value, callsignInput?.value);
    });
    wrapper.append(copy, form);
    this.duoContent.replaceChildren(wrapper);
    (callsignInput ?? codeInput).focus();
  }

  private async joinDuo(rawCode: string, rawCallsign = this.callsign.value): Promise<void> {
    if (this.duoBusy) return;
    const nameResult = validatePlayerName(rawCallsign);
    if (!nameResult.ok) {
      this.renderDuoError(nameResult.reason.toUpperCase());
      return;
    }
    const roomCode = rawCode.trim().replace(/[^a-z0-9]/gi, '').toUpperCase();
    if (roomCode.length < 6) {
      this.renderDuoError('INVITE CODE IS TOO SHORT');
      return;
    }
    this.duoBusy = true;
    this.renderDuoLoading('CONNECTING TO HOST...');
    try {
      const callsign = await claimDuoCallsign(nameResult.name);
      this.callsign.value = callsign;
      const skinId = this.selectSkinForCallsign(callsign);
      const session = await DuoSession.join(roomCode, callsign, this.duoCallbacks(), skinId);
      this.duoSession = session;
      this.pendingInviteCode = undefined;
      this.duoLobbyState = {
        roomCode: session.roomCode,
        hostCallsign: '',
        guestCallsign: callsign,
        hostSkinId: DEFAULT_PLAYER_SKIN_ID,
        guestSkinId: skinId,
        hostAim: DEFAULT_LOBBY_AIM,
        guestAim: DEFAULT_LOBBY_AIM,
        guestConnected: true,
        started: false,
      };
      this.renderGuestLobby();
    } catch (error) {
      if (error instanceof CallsignUnavailableError) {
        this.closeDuoLobby();
        this.duoModal.classList.add('hidden');
        this.showDuoCallsignError(error, nameResult.name);
      } else {
        this.renderDuoError(messageFromError(error));
      }
    } finally {
      this.duoBusy = false;
    }
  }

  private duoCallbacks() {
    return {
      lobby: (state: DuoLobbyState) => {
        this.duoLobbyState = state;
        if (!this.duoSession?.isStarted) this.updateDuoLobby();
      },
      started: () => void this.launchDuo(),
      kicked: (reason: string) => {
        if (this.duoSession?.isStarted) {
          window.dispatchEvent(new CustomEvent('last-light:duo-disconnected', { detail: { reason } }));
          return;
        }
        this.duoSession = undefined;
        this.duoLobbyState = undefined;
        this.renderDuoKicked(reason);
      },
      ping: (milliseconds: number | null) => {
        window.dispatchEvent(new CustomEvent('last-light:ping', { detail: { milliseconds } }));
      },
      connection: (state: 'connected' | 'reconnecting' | 'failed') => {
        window.dispatchEvent(new CustomEvent('last-light:duo-connection', { detail: { state } }));
      },
      gameOver: (message: string, score?: number) => {
        window.dispatchEvent(new CustomEvent('last-light:duo-game-over', { detail: { message, score } }));
      },
      leaderboardResult: (result: { rank: number | null; newRecord: boolean; available: boolean }) => {
        window.dispatchEvent(new CustomEvent('last-light:duo-leaderboard-result', { detail: result }));
      },
      disconnected: (reason: string) => {
        if (this.duoSession?.isStarted) {
          window.dispatchEvent(new CustomEvent('last-light:duo-disconnected', { detail: { reason } }));
          return;
        }
        this.setDuoStatus(reason, true);
      },
    };
  }

  private renderHostLobby(): void {
    const session = this.duoSession;
    const state = this.duoLobbyState;
    if (!session || !state) return;
    const wrapper = document.createElement('div');
    wrapper.className = 'duo-lobby';
    const copy = text('p', 'Send this code to a friend. The game will remain private between your two browsers.');
    copy.className = 'duo-lobby-copy';
    wrapper.append(copy, this.makeCodeBlock(session.roomCode));

    const slots = document.createElement('div');
    slots.className = 'duo-slots';
    const hostSlot = this.makeDuoSlot('host', state.hostCallsign, false, state.hostSkinId);
    const guestSlot = this.makeDuoSlot('guest', state.guestCallsign, true, state.guestSkinId);
    const kick = document.createElement('button');
    kick.id = 'duo-kick-button';
    kick.className = 'duo-kick-button';
    kick.type = 'button';
    kick.textContent = '×';
    kick.addEventListener('click', () => void this.kickDuoGuest());
    guestSlot.querySelector('.duo-slot-entry')?.classList.remove('single');
    guestSlot.querySelector('.duo-slot-entry')?.append(kick);
    slots.append(hostSlot, guestSlot);
    wrapper.append(slots);

    const status = text('p', 'WAITING FOR SECOND SURVIVOR...');
    status.id = 'duo-status';
    status.className = 'duo-status';
    const actions = document.createElement('div');
    actions.className = 'duo-form-actions';
    const cancel = document.createElement('button');
    cancel.className = 'menu-button';
    cancel.type = 'button';
    cancel.textContent = 'CANCEL';
    cancel.addEventListener('click', () => {
      this.closeDuoLobby();
      this.duoModal.classList.add('hidden');
    });
    const start = document.createElement('button');
    start.id = 'duo-start-button';
    start.className = 'menu-button menu-button-primary';
    start.type = 'button';
    start.textContent = 'START DUOS';
    start.disabled = !state.guestConnected || !state.guestCallsign;
    start.addEventListener('click', () => {
      if (!this.duoSession?.startGame()) this.setDuoStatus('WAITING FOR A CONNECTED SURVIVOR', true);
    });
    actions.append(cancel, start);
    wrapper.append(status, actions, text('p', 'Keep this tab open: it owns the private operation.'));
    wrapper.lastElementChild!.className = 'duo-lobby-note';
    this.duoContent.replaceChildren(wrapper);
    this.bindDuoSlotInputs(hostSlot, guestSlot);
    this.updateDuoLobby();
  }

  private renderGuestLobby(): void {
    const session = this.duoSession;
    const state = this.duoLobbyState;
    if (!session || !state) return;
    const wrapper = document.createElement('div');
    wrapper.className = 'duo-lobby';
    const copy = text('p', 'Connected to the host. Your callsign is locked for this operation. Wait for the host to begin.');
    copy.className = 'duo-lobby-copy';
    wrapper.append(copy, this.makeCodeBlock(session.roomCode));

    const slots = document.createElement('div');
    slots.className = 'duo-slots';
    const hostSlot = this.makeDuoSlot('host', state.hostCallsign, true, state.hostSkinId);
    const guestSlot = this.makeDuoSlot('guest', state.guestCallsign, false, state.guestSkinId);
    slots.append(hostSlot, guestSlot);
    wrapper.append(slots);
    const status = text('p', 'WAITING FOR HOST TO START...');
    status.id = 'duo-status';
    status.className = 'duo-status';
    const cancel = document.createElement('button');
    cancel.className = 'menu-button';
    cancel.type = 'button';
    cancel.textContent = 'CANCEL';
    cancel.addEventListener('click', () => {
      this.closeDuoLobby();
      this.duoModal.classList.add('hidden');
    });
    wrapper.append(status, cancel, text('p', 'The host tab owns the private operation.'));
    wrapper.lastElementChild!.className = 'duo-lobby-note';
    this.duoContent.replaceChildren(wrapper);
    this.bindDuoSlotInputs(hostSlot, guestSlot);
    this.updateDuoLobby();
  }

  private makeCodeBlock(roomCode: string): HTMLElement {
    const block = document.createElement('div');
    block.className = 'duo-code';
    const label = document.createElement('div');
    label.append(text('span', 'INVITE CODE'), text('strong', roomCode));
    const actions = document.createElement('div');
    actions.className = 'duo-code-actions';
    const copyCode = document.createElement('button');
    copyCode.className = 'duo-copy-button';
    copyCode.type = 'button';
    copyCode.textContent = 'COPY CODE';
    copyCode.addEventListener('click', () => {
      void this.copyLobbyValue(roomCode, copyCode, 'COPY CODE');
    });
    const link = new URL(window.location.href);
    link.searchParams.set('duo', roomCode);
    const copyLink = document.createElement('button');
    copyLink.className = 'duo-copy-button';
    copyLink.type = 'button';
    copyLink.textContent = 'COPY LINK';
    copyLink.addEventListener('click', () => {
      void this.copyLobbyValue(link.toString(), copyLink, 'COPY LINK');
    });
    actions.append(copyCode, copyLink);
    block.append(label, actions);
    return block;
  }

  private makeDuoSlot(
    playerId: DuoPlayerId,
    callsign: string,
    skinReadonly: boolean,
    skinId: string,
  ): HTMLElement {
    const skin = getPlayerSkin(skinId, callsign);
    const slot = document.createElement('label');
    slot.className = `duo-slot ${playerId}`;
    slot.dataset.playerId = playerId;
    slot.style.setProperty('--skin-color', skin.hex);
    const label = text('span', `${playerId === 'host' ? 'HOST' : 'GUEST'} // ${skin.name.toUpperCase()}`);
    label.className = 'duo-slot-label';
    slot.append(label);
    const input = document.createElement('input');
    input.id = playerId === 'host' ? 'duo-host-callsign' : 'duo-guest-callsign';
    input.maxLength = 18;
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.value = callsign;
    input.placeholder = 'WAITING...';
    input.readOnly = true;
    input.setAttribute('aria-readonly', 'true');
    const entry = document.createElement('div');
    entry.className = 'duo-slot-entry single';
    entry.append(input);
    slot.append(entry, this.makeSkinSelector(playerId, skin, skinReadonly));
    return slot;
  }

  private makeSkinSelector(playerId: DuoPlayerId, skin: ReturnType<typeof getPlayerSkin>, readonly: boolean): HTMLElement {
    const selector = document.createElement('div');
    selector.className = 'duo-skin-selector';
    selector.dataset.skinSelector = playerId;
    const previous = document.createElement('button');
    previous.className = 'duo-skin-arrow';
    previous.type = 'button';
    previous.dataset.skinDirection = '-1';
    previous.textContent = '‹';
    previous.setAttribute('aria-label', `Previous ${playerId} skin`);
    const current = document.createElement('div');
    current.className = 'duo-skin-current';
    const preview = document.createElement('img');
    preview.className = 'duo-skin-preview';
    preview.decoding = 'async';
    preview.loading = 'eager';
    current.append(preview);
    const next = document.createElement('button');
    next.className = 'duo-skin-arrow';
    next.type = 'button';
    next.dataset.skinDirection = '1';
    next.textContent = '›';
    next.setAttribute('aria-label', `Next ${playerId} skin`);
    selector.append(previous, current, next);
    if (readonly) selector.classList.add('readonly');
    this.updateSkinPreview(current, preview, skin);
    this.setLobbyAimPreview(playerId, preview, DEFAULT_LOBBY_AIM, true);
    return selector;
  }

  private bindDuoSlotInputs(hostSlot: HTMLElement, guestSlot: HTMLElement): void {
    [hostSlot, guestSlot].forEach((slot) => {
      slot.querySelectorAll<HTMLButtonElement>('[data-skin-direction]').forEach((button) => {
        button.addEventListener('click', () => {
          const playerId = slot.dataset.playerId as DuoPlayerId | undefined;
          const direction = Number(button.dataset.skinDirection);
          if (playerId && Number.isFinite(direction)) this.cycleDuoSkin(playerId, direction);
        });
      });
    });
  }

  private resolveSkin(callsign: string, preferredId?: string | null): ReturnType<typeof getPlayerSkin> {
    const available = getAvailablePlayerSkins(callsign);
    return available.find((skin) => skin.id === preferredId) ?? getDefaultPlayerSkin(callsign);
  }

  private persistSkinPreference(skinId: string): void {
    localStorage.setItem(SKIN_KEY, skinId);
  }

  private selectSkinForCallsign(callsign: string): string {
    this.callsignAvailable = true;
    const skin = this.resolveSkin(callsign, this.soloSkinId);
    this.soloSkinId = skin.id;
    this.persistSkinPreference(skin.id);
    return skin.id;
  }

  private updateSoloSkinForCallsign(): void {
    const callsign = this.callsign.value;
    const normalizedCallsign = callsign.trim().toLocaleLowerCase();
    const callsignChanged = normalizedCallsign !== this.lastSoloCallsign;
    const defaultSkin = getDefaultPlayerSkin(callsign);
    if (!this.deploying) this.notice.textContent = '';
    if (callsignChanged && defaultSkin.secret) this.soloSkinId = defaultSkin.id;
    this.lastSoloCallsign = normalizedCallsign;
    this.callsignAvailable = false;
    this.renderSoloSkin(callsign);
    this.scheduleCallsignAvailabilityCheck();
  }

  private scheduleCallsignAvailabilityCheck(): void {
    if (this.callsignCheckTimer !== undefined) window.clearTimeout(this.callsignCheckTimer);
    const generation = ++this.callsignCheckGeneration;
    const result = validatePlayerName(this.callsign.value);
    if (!result.ok) return;
    const callsign = result.name;
    this.callsignCheckTimer = window.setTimeout(() => {
      this.callsignCheckTimer = undefined;
      void this.checkCallsignAvailability(callsign, generation);
    }, 180);
  }

  private async checkCallsignAvailability(callsign: string, generation: number): Promise<void> {
    try {
      const availableCallsign = await checkPlayerName(callsign);
      if (!this.isCurrentCallsignCheck(callsign, generation)) return;
      this.callsignAvailable = true;
      this.renderSoloSkin(availableCallsign);
    } catch (error) {
      if (!this.isCurrentCallsignCheck(callsign, generation)) return;
      this.callsignAvailable = false;
      this.renderSoloSkin(callsign);
      if (!this.deploying && error instanceof CallsignUnavailableError) {
        this.notice.textContent = 'CALLSIGN ALREADY IN USE';
      }
    }
  }

  private isCurrentCallsignCheck(callsign: string, generation: number): boolean {
    if (generation !== this.callsignCheckGeneration) return false;
    const result = validatePlayerName(this.callsign.value);
    return result.ok && result.name.toLocaleLowerCase() === callsign.toLocaleLowerCase();
  }

  private renderSoloSkin(callsign = this.callsign.value): void {
    const available = this.callsignAvailable
      ? getAvailablePlayerSkins(callsign)
      : getAvailablePlayerSkins('');
    const skin = available.find((candidate) => candidate.id === this.soloSkinId)
      ?? getDefaultPlayerSkin(this.callsignAvailable ? callsign : '');
    if (this.callsignAvailable) {
      this.soloSkinId = skin.id;
      this.persistSkinPreference(skin.id);
    }
    this.skinButton.disabled = !this.callsignAvailable;
    this.skinButton.setAttribute('aria-disabled', String(!this.callsignAvailable));
    this.skinButton.title = this.callsignAvailable
      ? 'CHOOSE SURVIVOR SKIN'
      : 'ENTER AN AVAILABLE CALLSIGN TO CHOOSE A SURVIVOR';
    this.soloSkinPicker.style.setProperty('--skin-color', skin.hex);
    this.soloSkinName.textContent = skin.name.toUpperCase();
    const current = this.soloSkinSelector.querySelector<HTMLElement>('.duo-skin-current');
    if (current) {
      this.updateSkinPreview(current, this.soloSkinPreview, skin);
      this.soloSkinPreview.style.transform = '';
    }
    this.soloSkinSelector.querySelectorAll<HTMLButtonElement>('[data-solo-skin-direction]').forEach((button) => {
      button.disabled = !this.callsignAvailable || available.length <= 1;
    });
  }

  private cycleSoloSkin(direction: number): void {
    if (!this.callsignAvailable) return;
    const available = getAvailablePlayerSkins(this.callsign.value);
    if (available.length < 2) return;
    const currentIndex = Math.max(0, available.findIndex((skin) => skin.id === this.soloSkinId));
    const nextIndex = (currentIndex + (direction < 0 ? -1 : 1) + available.length) % available.length;
    this.soloSkinId = available[nextIndex].id;
    this.persistSkinPreference(this.soloSkinId);
    this.renderSoloSkin();
  }

  private updateDuoLobby(): void {
    const state = this.duoLobbyState;
    if (!state) return;
    const hostInput = document.getElementById('duo-host-callsign') as HTMLInputElement | null;
    const guestInput = document.getElementById('duo-guest-callsign') as HTMLInputElement | null;
    if (hostInput && document.activeElement !== hostInput) hostInput.value = state.hostCallsign;
    if (guestInput && document.activeElement !== guestInput) guestInput.value = state.guestCallsign;
    const connected = state.guestConnected && !!state.guestCallsign;
    const status = document.getElementById('duo-status');
    if (status) {
      status.className = 'duo-status';
      status.textContent = connected ? 'LINK ACTIVE // READY TO DEPLOY' : 'WAITING FOR SECOND SURVIVOR...';
    }
    const start = document.getElementById('duo-start-button') as HTMLButtonElement | null;
    if (start) start.disabled = !connected;
    const kick = document.getElementById('duo-kick-button') as HTMLButtonElement | null;
    if (kick) kick.disabled = !connected || this.duoBusy;
    this.updateSkinSelector('host', state.hostCallsign, state.hostSkinId);
    this.updateSkinSelector('guest', state.guestCallsign, state.guestSkinId);
  }

  private updateSkinSelector(playerId: DuoPlayerId, callsign: string, skinId: string): void {
    const state = this.duoLobbyState;
    const slot = this.duoContent.querySelector<HTMLElement>(`[data-player-id="${playerId}"]`);
    const selector = slot?.querySelector<HTMLElement>('[data-skin-selector]');
    if (!state || !slot || !selector) return;
    const skin = getPlayerSkin(skinId, callsign);
    slot.style.setProperty('--skin-color', skin.hex);
    const label = slot.querySelector<HTMLElement>('.duo-slot-label');
    if (label) label.textContent = `${playerId === 'host' ? 'HOST' : 'GUEST'} // ${skin.name.toUpperCase()}`;
    const preview = selector.querySelector<HTMLImageElement>('.duo-skin-preview');
    const current = selector.querySelector<HTMLElement>('.duo-skin-current');
    const aim = playerId === 'host' ? state.hostAim : state.guestAim;
    if (preview && current) {
      this.updateSkinPreview(current, preview, skin);
      this.setLobbyAimPreview(
        playerId,
        preview,
        Number.isFinite(aim) ? aim : DEFAULT_LOBBY_AIM,
        this.duoSession?.localPlayerId === playerId,
      );
    }
    const canEdit = this.duoSession?.localPlayerId === playerId && !this.duoSession.isStarted;
    selector.classList.toggle('readonly', !canEdit);
    selector.querySelectorAll<HTMLButtonElement>('[data-skin-direction]').forEach((button) => {
      button.disabled = !canEdit || getAvailablePlayerSkins(callsign).length <= 1;
    });
  }

  private updateSkinPreview(
    current: HTMLElement,
    preview: HTMLImageElement,
    skin: ReturnType<typeof getPlayerSkin>,
  ): void {
    const url = getPlayerSkinPreviewUrl(skin);
    if (preview.getAttribute('src') !== url) {
      current.classList.add('is-loading');
      preview.onload = () => current.classList.remove('is-loading');
      preview.onerror = () => current.classList.remove('is-loading');
      preview.src = url;
    }
    preview.alt = `${skin.name} skin preview`;
    if (preview.complete) current.classList.remove('is-loading');
  }

  private setLobbyAimPreview(
    playerId: DuoPlayerId,
    preview: HTMLImageElement,
    aim: number,
    immediate: boolean,
  ): void {
    const current = this.lobbyAimVisual.get(playerId);
    const target = nearestEquivalentAngle(aim, current ?? aim);
    this.lobbyAimTargets.set(playerId, target);
    if (immediate || current === undefined) {
      this.lobbyAimVisual.set(playerId, target);
      this.renderLobbyAim(preview, target);
      return;
    }
    this.scheduleLobbyAimAnimation();
  }

  private renderLobbyAim(preview: HTMLImageElement, aim: number): void {
    preview.style.transform = `rotate(${aim - Math.PI / 2}rad)`;
  }

  private scheduleLobbyAimAnimation(): void {
    if (this.lobbyAimAnimationFrame !== undefined) return;
    this.lobbyAimAnimationFrame = requestAnimationFrame(() => {
      this.lobbyAimAnimationFrame = undefined;
      let moving = false;
      this.lobbyAimTargets.forEach((target, playerId) => {
        const current = this.lobbyAimVisual.get(playerId) ?? target;
        const preview = this.duoContent
          .querySelector<HTMLImageElement>(`[data-player-id="${playerId}"] .duo-skin-preview`);
        if (!preview) {
          this.lobbyAimVisual.set(playerId, target);
          return;
        }
        const difference = target - current;
        if (Math.abs(difference) < 0.001) {
          this.lobbyAimVisual.set(playerId, target);
          this.renderLobbyAim(preview, target);
          return;
        }
        const next = current + difference * 0.28;
        this.lobbyAimVisual.set(playerId, next);
        this.renderLobbyAim(preview, next);
        moving = true;
      });
      if (moving) this.scheduleLobbyAimAnimation();
    });
  }

  private updateSoloAimFromPointer(event: PointerEvent): void {
    if (this.skinModal.classList.contains('hidden')) return;
    const bounds = this.soloSkinPreview.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    const aim = Math.atan2(
      event.clientY - (bounds.top + bounds.height / 2),
      event.clientX - (bounds.left + bounds.width / 2),
    );
    this.renderLobbyAim(this.soloSkinPreview, aim);
  }

  private updateDuoAimFromPointer(event: PointerEvent): void {
    const session = this.duoSession;
    if (!session || session.isStarted || this.duoModal.classList.contains('hidden')) return;
    const playerId = session.localPlayerId;
    const preview = this.duoContent
      .querySelector<HTMLImageElement>(`[data-player-id="${playerId}"] .duo-skin-preview`);
    if (!preview) return;
    const bounds = preview.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    const aim = Math.atan2(
      event.clientY - (bounds.top + bounds.height / 2),
      event.clientX - (bounds.left + bounds.width / 2),
    );
    this.setLobbyAimPreview(session.localPlayerId, preview, aim, true);
    this.pendingLobbyAim = aim;
    this.scheduleLobbyAimSend();
  }

  private scheduleLobbyAimSend(): void {
    if (this.lobbyAimFrame !== undefined) return;
    const elapsed = performance.now() - this.lastLobbyAimSentAt;
    if (elapsed >= 33) {
      this.flushLobbyAim();
      return;
    }
    this.lobbyAimFrame = requestAnimationFrame(() => {
      this.lobbyAimFrame = undefined;
      this.scheduleLobbyAimSend();
    });
  }

  private flushLobbyAim(): void {
    const aim = this.pendingLobbyAim;
    const session = this.duoSession;
    if (aim === undefined || !session || session.isStarted) return;
    this.pendingLobbyAim = undefined;
    this.lastLobbyAimSentAt = performance.now();
    session.updateLobbyAim(aim);
  }

  private cycleDuoSkin(playerId: DuoPlayerId, direction: number): void {
    const session = this.duoSession;
    const state = this.duoLobbyState;
    if (!session || !state || session.localPlayerId !== playerId || session.isStarted) return;
    const callsign = playerId === 'host' ? state.hostCallsign : state.guestCallsign;
    const available = getAvailablePlayerSkins(callsign);
    if (available.length < 2) return;
    const currentId = playerId === 'host' ? state.hostSkinId : state.guestSkinId;
    const currentIndex = Math.max(0, available.findIndex((skin) => skin.id === currentId));
    const nextIndex = (currentIndex + (direction < 0 ? -1 : 1) + available.length) % available.length;
    const nextSkinId = available[nextIndex].id;
    session.updateSkin(nextSkinId);
    this.soloSkinId = nextSkinId;
    this.persistSkinPreference(nextSkinId);
  }

  private async copyLobbyValue(value: string, button: HTMLButtonElement, label: string): Promise<void> {
    if (!navigator.clipboard) {
      this.setDuoStatus('COPY UNAVAILABLE — SEND IT MANUALLY', true);
      return;
    }
    try {
      await navigator.clipboard.writeText(value);
      button.textContent = 'COPIED';
      window.setTimeout(() => { button.textContent = label; }, 1500);
    } catch {
      this.setDuoStatus('COPY FAILED — SEND IT MANUALLY', true);
    }
  }

  private async kickDuoGuest(): Promise<void> {
    const session = this.duoSession;
    if (!session || session.role !== 'host' || !this.duoLobbyState?.guestConnected || this.duoBusy) return;
    this.duoBusy = true;
    this.setDuoStatus('REMOVING SECOND SURVIVOR...');
    try {
      await session.kickGuest();
    } catch (error) {
      this.setDuoStatus(`KICK FAILED — ${messageFromError(error).toUpperCase()}`, true);
    } finally {
      this.duoBusy = false;
      this.updateDuoLobby();
    }
  }

  private renderDuoLoading(message: string): void {
    const wrapper = document.createElement('div');
    wrapper.className = 'duo-lobby';
    wrapper.append(text('p', message), text('p', 'Private connection setup can take a moment.'));
    wrapper.firstElementChild!.className = 'duo-status';
    wrapper.lastElementChild!.className = 'duo-lobby-note';
    this.duoContent.replaceChildren(wrapper);
  }

  private showDuoCallsignError(error: unknown, callsign: string): void {
    this.callsign.value = callsign;
    this.callsignAvailable = false;
    this.renderSoloSkin(callsign);
    this.notice.textContent = error instanceof CallsignUnavailableError
      ? 'CALLSIGN ALREADY IN USE'
      : 'DUO CALLSIGN CHECK FAILED — TRY AGAIN';
    this.callsign.focus();
  }

  private renderDuoError(message: string): void {
    this.duoBusy = false;
    this.closeDuoLobby();
    this.duoContent.replaceChildren(text('p', message));
    this.duoContent.firstElementChild!.className = 'duo-status error';
    this.duoModal.classList.remove('hidden');
  }

  private renderDuoKicked(message: string): void {
    this.duoBusy = false;
    const wrapper = document.createElement('div');
    wrapper.className = 'duo-lobby';
    const status = text('p', message.toUpperCase());
    status.className = 'duo-status error';
    const copy = text('p', 'This private link is no longer active for your browser.');
    copy.className = 'duo-lobby-copy';
    const join = document.createElement('button');
    join.className = 'menu-button menu-button-primary';
    join.type = 'button';
    join.textContent = 'JOIN ANOTHER DUOS GAME';
    join.addEventListener('click', () => this.openJoinDuo());
    wrapper.append(status, copy, join);
    this.duoContent.replaceChildren(wrapper);
    this.duoModal.classList.remove('hidden');
  }

  private setDuoStatus(message: string, error = false): void {
    const status = document.getElementById('duo-status');
    if (!status) return;
    status.textContent = message;
    status.className = `duo-status${error ? ' error' : ''}`;
  }

  private async launchDuo(): Promise<void> {
    const session = this.duoSession;
    const state = this.duoLobbyState;
    if (!session || !state || !state.hostCallsign || !state.guestCallsign) return;
    let callsign = session.role === 'host' ? state.hostCallsign : state.guestCallsign;
    const partnerCallsign = session.role === 'host' ? state.guestCallsign : state.hostCallsign;
    const skinId = session.role === 'host' ? state.hostSkinId : state.guestSkinId;
    const partnerSkinId = session.role === 'host' ? state.guestSkinId : state.hostSkinId;
    this.renderDuoLoading('VERIFYING CALLSIGN...');
    this.fadeOutMenuMusic();
    this.deploying = true;
    this.notice.textContent = 'PREPARING DUO DEPLOYMENT...';
    try {
      // The callsign was claimed before the lobby opened. Re-check the final
      // local value here as defense in depth before deploying the operation.
      callsign = await claimDuoCallsign(callsign);
      this.callsignAvailable = true;
      this.callsign.value = callsign;
      this.soloSkinId = skinId;
      this.persistSkinPreference(skinId);
      localStorage.setItem(CALLSIGN_KEY, callsign);
      this.renderDuoLoading('DEPLOYING PRIVATE OPERATION...');
      await this.options.onDeploy({
        mode: 'duos',
        role: session.role,
        playerId: session.localPlayerId,
        callsign,
        partnerCallsign,
        skinId,
        partnerSkinId,
        session,
      });
    } catch (error) {
      session.close();
      this.duoSession = undefined;
      this.notice.textContent = `DEPLOYMENT FAILED — ${messageFromError(error).toUpperCase()}`;
      this.renderDuoError(messageFromError(error));
      this.startMenuMusic();
    } finally {
      this.deploying = false;
    }
  }

  private closeDuoLobby(): void {
    if (this.lobbyAimFrame !== undefined) cancelAnimationFrame(this.lobbyAimFrame);
    if (this.lobbyAimAnimationFrame !== undefined) cancelAnimationFrame(this.lobbyAimAnimationFrame);
    this.lobbyAimFrame = undefined;
    this.lobbyAimAnimationFrame = undefined;
    this.pendingLobbyAim = undefined;
    this.lobbyAimVisual.clear();
    this.lobbyAimTargets.clear();
    if (this.duoSession && !this.duoSession.isStarted) this.duoSession.close();
    if (!this.duoSession?.isStarted) this.duoSession = undefined;
    this.duoLobbyState = undefined;
    this.duoBusy = false;
  }

  private startMenuMusic(): void {
    this.stopMenuMusic();
    const audio = new Audio();
    audio.preload = 'none';
    audio.loop = true;
    audio.volume = HOME_MUSIC_VOLUME;
    this.menuMusic = audio;
    this.menuUnlockHandler = (event: Event) => {
      if (this.menuMusic !== audio) return;
      const target = event.target;
      if (target instanceof Element && target.closest('#deploy-form')) return;
      this.removeMenuUnlockHandler();
      audio.src = HOME_MUSIC_TRACKS[0];
      void audio.play().catch(() => undefined);
    };
    document.addEventListener('pointerdown', this.menuUnlockHandler);
    document.addEventListener('keydown', this.menuUnlockHandler);
  }

  private fadeOutMenuMusic(): void {
    this.stopMenuMusic();
  }

  private stopMenuMusic(): void {
    this.removeMenuUnlockHandler();
    this.menuMusic?.pause();
    this.menuMusic?.removeAttribute('src');
    this.menuMusic?.load();
    this.menuMusic = undefined;
  }

  private removeMenuUnlockHandler(): void {
    if (!this.menuUnlockHandler) return;
    document.removeEventListener('pointerdown', this.menuUnlockHandler);
    document.removeEventListener('keydown', this.menuUnlockHandler);
    this.menuUnlockHandler = undefined;
  }

  private async refreshStatus(): Promise<void> {
    try {
      const status = await getStatus();
      element('play-count').textContent = status.playCount.toLocaleString();
      element('last-update').textContent = formatUpdate(status.lastUpdate);
    } catch {
      element('play-count').textContent = 'OFFLINE';
      element('last-update').textContent = 'LOCAL BUILD';
    }
  }

  private async openLeaderboard(): Promise<void> {
    this.openModal('leaderboard-modal');
    this.updateLeaderboardModeButtons();
    await this.loadLeaderboard();
  }

  private async loadLeaderboard(): Promise<void> {
    const rows = element('leaderboard-rows');
    rows.textContent = 'RETRIEVING FIELD RECORDS...';
    try {
      await flushPendingScores();
      const entries = await getLeaderboard(this.leaderboardMode);
      rows.replaceChildren(...(entries.length ? entries.map(leaderboardRow) : [messageRow('NO SURVIVORS RECORDED YET')]));
    } catch {
      rows.replaceChildren(messageRow('FIELD ARCHIVE UNAVAILABLE'));
    }
  }

  private updateLeaderboardModeButtons(): void {
    document.querySelectorAll<HTMLButtonElement>('[data-leaderboard-mode]').forEach((button) => {
      button.setAttribute('aria-pressed', String(button.dataset.leaderboardMode === this.leaderboardMode));
    });
  }

  private async openChangelog(): Promise<void> {
    this.openModal('changelog-modal');
    const rows = element('changelog-rows');
    rows.textContent = 'RETRIEVING TRANSMISSIONS...';
    try {
      const changelog = await getChangelog();
      rows.replaceChildren(...(changelog.entries.length
        ? changelog.entries.map(changelogRow)
        : [messageRow('NO TRANSMISSIONS RECORDED')]));
    } catch {
      rows.replaceChildren(messageRow('TRANSMISSION LOST'));
    }
  }

  private openModal(id: string): void {
    document.querySelectorAll('.modal').forEach((modal) => modal.classList.add('hidden'));
    element(id).classList.remove('hidden');
  }
}

function leaderboardRow(entry: LeaderboardEntry, index: number): HTMLElement {
  const row = document.createElement('div');
  const eliminations = text('strong', String(entry.score).padStart(5, '0'));
  eliminations.className = 'leaderboard-score';
  row.className = `leaderboard-row${index === 0 ? ' first' : ''}`;
  row.append(
    text('span', String(index + 1).padStart(2, '0')),
    text('strong', entry.name),
    eliminations,
    text('span', entry.threat === null ? '--' : String(entry.threat).padStart(2, '0')),
    text('span', formatDuration(entry.survivalMs)),
    text('span', formatLeaderboardDate(entry.achievedAt)),
  );
  return row;
}

function changelogRow(entry: ChangelogEntry): HTMLElement {
  const link = document.createElement('a');
  link.className = 'changelog-row';
  link.href = entry.url;
  link.target = '_blank';
  link.rel = 'noreferrer';
  link.append(
    text('code', entry.sha.slice(0, 7)),
    text('strong', entry.message),
    text('time', entry.date ? new Date(entry.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '--'),
  );
  return link;
}

function messageRow(message: string): HTMLElement {
  const row = text('p', message);
  row.className = 'empty-row';
  return row;
}

function text<K extends keyof HTMLElementTagNameMap>(tag: K, value: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.textContent = value;
  return node;
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function formatLeaderboardDate(timestamp: number): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '--';
  const day = String(date.getDate()).padStart(2, '0');
  const month = date.toLocaleString(undefined, { month: 'short' }).toUpperCase();
  return `${day} ${month} ${String(date.getFullYear()).slice(-2)}`;
}

function formatUpdate(value: string | null): string {
  if (!value) return '--';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '--';
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

async function claimDuoCallsign(name: string): Promise<string> {
  return claimPlayerName(name);
}

function readInviteCode(): string | undefined {
  const value = new URL(window.location.href).searchParams.get('duo');
  if (!value) return undefined;
  const code = value.replace(/[^a-z0-9]/gi, '').toUpperCase().slice(0, 6);
  return code.length >= 6 ? code : undefined;
}

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function nearestEquivalentAngle(angle: number, reference: number): number {
  const fullTurn = Math.PI * 2;
  let result = angle;
  while (result - reference > Math.PI) result -= fullTurn;
  while (result - reference < -Math.PI) result += fullTurn;
  return result;
}

function element<T extends HTMLElement = HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing #${id}`);
  return value as T;
}
