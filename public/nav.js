'use strict';

// Navegação entre as seções da interface (sem recarregar a página).
(() => {
  const VIEWS = ['painel', 'players', 'mensagens', 'resumo-semanal', 'whatsapp'];
  const ALIASES = { setup: 'painel', configuracoes: 'painel' };
  const TITLES = {
    painel: 'Painel',
    players: 'Players',
    mensagens: 'Mensagens',
    'resumo-semanal': 'Resumo semanal',
    whatsapp: 'WhatsApp',
  };
  const views = [...document.querySelectorAll('[data-view]')];
  const links = [...document.querySelectorAll('[data-view-link]')];

  function viewFromHash() {
    const id = decodeURIComponent(location.hash.slice(1));
    if (VIEWS.includes(id)) return id;
    return ALIASES[id] || 'painel';
  }

  function show(id, { scroll = true } = {}) {
    for (const view of views) view.hidden = view.dataset.view !== id;
    for (const link of links) {
      if (link.dataset.viewLink === id) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
    document.body.dataset.view = id;
    document.title = `GG Report · ${TITLES[id]}`;
    if (scroll) window.scrollTo({ top: 0, behavior: 'instant' });
  }

  window.addEventListener('hashchange', () => show(viewFromHash()));
  show(viewFromHash(), { scroll: false });

  // Espelha os status do monitor e do WhatsApp no menu, já que ficam em seções diferentes.
  function mirror(sourceId, targetId) {
    const source = document.getElementById(sourceId);
    const target = document.getElementById(targetId);
    if (!source || !target) return;
    const sync = () => {
      target.textContent = source.textContent.trim();
      target.className = `nav-status-value ${[...source.classList].filter(name => name.startsWith('badge-')).join(' ')}`;
    };
    new MutationObserver(sync).observe(source, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    sync();
  }
  mirror('monitor-badge', 'nav-monitor-status');
  mirror('whatsapp-badge', 'nav-whatsapp-status');
})();
