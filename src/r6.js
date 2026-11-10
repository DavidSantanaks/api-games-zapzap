import { nonempty, retryDelay } from './http.js';

// Rainbow Six Siege pela API da stats.cc (https://api.stats.cc/siege/docs).
// Termos combinados com a stats.cc: crédito "Data by Stats.cc" nos resumos, respeitar perfis ocultos,
// chave só no servidor e nada de backfill: só partidas novas a partir do cadastro.
const STATS_CC_HOST = 'https://api.stats.cc/siege';
const CONFIG_TTL_MS = 12 * 60 * 60_000;
const PROFILE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MISSING_KEY = 'Configure STATS_CC_API_KEY no arquivo .env. No Docker, aplique com: docker compose up -d --force-recreate. Na execução local, reinicie o app.';

/** Playlists que geram mensagem (decisão do usuário em 10/11/2026). Os nomes em pt-BR valem também sem o config. */
export const R6_PLAYLISTS = { ranked: 'Ranqueada', unranked: 'Padrão', 'legend-division': 'Legend Division' };
/** Plataformas conhecidas, usadas enquanto o /v2/config não responde. */
export const R6_FALLBACK_PLATFORMS = [
  { slug: 'pc', display: 'PC' }, { slug: 'playstation', display: 'PlayStation' }, { slug: 'xbox', display: 'Xbox' },
];
const PLATFORM_ORDER = slug => {
  const index = R6_FALLBACK_PLATFORMS.findIndex(entry => entry.slug === slug);
  return index < 0 ? R6_FALLBACK_PLATFORMS.length : index;
};
// Resultado da partida para o jogador (`profile_match_outcomes`). Cancelamentos não geram mensagem.
const OUTCOMES = {
  win: 'win', loss: 'loss', draw: 'draw', abandon: 'loss', surrender: 'loss', forfeit: 'loss',
};
const CANCELED_OUTCOMES = new Set(['enemy-cancel', 'self-cancel', 'team-cancel']);

export class R6Error extends Error {
  constructor(message, { status = 0, kind = '', retryAfterMs = 0 } = {}) {
    super(message);
    this.name = 'R6Error';
    this.status = status;
    this.kind = kind;
    this.retryAfterMs = retryAfterMs;
  }
}

/** Nome legível de um slug sem config: `kafe-dostoyevsky` vira `Kafe Dostoyevsky`. */
export function slugLabel(slug) {
  const text = String(slug || '').trim().replace(/[-_]+/g, ' ');
  return text ? text.replace(/\b\p{L}/gu, letter => letter.toUpperCase()) : 'N/A';
}

const count = value => (Number.isFinite(Number(value)) && value !== null ? Math.max(0, Math.floor(Number(value))) : null);
const sum = (summary, keys) => {
  const values = keys.map(key => count(summary[key]));
  return values.some(value => value === null) ? null : values.reduce((a, b) => a + b, 0);
};

/**
 * Converte um item de `/v2/profiles/{id}/matches` em uma partida do GG Report.
 * Retorna `null` para partidas fora das playlists acompanhadas ou canceladas.
 * Campos que a fonte não informou ficam `null` e viram N/A na mensagem.
 */
