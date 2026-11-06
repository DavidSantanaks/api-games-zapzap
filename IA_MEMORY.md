# Memória do projeto — GG Report

Atualizada em **06/11/2026**. Leia este arquivo e o [README](README.md) antes de continuar o desenvolvimento. Registre decisões e entregas novas aqui, sem incluir credenciais ou dados da instalação do usuário.

## Objetivo e preferências

- Acompanhar partidas de jogos competitivos e publicar um resumo com zoeira em um grupo do WhatsApp.
- Manter o projeto leve, simples, com interface e execução em Docker; **sem Java**.
- Stack atual: Node.js 24, Express, SQLite nativo (`node:sqlite`) e HTML/CSS/JavaScript sem build ou CDN.
- Um único container, sem Chromium, Redis, banco separado ou serviço de IA. As frases usam regras locais.
- A interface e as mensagens são em português brasileiro.
- Repositório indicado pelo usuário: https://github.com/DavidSantanaks/api-games-zapzap.

## Entregas concluídas

- Integração com **League of Legends**: Riot ID → PUUID → histórico e detalhes da Match-v5.
- Cadastro, pausa e remoção de jogadores; região Américas para o servidor brasileiro.
- Monitor periódico configurável: padrão de 120 segundos, mínimo de 30; começa pausado na instalação nova.
- Baseline no cadastro para não enviar o histórico anterior; partidas em andamento podem aparecer depois de encerradas.
- Histórico paginado após períodos offline, consultas sequenciais, ciclos sem sobreposição e tratamento do `Retry-After` da Riot.
- Estatísticas normalizadas: resultado, campeão, K/D/A, farm, lane, ouro, duração e modo de jogo.
- `farm` soma tropas e monstros neutros. Partidas customizadas são ignoradas nesta versão.
- WhatsApp por QR Code, lista de grupos, sessão persistente, reconexão e desconexão pela interface.
- Fila persistente com uma entrada por partida/jogador, tentativas com espera crescente e até cinco tentativas automáticas.
- Repetição manual de envios com falha e ID estável de mensagem para reduzir duplicação nas tentativas.
- Histórico de partidas, status de envio, detalhes e cópia do texto.
- Interface responsiva com configurações, jogadores, conexão, histórico e editor de mensagens.
- Docker Compose com volume persistente, healthcheck e porta publicada apenas em `127.0.0.1:3000`.

## Editor de mensagens

- **22 variáveis**, três modelos completos e 28 frases iniciais em quatro grupos: zoeira (`feed`), obrigação (`normal`), elogio (`carry`) e elogio ao suporte (`support`).
- Até dez modelos; é necessário manter ao menos um ativo. A escolha de modelo/frase é determinística por partida.
- Criar, duplicar, renomear, ativar, remover e editar modelos; frases com uma por linha.
- Campos com busca, filtros por grupo, valores de exemplo/da prévia e inserção por clique ou arrastar.
- Editor em três colunas: campos, texto e prévia com aparência de conversa do WhatsApp.
- Texto ampliável, saída com Escape, indicadores de campos usados e seção recolhível para as zoeiras.
- Prévia do rascunho com exemplos ou partidas salvas: **não consulta a Riot, não grava partidas e não envia mensagens**.
- Salvamento explícito; buscar os modelos originais apenas carrega um rascunho.
- Texto e frases aceitam substituições simples, como `{{lane}}`; não executam JavaScript nem expressões do n8n.
- Variáveis desconhecidas, campos inválidos e mensagens potencialmente grandes demais são rejeitados antes de salvar.
- A interpolação ocorre uma vez: chaves presentes em dados da API permanecem texto literal.
- `{{zoeira}}` pertence ao modelo completo; as próprias frases podem usar as demais variáveis.

Variáveis disponíveis:

```text
jogo, modo, resultado, resultado_emoji, player, nick, tag, frag,
kills, deaths, assists, kda, personagem, farm, lane, gold, gold_bruto,
duracao, duracao_segundos, data, partida_id, zoeira
```

`{{modo}}` usa primeiro `queueId`, diferenciando Ranqueada Solo/Duo, Flex, Normal, ARAM e outras filas conhecidas. Sem fila conhecida, usa o modo da Riot ou um identificador explícito. Funciona também em registros antigos que tenham `queueId`.

### Seleção de frases pelo KDA

- `{{kda}}` já existia e agora também orienta a seleção da frase. O cálculo único é `(abates + assistências) / máximo(1, mortes)`, por partida.
- **KDA < 1:** `feed`, zoeira.
- **1 ≤ KDA < 2,5:** `normal`, obrigação. O padrão começa com “NÃO FEZ MAIS QUE A OBRIGAÇÃO”.
- **KDA ≥ 2,5:** `carry`, elogio moderado; na lane `SUP`, usa `support`, um subgrupo positivo com os mesmos limites.
- Os intervalos intermediários não especificados inicialmente ficaram na faixa de obrigação; exatamente 2,5 inicia o elogio. Assistências contam em todas as posições.
- O valor exibido tem duas casas decimais em pt-BR. Os limites usam o cálculo sem arredondar, para não alterar a faixa pelo formato do texto.
- `1/5/9` tem KDA 2,00 e recebe obrigação. O exemplo de zoeira foi alterado para `1/8/3`, KDA 0,50.
- Prévias retornam `performance` com KDA numérico, faixa, rótulo e intervalo, sem gravação ou envio.

## Regras de preservação importantes

