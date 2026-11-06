import { gameModeLabel } from './game-mode.js';
import { nonempty, number, retryDelay } from './http.js';

const REGIONS = new Set(['americas', 'europe', 'asia', 'sea']);

export class RiotError extends Error {
  constructor(message, { status = 0, retryAfterMs = 0 } = {}) {
    super(message);
    this.name = 'RiotError';
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

function regionHost(region) {
  if (!REGIONS.has(region)) throw new RiotError('Região inválida. Escolha Américas, Europa, Ásia ou SEA.');
  return `https://${region}.api.riotgames.com`;
}

function durationSeconds(info) {
  const [major, minor] = String(info.gameVersion || '').split('.').map(Number);
  const legacy = Number.isFinite(major) && (major < 11 || (major === 11 && minor < 20));
  let duration = number(info.gameDuration);
  if (legacy || duration > 86_400) duration = Math.floor(duration / 1000);
  if (!duration && info.gameEndTimestamp > info.gameStartTimestamp) {
    duration = Math.floor((info.gameEndTimestamp - info.gameStartTimestamp) / 1000);
  }
  return duration;
}

function position(info, participant) {
  if (info.gameMode === 'ARAM' || info.mapId === 12) return 'ARAM';
  const roles = { TOP: 'TOP', JUNGLE: 'JG', MIDDLE: 'MID', BOTTOM: 'ADC', UTILITY: 'SUP' };
  return roles[participant.teamPosition] || roles[participant.individualPosition] || 'N/A';
}

export class RiotClient {
  constructor({ apiKey = '', fetchImpl = fetch, timeoutMs = 15_000 } = {}) {
    this.apiKey = apiKey.trim();
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.blockedUntil = 0;
  }

  get configured() { return Boolean(this.apiKey); }

  async request(region, path) {
    const host = regionHost(region);
    if (!this.configured) throw new RiotError('Configure RIOT_API_KEY no arquivo .env. No Docker, aplique com: docker compose up -d --force-recreate. Na execução local, reinicie o app.');
    if (Date.now() < this.blockedUntil) {
      throw new RiotError('Limite da Riot atingido. A consulta será retomada após o tempo de espera.', {
        status: 429, retryAfterMs: this.blockedUntil - Date.now(),
      });
    }
    let response;
    try {
      response = await this.fetchImpl(`${host}${path}`, {
        headers: { 'X-Riot-Token': this.apiKey, Accept: 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new RiotError('Não foi possível consultar a Riot. Verifique a conexão e tente novamente.');
    }
    if (response.status === 429) {
      const retryAfterMs = retryDelay(response.headers.get('retry-after'));
      this.blockedUntil = Date.now() + retryAfterMs;
      throw new RiotError('Limite de consultas da Riot atingido. Aguarde antes de consultar novamente.', { status: 429, retryAfterMs });
    }
    if (response.status === 401 || response.status === 403) {
      throw new RiotError(`A Riot recusou a chave da API (HTTP ${response.status}). Se alterou o .env no Docker, aplique com: docker compose up -d --force-recreate. Se persistir, confira a validade e o acesso da chave no portal da Riot.`, { status: response.status });
    }
    if (response.status === 404) {
      throw new RiotError('Jogador ou partida não encontrado na Riot. Confira nick, tag e região.', { status: 404 });
    }
    if (!response.ok) {
      throw new RiotError(response.status >= 500
        ? 'A Riot está indisponível no momento. Uma nova tentativa será feita depois.'
        : 'A Riot rejeitou a consulta. Confira os dados informados.', { status: response.status });
    }
    try { return await response.json(); }
    catch { throw new RiotError('A Riot retornou uma resposta inválida. Tente novamente mais tarde.'); }
  }

  async resolvePlayer({ gameName, tagLine, region }) {
    if (!nonempty(gameName) || !nonempty(tagLine)) throw new RiotError('Informe o nick e a tag do Riot ID.');
    const account = await this.request(region,
      `/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName.trim())}/${encodeURIComponent(tagLine.trim())}`);
    if (!nonempty(account.puuid)) throw new RiotError('A Riot não retornou um identificador válido para esse jogador.');
    return {
      puuid: account.puuid,
      gameName: account.gameName || gameName.trim(),
      tagLine: account.tagLine || tagLine.trim(),
    };
  }

  async matchIds(player, { start = 0, count = 100, startTime } = {}) {
    if (!nonempty(player.puuid)) throw new RiotError('O jogador ainda não possui um identificador Riot válido.');
    const query = new URLSearchParams({ start: String(number(start)), count: String(Math.min(100, Math.max(1, number(count)))) });
    if (startTime !== undefined) query.set('startTime', String(number(startTime)));
    const ids = await this.request(player.region,
      `/lol/match/v5/matches/by-puuid/${encodeURIComponent(player.puuid)}/ids?${query}`);
    if (!Array.isArray(ids) || ids.some(id => !nonempty(id))) throw new RiotError('A Riot retornou uma lista de partidas inválida.');
    return ids;
  }

  async match(player, matchId) {
    if (!nonempty(player.puuid) || !nonempty(matchId)) throw new RiotError('Identificador de jogador ou partida inválido.');
    const data = await this.request(player.region, `/lol/match/v5/matches/${encodeURIComponent(matchId)}`);
    const info = data?.info;
    if (!info || !Array.isArray(info.participants)) throw new RiotError('A Riot retornou dados incompletos da partida.');
    // Custom matches must not be shared without explicit player opt-in. This MVP skips them.
    if (info.queueId === 0) return null;
    const participant = info.participants.find(item => item.puuid === player.puuid);
    if (!participant) throw new RiotError('O jogador não foi encontrado nos dados dessa partida.');
    const duration = durationSeconds(info);
    const end = Number(info.gameEndTimestamp) || (Number(info.gameStartTimestamp || info.gameCreation) + duration * 1000);
    if (!duration || !Number.isFinite(end) || end <= 0 || typeof participant.win !== 'boolean') {
      throw new RiotError('A partida ainda não tem um resultado completo. Será consultada novamente depois.');
    }
    const queueId = Number.isSafeInteger(info.queueId) && info.queueId >= 0 ? info.queueId : null;
    const gameMode = nonempty(info.gameMode) ? info.gameMode.trim() : null;
    return {
      id: matchId,
      playerName: `${participant.riotIdGameName || player.gameName}#${participant.riotIdTagline || player.tagLine}`,
      champion: participant.championName || 'Desconhecido',
      kills: number(participant.kills), deaths: number(participant.deaths), assists: number(participant.assists),
      cs: number(participant.totalMinionsKilled) + number(participant.neutralMinionsKilled),
      gold: number(participant.goldEarned), lane: position(info, participant),
      win: participant.win, durationSeconds: duration,
      endedAt: new Date(end).toISOString(), queueId, gameMode,
      mode: gameModeLabel({ queueId, gameMode }),
    };
  }
}
