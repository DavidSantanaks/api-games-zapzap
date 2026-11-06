import { nonempty, number, retryDelay } from './http.js';

const STEAM_HOST = 'https://api.steampowered.com';
const LEETIFY_HOST = 'https://api-public.cs-prod.leetify.com';
const STEAM_ID_MIN = 76561197960265728n;
const STEAM_ID_MAX = 76561202255233023n;
const SHARECODE_DICTIONARY = 'ABCDEFGHJKLMNOPQRSTUVWXYZabcdefhijkmnopqrstuvwxyz23456789';
const SHARECODE_PATTERN = new RegExp(`^CSGO(?:-[${SHARECODE_DICTIONARY}]{5}){5}$`);
const MODE_BY_SOURCE = new Map([
  ['matchmaking', 'Premier'],
  ['matchmaking_competitive', 'Competitivo'],
]);

export class Cs2Error extends Error {
  constructor(message, { status = 0, retryAfterMs = 0 } = {}) {
    super(message);
    this.name = 'Cs2Error';
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/** Aceita o SteamID64 puro ou a URL /profiles/<id> da comunidade Steam. */
export function normalizeSteamId(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  const match = /^(?:https?:\/\/steamcommunity\.com\/profiles\/)?(\d{17})\/?$/i.exec(raw);
  if (!match) throw new Cs2Error('Informe um SteamID64 válido de 17 dígitos (ex.: 76561198000000000).', { status: 400 });
  const parsed = BigInt(match[1]);
  if (parsed < STEAM_ID_MIN || parsed > STEAM_ID_MAX) {
    throw new Cs2Error('SteamID64 fora da faixa de contas individuais da Steam.', { status: 400 });
  }
  return match[1];
}

export function normalizeAuthCode(value) {
  const code = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (!/^[A-Z0-9]{4}-[A-Z0-9]{5}-[A-Z0-9]{4}$/.test(code)) {
    throw new Cs2Error('Informe o código de autenticação da partida no formato AAAA-AAAAA-AAAA.', { status: 400 });
  }
  return code;
}

/** Decodifica o código base57 da Valve em matchId, reservationId (outcomeId) e tvPort (token). */
export function decodeShareCode(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/^csgo-/i, 'CSGO-');
  if (!SHARECODE_PATTERN.test(normalized)) return null;
  const digits = normalized.slice(5).replaceAll('-', '');
  let acc = 0n;
  for (let index = digits.length - 1; index >= 0; index--) {
    acc = acc * 57n + BigInt(SHARECODE_DICTIONARY.indexOf(digits[index]));
  }
  const bytes = Buffer.alloc(18);
  for (let index = 17; index >= 0; index--) {
    bytes[index] = Number(acc & 0xffn);
    acc >>= 8n;
  }
  return {
    code: normalized,
    matchId: bytes.readBigUInt64LE(0),
    reservationId: bytes.readBigUInt64LE(8),
    tvPort: bytes.readUInt16LE(16),
  };
}

export function normalizeShareCode(value) {
  const decoded = decodeShareCode(value);
  if (!decoded) {
    throw new Cs2Error('Informe um código de partida válido no formato CSGO-xxxxx-xxxxx-xxxxx-xxxxx-xxxxx.', { status: 400 });
  }
  return decoded.code;
}

function resolveScores(data, participant) {
  const won = Number(participant.rounds_won);
  const lost = Number(participant.rounds_lost);
  if (Number.isFinite(won) && Number.isFinite(lost) && (won > 0 || lost > 0)) {
    return { own: number(won), enemy: number(lost) };
  }
  if (Array.isArray(data.team_scores) && data.team_scores.length >= 2 && participant.initial_team_number !== undefined) {
    const ownTeam = data.team_scores.find(team => team.team_number === participant.initial_team_number);
    const enemyTeam = data.team_scores.find(team => team.team_number !== participant.initial_team_number);
    if (ownTeam && enemyTeam && Number.isFinite(Number(ownTeam.score)) && Number.isFinite(Number(enemyTeam.score))) {
      return { own: number(ownTeam.score), enemy: number(enemyTeam.score) };
    }
  }
  return null;
}

export function normalizeCs2Match(data, player, fallbackShareCode = null) {
  if (!data || typeof data !== 'object') throw new Cs2Error('Resposta inválida ao consultar os dados da partida de CS2.');
  const mode = MODE_BY_SOURCE.get(data.data_source);
  // Ignora FACEIT, Wingman, HLTV e partidas fora do Premier/Competitivo oficial da Valve.
  if (!mode) return null;
  if (!Array.isArray(data.stats)) throw new Cs2Error('A partida de CS2 retornou estatísticas incompletas.');
  const participant = data.stats.find(entry => String(entry?.steam64_id) === player.steamId);
  if (!participant) throw new Cs2Error('O jogador não foi encontrado nas estatísticas dessa partida de CS2.');
  const endedMs = Date.parse(data.finished_at);
  if (!Number.isFinite(endedMs) || endedMs <= 0) {
    throw new Cs2Error('A partida de CS2 ainda não possui horário de encerramento válido.');
  }
  const scores = resolveScores(data, participant);
  if (!scores) {
    throw new Cs2Error('A partida de CS2 ainda não possui placar consolidado. Será consultada novamente depois.');
  }
  const result = scores.own > scores.enemy ? 'win' : scores.own < scores.enemy ? 'loss' : 'draw';
  const kills = number(participant.total_kills);
  const deaths = number(participant.total_deaths);
  const assists = number(participant.total_assists);
  const hasDamage = typeof participant.total_damage === 'number' && Number.isFinite(participant.total_damage);
  const damage = hasDamage ? number(participant.total_damage) : null;
  const hasRounds = typeof participant.rounds_count === 'number' && Number.isFinite(participant.rounds_count) && participant.rounds_count > 0;
  const rounds = hasRounds ? number(participant.rounds_count) : scores.own + scores.enemy;
  const rawDpr = Number(participant.dpr);
  const adr = typeof participant.dpr === 'number' && Number.isFinite(rawDpr)
    ? Math.round(rawDpr * 10) / 10
    : (damage !== null && rounds > 0 ? Math.round((damage / rounds) * 10) / 10 : null);
  const mvps = typeof participant.mvps === 'number' && Number.isFinite(participant.mvps) ? number(participant.mvps) : null;
  const hasHs = typeof participant.total_hs_kills === 'number' && Number.isFinite(participant.total_hs_kills);
  const headshotPercent = hasHs ? (kills > 0 ? Math.round((number(participant.total_hs_kills) / kills) * 100) : 0) : null;
  const id = nonempty(data.data_source_match_id) ? data.data_source_match_id.trim()
    : (fallbackShareCode || (nonempty(data.id) ? `leetify:${data.id.trim()}` : null));
  if (!id) throw new Cs2Error('A partida de CS2 não retornou um identificador válido.');
  return {
    id,
    game: 'cs2',
    leetifyMatchId: nonempty(data.id) ? data.id.trim() : null,
    playerName: nonempty(participant.name) ? participant.name.trim() : (player.gameName || player.steamId),
    map: nonempty(data.map_name) ? data.map_name.trim() : 'Desconhecido',
    mode,
    score: `${scores.own} x ${scores.enemy}`,
    result,
    win: result === 'win' ? true : result === 'loss' ? false : null,
    kills,
    deaths,
    assists,
    adr,
    damage,
    rounds,
    mvps,
    headshotPercent,
    endedAt: new Date(endedMs).toISOString(),
  };
}

export class Cs2Client {
  constructor({ steamApiKey = '', leetifyApiKey = '', fetchImpl = fetch, timeoutMs = 15_000, pendingGraceMs = 45 * 60_000 } = {}) {
    this.steamApiKey = steamApiKey.trim();
    this.leetifyApiKey = leetifyApiKey.trim();
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.pendingGraceMs = pendingGraceMs;
    this.steamBlockedUntil = 0;
    this.leetifyBlockedUntil = 0;
    // Evita insistir em steamidkey/knowncode recusados pela Valve (403/412), prevenindo bloqueio 503.
    this.invalidShareAuth = new Map();
  }