export function normalizeR6Match(item, { player = {}, labels = {} } = {}) {
  if (!item || typeof item !== 'object' || !nonempty(item.id)) throw new R6Error('A stats.cc devolveu uma partida sem identificador.');
  const summary = item.player_summary;
  if (!summary || typeof summary !== 'object') throw new R6Error('A partida do R6 veio sem as estatísticas do jogador.');
  if (!Object.hasOwn(R6_PLAYLISTS, item.playlist)) return null;
  const outcome = String(summary.outcome || '');
  if (CANCELED_OUTCOMES.has(outcome) || item.end_reason === 'canceled') return null;
  const result = OUTCOMES[outcome];
  if (!result) return null;
  const endedAt = Date.parse(item.ended_at);
  if (!Number.isFinite(endedAt)) throw new R6Error('A partida do R6 ainda não possui horário de encerramento válido.');

  const team = count(summary.team);
  const scores = Array.isArray(item.scores) ? item.scores.map(count) : [];
  const own = team === null ? null : scores[team];
  const enemy = team === null ? null : scores[1 - team];
  const kills = count(summary.kills) ?? 0;
  const headshots = count(summary.headshots);
  const session = item.ranked_session || item.legend_session || null;
  const rankSlug = session && nonempty(session.rank) ? session.rank : null;
  const delta = session && Number.isFinite(session.rank_points_delta) ? Math.trunc(session.rank_points_delta) : null;
  return {
    id: item.id,
    game: 'r6',
    playerName: String(summary.username || player.gameName || 'Jogador'),
    profileId: summary.profile_id || player.profileId || null,
    platform: player.platform || null,
    platformLabel: player.platformLabel || null,
    playlist: item.playlist,
    mode: R6_PLAYLISTS[item.playlist],
    map: item.map || null,
    mapLabel: item.map ? (labels.maps?.[item.map] || slugLabel(item.map)) : null,
    outcome,
    result,
    win: result === 'win',
    score: own !== null && own !== undefined && enemy !== null && enemy !== undefined ? `${own} x ${enemy}` : null,
    kills,
    deaths: count(summary.deaths) ?? 0,
    assists: count(summary.assists) ?? 0,
    headshots,
    headshotPercent: headshots === null ? null : kills > 0 ? Math.round((headshots / kills) * 100) : 0,
    rounds: count(summary.rounds),
    roundWins: count(summary.round_wins),
    roundLosses: count(summary.round_losses),
    openingKills: count(summary.opening_kills),
    openingDeaths: count(summary.opening_deaths),
    clutchWins: sum(summary, ['clutch_1v1_wins', 'clutch_1v2_wins', 'clutch_1v3_wins', 'clutch_1v4_wins', 'clutch_1v5_wins']),
    clutchLosses: sum(summary, ['clutch_1v1_losses', 'clutch_1v2_losses', 'clutch_1v3_losses', 'clutch_1v4_losses', 'clutch_1v5_losses']),
    rank: rankSlug,
    rankLabel: rankSlug ? (labels.ranks?.[rankSlug] || slugLabel(rankSlug.replace(/^v\d+-/, ''))) : null,
    rankPoints: session && Number.isFinite(session.rank_points) ? Math.trunc(session.rank_points) : null,
    rankPointsDelta: delta,
    startedAt: Number.isFinite(Date.parse(item.started_at)) ? new Date(item.started_at).toISOString() : null,
    endedAt: new Date(endedAt).toISOString(),
  };
}

export class R6Client {
  constructor({ apiKey = '', fetchImpl = fetch, timeoutMs = 15_000, unknownRetryMs = 4000, now = () => Date.now() } = {}) {
    this.apiKey = String(apiKey || '').trim();
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.unknownRetryMs = unknownRetryMs;
    this.now = now;
    this.blockedUntil = 0;
    this.config = null;
    this.configLoadedAt = 0;
  }

  get configured() { return Boolean(this.apiKey); }