- Cada entrada da fila guarda o texto e o grupo de destino no momento em que a partida é detectada.
- Editar mensagens ou trocar o grupo afeta as próximas entradas; não reescrever mensagens já na fila.
- Pausar o monitor impede novas consultas/envios, mas um envio já iniciado pode terminar.
- Pausar um jogador segura seus envios; reativá-lo pode recuperar partidas do período pausado.
- Remover um jogador cancela seus envios pendentes e preserva o histórico.
- A migração `message-presets-mode-v1` acrescenta modo somente aos textos originais intactos dos modelos.
- Essa migração roda uma vez e preserva textos personalizados, nomes, ativação e frases; remover modo depois é uma edição válida do usuário.
- A migração única `message-kda-bands-v1` substitui apenas listas que coincidam integralmente com os padrões anteriores; listas personalizadas e mensagens já na fila permanecem preservadas. Se um modelo personalizado estiver próximo do limite de tamanho, a migração mantém uma lista antiga quando substituí-la invalidaria o modelo, preservando a inicialização do aplicativo.
- Encerrar o processo preserva a sessão do WhatsApp. Desconectar pela interface encerra a sessão e pausa o monitor.
- Baileys é uma integração **não oficial**, atualmente fixada em `7.0.0-rc14`. Não há garantia de entrega exatamente uma vez após falhas de rede/processo.

## Mapa do código

| Arquivo | Responsabilidade |
| --- | --- |
| `src/server.js` | Inicialização, ambiente, sessão existente e encerramento |
| `src/app.js` | Rotas HTTP, validação, autenticação opcional e prévias |
| `src/riot.js` | API Riot, autenticação, limites e normalização |
| `src/game-mode.js` | Rótulos de filas/modos com fallback para registros antigos |
| `src/message.js` | Variáveis, validação, modelos, frases e classificação |
| `src/monitor.js` | Polling, cursor, coleta e envio da fila |
| `src/store.js` | SQLite, configurações, migrações, jogadores e fila |
| `src/whatsapp.js` | Baileys, QR, grupos, reconexão e sessão |
| `public/app.js` | Dashboard, jogadores, WhatsApp e histórico |
| `public/messages.js` | Editor, rascunho, busca, inserção e prévia |
| `public/index.html`, `public/style.css` | Estrutura e apresentação da interface |
| `test/` | Testes offline de domínio, HTTP, monitor, sessão e migrações |

## Operação e problema já resolvido

O volume `gg-data` guarda banco, configurações e autenticação do WhatsApp. Não apagar nem substituir os dados para atualizar a aplicação.

Houve um erro de chave Riot mesmo após gerar uma chave nova: o `.env` estava atualizado, mas o container ainda tinha o ambiente antigo. **`docker compose restart` não recarrega o `.env`.** Aplicar alterações de ambiente com:

```powershell
docker compose up -d --force-recreate
```

Para atualizar código e interface:

```powershell
docker compose up -d --build --wait
```

Credenciais ficam no ambiente, nunca no frontend. `APP_PASSWORD` oferece HTTP Basic opcional com usuário `admin`. Para exposição em rede, seguir as instruções de acesso e HTTPS do README.

## Validação conhecida

- Última entrega: **77 testes passando**, tanto no Windows quanto dentro do container Linux, incluindo faixas de KDA, precisão sem arredondar, zero mortes e migração das frases.
- `npm run check` passou; container com healthcheck saudável e rotas/arquivos atualizados verificados por HTTP.
- Interações do editor foram verificadas em DOM simulado: busca, grupos, cursor, arrastar/soltar, foco/Escape, rascunho e salvamento.
- A revisão visual em navegador real ficou indisponível na sessão por falha do serviço de controle do navegador; não afirmar que foi realizada.
- Testes usam integrações simuladas. Não enviar mensagens reais nem consultar contas reais como parte de testes automáticos.

## Expansão para outros jogos

Somente **LoL está implementado**. O usuário ainda não escolheu os próximos jogos. A pesquisa anterior indicou Dota 2/OpenDota, CS2/FACEIT e Deadlock/API comunitária como caminhos possíveis; CS2 Premier exige outra integração. R6 depende de acesso a fornecedor de API e FC 26 não teve opção atual confiável confirmada. Revalidar disponibilidade, modos cobertos e credenciais antes de implementar; pesquisa não equivale a integração entregue.

Consulte [MELHORIAS.md](MELHORIAS.md) antes de definir novas prioridades. O usuário pediu uma lista sugerida; os itens não são implementações já aprovadas. A revisão pré-publicação reproduziu dois problemas de fila ainda pendentes: entradas de jogadores pausados podem ocupar todo o lote de 20, e desconectar durante um lote pode consumir tentativas das mensagens seguintes. Consulte M-001 e M-002 para critérios de aceite.

## Orientação para próximas alterações

- Preservar a arquitetura leve, as configurações existentes e os rascunhos/textos personalizados.
- Nunca registrar ou versionar `.env`, tokens, QR Codes, banco, sessão do WhatsApp ou dados pessoais da instalação.
- Manter `.env`, `data/`, `.qa/` e `node_modules/` fora do Git; `.env.example` deve conter apenas exemplos sem segredos.
- Antes de concluir uma alteração, executar os testes relevantes e `npm run check`; mudanças funcionais devem ser verificadas no Docker.
- Atualizar README e esta memória quando o comportamento ou a operação mudarem.
- Usar commits semânticos, por exemplo `feat(messages): ...`, `fix(riot): ...`, `test(monitor): ...` e `docs: ...`.
- Separar commits por mudança coerente, sem inventar uma cronologia que não esteja no histórico Git.
- Verificar branch, remoto e conteúdo a publicar antes do push. Não sobrescrever histórico remoto com force push.
