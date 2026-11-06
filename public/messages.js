(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  if (!$('mensagens')) return;
  let currentGame = window.ggActiveGame || 'lol';
  const sessions = new Map();
  const loadingGames = new Set();
  const savingGames = new Set();
  let insertTarget = 'message-template-text';
  let previewTimer;
  let previewController;
  let previewVersion = 0;
  let refreshingMatches = false;
  let variableGroup = 'all';
  let focusMode = false;
  const cursors = new Map();
  const variableExamples = new Map();
  const inertStates = new Map();
  const variableGroups = [
    { key: 'all', label: 'Todos' }, { key: 'partida', label: 'Partida' },
    { key: 'jogador', label: 'Jogador' }, { key: 'desempenho', label: 'Desempenho' },
    { key: 'mensagem', label: 'Mensagem' },
  ];
  const groupFor = key => ['player', 'nick', 'tag', 'personagem', 'lane'].includes(key) ? 'jogador'
    : ['frag', 'kills', 'deaths', 'assists', 'kda', 'farm', 'gold', 'gold_bruto', 'adr', 'dano', 'mvps', 'hs'].includes(key) ? 'desempenho'
    : key === 'zoeira' ? 'mensagem' : 'partida';
  const searchable = text => String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const clone = value => JSON.parse(JSON.stringify(value));
  const session = () => sessions.get(currentGame) || null;
  const selected = () => {
    const active = session();
    return active?.draft?.templates.find(template => template.id === active.selectedId);
  };
  const categoryLabel = key => session()?.categories.find(item => item.key === key)?.label || key;
  const bandLabels = { feed: 'Zoeira', normal: 'Não fez mais que a obrigação', carry: 'Elogio moderado' };
  const bandRanges = { feed: 'KDA < 1', normal: '1 ≤ KDA < 2,5', carry: 'KDA ≥ 2,5' };

  function showPerformance(result) {
    const band = result.performance?.band || (result.category === 'support' ? 'carry' : result.category);
    const kda = result.values?.kda || (Number.isFinite(result.performance?.kda)
      ? result.performance.kda.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—');
    $('message-preview-kda').textContent = kda;
    $('message-preview-band').textContent = result.performance?.label || bandLabels[band] || 'Desempenho da partida';
    $('message-preview-range').textContent = result.performance?.range || bandRanges[band] || '';
    $('message-preview-performance').dataset.band = band;
    for (const item of document.querySelectorAll('[data-kda-band]')) item.classList.toggle('active', item.dataset.kdaBand === band);
  }
  function clearPerformance() {
    $('message-preview-kda').textContent = '—';
    $('message-preview-band').textContent = 'Aguardando uma prévia válida';
    $('message-preview-range').textContent = '';
    delete $('message-preview-performance').dataset.band;
    for (const item of document.querySelectorAll('[data-kda-band]')) item.classList.remove('active');
  }
  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }
  function toast(message, error = false) {
    const item = node('div', 'toast' + (error ? ' error' : ''), message);
    $('toast-container').append(item);
    setTimeout(() => item.remove(), error ? 7000 : 4500);
  }
  async function request(path, { method = 'GET', body, signal } = {}) {
    const response = await fetch(path, {
      method, cache: 'no-store', signal,
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Não foi possível concluir a operação.');
    return data;
  }
  function dirty() {
    const active = session();
    const isSaving = savingGames.has(currentGame);
    const isLoading = loadingGames.has(currentGame);
    const hasChanges = Boolean(active?.draft && JSON.stringify(active.draft) !== active.saved);
    $('message-save-state').textContent = isSaving ? 'Salvando…' : isLoading && !active ? 'Carregando' : hasChanges ? 'Rascunho não salvo' : 'Tudo salvo';
    $('message-save-state').className = 'badge ' + (hasChanges ? 'badge-pending' : active ? 'badge-lime' : 'badge-neutral');
    $('save-messages').disabled = !active?.draft || !hasChanges || isSaving || isLoading;
    $('save-messages').setAttribute('aria-busy', String(isSaving));
  }
  function changed({ resetPhrase = false } = {}) {
    const active = session();
    if (active && resetPhrase) active.phraseIndex = null;
    dirty();
    schedulePreview();
  }
  function rememberCursor(input) {
    cursors.set(input.id, { start: input.selectionStart ?? input.value.length, end: input.selectionEnd ?? input.value.length });
  }
  function updateInsertTarget() {
    const phrases = insertTarget === 'message-phrases-text';
    $('message-variable-target').textContent = phrases ? 'Inserir na frase' : 'Inserir no texto';
    for (const button of $('message-variable-list').querySelectorAll('button')) {
      button.disabled = phrases && button.dataset.variable === 'zoeira';
    }
  }
  function highlight(element, text, query) {
    const position = query ? searchable(text).indexOf(query) : -1;
    if (position < 0) { element.textContent = text; return; }
    const mark = node('mark', '', text.slice(position, position + query.length));
    element.append(document.createTextNode(text.slice(0, position)), mark, document.createTextNode(text.slice(position + query.length)));
  }
  function renderGameChrome() {
    const isCs2 = currentGame === 'cs2';
    const eyebrow = $('studio-eyebrow');
    if (eyebrow) eyebrow.textContent = isCs2 ? '04 / VOCÊ ESCREVE A RESENHA · CS2' : '04 / VOCÊ ESCREVE A RESENHA · LOL';
    const note = $('studio-kda-note');
    if (note) {
      note.textContent = isCs2
        ? 'As assistências entram na fórmula do KDA. As faixas usam o cálculo exato antes de arredondar.'
        : 'As assistências também contam para o suporte. As faixas usam o cálculo sem arredondar.';
    }
    $('message-template-help').innerHTML = isCs2
      ? 'Os campos entre <code>{{chaves}}</code> viram dados reais. Exemplo: <code>Mapa: {{mapa}} ({{placar}})</code>. Use <code>{{zoeira}}</code> para incluir um comentário.'
      : 'Os campos entre <code>{{chaves}}</code> viram dados reais. Exemplo: <code>Modo: {{modo}}</code>. Use <code>{{zoeira}}</code> para incluir um comentário.';
  }
  function renderScenarioSelect() {
    const active = session();
    if (!active) return;
    const select = $('message-preview-scenario');
    select.replaceChildren();
    const list = active.scenarios?.length ? active.scenarios : active.categories.map(item => ({ key: item.key, label: item.label }));
    for (const item of list) {
      const option = node('option', '', item.label);
      option.value = item.key;
      select.append(option);
    }
    if (!list.some(item => item.key === active.scenario)) active.scenario = list[0]?.key || 'feed';
    select.value = active.scenario;
  }
  function renderVariableGroups() {
    const list = $('message-variable-groups');
    list.replaceChildren();
    for (const group of variableGroups) {
      const button = node('button', 'studio-variable-group' + (group.key === variableGroup ? ' active' : ''), group.label);
      button.type = 'button';
      button.dataset.variableGroup = group.key;
      button.setAttribute('aria-pressed', String(group.key === variableGroup));
      button.addEventListener('click', () => {
        variableGroup = group.key;
        for (const tab of list.children) {
          const active = tab.dataset.variableGroup === variableGroup;
          tab.classList.toggle('active', active);
          tab.setAttribute('aria-pressed', String(active));
        }
        renderVariables();
      });
      list.append(button);
    }
  }
  function renderVariables() {
    const active = session();
    const variables = active?.variables || [];
    const list = $('message-variable-list');
    list.replaceChildren();
    variableExamples.clear();
    const query = searchable($('message-variable-search').value.trim());
    const filtered = variables.filter(variable => (variableGroup === 'all' || groupFor(variable.key) === variableGroup)
      && (!query || searchable(`${variable.label} ${variable.key} ${variable.description}`).includes(query)));
    for (const variable of filtered) {
      const button = node('button', 'studio-variable-chip');
      button.type = 'button';
      button.dataset.variable = variable.key;
      button.draggable = true;
      button.title = `${variable.label}: ${variable.description}`;
      button.setAttribute('aria-label', `Inserir ${variable.label}, variável ${variable.key}`);
      const label = node('span', 'studio-variable-label');
      const key = node('code');
      highlight(label, variable.label, query);
      highlight(key, `{{${variable.key}}}`, query);
      const value = String(active?.currentValues.get(variable.key) ?? variable.example ?? '');
      const example = node('small', 'studio-variable-example', value);
      example.title = value;
      variableExamples.set(variable.key, example);
      button.append(label, key, example);
      button.addEventListener('click', () => insertVariable(variable.key));
      button.addEventListener('dragstart', event => {
        if (button.disabled || !event.dataTransfer) { event.preventDefault(); return; }
        event.dataTransfer.setData('application/x-gg-variable', variable.key);
        event.dataTransfer.setData('text/plain', `{{${variable.key}}}`);
        event.dataTransfer.effectAllowed = 'copy';
      });
      list.append(button);
    }
    $('message-variable-count').textContent = `${filtered.length}/${variables.length}`;
    $('message-variable-empty').hidden = filtered.length !== 0;
    updateInsertTarget();
  }
  function renderUsedVariables() {
    const active = session();
    const variables = active?.variables || [];
    const list = $('message-used-variables');
    list.replaceChildren();
    const keys = [...new Set([...String(selected()?.text || '').matchAll(/\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g)].map(match => match[1]))];
    list.append(node('span', '', keys.length ? 'Campos no texto' : 'Insira campos para personalizar a mensagem'));
    for (const key of keys) {
      const valid = variables.some(variable => variable.key === key);
      const token = node('button', 'studio-used-token' + (valid ? '' : ' unknown'), `{{${key}}}`);
      token.type = 'button';
      token.disabled = !valid;
      token.title = valid ? `Inserir ${key} novamente` : 'Campo não reconhecido';
      token.addEventListener('click', () => {
        insertTarget = 'message-template-text';
        updateInsertTarget();
        insertVariable(key);
      });
      list.append(token);
    }
  }
  function renderCategories() {
    const active = session();
    if (!active) return;
    const tabs = $('message-category-tabs');
    tabs.replaceChildren();
    for (const category of active.categories) {
      const button = node('button', 'preview-tab' + (category.key === active.phraseCategory ? ' active' : ''), category.label);
      button.type = 'button';
      button.dataset.category = category.key;
      button.setAttribute('aria-pressed', String(category.key === active.phraseCategory));
      button.addEventListener('click', () => {
        active.phraseCategory = category.key;
        for (const tab of tabs.children) {
          const isCurrent = tab.dataset.category === active.phraseCategory;
          tab.classList.toggle('active', isCurrent);
          tab.setAttribute('aria-pressed', String(isCurrent));
        }
        renderPhrases();
        if (!active.sourceMatchId) {
          active.scenario = category.key;
          $('message-preview-scenario').value = category.key;
          changed({ resetPhrase: true });
        }
      });
      tabs.append(button);
    }
  }
  function renderTemplateOptions() {
    const active = session();
    if (!active) return;
    const select = $('message-template-select');
    select.replaceChildren();
    for (const template of active.draft.templates) {
      const option = node('option', '', `${template.enabled ? '● ' : '○ '}${template.name || 'Sem nome'}`);
      option.value = template.id;
      select.append(option);
    }
    select.value = active.selectedId;
    const count = active.draft.templates.filter(template => template.enabled).length;
    $('message-template-count').textContent = `${count} ${count === 1 ? 'ativa' : 'ativas'} / ${active.draft.templates.length}`;
    $('add-message-template').disabled = active.draft.templates.length >= 10;
    $('duplicate-message-template').disabled = active.draft.templates.length >= 10;
    $('remove-message-template').disabled = active.draft.templates.length <= 1;
  }
  function renderTemplate() {
    const template = selected();
    if (!template) return;
    $('message-template-name').value = template.name;
    $('message-template-enabled').checked = template.enabled;
    $('message-template-text').value = template.text;
    $('message-text-count').textContent = `${template.text.length.toLocaleString('pt-BR')} / 3.000`;
    cursors.set('message-template-text', { start: template.text.length, end: template.text.length });
    renderTemplateOptions();
    renderUsedVariables();
  }
  function renderPhrases() {
    const active = session();
    if (!active) return;
    const phrases = active.draft.phrases[active.phraseCategory] || [];
    const category = active.categories.find(item => item.key === active.phraseCategory);
    const band = category?.band || (active.phraseCategory === 'support' ? 'carry' : active.phraseCategory);
    $('message-category-range').textContent = `${category?.range || bandRanges[band] || ''}${active.phraseCategory === 'support' ? ' · Frases positivas próprias para quem jogou de suporte.' : ' · Frases usadas automaticamente nesta faixa.'}`;
    $('message-phrases-text').value = phrases.join('\n');
    $('message-phrase-count').textContent = `${phrases.length} ${phrases.length === 1 ? 'frase' : 'frases'}`;
    cursors.set('message-phrases-text', { start: $('message-phrases-text').value.length, end: $('message-phrases-text').value.length });
  }
  function renderActiveSession() {
    const active = session();
    renderGameChrome();
    if (!active) return;
    $('message-load-error').hidden = true;
    $('message-editor-fields').disabled = false;
    renderScenarioSelect();
    renderTemplate();
    renderCategories();
    renderPhrases();
    renderVariableGroups();
    renderVariables();
    dirty();
    schedulePreview();
    loadMatches();
  }
  function updateTextFromInput(input) {
    const active = session();
    if (!active) return;
    if (input.id === 'message-template-text') {
      selected().text = input.value;
      $('message-text-count').textContent = `${input.value.length.toLocaleString('pt-BR')} / 3.000`;
      renderUsedVariables();
    } else {
      active.draft.phrases[active.phraseCategory] = input.value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
      const count = active.draft.phrases[active.phraseCategory].length;
      $('message-phrase-count').textContent = `${count} ${count === 1 ? 'frase' : 'frases'}`;
      active.phraseIndex = null;
    }
    rememberCursor(input);
    changed();
  }
  function insertVariable(key) {
    const active = session();
    if (!active?.draft) return;
    if (insertTarget === 'message-phrases-text' && key === 'zoeira') return;
    const input = $(insertTarget);
    const position = cursors.get(input.id) || { start: input.value.length, end: input.value.length };
    const start = Math.min(position.start, input.value.length);
    const end = Math.min(position.end, input.value.length);
    const text = `{{${key}}}`;
    const max = input.maxLength > 0 ? input.maxLength : Infinity;
    if (input.value.length - (end - start) + text.length > max) return toast('O texto chegou ao limite de caracteres.', true);
    input.setRangeText(text, start, end, 'end');
    input.focus();
    updateTextFromInput(input);
  }
  function schedulePreview() {
    clearTimeout(previewTimer);
    previewController?.abort();
    previewVersion++;
    $('next-message-phrase').disabled = true;
    if (!session()?.draft) return;
    $('message-studio-preview').setAttribute('aria-busy', 'true');
    previewTimer = setTimeout(() => preview(), 350);
  }
  async function preview() {
    const active = session();
    if (!active?.draft) return;
    const targetGame = currentGame;
    const version = ++previewVersion;
    previewController?.abort();
    previewController = new AbortController();
    $('next-message-phrase').disabled = true;
    const body = { game: targetGame, config: clone(active.draft), scenario: active.scenario, templateId: active.selectedId };
    if (active.sourceMatchId) body.matchId = active.sourceMatchId;
    if (active.phraseIndex !== null) body.phraseIndex = active.phraseIndex;
    $('message-studio-preview').setAttribute('aria-busy', 'true');
    try {
      const result = await request(`/api/message-preview?game=${encodeURIComponent(targetGame)}`, {
        method: 'POST', body, signal: previewController.signal,
      });
      if (version !== previewVersion || currentGame !== targetGame) return;
      $('message-studio-preview').textContent = result.message;
      $('message-preview-error').hidden = true;
      active.previewCategory = result.category;
      showPerformance(result);
      active.lastPhraseIndex = result.phraseIndex ?? 0;
      $('message-preview-category').textContent = categoryLabel(result.category);
      $('message-preview-mode').textContent = result.values?.modo || result.match?.mode || 'Modo não disponível';
      const count = active.draft.phrases[result.category]?.length || 0;
      $('next-message-phrase').disabled = count < 2;
      $('message-preview-meta').textContent = `${result.templateName || selected().name} · frase ${active.lastPhraseIndex + 1} de ${count} · ${body.matchId ? 'dados de uma partida salva' : 'dados fictícios de exemplo'}. Prévia sem envio.`;
      for (const variable of active.variables) {
        const value = String(result.values?.[variable.key] ?? variable.example ?? '');
        active.currentValues.set(variable.key, value);
        const example = variableExamples.get(variable.key);
        if (example) { example.textContent = value; example.title = value; }
      }
    } catch (error) {
      if (error.name === 'AbortError' || version !== previewVersion || currentGame !== targetGame) return;
      $('message-preview-error').textContent = error.message || 'Não foi possível gerar a prévia. Tente novamente.';
      clearPerformance();
      $('next-message-phrase').disabled = true;
      $('message-preview-error').hidden = false;
      $('message-studio-preview').textContent = 'Ajuste o rascunho para ver a mensagem preenchida.';
      $('message-preview-meta').textContent = 'Nada foi salvo ou enviado. Corrija o texto ou selecione outra partida.';
    } finally {
      if (version === previewVersion) $('message-studio-preview').removeAttribute('aria-busy');
    }
  }
  async function loadMatches(notify = false) {
    if (refreshingMatches) return;
    const targetGame = currentGame;
    refreshingMatches = true;
    $('refresh-message-matches').disabled = true;
    try {
      const state = await request('/api/state');
      if (currentGame !== targetGame) return;
      const active = session();
      const select = $('message-preview-source');
      const previous = active?.sourceMatchId || '';
      const placeholder = node('option', '', 'Partida de exemplo');
      placeholder.value = '';
      select.replaceChildren(placeholder);
      const matches = (state.matches || []).filter(match => (match.game || 'lol') === targetGame);
      for (const match of matches) {
        const mode = match.mode ? ` · ${match.mode}` : '';
        const subject = targetGame === 'cs2'
          ? `${match.mapLabel || match.map || 'Mapa'}${match.score ? ' (' + match.score + ')' : ''}`
          : match.champion;
        const option = node('option', '', `${match.playerName}${mode} · ${subject} · ${match.kills}/${match.deaths}/${match.assists}`);
        option.value = match.id;
        select.append(option);
      }
      if ([...select.options].some(option => option.value === previous)) select.value = previous;
      else select.value = '';
      if (active) active.sourceMatchId = select.value;
      $('message-preview-scenario').disabled = Boolean(select.value);
      if (notify) toast(matches.length ? 'Partidas disponíveis atualizadas.' : 'Ainda não há partidas salvas nesta aba. Use os exemplos.');
      if (previous && !select.value) changed({ resetPhrase: true });
    } catch (error) {
      if (notify) toast(error.message, true);
    } finally {
      refreshingMatches = false;
      $('refresh-message-matches').disabled = false;
    }
  }
  async function load(targetGame = currentGame) {
    if (loadingGames.has(targetGame)) return;
    loadingGames.add(targetGame);
    if (currentGame === targetGame) {
      renderGameChrome();
      $('message-load-error').hidden = true;
      $('message-save-state').textContent = 'Carregando';
      $('message-editor-fields').disabled = true;
    }
    try {
      const data = await request(`/api/message-config?game=${encodeURIComponent(targetGame)}`);
      const draft = clone(data.config);
      sessions.set(targetGame, {
        draft,
        saved: JSON.stringify(draft),
        variables: data.variables || [],
        categories: data.categories || [],
        scenarios: data.scenarios || [],
        selectedId: draft.templates[0].id,
        phraseCategory: data.categories?.[0]?.key || 'feed',
        scenario: data.scenarios?.[0]?.key || data.categories?.[0]?.key || 'feed',
        sourceMatchId: '',
        phraseIndex: null,
        previewCategory: 'feed',
        lastPhraseIndex: 0,
        currentValues: new Map(),
      });
      if (currentGame === targetGame) renderActiveSession();
    } catch (error) {
      if (currentGame === targetGame) {
        $('message-load-error').firstElementChild.textContent = error.message || 'Não foi possível carregar suas mensagens.';
        $('message-load-error').hidden = false;
        $('message-save-state').textContent = 'Não carregou';
      }
    } finally {
      loadingGames.delete(targetGame);
      if (currentGame === targetGame && session()) dirty();
    }
  }
  function switchGame(nextGame) {
    if (nextGame !== 'lol' && nextGame !== 'cs2') return;
    currentGame = nextGame;
    clearTimeout(previewTimer);
    previewController?.abort();
    previewVersion++;
    if (sessions.has(nextGame)) renderActiveSession();
    else load(nextGame);
  }
  function newId() { return 'modelo-' + (globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`); }
  function starterTemplateText() {
    return currentGame === 'cs2'
      ? '🎮 {{jogo}} · {{modo}}\n{{resultado_emoji}} {{resultado}} em {{mapa}} ({{placar}})\n{{player}} terminou {{frag}} · ADR {{adr}} · KDA {{kda}}\n\n{{zoeira}}'
      : '🎮 {{jogo}} · {{modo}}\n{{resultado_emoji}} {{resultado}}\n{{player}} terminou {{frag}} de {{personagem}}.\nLane: {{lane}} | Farm: {{farm}} CS | Gold: {{gold}}\n\n{{zoeira}}';
  }

  $('message-template-select').addEventListener('change', event => {
    const active = session();
    if (!active) return;
    active.selectedId = event.target.value;
    renderTemplate();
    active.phraseIndex = null;
    schedulePreview();
  });
  $('message-template-name').addEventListener('input', event => {
    if (!selected()) return;
    selected().name = event.target.value;
    renderTemplateOptions();
    changed();
  });
  $('message-template-enabled').addEventListener('change', event => {
    const active = session();
    if (!active) return;
    if (!event.target.checked && active.draft.templates.filter(template => template.enabled).length === 1) {
      event.target.checked = true;
      return toast('Mantenha pelo menos uma variação ativa para os envios.', true);
    }
    selected().enabled = event.target.checked;
    renderTemplateOptions();
    changed();
  });
  for (const id of ['message-template-text', 'message-phrases-text']) {
    const input = $(id);
    input.addEventListener('focus', () => { insertTarget = id; updateInsertTarget(); });
    for (const event of ['click', 'keyup', 'select', 'blur']) input.addEventListener(event, () => rememberCursor(input));
    input.addEventListener('input', () => updateTextFromInput(input));
    input.addEventListener('dragover', event => {
      if (!session()?.draft || !event.dataTransfer) return;
      if ([...event.dataTransfer.types].some(type => ['application/x-gg-variable', 'text/plain'].includes(type))) {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
        input.classList.add('studio-drag-over');
      }
    });
    input.addEventListener('dragleave', () => input.classList.remove('studio-drag-over'));
    input.addEventListener('drop', event => {
      input.classList.remove('studio-drag-over');
      const active = session();
      if (!active?.draft || !event.dataTransfer) return;
      const key = event.dataTransfer.getData('application/x-gg-variable')
        || event.dataTransfer.getData('text/plain').match(/^\{\{([a-z][a-z0-9_]*)\}\}$/)?.[1];
      if (!active.variables.some(variable => variable.key === key)) return;
      event.preventDefault();
      insertTarget = id;
      updateInsertTarget();
      insertVariable(key);
    });
  }
  $('add-message-template').addEventListener('click', () => {
    const active = session();
    if (!active || active.draft.templates.length >= 10) return;
    const template = { id: newId(), name: `Variação ${active.draft.templates.length + 1}`, enabled: false, text: starterTemplateText() };
    active.draft.templates.push(template);
    active.selectedId = template.id;
    renderTemplate();
    changed({ resetPhrase: true });
    $('message-template-name').focus();
    $('message-template-name').select();
  });
  $('duplicate-message-template').addEventListener('click', () => {
    const active = session();
    if (!active || active.draft.templates.length >= 10) return;
    const copy = { ...selected(), id: newId(), name: (selected().name.slice(0, 52) + ' (cópia)').slice(0, 60), enabled: false };
    active.draft.templates.push(copy);
    active.selectedId = copy.id;
    renderTemplate();
    changed({ resetPhrase: true });
  });
  $('remove-message-template').addEventListener('click', () => {
    const active = session();
    if (!active || active.draft.templates.length <= 1) return;
    if (selected().enabled && active.draft.templates.filter(template => template.enabled).length === 1)
      return toast('Ative outra variação antes de remover esta.', true);
    active.draft.templates = active.draft.templates.filter(template => template.id !== active.selectedId);
    active.selectedId = active.draft.templates[0].id;
    renderTemplate();
    changed({ resetPhrase: true });
  });
  $('message-preview-scenario').addEventListener('change', event => {
    const active = session();
    if (active) active.scenario = event.target.value;
    changed({ resetPhrase: true });
  });
  $('message-preview-source').addEventListener('change', event => {
    const active = session();
    if (active) active.sourceMatchId = event.target.value;
    $('message-preview-scenario').disabled = Boolean(event.target.value);
    changed({ resetPhrase: true });
  });
  $('refresh-message-matches').addEventListener('click', () => loadMatches(true));
  $('next-message-phrase').addEventListener('click', () => {
    const active = session();
    if (!active || $('next-message-phrase').disabled) return;
    const count = active.draft.phrases[active.previewCategory]?.length || 1;
    active.phraseIndex = (active.lastPhraseIndex + 1) % count;
    schedulePreview();
  });
  $('save-messages').addEventListener('click', async () => {
    const targetGame = currentGame;
    const targetSession = sessions.get(targetGame);
    if (!targetSession?.draft || savingGames.has(targetGame)) return;
    const snapshot = clone(targetSession.draft);
    const serialized = JSON.stringify(snapshot);
    savingGames.add(targetGame);
    if (currentGame === targetGame) dirty();
    try {
      const result = await request(`/api/message-config?game=${encodeURIComponent(targetGame)}`, {
        method: 'PUT', body: { game: targetGame, config: snapshot },
      });
      targetSession.saved = JSON.stringify(result.config);
      if (JSON.stringify(targetSession.draft) === serialized) {
        targetSession.draft = clone(result.config);
        if (currentGame === targetGame) {
          renderTemplate();
          renderPhrases();
        }
      }
      toast('Mensagens salvas. As próximas partidas usarão suas variações.');
      document.dispatchEvent(new CustomEvent('message-config-saved', { detail: { game: targetGame } }));
      if (currentGame === targetGame) schedulePreview();
    } catch (error) { toast(error.message, true); }
    finally {
      savingGames.delete(targetGame);
      if (currentGame === targetGame) dirty();
    }
  });
  $('restore-message-defaults').addEventListener('click', async event => {
    const button = event.currentTarget;
    const targetGame = currentGame;
    if (button.disabled) return;
    button.disabled = true;
    try {
      const data = await request(`/api/message-config/defaults?game=${encodeURIComponent(targetGame)}`);
      const targetSession = sessions.get(targetGame);
      if (!targetSession) return;
      targetSession.draft = clone(data.config);
      targetSession.selectedId = targetSession.draft.templates[0].id;
      targetSession.phraseIndex = null;
      if (currentGame === targetGame) {
        renderTemplate();
        renderPhrases();
        changed();
      }
      toast('Modelos originais carregados no rascunho. Clique em Salvar para aplicar.');
    } catch (error) { toast(error.message, true); }
    finally { button.disabled = false; }
  });
  $('retry-message-load').addEventListener('click', () => load(currentGame));
  $('message-variable-search').addEventListener('input', renderVariables);
  function setFocusMode(enabled) {
    focusMode = enabled;
    $('mensagens').classList.toggle('studio-focus', enabled);
    document.body.classList.toggle('message-studio-open', enabled);
    $('expand-message-editor').setAttribute('aria-pressed', String(enabled));
    $('expand-message-editor').title = enabled ? 'Sair do modo ampliado (Esc)' : 'Ampliar o editor';
    $('expand-message-label').textContent = enabled ? 'Fechar' : 'Ampliar';
    if (enabled) {
      const shell = document.querySelector('.app-shell');
      for (const child of shell.children) {
        const siblings = child.tagName === 'MAIN' ? [...child.children].filter(element => element !== $('mensagens')) : [child];
        for (const sibling of siblings) { inertStates.set(sibling, Boolean(sibling.inert)); sibling.inert = true; }
      }
    } else {
      for (const [element, previous] of inertStates) element.inert = previous;
      inertStates.clear();
    }
    $('expand-message-editor').focus({ preventScroll: true });
  }
  $('expand-message-editor').addEventListener('click', () => setFocusMode(!focusMode));
  document.addEventListener('keydown', event => {
    if (focusMode && event.key === 'Escape') { event.preventDefault(); setFocusMode(false); }
  });
  document.addEventListener('game-tab-changed', event => {
    if (event.detail?.game) switchGame(event.detail.game);
  });
  load(currentGame);
})();
