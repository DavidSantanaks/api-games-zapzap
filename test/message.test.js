import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyPerformance, formatMessage, createPreview, getDefaultMessageConfig,
  validateMessageConfig, MESSAGE_VARIABLES, MessageConfigError,
} from '../src/message.js';

test('requested 1/5/9 example receives feeder roast', () => {
  const result = createPreview('feed');
  assert.equal(result.category, 'feed');
  assert.match(result.message, /Frag: 1\/5\/9/);
  assert.match(result.message, /FEEDOU DEMAIS/);
  assert.match(result.message, /Resultado: DERROTA/);
  assert.match(result.message, /GOLD: 10\.000/);
  assert.match(result.message, /Modo: Ranqueada Solo\/Duo/);
});

test('strong support assistance is recognized even with few kills', () => {
  assert.equal(classifyPerformance({ lane: 'SUP', kills: 1, deaths: 5, assists: 20 }), 'support');
  assert.equal(createPreview('support').category, 'support');
  assert.equal(classifyPerformance({ lane: 'SUP', kills: 1, deaths: 5, assists: 9 }), 'feed');
});

test('carry roast and zero-death performance do not divide by zero', () => {
  assert.match(createPreview('carry').message, /NÃO FEZ MAIS QUE A OBRIGAÇÃO/);
  assert.equal(classifyPerformance({ kills: 7, deaths: 0, assists: 2, lane: 'MID' }), 'carry');
  assert.equal(classifyPerformance({ kills: 0, deaths: 0, assists: 0 }), 'normal');
});

test('message contains required summary fields and optional custom phrase', () => {
  const { match } = createPreview('support');
  const { message } = formatMessage(match, { phrase: 'Boa partida, tropa!' });
  for (const label of ['Jogo: LOL', 'Player: SeuAmigo#BR1', 'Personagem: Lulu', 'Farm: 32 CS', 'Lane: SUP', 'GOLD: 9.850']) {
    assert.ok(message.includes(label), label);
  }
  assert.ok(message.endsWith('Boa partida, tropa!'));
});

test('preview scenarios have isolated demonstration identifiers and reject unknown ones', () => {
  for (const scenario of ['feed', 'carry', 'support', 'normal']) {
    assert.equal(createPreview(scenario).match.id, `preview-${scenario}`);
    assert.equal(createPreview(scenario).category, scenario);
  }
  assert.throws(() => createPreview('unknown'), /Escolha uma prévia/);
  assert.throws(() => createPreview('__proto__'), /Escolha uma prévia/);
});

test('defaults provide three editable presets and 28 phrases without leaking shared state', () => {
  const original = getDefaultMessageConfig();
  assert.equal(original.templates.length, 3);
  assert.equal(original.templates.filter(template => template.enabled).length, 1);
  assert.deepEqual(Object.values(original.phrases).map(pool => pool.length), [8, 8, 6, 6]);
  const copy = getDefaultMessageConfig();
  copy.templates[0].text = 'Alterado';
  copy.phrases.feed.splice(0);
  assert.deepEqual(getDefaultMessageConfig(), original);
  const normalized = validateMessageConfig(original);
  normalized.templates[0].name = 'Outro nome';
  normalized.phrases.feed[0] = 'Outra frase';
  assert.notDeepEqual(normalized, original);
  assert.deepEqual(getDefaultMessageConfig(), original);
});

