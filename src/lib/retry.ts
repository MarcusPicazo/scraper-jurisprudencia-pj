import { AxiosError } from "axios";
import { SCRAPER_CONFIG } from "../config";
import { sleep, withJitter } from "./sleep";
import { Logger } from "./logger";

export function isRateLimited(err: unknown): boolean {
  const axiosErr = err as AxiosError;
  return axiosErr?.isAxiosError === true && axiosErr.response?.status === 429;
}

/** Calcula el tiempo de espera de un backoff exponencial, respetando Retry-After si el servidor lo envía. */
function computeBackoffMs(attempt: number, retryAfterHeader?: string): number {
  if (retryAfterHeader) {
    const seconds = Number(retryAfterHeader);
    if (!Number.isNaN(seconds) && seconds > 0) {
      return withJitter(seconds * 1000);
    }
  }
  const exp = SCRAPER_CONFIG.backoffBaseMs * 2 ** attempt;
  return withJitter(Math.min(exp, SCRAPER_CONFIG.backoffMaxMs));
}

/**
 * Ejecuta `fn`, reintentando con backoff exponencial cuando la respuesta es un 429
 * (Too Many Requests). Si se agotan los reintentos, relanza el último error para que
 * el llamador decida cómo manejar el fallo definitivo (p. ej. registrarlo y continuar).
 */
export async function withRetry429<T>(
  fn: () => Promise<T>,
  opts: { label: string; logger: Logger; maxRetries?: number }
): Promise<T> {
  const maxRetries = opts.maxRetries ?? SCRAPER_CONFIG.maxRetries;
  let attempt = 0;

  while (true) {
    try {
      return await fn();
    } catch (err) {
      if (!isRateLimited(err) || attempt >= maxRetries) {
        throw err;
      }
      attempt++;
      const axiosErr = err as AxiosError;
      const retryAfter = axiosErr.response?.headers?.["retry-after"] as
        | string
        | undefined;
      const waitMs = computeBackoffMs(attempt, retryAfter);
      opts.logger.warn(
        `429 Too Many Requests en "${opts.label}" (intento ${attempt}/${maxRetries}). Reintentando en ${waitMs}ms...`
      );
      await sleep(waitMs);
    }
  }
}
