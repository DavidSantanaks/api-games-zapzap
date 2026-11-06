# Memória do projeto — GG Report

Atualizada em **06/11/2026**. Leia este arquivo e o [README](README.md) antes de continuar o desenvolvimento. Registre decisões e entregas novas aqui, sem incluir credenciais ou dados da instalação do usuário.

## Objetivo e preferências

- Acompanhar partidas de jogos competitivos (**League of Legends** e **Counter-Strike 2**) e publicar um resumo com zoeira em um grupo do WhatsApp.
- Manter o projeto leve, simples, com interface e execução em Docker; **sem Java**.
- Stack atual: Node.js 24, Express, SQLite nativo (`node:sqlite`) e HTML/CSS/JavaScript sem build ou CDN, sem novas dependências de runtime.
- Um único container, sem Chromium, Redis, banco separado ou serviço de IA. As frases usam regras locais.
- A interface e as mensagens são em português brasileiro.
- Repositório indicado pelo usuário: https://github.com/DavidSantanaks/api-games-zapzap.

## Entregas concluídas

### Infraestrutura compartilhada e League of Legends

- Duas abas independentes na interface (**League of Legends** e **Counter-Strike 2**), cada uma com seus jogadores, contadores, histórico, prévias e editor de mensagens, compartilhando WhatsApp, grupo selecionado, intervalo, monitor e fila persistente.
- Integração com **League of Legends**: Riot ID → PUUID → histórico e detalhes da Match-v5.
- Cadastro, pausa e remoção de jogadores; região Américas para o servidor brasileiro.
- Monitor periódico configurável: padrão de 120 segundos, mínimo de 30; começa pausado na instalação nova.
- Baseline no cadastro para não enviar o histórico anterior; partidas em andamento podem aparecer depois de encerradas.
- Histórico paginado após períodos offline, consultas sequenciais, ciclos sem sobreposição e tratamento isolado de `Retry-After` por jogo (um `429` na Riot não bloqueia CS2 nem envios pendentes no WhatsApp).
- Estatísticas normalizadas de LoL: resultado, campeão, K/D/A, farm (`farm` soma tropas e monstros neutros), lane, ouro, duração e modo de jogo. Partidas customizadas são ignoradas nesta versão.
- WhatsApp por QR Code, lista de grupos, sessão persistente, reconexão e desconexão pela interface.
- Fila persistente com uma entrada por partida/jogador, tentativas com espera crescente e até cinco tentativas automáticas.
- Repetição manual de envios com falha e ID estável de mensagem para reduzir duplicação nas tentativas.
- Histórico de partidas por jogo, status de envio, detalhes e cópia do texto.
- Docker Compose com volume persistente (`gg-data`), healthcheck e porta publicada apenas em `127.0.0.1:3000`.

### Counter-Strike 2 (Premier e Competitivo)

- Cadastro por **SteamID64** (17 dígitos ou URL `/profiles/<id>`), com apelido opcional, sem exigir jogo aberto, GSI local, FACEIT ou senha Steam.
- Suporte a duas formas de acompanhamento:
  1. **Autorização oficial de partidas da Steam (`STEAM_API_KEY` + `authCode` `AAAA-AAAAA-AAAA` + `knownCode` `CSGO-xxxxx-xxxxx-xxxxx-xxxxx-xxxxx`):** percorre `ICSGOPlayers_730/GetNextMatchSharingCode/v1` até `HTTP 202` / `"n/a"` e permite atualizar os códigos depois via `PATCH /api/players/:id` (modal **Código Steam**).
  2. **Apenas `SteamID64`:** consulta `/v3/profile/matches?steam64_id=...` quando o jogador possui histórico público no Leetify.