test('all catalog variables resolve with locale, duration and stored Riot match identity', () => {
  const { match } = createPreview('feed');
  const config = getDefaultMessageConfig();
  config.templates[0].text = MESSAGE_VARIABLES.map(variable => `{{${variable.key}}}`).join('|');
  const result = formatMessage({ ...match, id: 'local-uuid', riotMatchId: 'BR1_real', endedAt: '2026-11-06T12:34:56Z' }, { config, phraseIndex: 0 });
  assert.equal(new Set(MESSAGE_VARIABLES.map(variable => variable.key)).size, MESSAGE_VARIABLES.length);
  assert.deepEqual(Object.keys(result.values).sort(), MESSAGE_VARIABLES.map(variable => variable.key).sort());
  assert.ok(Object.values(result.values).every(value => typeof value === 'string'));
  assert.equal(result.values.lane, 'MID');
  assert.equal(result.values.gold, '10.000');
  assert.equal(result.values.gold_bruto, '10000');
  assert.equal(result.values.duracao, '30:00');
  assert.equal(result.values.duracao_segundos, '1800');
  assert.equal(result.values.kda, '2,00');
  assert.equal(result.values.partida_id, 'BR1_real');
  assert.equal(result.values.modo, 'Ranqueada Solo/Duo');
  assert.equal(result.values.data, '06/11/2026, 09:34');
  assert.equal(result.values.player, 'SeuAmigo#BR1');
  assert.equal(result.values.nick, 'SeuAmigo');
  assert.equal(result.values.tag, 'BR1');
  assert.equal(result.message.includes('{{'), false);
});

test('text rendering preserves authored whitespace and expands variables inside a phrase', () => {
  const { match } = createPreview('support');
  const config = getDefaultMessageConfig();
  config.templates[0].text = '  {{ player }}\n\n  {{lane}}: {{zoeira}}  \n';
  config.phrases.support = ['{{nick}} fez {{assists}} assistências de {{personagem}}!'];
  const { message } = formatMessage(match, { config });
  assert.equal(message, '  SeuAmigo#BR1\n\n  SUP: SeuAmigo fez 24 assistências de Lulu!  \n');
});

test('API data and phrase substitutions stay literal and cannot become nested expressions', () => {
  const { match } = createPreview('feed');
  const config = getDefaultMessageConfig();
  config.templates[0].text = '{{player}}\n{{personagem}}\n{{zoeira}}';
  config.phrases.feed = ['{{nick}} continua com {{frag}}'];
  const result = formatMessage({ ...match, playerName: '{{gold}}<script>$&#BR1', champion: '{{kills}}' }, { config });
  assert.equal(result.message, '{{gold}}<script>$&#BR1\n{{kills}}\n{{gold}}<script>$& continua com 1/5/9');
});

test('multiple active templates and phrase pools vary deterministically between matches', () => {
  const { match } = createPreview('feed');
  const config = getDefaultMessageConfig();
  config.templates.forEach(template => { template.enabled = true; });
  const templates = new Set(), phrases = new Set();
  for (let index = 0; index < 80; index++) {
    const input = { ...match, id: `BR1_${index}` };
    const first = formatMessage(input, { config });
    assert.deepEqual(formatMessage(input, { config: structuredClone(config) }), first);
    templates.add(first.templateId);
    phrases.add(first.phraseIndex);
  }
  assert.equal(templates.size, 3);
  assert.equal(phrases.size, config.phrases.feed.length);
  config.templates[0].enabled = false;
  assert.notEqual(formatMessage(match, { config }).templateId, config.templates[0].id);
});

test('preview can explicitly select a disabled template and every preset renders every category', () => {
  const config = getDefaultMessageConfig();
  for (const template of config.templates) {
    for (const scenario of ['feed', 'carry', 'support', 'normal']) {
      const result = createPreview(scenario, { config, templateId: template.id, phraseIndex: 0 });
      assert.equal(result.templateId, template.id);
      assert.equal(result.templateName, template.name);
      assert.equal(result.phraseIndex, 0);
      assert.equal(result.category, scenario);
      assert.ok(result.message.includes(result.match.champion));
      assert.equal(result.message.includes('{{'), false);
    }
  }
  assert.throws(() => createPreview('feed', { config, templateId: 'missing' }), MessageConfigError);
  for (const phraseIndex of [-1, 8, 0.5, '0', null]) {
    assert.throws(() => createPreview('feed', { config, phraseIndex }), MessageConfigError);
  }
});

