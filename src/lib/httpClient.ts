import axios, { AxiosInstance } from "axios";
import { SCRAPER_CONFIG } from "../config";

/**
 * Cookie jar mínimo: los portales JSF/PrimeFaces atan el ViewState a la sesión de
 * servidor (JSESSIONID), así que cada request debe reenviar las cookies recibidas.
 * Evitamos depender de axios-cookiejar-support (choca de tipos con axios recientes)
 * e implementamos el manejo con un par de interceptores.
 */
class CookieJar {
  private cookies = new Map<string, string>();

  storeFromSetCookieHeader(setCookie: string[] | undefined): void {
    if (!setCookie) return;
    for (const raw of setCookie) {
      const [pair] = raw.split(";");
      const eq = pair.indexOf("=");
      if (eq === -1) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      this.cookies.set(name, value);
    }
  }

  toHeader(): string {
    return Array.from(this.cookies.entries())
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  }
}

export function createHttpClient(): { client: AxiosInstance; jar: CookieJar } {
  const jar = new CookieJar();

  const client = axios.create({
    timeout: SCRAPER_CONFIG.requestTimeoutMs,
    headers: {
      "User-Agent": SCRAPER_CONFIG.userAgent,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "es-PE,es;q=0.9,en;q=0.8",
    },
    // Comportamiento por defecto: axios lanza AxiosError para status fuera de 2xx,
    // lo que permite a withRetry429 detectar 429 mediante try/catch.
  });

  client.interceptors.request.use((config) => {
    const cookieHeader = jar.toHeader();
    if (cookieHeader) {
      config.headers = config.headers ?? {};
      config.headers["Cookie"] = cookieHeader;
    }
    return config;
  });

  client.interceptors.response.use(
    (response) => {
      jar.storeFromSetCookieHeader(response.headers["set-cookie"] as string[] | undefined);
      return response;
    },
    (error) => {
      if (error.response) {
        jar.storeFromSetCookieHeader(
          error.response.headers?.["set-cookie"] as string[] | undefined
        );
      }
      return Promise.reject(error);
    }
  );

  return { client, jar };
}

export type HttpClient = AxiosInstance;
