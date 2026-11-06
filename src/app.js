import express from 'express';
import { timingSafeEqual, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createPreview, formatMessage, getDefaultMessageConfig, MESSAGE_VARIABLES, validateMessageConfig } from './message.js';
import { gameModeLabel } from './game-mode.js';

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new HttpError(status, message); };
const publicPlayer = ({ puuid, lastSeenMatchId, ...player }) => player;
const validGroup = id => typeof id === 'string' && /^\d+(?:-\d+)?@g\.us$/.test(id);
const MESSAGE_CATEGORIES = [
  { key: 'feed', label: 'Feedou' }, { key: 'carry', label: 'Carregou' },
  { key: 'support', label: 'Suporte' }, { key: 'normal', label: 'Partida normal' },
];
const messageConfigResponse = config => ({ config, variables: MESSAGE_VARIABLES, categories: MESSAGE_CATEGORIES });

export function createApp({ store, riot, whatsapp, monitor, password = '', logger = console }) {
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
    settings: store.settings(), riotConfigured: riot.configured,
    whatsapp: whatsapp.status(), monitor: monitor.status(),
    players: store.players().map(publicPlayer),
    matches: store.matches().map(match => ({ ...match, mode: gameModeLabel(match) })), stats: store.stats(),
  }));

  app.get('/api/message-config', (_req, res) => res.json(messageConfigResponse(store.messageConfig())));
  app.get('/api/message-config/defaults', (_req, res) => res.json(messageConfigResponse(getDefaultMessageConfig())));
  app.put('/api/message-config', (req, res) => {
    const config = store.updateMessageConfig(req.body.config);
    res.json(messageConfigResponse(config));
  });
  app.post('/api/message-preview', (req, res) => {
    const { scenario = 'feed', templateId, phraseIndex, matchId } = req.body;
    if (!MESSAGE_CATEGORIES.some(category => category.key === scenario)) fail(400, 'Escolha feed, carry, support ou normal para a prévia.');
    if (templateId !== undefined && (typeof templateId !== 'string' || !templateId || templateId.length > 64)) fail(400, 'Escolha uma variação de mensagem válida.');
    if (phraseIndex !== undefined && (!Number.isInteger(phraseIndex) || phraseIndex < 0 || phraseIndex > 29)) fail(400, 'Escolha uma frase válida para a prévia.');
    if (matchId !== undefined && (typeof matchId !== 'string' || !matchId || matchId.length > 128)) fail(400, 'Escolha uma partida válida para a prévia.');
    const config = validateMessageConfig(req.body.config === undefined ? store.messageConfig() : req.body.config);
    const options = { config, templateId, phraseIndex };
    if (matchId !== undefined) {
      const entry = store.match(matchId);
      if (!entry) fail(404, 'Partida não encontrada no histórico.');
      const match = Object.fromEntries(['playerName', 'champion', 'kills', 'deaths', 'assists', 'cs', 'gold', 'lane', 'win', 'durationSeconds', 'endedAt', 'queueId', 'gameMode', 'mode']
        .map(key => [key, entry[key]]));
      match.id = entry.riotMatchId || entry.id;
      return res.json({ match, ...formatMessage(match, options) });
    }
    res.json(createPreview(scenario, options));
  });

  app.post('/api/players', async (req, res) => {
    const { gameName, tagLine, region = 'americas' } = req.body;
    if (typeof gameName !== 'string' || !gameName.trim() || gameName.trim().length > 50 || gameName.includes('#'))
      fail(400, 'Informe o nick sem #, com até 50 caracteres.');
    if (typeof tagLine !== 'string' || !tagLine.trim() || tagLine.trim().length > 10 || tagLine.includes('#'))
      fail(400, 'Informe a tag sem #, com até 10 caracteres.');
    if (!['americas', 'europe', 'asia', 'sea'].includes(region)) fail(400, 'Região inválida. Para o Brasil, escolha Américas.');
    if (!riot.configured) fail(400, 'Configure RIOT_API_KEY no arquivo .env. No Docker, aplique com: docker compose up -d --force-recreate. Na execução local, reinicie o app.');
    if (store.players().length >= 20) fail(400, 'O limite desta versão leve é de 20 jogadores.');
    const account = await riot.resolvePlayer({ gameName: gameName.trim(), tagLine: tagLine.trim(), region });
    if (store.players().some(player => player.puuid === account.puuid && player.region === region)) fail(409, 'Este jogador já está cadastrado nesta região.');
    const ids = await riot.matchIds({ ...account, region }, { count: 1 });
    try {
      const player = store.addPlayer(account, region, ids[0] || null);
      res.status(201).json({ player: publicPlayer(player) });
    } catch (error) {
      if (error.message.includes('UNIQUE')) fail(409, 'Este jogador já está cadastrado nesta região.');
      throw error;
    }
  });
  app.patch('/api/players/:id', (req, res) => {
    if (!store.player(req.params.id)) fail(404, 'Jogador não encontrado.');
    if (typeof req.body.enabled !== 'boolean') fail(400, 'Informe se o acompanhamento está ativo.');
    res.json({ player: publicPlayer(store.updatePlayer(req.params.id, { enabled: req.body.enabled })) });
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
        if (!riot.configured) fail(400, 'Configure RIOT_API_KEY no .env antes de ativar.');
        if (!store.players().some(player => player.enabled)) fail(400, 'Cadastre e ative pelo menos um jogador.');
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
    if (!MESSAGE_CATEGORIES.some(category => category.key === req.body.scenario)) fail(400, 'Escolha feed, carry, support ou normal para a prévia.');
    res.json(createPreview(req.body.scenario, { config: store.messageConfig() }));
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

  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Rota não encontrada.')));
  app.use(express.static(fileURLToPath(new URL('../public/', import.meta.url)), { etag: true }));
  app.use((error, _req, res, _next) => {
    const status = error.status || (error.name === 'MessageConfigError' ? 400 : error.name === 'RiotError' ? 502 : 500);
    if (status >= 500) logger.error({ error: error.message }, 'Erro na requisição');
    const message = error instanceof HttpError || error.name === 'RiotError' || error.name === 'MessageConfigError' || status < 500
      ? (error.type === 'entity.parse.failed' ? 'JSON inválido.' : error.type === 'entity.too.large'
        ? 'O conteúdo excede o limite de tamanho. Reduza o texto ou a quantidade de variações.' : error.message)
      : 'Não foi possível concluir a operação. Verifique os logs e tente novamente.';
    res.status(status).json({ error: message });
  });
  return app;
}
