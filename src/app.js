import express from 'express';
import { timingSafeEqual, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { calculateKda } from './message.js';
import { gameModeLabel } from './game-mode.js';
import { mapLabel } from './cs2-message.js';
import { Cs2Client, normalizeSteamId } from './cs2.js';
import { R6Client } from './r6.js';
import { GAMES, isGame, messagesFor } from './games.js';
import {
  WEEKLY_BANDS, WEEKLY_LINE_VARIABLES, WEEKLY_PHRASE_GROUPS, WEEKLY_RULES, WEEKLY_TEMPLATE_VARIABLES, currentWeeklyWindow,
  exampleWeekSummaries, getDefaultWeeklyConfig, lastWeeklyWindow, renderWeeklyReport, summarizeWeek, validateWeeklyConfig,
} from './weekly.js';

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new HttpError(status, message); };
const parseGame = value => {
  if (value === undefined) return 'lol';
  if (!isGame(value)) fail(400, 'Jogo inválido. Escolha lol, cs2 ou r6.');
  return value;
};
const publicPlayer = ({ puuid, lastSeenMatchId, authCode, knownCode, pendingShareCode, pendingSince, ...player }) => (
  player.game === 'cs2' ? { ...player, hasShareAuth: Boolean(authCode) } : player
);
const publicMatch = match => (
  match.game === 'cs2' ? { ...match, mapLabel: mapLabel(match.map) } : { ...match, mode: gameModeLabel(match) }
);
const validGroup = id => typeof id === 'string' && /^\d+(?:-\d+)?@g\.us$/.test(id);
const messageConfigResponse = (game, config) => {
  const engine = messagesFor(game);
  return {
    game,
    config,
    variables: engine.variables,
    categories: engine.ui.categories,
    scenarios: engine.ui.scenarios,
  };
};
const withPerformance = (game, preview) => {
  const categories = messagesFor(game).ui.categories;
  const category = categories.find(entry => entry.key === preview.category) || categories[0];
  return { ...preview, performance: {
    kda: calculateKda(preview.match), band: category.band, label: category.label, range: category.range,
  } };
};

const publicWeeklyReport = ({ groupId, ...report }) => report;
const weeklySchedule = settings => ({ weeklyDay: settings.weeklyDay, weeklyHour: settings.weeklyHour });