test('unknown variables, malformed braces, expressions and prototype paths are rejected', () => {
  for (const text of [
    '{{unknown}}', '{{lane', 'lane}}', '{{}}', '{{{lane}}}', '{{constructor}}', '{{__proto__}}',
    '{{player.name}}', '{{process.env.RIOT_API_KEY}}', '{{kills + 1}}', '{{(() => 1)()}}',
  ]) {
    const config = getDefaultMessageConfig();
    config.templates[0].text = text;
    assert.throws(() => validateMessageConfig(config), MessageConfigError, text);
  }
  for (const text of ['{{zoeira}}', '{{unknown}}', 'duas\nlinhas', 'duas\rlinhas', '  ']) {
    const config = getDefaultMessageConfig();
    config.phrases.feed = [text];
    assert.throws(() => validateMessageConfig(config), MessageConfigError, text);
  }
});

test('configuration bounds and field types prevent invalid saved message definitions', () => {
  const invalid = [
    config => { config.templates = []; },
    config => { config.templates = Array.from({ length: 11 }, (_, i) => ({ ...config.templates[0], id: `id${i}` })); },
    config => { config.templates[1].id = config.templates[0].id; },
    config => { config.templates[0].id = '../unsafe'; },
    config => { config.templates[0].name = ' '; },
    config => { config.templates[0].name = 'x'.repeat(61); },
    config => { config.templates[0].text = 'x'.repeat(3001); },
    config => { config.templates[0].enabled = 1; },
    config => { config.templates.forEach(template => { template.enabled = false; }); },
    config => { config.templates[0].unexpected = true; },
    config => { config.phrases.feed = []; },
    config => { config.phrases.feed = Array(31).fill('Mais uma frase'); },
    config => { config.phrases.feed = ['x'.repeat(301)]; },
    config => { config.phrases.feed = [42]; },
    config => { config.phrases.other = ['Outro tipo']; },
    config => { delete config.phrases.normal; },
    config => { config.templates[0] = null; },
    config => { config.unexpected = true; },
  ];
  for (const change of invalid) {
    const config = getDefaultMessageConfig();
    change(config);
    assert.throws(() => validateMessageConfig(config), MessageConfigError);
  }
  for (const config of [null, [], 'text', 3, { templates: [], phrases: {} }]) {
    assert.throws(() => validateMessageConfig(config), MessageConfigError);
  }
});

test('rendered length is bounded after phrase expansion and missing stats stay finite', () => {
  const config = getDefaultMessageConfig();
  config.templates[0].text = '{{zoeira}}'.repeat(250);
  config.phrases.feed = ['x'.repeat(300)];
  assert.throws(() => createPreview('feed', { config }), /10\.000/);
  const result = formatMessage({ kills: 7, deaths: 0, assists: 2, durationSeconds: 3661, gold: Infinity });
  assert.equal(result.values.kda, '9,00');
  assert.equal(result.values.duracao, '61:01');
  assert.equal(result.values.gold, '0');
  assert.equal(result.values.data, 'N/A');
  assert.equal(result.values.lane, 'N/A');
  assert.equal(result.values.tag, '');
  assert.equal(result.message.includes('undefined'), false);
});

test('saving rejects oversized expansions in unselected inactive templates and later phrase choices', () => {
  const config = getDefaultMessageConfig();
  config.templates[1].text = '{{zoeira}}'.repeat(250);
  assert.equal(config.templates[1].enabled, false);
  config.phrases.normal = ['Curta', 'x'.repeat(300)];
  assert.throws(() => validateMessageConfig(config), /Placar do grupo.*pode ultrapassar 10\.000/);

  const repeatedField = getDefaultMessageConfig();
  repeatedField.templates[0].text = '{{nick}}'.repeat(220);
  assert.throws(() => validateMessageConfig(repeatedField), /repetição de campos ou frases/);

  const valid = getDefaultMessageConfig();
  valid.templates[0].text = 'x'.repeat(2800) + '\n{{player}}\n{{zoeira}}';
  valid.phrases.normal = ['x'.repeat(300)];
  assert.doesNotThrow(() => validateMessageConfig(valid));
});