- **Decisão técnica sobre `GetNextMatchSharingCode` e demos `.dem`:** a API da Valve devolve apenas códigos base57 `CSGO-...` (`matchId`, `reservationId`, `tvPort`), sem placar, mapa, estatísticas nem link de download da demo `.dem`. Obter a URL do `.dem.bz2` direto na Valve exige login em conta de usuário Steam + conexão ao Game Coordinator (`appid 730`), o que exigiria credenciais de conta Steam e download/parsing pesado. A solução validada combina `GetNextMatchSharingCode` com a API pública do **Leetify** (`https://api-public.cs-prod.leetify.com`, `LEETIFY_API_KEY` opcional), que já processa as demos `.dem` oficiais da Valve (`/v2/matches/matchmaking/{shareCode}`) para **Premier** (`matchmaking`) e **Competitivo** (`matchmaking_competitive`).
- Fontes fora do escopo (`faceit`, Wingman, HLTV etc.) são ignoradas na normalização.
- Estatísticas coletadas no CS2: mapa (`de_mirage` → `Mirage`), placar (`13 x 11`, `12 x 12` etc.), resultado (`VITÓRIA 🟢`, `DERROTA 🔴`, `EMPATE 🟡`), kills, deaths, assists, KDA, ADR (`dpr`), dano total, rounds, MVPs e percentual de headshots. Campos opcionais ausentes retornam `null` e renderizam `N/A`, sem estimar valores inexistentes.
- **Case-sensitivity do código `CSGO-...`:** o alfabeto base57 da Valve diferencia maiúsculas e minúsculas; apenas o prefixo `CSGO-` é normalizado em maiúsculas, e o decodificador puro em `src/cs2.js` valida os 18 bytes antes de consultar a API.
- **Proteção contra bloqueio `503` da Valve e demos pendentes:** respostas `403`/`412` em `GetNextMatchSharingCode` ficam em cache (`invalidShareAuth`) até os códigos mudarem. Quando uma partida recém-detectada na Steam ainda não teve a demo `.dem` indexada (`404`/`5xx` no Leetify), o monitor mantém o cursor e aguarda por até 45 minutos (`pendingGraceMs`) antes de avançar, evitando perder a partida ou travar a fila indefinidamente se a demo expirar na Valve.
- Atribuição exigida pelo provedor incluída na aba e no diálogo de detalhes do CS2 (`Data Provided by Leetify` + link `View on Leetify` quando há `leetifyMatchId`).
- Segredos protegidos: `STEAM_API_KEY`, `LEETIFY_API_KEY`, `authCode` e `knownCode` nunca vão para `/api/state` (que expõe apenas `hasShareAuth`) e estão na lista `redact` do Pino em `src/server.js`.

## Editor de mensagens (motor comum em `src/message.js`)

- Motor reutilizável `createMessageEngine(profile)` compartilhado entre `lolMessages` (`src/message.js`) e `cs2Messages` (`src/cs2-message.js`), mantendo 100% das exportações originais do LoL compatíveis.
- **League of Legends:** **22 variáveis**, três modelos completos e 28 frases iniciais em quatro grupos: zoeira (`feed`), obrigação (`normal`), elogio (`carry`) e elogio ao suporte (`support`).
- **Counter-Strike 2:** **21 variáveis**, três modelos completos e 22 frases iniciais em três grupos: zoeira (`feed`), obrigação (`normal`) e elogio (`carry`).
- Até dez modelos por jogo; é necessário manter ao menos um ativo. A escolha de modelo/frase é determinística por partida.
- Criar, duplicar, renomear, ativar, remover e editar modelos; frases com uma por linha.
- Campos com busca, filtros por grupo, valores de exemplo/da prévia e inserção por clique ou arrastar.
- Editor em três colunas: campos, texto e prévia com aparência de conversa do WhatsApp.
- Rascunhos independentes por aba em `public/messages.js`: alternar entre LoL e CS2 preserva edições não salvas na memória da página.
- Prévia do rascunho com exemplos ou partidas salvas do próprio jogo: **não consulta APIs externas, não grava partidas e não envia mensagens**.
- Texto e frases aceitam substituições simples (`{{mapa}}`, `{{lane}}`); não executam JavaScript nem expressões do n8n. A interpolação ocorre uma única vez e valida tamanho máximo antes de salvar.