  async send(path, { auth = true } = {}) {
    if (auth && !this.configured) throw new R6Error(MISSING_KEY, { status: 400, kind: 'missing_key' });
    if (auth && this.blockedUntil > this.now()) {
      throw new R6Error('Limite de consultas da stats.cc atingido. A consulta será retomada após o tempo de espera.', {
        status: 429, kind: 'rate_limited', retryAfterMs: this.blockedUntil - this.now(),
      });
    }
    let response;
    try {
      response = await this.fetchImpl(STATS_CC_HOST + path, {
        headers: { accept: 'application/json', ...(auth ? { 'x-api-key': this.apiKey } : {}) },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new R6Error('Não foi possível consultar a stats.cc. Verifique a conexão e tente novamente.', { status: 503, kind: 'network', retryAfterMs: 30_000 });
    }
    const header = name => response.headers?.get?.(name) ?? null;
    // Respeita a cota informada nos cabeçalhos RateLimit-* antes de chegar ao 429.
    if (auth && header('ratelimit-remaining') === '0') {
      this.blockedUntil = this.now() + retryDelay(header('ratelimit-reset'));
    }
    let body = null;
    try { body = await response.json(); } catch { body = null; }
    if (response.ok) {
      if (body === null) throw new R6Error('A stats.cc retornou uma resposta inválida.', { status: 502 });
      return body;
    }
    const kind = typeof body?.kind === 'string' ? body.kind : '';
    const status = response.status;
    if (status === 429) {
      const retryAfterMs = retryDelay(header('retry-after') || header('ratelimit-reset'));
      this.blockedUntil = this.now() + retryAfterMs;
      throw new R6Error('Limite de consultas da stats.cc atingido. A consulta será retomada após o tempo de espera.', { status, kind: kind || 'rate_limited', retryAfterMs });
    }
    if (status === 503 || status >= 500) {
      const retryAfterMs = header('retry-after') ? retryDelay(header('retry-after')) : 30_000;
      throw new R6Error('A stats.cc está sobrecarregada ou indisponível no momento. Nova tentativa no próximo ciclo.', { status, kind: kind || 'unavailable', retryAfterMs });
    }
    if (status === 401) {
      throw new R6Error('A stats.cc recusou STATS_CC_API_KEY (HTTP 401). Confira a chave no .env e aplique com: docker compose up -d --force-recreate.', { status: 502, kind });
    }
    if (status === 403 && kind === 'missing_scope') {
      throw new R6Error('A chave da stats.cc não tem o escopo necessário (profiles e matches). Peça à stats.cc para liberar os escopos.', { status: 502, kind });
    }
    if (status === 403) throw new R6Error('A stats.cc recusou a consulta (HTTP 403). Confira STATS_CC_API_KEY.', { status: 502, kind });
    if (status === 404 && kind === 'hidden_profile') {
      throw new R6Error('O dono ocultou este perfil na stats.cc. O GG Report respeita a escolha e não acompanha perfis ocultos.', { status, kind });
    }
    if (status === 404) throw new R6Error('Perfil do Rainbow Six Siege não encontrado na stats.cc.', { status, kind: kind || 'unknown_profile' });
    throw new R6Error(`A stats.cc rejeitou a consulta (HTTP ${status}).`, { status, kind });
  }

  /** Dados de referência (`/v2/config`, sem chave e sem limite), com cache de 12 horas e fallback para o último válido. */
  async referenceData() {
    if (this.config && this.now() - this.configLoadedAt < CONFIG_TTL_MS) return this.config;
    try {
      const data = await this.send('/v2/config', { auth: false });
      const labels = group => Object.fromEntries(Object.values(data?.[group] || {})
        .filter(entry => nonempty(entry?.slug)).map(entry => [entry.slug, String(entry.display || entry.slug)]));
      this.config = {
        platforms: Object.values(data?.platforms || {}).filter(entry => nonempty(entry?.slug))
          .map(entry => ({ slug: entry.slug, display: entry.slug === 'playstation' ? 'PlayStation' : String(entry.display || entry.slug) }))
          .sort((a, b) => PLATFORM_ORDER(a.slug) - PLATFORM_ORDER(b.slug)),
        maps: labels('maps'),
        ranks: labels('ranks'),
      };
      if (!this.config.platforms.length) this.config.platforms = structuredClone(R6_FALLBACK_PLATFORMS);
      this.configLoadedAt = this.now();
    } catch {
      if (!this.config) return { platforms: structuredClone(R6_FALLBACK_PLATFORMS), maps: {}, ranks: {} };
    }
    return this.config;
  }

  async platforms() { return (await this.referenceData()).platforms; }

  async profile(platform, username) {
    const path = `/v2/profiles/${encodeURIComponent(platform)}/${encodeURIComponent(username)}`;
    try { return await this.send(path); }
    catch (error) {
      // Um perfil nunca buscado pode responder unknown_profile e aparecer segundos depois.
      if (error.kind !== 'unknown_profile') throw error;
      if (this.unknownRetryMs > 0) await new Promise(resolve => setTimeout(resolve, this.unknownRetryMs));
      try { return await this.send(path); }
      catch (retryError) {
        if (retryError.kind !== 'unknown_profile') throw retryError;
        throw new R6Error('Perfil não encontrado na stats.cc. Confira o nick e a plataforma; se estiverem certos, o perfil pode estar sendo buscado pela primeira vez: tente de novo em alguns segundos.', {
          status: 404, kind: 'unknown_profile',
        });
      }
    }
  }

  async matchesPage(profileId, { after = null, limit = 20 } = {}) {
    if (!PROFILE_ID.test(String(profileId || ''))) throw new R6Error('Perfil do R6 sem identificador válido. Remova e cadastre o player de novo.', { status: 400 });
    const params = new URLSearchParams({ limit: String(limit) });
    if (after) params.set('after', after);
    const data = await this.send(`/v2/profiles/${encodeURIComponent(profileId)}/matches?${params}`);
    if (!Array.isArray(data)) throw new R6Error('A stats.cc retornou um histórico de partidas inválido.', { status: 502 });
    return data;
  }

  /** Cadastro: resolve o perfil, guarda o `profile_id` (o nick muda) e a partida mais recente como referência. */
  async resolvePlayer({ platform, username }) {
    if (!this.configured) throw new R6Error(MISSING_KEY, { status: 400, kind: 'missing_key' });
    const platforms = await this.platforms();
    const selected = platforms.find(entry => entry.slug === platform);
    if (!selected) throw new R6Error('Escolha uma plataforma válida (PC, PlayStation ou Xbox).', { status: 400 });
    const profile = await this.profile(platform, username);
    if (!PROFILE_ID.test(String(profile?.id || ''))) throw new R6Error('A stats.cc devolveu um perfil sem identificador.', { status: 502 });
    const latest = await this.matchesPage(profile.id, { limit: 1 });
    return {
      account: {
        profileId: profile.id, gameName: String(profile.username || username), platform: selected.slug,
        platformLabel: selected.display,
      },
      baselineMatchId: nonempty(latest[0]?.id) ? latest[0].id : null,
    };
  }

  /**
   * Partidas novas depois de `after`, mais antigas primeiro, já normalizadas (ou `null` quando ignoradas).
   * Pagina com `after` até esgotar, sem recorrer a `before`: não fazemos backfill de histórico antigo.
   */
  async newMatches(player, { maxPages = 5 } = {}) {
    const labels = await this.referenceData();
    const items = [];
    let cursor = player.lastSeenMatchId || null;
    for (let page = 0; page < maxPages; page++) {
      const batch = await this.matchesPage(player.profileId, { after: cursor });
      const fresh = batch.filter(item => nonempty(item?.id) && item.id !== cursor && !items.some(seen => seen.id === item.id));
      if (!fresh.length) break;
      items.push(...fresh);
      // Sem cursor (nenhuma partida no cadastro), a primeira página já basta: o resto é histórico.
      if (!cursor || batch.length < 20) break;
      cursor = [...fresh].sort((a, b) => String(b.ended_at).localeCompare(String(a.ended_at)))[0].id;
    }
    return items
      .sort((a, b) => String(a.ended_at).localeCompare(String(b.ended_at)))
      .map(item => {
        // Um item malformado não pode travar as partidas seguintes: ele é pulado e o erro fica registrado.
        try { return { id: item.id, match: normalizeR6Match(item, { player, labels }) }; }
        catch (error) { return { id: item.id, match: null, error: error.message }; }
      });
  }
}