  get steamConfigured() { return Boolean(this.steamApiKey); }
  get leetifyConfigured() { return Boolean(this.leetifyApiKey); }
  get configured() { return Boolean(this.steamApiKey || this.leetifyApiKey); }

  async steamRequest(path, params) {
    if (!this.steamConfigured) {
      throw new Cs2Error('Configure STEAM_API_KEY no arquivo .env. No Docker, aplique com: docker compose up -d --force-recreate. Na execução local, reinicie o app.', { status: 400 });
    }
    if (Date.now() < this.steamBlockedUntil) {
      throw new Cs2Error('Limite da Steam Web API atingido. A consulta será retomada após o tempo de espera.', {
        status: 429, retryAfterMs: this.steamBlockedUntil - Date.now(),
      });
    }
    const query = new URLSearchParams({ ...params, key: this.steamApiKey });
    let response;
    try {
      response = await this.fetchImpl(`${STEAM_HOST}${path}?${query}`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new Cs2Error('Não foi possível consultar a Steam Web API. Verifique a conexão e tente novamente.');
    }
    if (response.status === 429 || response.status === 503) {
      const retryAfterMs = retryDelay(response.headers?.get?.('retry-after'));
      this.steamBlockedUntil = Date.now() + retryAfterMs;
      throw new Cs2Error('A Steam Web API limitou ou suspendeu temporariamente as consultas. Nova tentativa em instantes.', {
        status: response.status, retryAfterMs,
      });
    }
    let data = null;
    try { data = await response.json(); } catch { data = null; }
    return { status: response.status, ok: response.ok, data };
  }

  async leetifyRequest(path) {
    if (Date.now() < this.leetifyBlockedUntil) {
      throw new Cs2Error('Limite de consultas do Leetify atingido. A consulta será retomada após o tempo de espera.', {
        status: 429, retryAfterMs: this.leetifyBlockedUntil - Date.now(),
      });
    }
    const headers = { Accept: 'application/json' };
    if (this.leetifyApiKey) {
      headers.Authorization = `Bearer ${this.leetifyApiKey}`;
      headers._leetify_key = this.leetifyApiKey;
    }
    let response;
    try {
      response = await this.fetchImpl(`${LEETIFY_HOST}${path}`, {
        headers,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new Cs2Error('Não foi possível consultar as estatísticas de CS2 no Leetify. Verifique a conexão e tente novamente.');
    }
    if (response.status === 429) {
      const retryAfterMs = retryDelay(response.headers?.get?.('retry-after'));
      this.leetifyBlockedUntil = Date.now() + retryAfterMs;
      throw new Cs2Error('Limite de consultas do Leetify atingido. Configure LEETIFY_API_KEY no .env ou aguarde o intervalo.', {
        status: 429, retryAfterMs,
      });
    }
    if (response.status === 401 || response.status === 403) {
      throw new Cs2Error(`O Leetify recusou a consulta (HTTP ${response.status}). Confira LEETIFY_API_KEY no .env e a privacidade do perfil.`, {
        status: response.status,
      });
    }
    if (response.status === 404) return { status: 404, data: null };
    if (response.status >= 500) return { status: response.status, data: null };
    if (!response.ok) {
      throw new Cs2Error('O provedor de estatísticas de CS2 rejeitou a consulta.', { status: response.status });
    }
    try { return { status: response.status, data: await response.json() }; }
    catch { throw new Cs2Error('O provedor de estatísticas de CS2 retornou uma resposta inválida.'); }
  }

  async steamSummary(steamId) {
    const { status, ok, data } = await this.steamRequest('/ISteamUser/GetPlayerSummaries/v2/', { steamids: steamId });
    if (status === 401 || status === 403) {
      throw new Cs2Error(`A Steam recusou STEAM_API_KEY (HTTP ${status}). Se alterou o .env no Docker, aplique com: docker compose up -d --force-recreate.`, { status });
    }
    if (!ok || !Array.isArray(data?.response?.players)) {
      throw new Cs2Error('Não foi possível consultar o perfil Steam no momento.', { status });
    }
    const profile = data.response.players.find(entry => String(entry?.steamid) === steamId);
    if (!profile) throw new Cs2Error('Conta Steam não encontrada para esse SteamID64.', { status: 404 });
    return {
      steamId,
      personaname: nonempty(profile.personaname) ? profile.personaname.trim() : steamId,
    };
  }

  async nextSharingCode(steamId, authCode, knownCode) {
    const cacheKey = `${steamId}:${authCode}:${knownCode}`;
    const cachedError = this.invalidShareAuth.get(cacheKey);
    if (cachedError) throw new Cs2Error(cachedError.message, { status: cachedError.status });
    const { status, ok, data } = await this.steamRequest('/ICSGOPlayers_730/GetNextMatchSharingCode/v1', {
      steamid: steamId, steamidkey: authCode, knowncode: knownCode,
    });
    if (status === 202) return null;
    if (status === 200) {
      const next = data?.result?.nextcode;
      if (!next || next === 'n/a') return null;
      return normalizeShareCode(next);
    }
    if (status === 403) {
      const message = 'A Steam recusou o código de autenticação da partida ou a STEAM_API_KEY (HTTP 403). Gere ou confira o código na página de dados pessoais do CS2 na Steam.';
      this.invalidShareAuth.set(cacheKey, { status: 403, message });
      throw new Cs2Error(message, { status: 403 });
    }
    if (status === 412) {
      const message = 'O código da última partida não pertence a este SteamID64 ou expirou na Valve (HTTP 412). Atualize com um código CSGO-... recente.';
      this.invalidShareAuth.set(cacheKey, { status: 412, message });
      throw new Cs2Error(message, { status: 412 });
    }
    if (!ok) {
      throw new Cs2Error('A Steam não pôde consultar o histórico de códigos de partida no momento.', { status });
    }
    return null;
  }

  async walkSharingCodes(steamId, authCode, startCode, { maxSteps = 50 } = {}) {
    const normalizedSteamId = normalizeSteamId(steamId);
    const normalizedAuth = normalizeAuthCode(authCode);
    let cursor = normalizeShareCode(startCode);
    const codes = [];
    for (let step = 0; step < maxSteps; step++) {
      const next = await this.nextSharingCode(normalizedSteamId, normalizedAuth, cursor);
      if (!next || next === cursor) break;
      codes.push(next);
      cursor = next;
    }
    return codes;
  }

  async verifyShareAuth(steamId, authCode, knownCode) {
    const normalizedSteamId = normalizeSteamId(steamId);
    const normalizedAuth = normalizeAuthCode(authCode);
    const normalizedKnown = normalizeShareCode(knownCode);
    const codes = await this.walkSharingCodes(normalizedSteamId, normalizedAuth, normalizedKnown, { maxSteps: 50 });
    return {
      authCode: normalizedAuth,
      knownCode: codes.at(-1) || normalizedKnown,
    };
  }

  async resolvePlayer({ steamId, authCode = '', knownCode = '', gameName = '' }) {
    if (!this.configured) {
      throw new Cs2Error('Configure STEAM_API_KEY (e opcionalmente LEETIFY_API_KEY) no arquivo .env. No Docker, aplique com: docker compose up -d --force-recreate. Na execução local, reinicie o app.', { status: 400 });
    }
    const normalizedSteamId = normalizeSteamId(steamId);
    const hasAuth = nonempty(authCode);
    const hasKnown = nonempty(knownCode);
    if (hasAuth !== hasKnown) {
      throw new Cs2Error('Informe juntos o código de autenticação da partida e o código de uma partida recente (ou deixe ambos em branco).', { status: 400 });
    }
    const customName = nonempty(gameName) ? gameName.trim() : '';
    let steamName = '';
    if (this.steamConfigured) {
      const profile = await this.steamSummary(normalizedSteamId);
      steamName = profile.personaname;
    }
    if (hasAuth) {
      const verified = await this.verifyShareAuth(normalizedSteamId, authCode, knownCode);
      return {
        game: 'cs2',
        steamId: normalizedSteamId,
        gameName: customName || steamName || normalizedSteamId,
        tagLine: '',
        authCode: verified.authCode,
        knownCode: verified.knownCode,
        baselineMatchId: verified.knownCode,
      };
    }
    const { status, data } = await this.leetifyRequest(`/v3/profile/matches?steam64_id=${encodeURIComponent(normalizedSteamId)}`);
    if (status === 404) {
      throw new Cs2Error('Jogador não encontrado no Leetify ou com perfil privado. Conecte a conta Steam no Leetify ou informe o código de autenticação e o último código de partida da Steam.', { status: 404 });
    }
    if (!Array.isArray(data)) {
      throw new Cs2Error('Não foi possível consultar o histórico inicial de CS2 no Leetify. Tente novamente em instantes.', { status });
    }
    let leetifyName = '';
    let baselineMatchId = null;
    for (const rawMatch of data) {
      const entry = Array.isArray(rawMatch?.stats)
        ? rawMatch.stats.find(item => String(item?.steam64_id) === normalizedSteamId)
        : null;
      if (!leetifyName && nonempty(entry?.name)) leetifyName = entry.name.trim();
      if (!baselineMatchId && MODE_BY_SOURCE.has(rawMatch?.data_source)) {
        baselineMatchId = nonempty(rawMatch.data_source_match_id)
          ? rawMatch.data_source_match_id.trim()
          : (nonempty(rawMatch.id) ? `leetify:${rawMatch.id.trim()}` : null);
      }
      if (leetifyName && baselineMatchId) break;
    }
    return {
      game: 'cs2',
      steamId: normalizedSteamId,
      gameName: customName || steamName || leetifyName || normalizedSteamId,
      tagLine: '',
      authCode: null,
      knownCode: null,
      baselineMatchId,
    };
  }

  async matchByShareCode(player, shareCode) {
    const normalizedCode = normalizeShareCode(shareCode);
    const { status, data } = await this.leetifyRequest(`/v2/matches/matchmaking/${encodeURIComponent(normalizedCode)}`);
    // O Leetify retorna 404 ou 500 enquanto a demo .dem da partida recém-encerrada ainda não foi indexada.
    if (status === 404 || status >= 500 || !data) return { state: 'pending' };
    const match = normalizeCs2Match(data, player, normalizedCode);
    if (!match) return { state: 'ignored' };
    return { state: 'ready', match };
  }

  async recentMatches(player) {
    const normalizedSteamId = normalizeSteamId(player.steamId);
    const { status, data } = await this.leetifyRequest(`/v3/profile/matches?steam64_id=${encodeURIComponent(normalizedSteamId)}`);
    if (status === 404) {
      throw new Cs2Error('Perfil CS2 não encontrado ou privado no Leetify.', { status: 404 });
    }
    if (!Array.isArray(data)) {
      throw new Cs2Error('O Leetify está indisponível no momento. Nova tentativa no próximo ciclo.', { status });
    }
    const matches = [];
    for (const raw of data) {
      const normalized = normalizeCs2Match(raw, player);
      if (normalized) matches.push(normalized);
    }
    return matches;
  }
}