export function createApp({ store, riot, cs2 = new Cs2Client(), r6 = new R6Client(), whatsapp, monitor, password = '', logger = console, now = () => Date.now() }) {
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    });
    next();
  });
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  if (password) {
    const expected = createHash('sha256').update(`admin:${password}`).digest();
    app.use((req, res, next) => {
      const header = req.get('authorization') || '';
      const supplied = header.startsWith('Basic ') ? Buffer.from(header.slice(6), 'base64').toString('utf8') : '';
      const actual = createHash('sha256').update(supplied).digest();
      if (timingSafeEqual(actual, expected)) return next();
      res.set('WWW-Authenticate', 'Basic realm="GG Report", charset="UTF-8"');
      res.status(401).json({ error: 'Entre com o usuário admin e a senha APP_PASSWORD.' });
    });
  }
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const origin = req.get('origin');
      if (origin) {
        try {
          if (new URL(origin).host !== req.get('host')) return next(new HttpError(403, 'Origem da requisição não permitida.'));
        } catch { return next(new HttpError(403, 'Origem da requisição inválida.')); }
      }
      if (!req.is('application/json')) return next(new HttpError(415, 'Envie o corpo como application/json.'));
    }
    next();
  });
  app.use(express.json({ limit: '256kb', strict: true }));
  app.use('/api', (req, _res, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)
      && (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)))
      return next(new HttpError(400, 'Envie um objeto JSON no corpo da requisição.'));
    next();
  });
  const whatsappCall = async callback => {
    try { return await callback(); }
    catch (error) { throw new HttpError(502, error.message); }
  };

  app.get('/api/state', (_req, res) => res.json({
    settings: store.settings(),
    riotConfigured: riot.configured,
    cs2Configured: cs2.configured,
    cs2SteamConfigured: cs2.steamConfigured,
    cs2LeetifyConfigured: cs2.leetifyConfigured,
    games: {
      lol: { id: 'lol', name: GAMES.lol.name, configured: riot.configured, stats: store.stats('lol') },
      cs2: {
        id: 'cs2', name: GAMES.cs2.name, configured: cs2.configured,
        steamConfigured: cs2.steamConfigured, leetifyConfigured: cs2.leetifyConfigured,
        stats: store.stats('cs2'),
      },
      r6: { id: 'r6', name: GAMES.r6.name, configured: r6.configured, stats: store.stats('r6') },
    },
    r6Configured: r6.configured,
    whatsapp: whatsapp.status(),
    monitor: monitor.status(),
    players: store.players().map(publicPlayer),
    matches: [...store.matches(100, 'lol'), ...store.matches(100, 'cs2'), ...store.matches(100, 'r6')]
      .sort((a, b) => b.endedAt.localeCompare(a.endedAt))
      .map(publicMatch),
    stats: store.stats(),
  }));

  // Plataformas do R6 vindas do /v2/config da stats.cc (cache no servidor; a chave nunca vai ao navegador).
  app.get('/api/r6/platforms', async (_req, res) => res.json({ platforms: await r6.platforms() }));
  app.get('/api/message-config', (req, res) => {
    const game = parseGame(req.query.game);
    res.json(messageConfigResponse(game, store.messageConfig(game)));
  });
  app.get('/api/message-config/defaults', (req, res) => {
    const game = parseGame(req.query.game);
    res.json(messageConfigResponse(game, messagesFor(game).defaultConfig()));
  });
  app.put('/api/message-config', (req, res) => {
    const game = parseGame(req.query.game ?? req.body.game);
    const config = store.updateMessageConfig(req.body.config, game);
    res.json(messageConfigResponse(game, config));
  });
  app.post('/api/message-preview', (req, res) => {
    const game = parseGame(req.query.game ?? req.body.game);
    const engine = messagesFor(game);
    const { scenario = 'feed', templateId, phraseIndex, matchId } = req.body;
    if (!engine.ui.categories.some(category => category.key === scenario)) {
      fail(400, `Escolha uma categoria válida para a prévia (${engine.categories.join(', ')}).`);
    }
    if (templateId !== undefined && (typeof templateId !== 'string' || !templateId || templateId.length > 64)) fail(400, 'Escolha uma variação de mensagem válida.');
    if (phraseIndex !== undefined && (!Number.isInteger(phraseIndex) || phraseIndex < 0 || phraseIndex > 29)) fail(400, 'Escolha uma frase válida para a prévia.');
    if (matchId !== undefined && (typeof matchId !== 'string' || !matchId || matchId.length > 128)) fail(400, 'Escolha uma partida válida para a prévia.');
    const config = engine.validateConfig(req.body.config === undefined ? store.messageConfig(game) : req.body.config);
    const options = { config, templateId, phraseIndex };
    if (matchId !== undefined) {
      const entry = store.match(matchId);
      if (!entry || (entry.game || 'lol') !== game) fail(404, 'Partida não encontrada no histórico.');
      const match = Object.fromEntries(GAMES[game].previewFields.map(key => [key, entry[key]]));
      match.id = entry.riotMatchId || entry.id;
      match.game = game;
      return res.json(withPerformance(game, { match, ...engine.formatMessage(match, options) }));
    }
    res.json(withPerformance(game, engine.createPreview(scenario, options)));
  });

  app.post('/api/players', async (req, res) => {
    const game = parseGame(req.body.game);
    if (store.players(game).length >= 20) fail(400, 'O limite desta versão leve é de 20 jogadores por jogo.');
    if (game === 'cs2') {
      const { steamId, authCode = '', knownCode = '', gameName = '' } = req.body;
      if (typeof steamId !== 'string' || !steamId.trim()) fail(400, 'Informe o SteamID64 do jogador.');
      if (typeof authCode !== 'string') fail(400, 'Código de autenticação inválido.');
      if (typeof knownCode !== 'string') fail(400, 'Código da partida inválido.');
      if (typeof gameName !== 'string' || gameName.trim().length > 50) fail(400, 'O apelido opcional deve ter até 50 caracteres.');
      if (!cs2.configured) {
        fail(400, 'Configure STEAM_API_KEY (e opcionalmente LEETIFY_API_KEY) no arquivo .env. No Docker, aplique com: docker compose up -d --force-recreate. Na execução local, reinicie o app.');
      }
      const normalizedSteamId = normalizeSteamId(steamId);
      if (store.players('cs2').some(player => player.steamId === normalizedSteamId)) {
        fail(409, 'Este jogador já está cadastrado no Counter-Strike 2.');
      }
      const resolved = await cs2.resolvePlayer({ steamId: normalizedSteamId, authCode, knownCode, gameName });
      const { baselineMatchId, ...account } = resolved;
      try {
        const player = store.addPlayer(account, 'steam', baselineMatchId, 'cs2');
        return res.status(201).json({ player: publicPlayer(player) });
      } catch (error) {
        if (error.message.includes('UNIQUE')) fail(409, 'Este jogador já está cadastrado no Counter-Strike 2.');
        throw error;
      }
    }
    if (game === 'r6') {
      const { platform, username } = req.body;
      if (typeof platform !== 'string' || !/^[a-z0-9-]{1,32}$/.test(platform)) fail(400, 'Escolha a plataforma do player.');
      if (typeof username !== 'string' || !username.trim() || username.trim().length > 40 || /[/\\?#]/.test(username))
        fail(400, 'Informe o nick do Rainbow Six Siege, com até 40 caracteres.');
      if (!r6.configured) fail(400, 'Configure STATS_CC_API_KEY no arquivo .env. No Docker, aplique com: docker compose up -d --force-recreate. Na execução local, reinicie o app.');
      const { account, baselineMatchId } = await r6.resolvePlayer({ platform, username: username.trim() });
      if (store.players('r6').some(player => player.profileId === account.profileId)) fail(409, 'Este perfil já está cadastrado no Rainbow Six Siege.');
      try {
        const player = store.addPlayer(account, account.platform, baselineMatchId, 'r6');
        return res.status(201).json({ player: publicPlayer(player) });
      } catch (error) {
        if (error.message.includes('UNIQUE')) fail(409, 'Este perfil já está cadastrado no Rainbow Six Siege.');
        throw error;
      }
    }
    const { gameName, tagLine, region = 'americas' } = req.body;
    if (typeof gameName !== 'string' || !gameName.trim() || gameName.trim().length > 50 || gameName.includes('#'))
      fail(400, 'Informe o nick sem #, com até 50 caracteres.');
    if (typeof tagLine !== 'string' || !tagLine.trim() || tagLine.trim().length > 10 || tagLine.includes('#'))
      fail(400, 'Informe a tag sem #, com até 10 caracteres.');
    if (!['americas', 'europe', 'asia', 'sea'].includes(region)) fail(400, 'Região inválida. Para o Brasil, escolha Américas.');
    if (!riot.configured) fail(400, 'Configure RIOT_API_KEY no arquivo .env. No Docker, aplique com: docker compose up -d --force-recreate. Na execução local, reinicie o app.');
    const account = await riot.resolvePlayer({ gameName: gameName.trim(), tagLine: tagLine.trim(), region });
    if (store.players('lol').some(player => player.puuid === account.puuid && player.region === region)) fail(409, 'Este jogador já está cadastrado nesta região.');
    const ids = await riot.matchIds({ ...account, region }, { count: 1 });
    try {
      const player = store.addPlayer(account, region, ids[0] || null, 'lol');
      res.status(201).json({ player: publicPlayer(player) });
    } catch (error) {
      if (error.message.includes('UNIQUE')) fail(409, 'Este jogador já está cadastrado nesta região.');
      throw error;
    }
  });
  app.patch('/api/players/:id', async (req, res) => {
    const existing = store.player(req.params.id);
    if (!existing) fail(404, 'Jogador não encontrado.');
    const patch = {};
    if (req.body.authCode !== undefined || req.body.knownCode !== undefined) {
      if (existing.game !== 'cs2') fail(400, 'Apenas jogadores de CS2 usam código de autenticação de partida da Steam.');
      if (typeof req.body.authCode !== 'string' || typeof req.body.knownCode !== 'string') {
        fail(400, 'Informe juntos o código de autenticação e o código da última partida.');
      }
      const verified = await cs2.verifyShareAuth(existing.steamId, req.body.authCode, req.body.knownCode);
      Object.assign(patch, {
        authCode: verified.authCode,
        knownCode: verified.knownCode,
        lastSeenMatchId: verified.knownCode,
        pendingShareCode: null,
        pendingSince: null,
        lastError: null,
      });
    }
    if (req.body.enabled !== undefined) {
      if (typeof req.body.enabled !== 'boolean') fail(400, 'Informe se o acompanhamento está ativo.');
      patch.enabled = req.body.enabled;
    }
    if (!Object.keys(patch).length) fail(400, 'Informe a alteração desejada para o jogador.');
    res.json({ player: publicPlayer(store.updatePlayer(req.params.id, patch)) });
  });
  app.delete('/api/players/:id', (req, res) => {
    if (!store.player(req.params.id)) fail(404, 'Jogador não encontrado.');
    store.removePlayer(req.params.id);
    res.json({ ok: true });
  });

  app.put('/api/settings', async (req, res) => {
    const patch = {};
    if (req.body.pollIntervalSeconds !== undefined) {
      const value = req.body.pollIntervalSeconds;
      if (!Number.isInteger(value) || value < 30 || value > 86400) fail(400, 'O intervalo deve ser um número inteiro entre 30 e 86.400 segundos.');
      patch.pollIntervalSeconds = value;
    }
    if (req.body.whatsappGroupId !== undefined) {
      const id = req.body.whatsappGroupId;
      if (!validGroup(id)) fail(400, 'Escolha um grupo válido do WhatsApp.');
      if (id !== store.settings().whatsappGroupId) {
        const group = (await whatsappCall(() => whatsapp.groups())).find(group => group.id === id);
        if (!group) fail(400, 'O grupo não pertence ao WhatsApp conectado. Atualize a lista de grupos.');
        patch.whatsappGroupId = id;
        patch.whatsappGroupName = group.name;
      }
    }
    if (req.body.monitoringEnabled !== undefined) {
      if (typeof req.body.monitoringEnabled !== 'boolean') fail(400, 'O estado do monitor deve ser verdadeiro ou falso.');
      if (req.body.monitoringEnabled) {
        const activePlayers = store.players().filter(player => player.enabled);
        const hasLol = activePlayers.some(player => (player.game || 'lol') === 'lol');
        const hasCs2 = activePlayers.some(player => player.game === 'cs2');
        const hasR6 = activePlayers.some(player => player.game === 'r6');
        if (!activePlayers.length && !riot.configured && !cs2.configured && !r6.configured) {
          fail(400, 'Configure RIOT_API_KEY, STEAM_API_KEY ou STATS_CC_API_KEY no .env antes de ativar.');
        }
        if (hasR6 && !r6.configured) fail(400, 'Configure STATS_CC_API_KEY no .env antes de ativar.');
        if (hasLol && !riot.configured) fail(400, 'Configure RIOT_API_KEY no .env antes de ativar.');
        if (hasCs2 && !cs2.configured) fail(400, 'Configure STEAM_API_KEY no .env antes de ativar.');
        if (activePlayers.some(player => player.game === 'cs2' && player.authCode) && !cs2.steamConfigured) {
          fail(400, 'Configure STEAM_API_KEY no .env para usar a autorização de partida da Steam.');
        }
        if (!activePlayers.length) fail(400, 'Cadastre e ative pelo menos um jogador.');
        if (!validGroup(patch.whatsappGroupId || store.settings().whatsappGroupId)) fail(400, 'Conecte o WhatsApp e selecione um grupo antes de ativar.');
        if (!store.settings().monitoringEnabled && whatsapp.status().state !== 'connected') fail(400, 'Conecte o WhatsApp antes de ativar o monitor.');
      }
      patch.monitoringEnabled = req.body.monitoringEnabled;
    }
    const settings = store.updateSettings(patch);
    monitor.refresh();
    res.json({ settings });
  });
  app.post('/api/check', async (_req, res) => {
    if (!store.settings().monitoringEnabled) fail(400, 'Ative o monitor antes de verificar partidas.');
    await monitor.check();
    res.json({ monitor: monitor.status() });
  });
  app.post('/api/preview', (req, res) => {
    const game = parseGame(req.body.game);
    const engine = messagesFor(game);
    if (!engine.ui.categories.some(category => category.key === req.body.scenario)) {
      fail(400, `Escolha uma categoria válida para a prévia (${engine.categories.join(', ')}).`);
    }
    res.json(withPerformance(game, engine.createPreview(req.body.scenario, { config: store.messageConfig(game) })));
  });
  app.post('/api/whatsapp/connect', async (_req, res) => {
    await whatsappCall(() => whatsapp.start());
    res.json({ whatsapp: whatsapp.status() });
  });
  app.post('/api/whatsapp/disconnect', async (_req, res) => {
    store.updateSettings({ monitoringEnabled: false });
    monitor.refresh();
    await whatsappCall(() => whatsapp.disconnect());
    res.json({ whatsapp: whatsapp.status() });
  });
  app.get('/api/whatsapp/groups', async (_req, res) => res.json({ groups: await whatsappCall(() => whatsapp.groups()) }));
  app.post('/api/matches/:id/retry', (req, res) => {
    const entry = store.match(req.params.id);
    if (!entry) fail(404, 'Partida não encontrada.');
    if (entry.status !== 'failed') fail(400, 'Somente envios com falha podem ser repetidos.');
    if (!store.player(entry.playerId)?.enabled) fail(400, 'O jogador precisa estar cadastrado e ativo para reenviar.');
    const match = store.updateDelivery(entry.id, { status: 'pending', attempts: 0, error: null, nextAttemptAt: 0 });
    monitor.refresh();
    res.json({ match });
  });

  const weeklyState = config => {
    const settings = store.settings();
    const next = currentWeeklyWindow(now(), weeklySchedule(settings));
    return {
      settings: { enabled: settings.weeklyEnabled, day: settings.weeklyDay, hour: settings.weeklyHour },
      next: { key: next.key, period: next.period, scheduledAt: new Date(next.end).toISOString() },
      config,
      templateVariables: WEEKLY_TEMPLATE_VARIABLES,
      lineVariables: WEEKLY_LINE_VARIABLES,
      bands: WEEKLY_BANDS,
      phraseGroups: WEEKLY_PHRASE_GROUPS,
      rules: WEEKLY_RULES,
      reports: store.weeklyReports(12).map(publicWeeklyReport),
    };
  };
  app.get('/api/weekly', (_req, res) => res.json(weeklyState(store.weeklyConfig())));
  app.get('/api/weekly/defaults', (_req, res) => res.json(weeklyState(getDefaultWeeklyConfig())));
  app.put('/api/weekly/settings', (req, res) => {
    const patch = {};
    if (req.body.enabled !== undefined) {
      if (typeof req.body.enabled !== 'boolean') fail(400, 'Informe se o resumo semanal está ativo.');
      patch.weeklyEnabled = req.body.enabled;
    }
    if (req.body.day !== undefined) {
      if (!Number.isInteger(req.body.day) || req.body.day < 0 || req.body.day > 6) fail(400, 'Escolha um dia da semana válido.');
      patch.weeklyDay = req.body.day;
    }
    if (req.body.hour !== undefined) {
      if (!Number.isInteger(req.body.hour) || req.body.hour < 0 || req.body.hour > 23) fail(400, 'Escolha uma hora entre 0 e 23.');
      patch.weeklyHour = req.body.hour;
    }
    if (!Object.keys(patch).length) fail(400, 'Informe a alteração desejada para o resumo semanal.');
    store.updateSettings(patch);
    res.json(weeklyState(store.weeklyConfig()));
  });
  app.put('/api/weekly/config', (req, res) => {
    res.json(weeklyState(store.updateWeeklyConfig(req.body.config)));
  });
  // Prévia: monta o resumo com dados reais (semana atual ou última encerrada) ou de exemplo. Nunca envia nem grava.
  app.post('/api/weekly/preview', (req, res) => {
    const game = parseGame(req.body.game);
    const source = req.body.source ?? 'current';
    if (!['current', 'last', 'example'].includes(source)) fail(400, 'Escolha os dados da prévia: current, last ou example.');
    const config = validateWeeklyConfig(req.body.config === undefined ? store.weeklyConfig() : req.body.config);
    const schedule = weeklySchedule(store.settings());
    const window = source === 'last' ? lastWeeklyWindow(now(), schedule) : currentWeeklyWindow(now(), schedule);
    const summaries = source === 'example'
      ? exampleWeekSummaries(game)
      : summarizeWeek(store.players(game).filter(player => player.enabled),
        store.matchesDetectedBetween(game, window.start, Math.min(window.end, now())));
    const report = renderWeeklyReport({ game, summaries, period: window.period, seed: window.key, config });
    res.json({
      game, source, period: window.period,
      message: report?.message || null,
      players: report?.players || [],
      empty: !report,
    });
  });
  app.post('/api/weekly/reports/:id/retry', (req, res) => {
    const report = store.weeklyReport(req.params.id);
    if (!report) fail(404, 'Resumo semanal não encontrado.');
    if (report.status !== 'failed') fail(400, 'Somente resumos com falha podem ser reenviados.');
    const updated = store.updateWeeklyReport(report.id, { status: 'pending', attempts: 0, error: null, nextAttemptAt: 0 });
    monitor.refresh();
    res.json({ report: publicWeeklyReport(updated) });
  });

  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Rota não encontrada.')));
  app.use(express.static(fileURLToPath(new URL('../public/', import.meta.url)), { etag: true }));
  app.use((error, _req, res, _next) => {
    const upstreamError = error.name === 'RiotError' || error.name === 'Cs2Error' || error.name === 'R6Error';
    const status = error.status || (error.name === 'MessageConfigError' ? 400 : upstreamError ? 502 : 500);
    if (status >= 500) logger.error({ error: error.message }, 'Erro na requisição');
    const message = error instanceof HttpError || upstreamError || error.name === 'MessageConfigError' || status < 500
      ? (error.type === 'entity.parse.failed' ? 'JSON inválido.' : error.type === 'entity.too.large'
        ? 'O conteúdo excede o limite de tamanho. Reduza o texto ou a quantidade de variações.' : error.message)
      : 'Não foi possível concluir a operação. Verifique os logs e tente novamente.';
    res.status(status).json({ error: message });
  });
  return app;
}
