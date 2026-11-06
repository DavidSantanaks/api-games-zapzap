(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  let state = null;
  let activeGame = 'lol';
  window.ggActiveGame = activeGame;
  let filter = 'all';
  let intervalDirty = false;
  let groupsLoaded = false;
  let groupsLoading = false;
  let groups = [];
  let lastPlayerRender = '';
  let lastMatchRender = '';
  let refreshing = false;
  let selectedScenario = 'feed';
  let previewRequestId = 0;
  let dialogMatch = null;
  let authDialogPlayer = null;
  const busyButtons = new WeakSet();
  const regions = { americas: 'Américas', europe: 'Europa', asia: 'Ásia', sea: 'Sudeste Asiático / Oceania' };
  const statusLabels = { pending: 'Na fila', sent: 'Enviada', failed: 'Falha no envio' };
  const dates = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function date(value) {
    if (!value) return 'Ainda não verificado';
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? 'Data indisponível' : dates.format(parsed);
  }
  function toast(message, error = false) {
    const node = el('div', `toast${error ? ' error' : ''}`, message);
    $('toast-container').append(node);
    setTimeout(() => node.remove(), error ? 7000 : 4500);
  }
  async function api(path, method = 'GET', body) {
    method = method.toUpperCase();
    if (method !== 'GET' && method !== 'HEAD' && body === undefined) body = {};
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45000);
    try {
      const response = await fetch(path, {
        method,
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
        cache: 'no-store'
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `Não foi possível concluir a ação (${response.status}).`);
      return data;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('A operação demorou mais que o esperado. Confira o estado antes de tentar novamente.');
      if (error instanceof TypeError) throw new Error('Não foi possível conectar ao servidor. Confira se o app está rodando.');
      throw error;
    } finally { clearTimeout(timeout); }
  }
  async function action(button, fn) {
    if (button.disabled || busyButtons.has(button)) return;
    busyButtons.add(button);
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    try { await fn(); }
    catch (error) { toast(error.message, true); }
    finally {
      busyButtons.delete(button);
      button.disabled = false;
      button.removeAttribute('aria-busy');
      syncDisabledStates();
      if (state && button.id === 'monitor-toggle') button.checked = !!state.settings.monitoringEnabled;
    }
  }
  function setSectionControls(container, active) {
    container.hidden = !active;
    for (const control of container.querySelectorAll('input, select, button')) {
      if (!busyButtons.has(control)) control.disabled = !active;
    }
  }
  function syncFormMode() {
    const isCs2 = activeGame === 'cs2';
    setSectionControls($('lol-player-fields'), !isCs2);
    setSectionControls($('cs2-player-fields'), isCs2);
    $('game-name').required = !isCs2;
    $('tag-line').required = !isCs2;
    $('steam-id').required = isCs2;
  }
  function syncDisabledStates() {
    const connect = $('connect-whatsapp');
    const check = $('check-now');
    connect.disabled = busyButtons.has(connect) || state?.whatsapp.state === 'connecting';
    check.disabled = busyButtons.has(check) || !!state?.monitor.running;
    $('refresh-groups').disabled = groupsLoading;
    syncFormMode();
  }
  function scopedStats() {
    if (state?.games?.[activeGame]?.stats) return state.games[activeGame].stats;
    const players = (state?.players || []).filter(player => (player.game || 'lol') === activeGame);
    const matches = (state?.matches || []).filter(match => (match.game || 'lol') === activeGame);
    return {
      players: players.length,
      matches: matches.length,
      sent: matches.filter(match => match.status === 'sent').length,
      pending: matches.filter(match => match.status === 'pending' || match.status === 'failed').length,
    };
  }
  function setActiveGame(game) {
    if (game !== 'lol' && game !== 'cs2') return;
    const changedGame = activeGame !== game;
    activeGame = game;
    window.ggActiveGame = game;
    document.querySelectorAll('[data-game-tab]').forEach(tab => {
      const current = tab.dataset.gameTab === game;
      tab.classList.toggle('active', current);
      tab.setAttribute('aria-pressed', String(current));
    });
    const isCs2 = game === 'cs2';
    $('active-game-eyebrow').textContent = isCs2 ? 'COUNTER-STRIKE 2 · PREMIER E COMPETITIVO' : 'LEAGUE OF LEGENDS';
    $('brand-subtitle').textContent = isCs2 ? 'DO BOMB PRO GRUPO' : 'DO NEXUS PRO GRUPO';
    $('preview-game-tag').textContent = isCs2 ? 'EXEMPLO · CS2' : 'EXEMPLO';
    $('players-footnote-text').textContent = isCs2
      ? 'Ao cadastrar, o histórico anterior vira referência. Só novas partidas Premier e Competitivo geram mensagens (dados via Steam e Leetify).'
      : 'Ao cadastrar, o histórico anterior vira referência. Só novas partidas geram mensagens.';
    const supportTab = $('preview-support-tab');
    if (supportTab) supportTab.hidden = isCs2;
    if (isCs2 && selectedScenario === 'support') selectedScenario = 'carry';
    syncFormMode();
    lastPlayerRender = '';
    lastMatchRender = '';
    if (state) render();
    if (changedGame) {
      loadPreview(selectedScenario);
      document.dispatchEvent(new CustomEvent('game-tab-changed', { detail: { game } }));
    }
  }
  async function refresh() {
    if (refreshing) return;
    refreshing = true;
    try {
      state = await api('/api/state');
      $('connection-alert').hidden = true;
      render();
    } catch { $('connection-alert').hidden = false; }
    finally { refreshing = false; }
  }
  function render() {
    const stats = scopedStats();
    for (const key of ['players', 'matches', 'sent', 'pending']) $('stat-' + key).textContent = stats[key] ?? 0;
    $('riot-notice').hidden = activeGame !== 'lol' || !!state.riotConfigured;
    $('cs2-notice').hidden = activeGame !== 'cs2' || !!state.cs2Configured;
    const active = !!state.settings.monitoringEnabled;
    const monitor = state.monitor || {};
    if (!busyButtons.has($('monitor-toggle'))) $('monitor-toggle').checked = active;
    $('toggle-label').textContent = active ? 'Ativo' : 'Ativar';
    $('monitor-badge').textContent = monitor.running ? 'Verificando' : active ? 'Ativo' : 'Pausado';
    $('monitor-badge').className = 'badge ' + (active ? 'badge-lime' : 'badge-neutral');
    const last = monitor.lastCheckAt ? `Última verificação: ${date(monitor.lastCheckAt)}` : 'Aguardando a primeira verificação';
    $('monitor-detail').textContent = monitor.running ? 'Consultando novas partidas…' : active ? `${last}. Intervalo: ${state.settings.pollIntervalSeconds}s.` : 'Ative para detectar partidas e enviar os resumos ao grupo.';
    $('monitor-error').hidden = !monitor.lastError;
    $('monitor-error').textContent = monitor.lastError || '';
    if (!intervalDirty && document.activeElement !== $('poll-interval')) $('poll-interval').value = state.settings.pollIntervalSeconds;
    renderPlayers();
    renderMatches();
    renderWhatsApp();
    syncDisabledStates();
  }
  function emptyList(title, copy, symbol = '◎', compact = false) {
    const node = el('div', `empty-state${compact ? ' compact' : ''}`);
    const icon = el('span', 'empty-symbol', symbol);
    icon.setAttribute('aria-hidden', 'true');
    node.append(icon);
    if (title) node.append(el('h3', '', title));
    node.append(el('p', '', copy));
    return node;
  }
  function openCs2AuthDialog(player) {
    authDialogPlayer = player;
    $('cs2-auth-dialog-title').textContent = `Código Steam · ${player.gameName}`;
    $('dialog-auth-code').value = '';
    $('dialog-known-code').value = '';
    $('cs2-auth-dialog').showModal();
    $('dialog-auth-code').focus();
  }
  function renderPlayers() {
    const players = (state.players || []).filter(player => (player.game || 'lol') === activeGame);
    const signature = activeGame + ':' + JSON.stringify(players);
    if (signature === lastPlayerRender) return;
    lastPlayerRender = signature;
    const list = $('players-list');
    list.replaceChildren();
    if (!players.length) {
      list.append(emptyList(
        'Quem vai ser o primeiro?',
        activeGame === 'cs2' ? 'Adicione o SteamID64 de um player para começar.' : 'Adicione o Riot ID de um player para começar.',
        '◎',
        true
      ));
      return;
    }
    for (const player of players) {
      const isCs2 = player.game === 'cs2';
      const row = el('div', 'player-row' + (player.enabled ? '' : ' player-paused'));
      row.append(el('div', 'player-avatar', (player.gameName || 'CS').slice(0, 2).toUpperCase()));
      const info = el('div', 'player-info');
      const name = el('span', 'player-name', player.gameName);
      if (!isCs2 && player.tagLine) {
        name.append(el('small', '', '#' + player.tagLine));
        name.title = `${player.gameName}#${player.tagLine}`;
      } else if (isCs2) {
        name.title = `${player.gameName} (${player.steamId})`;
      }
      const subtitle = el('span', 'player-region');
      const dot = el('span', 'player-status-dot');
      dot.setAttribute('aria-hidden', 'true');
      const detail = isCs2
        ? `SteamID ${player.steamId} · ${player.hasShareAuth ? 'Código Steam ativo' : 'Histórico Leetify'}`
        : (regions[player.region] || player.region);
      subtitle.append(dot, document.createTextNode(`${player.enabled ? 'Monitorando' : 'Pausado'} · ${detail}`));
      info.append(name, subtitle);
      if (player.lastError) info.append(el('span', 'player-error', player.lastError));
      info.title = player.lastCheckedAt ? 'Última consulta: ' + date(player.lastCheckedAt) : 'Aguardando consulta';
      row.append(info);
      const actions = el('div', 'player-actions');
      if (isCs2) {
        const authButton = el('button', 'player-action', 'Código');
        authButton.type = 'button';
        authButton.title = 'Configurar ou atualizar código de partida da Steam';
        authButton.setAttribute('aria-label', 'Atualizar código Steam de ' + player.gameName);
        authButton.addEventListener('click', () => openCs2AuthDialog(player));
        actions.append(authButton);
      }
      const toggle = el('button', 'player-action', player.enabled ? 'Pausar' : 'Retomar');
      toggle.type = 'button';
      toggle.setAttribute('aria-label', `${player.enabled ? 'Pausar' : 'Retomar'} ${player.gameName}`);
      toggle.addEventListener('click', () => action(toggle, async () => {
        await api('/api/players/' + encodeURIComponent(player.id), 'PATCH', { enabled: !player.enabled });
        await refresh();
      }));
      const remove = el('button', 'player-action remove', '×');
      remove.type = 'button';
      remove.title = 'Remover player';
      remove.setAttribute('aria-label', 'Remover ' + player.gameName);
      remove.addEventListener('click', () => action(remove, async () => {
        await api('/api/players/' + encodeURIComponent(player.id), 'DELETE');
        toast('Player removido do acompanhamento.');
        await refresh();
      }));
      actions.append(toggle, remove);
      row.append(actions);
      list.append(row);
    }
  }
  function renderMatches() {
    const gameMatches = (state.matches || []).filter(match => (match.game || 'lol') === activeGame);
    const signature = activeGame + ':' + filter + ':' + JSON.stringify(gameMatches);
    if (signature === lastMatchRender) return;
    lastMatchRender = signature;
    $('history-count').textContent = `${gameMatches.length} ${gameMatches.length === 1 ? 'partida' : 'partidas'}`;
    const list = $('matches-list');
    const matches = gameMatches.filter(match => filter === 'all' || match.status === filter);
    list.replaceChildren();
    if (!matches.length) {
      list.append(filter === 'all' ? emptyList('A próxima partida já tem plateia.', 'Cadastre um player e ative o monitor. As novas partidas aparecem aqui.', '▤') : emptyList('Nenhuma partida por aqui.', 'As partidas com esse status aparecerão nesta lista.', '▤'));
      return;
    }
    for (const match of matches) {
      const isCs2 = match.game === 'cs2';
      const outcome = isCs2
        ? (match.result || (match.win === true ? 'win' : match.win === false ? 'loss' : 'draw'))
        : (match.win ? 'win' : 'loss');
      const toneClass = outcome === 'win' ? '' : outcome === 'draw' ? ' draw' : ' loss';
      const resultText = outcome === 'win' ? 'VITÓRIA' : outcome === 'draw' ? 'EMPATE' : 'DERROTA';
      const tileSource = isCs2 ? (match.mapLabel || match.map || 'CS').replace(/^(?:de|cs)_/i, '') : (match.champion || '?');
      const row = el('div', 'match-row');
      row.append(el('span', 'result-stripe' + toneClass), el('div', 'champion-tile', tileSource.slice(0, 2).toUpperCase()));
      const main = el('button', 'match-main match-info-button');
      main.type = 'button';
      main.setAttribute('aria-label', 'Ver mensagem da partida de ' + match.playerName);
      const top = el('div', 'match-topline');
      const name = el('span', 'match-name', match.playerName);
      name.title = match.playerName;
      top.append(name, el('span', 'match-result' + toneClass, resultText));
      let subText;
      if (isCs2) {
        const mapName = match.mapLabel || match.map || 'Mapa';
        const scorePart = match.score ? ` · ${match.score}` : '';
        const adrPart = match.adr !== null && match.adr !== undefined && Number.isFinite(Number(match.adr))
          ? ` · ADR ${Number(match.adr).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}`
          : '';
        subText = `${match.mode || 'Premier'} · ${mapName}${scorePart}${adrPart} · ${date(match.endedAt)}`;
      } else {
        const mode = match.mode ? `${match.mode} · ` : '';
        subText = `${mode}${match.champion} · ${match.lane || '—'} · ${date(match.endedAt)}`;
      }
      const sub = el('div', 'match-subline', subText);
      sub.title = sub.textContent;
      main.append(top, sub);
      main.addEventListener('click', () => openMatch(match));
      row.append(main, el('strong', 'match-kda', `${match.kills}/${match.deaths}/${match.assists}`));
      const right = el('div', 'match-right');
      right.append(el('span', 'badge ' + (match.status === 'sent' ? 'badge-lime' : match.status === 'failed' ? 'badge-error' : 'badge-pending'), statusLabels[match.status] || match.status));
      const detail = el('button', 'text-link', match.status === 'failed' ? 'Tentar de novo ↻' : 'Ver mensagem ↗');
      detail.type = 'button';
      if (match.status === 'failed') {
        detail.title = match.error || 'Recolocar mensagem na fila';
        detail.addEventListener('click', () => action(detail, async () => {
          await api('/api/matches/' + encodeURIComponent(match.id) + '/retry', 'POST');
          toast('Mensagem recolocada na fila.');
          await refresh();
        }));
      } else detail.addEventListener('click', () => openMatch(match));
      right.append(detail);
      row.append(right);
      list.append(row);
    }
  }
  function renderWhatsApp() {
    const wa = state.whatsapp;
    const connected = wa.state === 'connected';
    const qr = wa.state === 'qr' && !!wa.qrDataUrl;
    const labels = { disconnected: 'Desconectado', connecting: 'Conectando', qr: 'Escaneie o QR', connected: 'Conectado', error: 'Erro de conexão' };
    $('whatsapp-badge').textContent = labels[wa.state] || 'Desconectado';
    $('whatsapp-badge').className = 'badge ' + (connected ? 'badge-lime' : wa.state === 'error' ? 'badge-error' : 'badge-neutral');
    $('whatsapp-offline').hidden = connected || qr;
    $('qr-container').hidden = !qr;
    if (qr && $('whatsapp-qr').getAttribute('src') !== wa.qrDataUrl) $('whatsapp-qr').src = wa.qrDataUrl;
    if (!qr) $('whatsapp-qr').removeAttribute('src');
    $('whatsapp-connected').hidden = !connected;
    $('whatsapp-phone').textContent = wa.phone || 'Pronto para escolher um grupo';
    $('whatsapp-error').hidden = !wa.error;
    $('whatsapp-error').textContent = wa.error || '';
    $('group-controls').hidden = !connected;
    $('connect-whatsapp').hidden = connected || qr;
    $('connect-whatsapp').textContent = wa.state === 'connecting' ? 'Aguardando conexão…' : 'Conectar com QR Code ↗';
    $('disconnect-whatsapp').hidden = !(connected || qr || wa.state === 'connecting');
    $('disconnect-whatsapp').textContent = connected ? 'Desconectar conta' : 'Cancelar conexão';
    $('saved-group').textContent = state.settings.whatsappGroupId ? `Destino salvo: ${state.settings.whatsappGroupName || state.settings.whatsappGroupId}` : 'Nenhum grupo salvo. Escolha o destino acima.';
    if (connected && !groupsLoaded && !groupsLoading) loadGroups(false);
    if (!connected) groupsLoaded = false;
  }
  async function loadGroups(notify = true) {
    if (groupsLoading) return;
    groupsLoading = true;
    $('refresh-groups').disabled = true;
    try {
      const response = await api('/api/whatsapp/groups');
      groups = response.groups || [];
      groupsLoaded = true;
      const select = $('whatsapp-group');
      const current = select.value || state.settings.whatsappGroupId;
      const placeholder = el('option', '', groups.length ? 'Selecione um grupo' : 'Nenhum grupo encontrado');
      placeholder.value = '';
      select.replaceChildren(placeholder);
      for (const group of groups) {
        const option = el('option', '', group.name);
        option.value = group.id;
        select.append(option);
      }
      if (groups.some(group => group.id === current)) select.value = current;
      if (notify) toast(groups.length ? 'Lista de grupos atualizada.' : 'Nenhum grupo encontrado nesta conta.');
    } catch (error) {
      groupsLoaded = true;
      toast(error.message, true);
    } finally {
      groupsLoading = false;
      $('refresh-groups').disabled = false;
    }
  }
  async function loadPreview(scenario) {
    if (activeGame === 'cs2' && scenario === 'support') scenario = 'carry';
    selectedScenario = scenario;
    const game = activeGame;
    const reqId = ++previewRequestId;
    document.querySelectorAll('[data-scenario]').forEach(button => {
      const active = button.dataset.scenario === scenario;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    $('preview-message').textContent = 'Gerando exemplo…';
    $('preview-kda-summary').textContent = 'Calculando o KDA do exemplo…';
    try {
      const data = await api('/api/preview', 'POST', { game, scenario });
      if (reqId === previewRequestId && activeGame === game && selectedScenario === scenario) {
        $('preview-message').textContent = data.message;
        const label = data.performance?.label || ({ feed: 'Zoeira', normal: 'Obrigação', carry: 'Elogio moderado', support: 'Elogio ao suporte' })[data.category] || '';
        $('preview-kda-summary').textContent = `KDA ${data.values?.kda || '—'} · ${label}`;
      }
    } catch (error) {
      if (reqId === previewRequestId && activeGame === game && selectedScenario === scenario) {
        $('preview-message').textContent = 'Não foi possível carregar a prévia. Escolha um exemplo para tentar novamente.';
        $('preview-kda-summary').textContent = 'Prévia indisponível';
      }
      toast(error.message, true);
    }
  }
  function openMatch(match) {
    dialogMatch = match;
    $('dialog-title').textContent = match.playerName;
    $('dialog-message').textContent = match.message;
    const scorePart = match.game === 'cs2' && match.score ? ` · ${match.mapLabel || match.map || ''} (${match.score})` : '';
    $('dialog-meta').textContent = `${statusLabels[match.status] || match.status}${match.mode ? ' · ' + match.mode : ''}${scorePart} · ${date(match.endedAt)}${match.error ? ' · ' + match.error : ''}`;
    const leetifyWrap = $('dialog-leetify-wrap');
    if (leetifyWrap) {
      const hasLink = match.game === 'cs2' && Boolean(match.leetifyMatchId);
      leetifyWrap.hidden = !hasLink;
      if (hasLink) $('dialog-leetify-link').href = `https://leetify.com/app/match-details/${encodeURIComponent(match.leetifyMatchId)}/overview`;
    }
    $('message-dialog').showModal();
  }

  document.querySelectorAll('[data-game-tab]').forEach(button => {
    button.addEventListener('click', () => setActiveGame(button.dataset.gameTab));
  });
  $('poll-interval').addEventListener('input', () => { intervalDirty = true; });
  $('interval-form').addEventListener('submit', event => {
    event.preventDefault();
    action($('save-interval'), async () => {
      await api('/api/settings', 'PUT', { pollIntervalSeconds: Number($('poll-interval').value) });
      intervalDirty = false;
      toast('Intervalo atualizado.');
      await refresh();
    });
  });
  $('monitor-toggle').addEventListener('change', event => {
    const enabled = event.target.checked;
    action(event.target, async () => {
      try {
        await api('/api/settings', 'PUT', { monitoringEnabled: enabled });
        toast(enabled ? 'Monitor ativo. Novas partidas poderão ser enviadas ao grupo salvo.' : 'Monitor pausado.');
      } finally { await refresh(); }
    });
  });
  $('check-now').addEventListener('click', () => action($('check-now'), async () => {
    await api('/api/check', 'POST');
    toast('Verificação solicitada. Acompanhe o resultado no painel.');
    await refresh();
  }));
  $('player-form').addEventListener('submit', event => {
    event.preventDefault();
    if (activeGame === 'cs2') {
      action($('add-cs2-player'), async () => {
        await api('/api/players', 'POST', {
          game: 'cs2',
          steamId: $('steam-id').value.trim(),
          gameName: $('cs2-player-name').value.trim(),
          authCode: $('cs2-auth-code').value.trim(),
          knownCode: $('cs2-known-code').value.trim(),
        });
        $('steam-id').value = '';
        $('cs2-player-name').value = '';
        $('cs2-auth-code').value = '';
        $('cs2-known-code').value = '';
        toast('Player de CS2 cadastrado. O histórico anterior será usado como referência.');
        await refresh();
        $('steam-id').focus();
      });
      return;
    }
    action($('add-player'), async () => {
      await api('/api/players', 'POST', {
        game: 'lol',
        gameName: $('game-name').value.trim(),
        tagLine: $('tag-line').value.trim().replace(/^#/, ''),
        region: $('region').value,
      });
      $('game-name').value = '';
      $('tag-line').value = '';
      toast('Player cadastrado. O histórico anterior será usado como referência.');
      await refresh();
      $('game-name').focus();
    });
  });
  $('cs2-auth-form').addEventListener('submit', event => {
    event.preventDefault();
    if (!authDialogPlayer) return;
    action($('save-cs2-auth'), async () => {
      await api('/api/players/' + encodeURIComponent(authDialogPlayer.id), 'PATCH', {
        authCode: $('dialog-auth-code').value.trim(),
        knownCode: $('dialog-known-code').value.trim(),
      });
      $('cs2-auth-dialog').close();
      toast('Código Steam atualizado com sucesso.');
      await refresh();
    });
  });
  $('close-cs2-auth').addEventListener('click', () => $('cs2-auth-dialog').close());
  $('cs2-auth-dialog').addEventListener('click', event => {
    if (event.target === $('cs2-auth-dialog')) {
      const rect = event.target.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) event.target.close();
    }
  });
  $('connect-whatsapp').addEventListener('click', () => action($('connect-whatsapp'), async () => {
    await api('/api/whatsapp/connect', 'POST');
    await refresh();
  }));
  $('disconnect-whatsapp').addEventListener('click', () => action($('disconnect-whatsapp'), async () => {
    await api('/api/whatsapp/disconnect', 'POST');
    groupsLoaded = false;
    toast('Conta desconectada.');
    await refresh();
  }));
  $('refresh-groups').addEventListener('click', () => loadGroups());
  $('group-form').addEventListener('submit', event => {
    event.preventDefault();
    action($('save-group'), async () => {
      const group = groups.find(item => item.id === $('whatsapp-group').value);
      if (!group) throw new Error('Escolha um grupo da lista.');
      await api('/api/settings', 'PUT', { whatsappGroupId: group.id, whatsappGroupName: group.name });
      toast('Grupo de destino salvo.');
      await refresh();
    });
  });
  document.querySelectorAll('[data-filter]').forEach(button => button.addEventListener('click', () => {
    filter = button.dataset.filter;
    document.querySelectorAll('[data-filter]').forEach(tab => {
      tab.classList.toggle('active', tab === button);
      tab.setAttribute('aria-pressed', String(tab === button));
    });
    if (state) renderMatches();
  }));
  document.querySelectorAll('[data-scenario]').forEach(button => button.addEventListener('click', () => loadPreview(button.dataset.scenario)));
  $('close-dialog').addEventListener('click', () => $('message-dialog').close());
  $('message-dialog').addEventListener('click', event => {
    if (event.target === $('message-dialog')) {
      const rect = event.target.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) event.target.close();
    }
  });
  $('copy-message').addEventListener('click', () => action($('copy-message'), async () => {
    if (!dialogMatch) return;
    try { await navigator.clipboard.writeText(dialogMatch.message); }
    catch { throw new Error('Não foi possível copiar automaticamente. Selecione e copie o texto da mensagem.'); }
    toast('Mensagem copiada.');
  }));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  document.addEventListener('message-config-saved', event => {
    if (!event.detail?.game || event.detail.game === activeGame) loadPreview(selectedScenario);
  });
  syncFormMode();
  refresh();
  loadPreview('feed');
  setInterval(() => { if (!document.hidden) refresh(); }, 5000);
})();
