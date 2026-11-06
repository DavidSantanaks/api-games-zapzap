// Helpers compartilhados pelos clientes HTTP de cada jogo (Riot, Steam, Leetify).
export const number = value => Math.max(0, Math.floor(Number(value) || 0));
export const nonempty = value => typeof value === 'string' && value.trim().length > 0;

/** Converte o cabeçalho Retry-After (segundos ou data) em milissegundos, entre 1 s e 24 h. */
export function retryDelay(value) {
  let milliseconds = 60_000;
  if (value && /^\d+(\.\d+)?$/.test(value.trim())) milliseconds = Number(value) * 1000;
  else if (value && Number.isFinite(Date.parse(value))) milliseconds = Date.parse(value) - Date.now();
  return Math.min(86_400_000, Math.max(1000, milliseconds));
}
