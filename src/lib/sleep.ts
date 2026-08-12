export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Pequeño jitter aleatorio (0-250ms) para no enviar requests en ráfagas perfectamente espaciadas. */
export function withJitter(ms: number): number {
  return ms + Math.floor(Math.random() * 250);
}
