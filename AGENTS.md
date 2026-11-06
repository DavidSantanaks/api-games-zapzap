# Instruções para trabalhar neste projeto

Leia [IA_MEMORY.md](IA_MEMORY.md), [README.md](README.md) e [MELHORIAS.md](MELHORIAS.md) antes de alterar o projeto.

- Mantenha a aplicação leve: Node.js 24, SQLite nativo, interface sem build e um container Docker.
- Responda e escreva os textos da interface em português brasileiro.
- Preserve banco, sessão do WhatsApp, configurações e textos personalizados. Migrações devem ser aditivas e testadas.
- Mensagens já na fila preservam o texto e o grupo de destino originais.
- Não versione nem registre credenciais, QR Codes, bancos ou dados reais da instalação. Use somente valores fictícios nos testes.
- Execute os testes pertinentes e `npm run check`; valide mudanças funcionais no Docker quando disponível.
- A lista de melhorias contém sugestões pendentes; sua existência não autoriza implementar tudo automaticamente.
- Atualize a memória e a documentação quando uma entrega mudar o comportamento do projeto.
- Use Conventional Commits com escopo quando útil: `feat(messages): ...`, `fix(monitor): ...`, `docs: ...`.
- Separe mudanças coerentes em commits. Faça push quando solicitado e preserve o histórico remoto, sem force push.