Variáveis do LoL:

```text
jogo, modo, resultado, resultado_emoji, player, nick, tag, frag,
kills, deaths, assists, kda, personagem, farm, lane, gold, gold_bruto,
duracao, duracao_segundos, data, partida_id, zoeira
```

Variáveis do CS2:

```text
jogo, modo, resultado, resultado_emoji, player, nick, frag,
kills, deaths, assists, kda, mapa, placar, adr, dano,
rounds, mvps, hs, data, partida_id, zoeira
```

No LoL, `{{modo}}` usa primeiro `queueId`, diferenciando Ranqueada Solo/Duo, Flex, Normal, ARAM e outras filas conhecidas, com fallback para registros antigos. No CS2, `{{modo}}` exibe `Premier` ou `Competitivo`.

### Seleção de frases pelo KDA

- O cálculo único nos dois jogos é `(abates + assistências) / máximo(1, mortes)`, por partida, sem arredondar na comparação de limites:
  - **KDA < 1:** `feed`, zoeira.
  - **1 ≤ KDA < 2,5:** `normal`, obrigação. O padrão começa com “NÃO FEZ MAIS QUE A OBRIGAÇÃO”.
  - **KDA ≥ 2,5:** `carry`, elogio moderado; no LoL, na lane `SUP`, usa `support` com os mesmos limites.
- O valor exibido tem duas casas decimais em pt-BR. Prévias retornam `performance` com KDA numérico, faixa, rótulo e intervalo.

## Regras de preservação importantes

- **Migração aditiva multi-jogo em `src/store.js`:** adiciona `game TEXT NOT NULL DEFAULT 'lol'` em `players` e `matches`, cria o índice `matches_by_game` e a tabela `game_message_config` para jogos novos (`cs2`), mantendo os modelos de LoL intactos na tabela original `message_config`.
- Cada entrada da fila guarda o texto e o grupo de destino no momento em que a partida é detectada.
- Editar mensagens ou trocar o grupo afeta as próximas entradas; não reescrever mensagens já na fila.
- Pausar o monitor impede novas consultas/envios, mas um envio já iniciado pode terminar.
- Pausar um jogador segura seus envios; reativá-lo pode recuperar partidas do período pausado.
- Remover um jogador cancela seus envios pendentes e preserva o histórico.
- As migrações `message-presets-mode-v1` e `message-kda-bands-v1` do LoL rodam uma única vez e preservam textos personalizados, ativações, frases editadas e mensagens na fila.
- Encerrar o processo preserva a sessão do WhatsApp. Desconectar pela interface encerra a sessão e pausa o monitor.
- Baileys é uma integração **não oficial**, atualmente fixada em `7.0.0-rc14`. Não há garantia de entrega exatamente uma vez após falhas de rede/processo.

## Mapa do código

| Arquivo | Responsabilidade |
| --- | --- |
| `src/server.js` | Inicialização, ambiente, redaction de segredos, sessão existente e encerramento |
| `src/app.js` | Rotas HTTP multi-jogo, validação, autenticação opcional e prévias |
| `src/games.js` | Registro dos jogos suportados (`lol` e `cs2`) e campos de prévia |
| `src/http.js` | Utilitários compartilhados (`nonempty`, `number`, `retryDelay`) |
| `src/riot.js` | API Riot, autenticação, limites e normalização (LoL) |
| `src/game-mode.js` | Rótulos de filas/modos do LoL com fallback para registros antigos |
| `src/cs2.js` | Steam Web API (`GetPlayerSummaries`, `GetNextMatchSharingCode`), decodificador base57 `CSGO-...`, Leetify e normalização (CS2) |
| `src/message.js` | Motor comum `createMessageEngine` + variáveis, modelos, frases e classificação do LoL |
| `src/cs2-message.js` | Variáveis, modelos, frases, faixas de KDA, `mapLabel` e prévias do CS2 |
| `src/monitor.js` | Polling multi-jogo (`lol` e `cs2`), espera de demo `.dem` e envio da fila |
| `src/store.js` | SQLite, configurações, migrações aditivas, modelos por jogo, jogadores e fila |
| `src/whatsapp.js` | Baileys, QR, grupos, reconexão e sessão |
| `public/app.js` | Abas de jogo, dashboard, jogadores, modal de código Steam, WhatsApp e histórico |
| `public/messages.js` | Editor por jogo, rascunhos isolados por aba, busca, inserção e prévia |
| `public/index.html`, `public/style.css` | Estrutura e apresentação da interface |
| `test/` | Testes offline de domínio, HTTP, CS2, monitor, sessão e migrações |

## Operação e problema já resolvido

O volume `gg-data` guarda banco, configurações e autenticação do WhatsApp. Não apagar nem substituir os dados para atualizar a aplicação.

**`docker compose restart` não recarrega o `.env`.** Aplicar alterações de chaves (`RIOT_API_KEY`, `STEAM_API_KEY`, `LEETIFY_API_KEY`, `APP_PASSWORD`) com:

```powershell
docker compose up -d --force-recreate
```

Para atualizar código e interface:

```powershell
docker compose up -d --build --wait
```

Credenciais ficam no ambiente (ou protegidas no SQLite no caso de `authCode`/`knownCode`), nunca expostas no frontend. `APP_PASSWORD` oferece HTTP Basic opcional com usuário `admin`.

## Validação conhecida

- Entrega atual (LoL + CS2): **89 testes passando** tanto no Windows quanto dentro do container Linux (`node:24-bookworm-slim`), cobrindo LoL, decodificação base57 `CSGO-...`, `GetNextMatchSharingCode`, espera de demo `.dem`, empates, `N/A` sem inventar dados, isolamento entre abas/rotas, deduplicação após reinício e migração aditiva do SQLite preservando dados anteriores.
- `npm run check` passou; container reconstruído com `gg-data` preservado, healthcheck saudável (`healthy`) e imagem de produção verificada por HTTP em ambiente isolado.
- Interações do editor e alternância entre as abas LoL e CS2 verificadas em DOM simulado (incluindo preservação de rascunhos por aba, modal de código Steam, empate e link do Leetify).
- Testes usam integrações simuladas. Não enviar mensagens reais nem consultar contas reais como parte de testes automáticos.

## Expansão para outros jogos e pendências

**League of Legends** e **Counter-Strike 2 (Premier e Competitivo)** estão implementados. Outros candidatos anteriormente pesquisados (Dota 2/OpenDota, Deadlock, R6, FC) seguem apenas como referência e dependem de pedido explícito do usuário e revalidação de API.

Consulte [MELHORIAS.md](MELHORIAS.md) antes de definir novas prioridades. Os itens pendentes (como M-001 sobre jogadores pausados no limite de 20 entregas e M-002 sobre desconexão durante lote de envio) não devem ser implementados sem solicitação explícita.

## Orientação para próximas alterações

- Preservar a arquitetura leve, as configurações existentes e os rascunhos/textos personalizados de ambos os jogos.
- Nunca registrar ou versionar `.env`, tokens, códigos de autenticação Steam, QR Codes, banco, sessão do WhatsApp ou dados pessoais da instalação.
- Manter `.env`, `data/`, `.qa/` e `node_modules/` fora do Git; `.env.example` deve conter apenas exemplos sem segredos.
- Antes de concluir uma alteração, executar os testes relevantes e `npm run check`; mudanças funcionais devem ser verificadas no Docker.
- Atualizar README e esta memória quando o comportamento ou a operação mudarem.
- Usar commits semânticos, por exemplo `feat(cs2): ...`, `feat(messages): ...`, `fix(monitor): ...` e `docs: ...`.
- Separar commits por mudança coerente, sem inventar uma cronologia que não esteja no histórico Git.
- Verificar branch, remoto e conteúdo a publicar antes do push. Não sobrescrever histórico remoto com force push.
