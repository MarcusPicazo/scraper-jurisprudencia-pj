# Scraper de Jurisprudencia (Desafío de Scraping)

Scraper en TypeScript, hecho desde cero con **HTTP puro** (sin automatización de
navegador), que descubre la estructura de un portal de resultados judiciales/
administrativos construido sobre **JSF + PrimeFaces (Mojarra)**, recorre todas sus
páginas, extrae los datos de cada documento y descarga los PDFs asociados, con
manejo de errores `429 Too Many Requests` (backoff exponencial + reintentos).

## Sitios soportados

| Sitio | Clave (`--site=`) | Requiere VPN a Perú | Estado |
|---|---|---|---|
| `https://jurisprudencia.pj.gob.pe/jurisprudenciaweb/faces/page/resultado.xhtml` | `pj` | **Sí** | Objetivo real del desafío. Ver nota abajo. |
| `https://publico.oefa.gob.pe/repdig/consulta/consultaTfa.xhtml` | `oefa` | No | Sitio alternativo usado para desarrollo y pruebas. **Probado de punta a punta.** |

### ⚠️ Nota importante sobre `pj`

Sin VPN a Perú, `jurisprudencia.pj.gob.pe` devuelve `403 Forbidden` (bloqueo por
geolocalización/WAF), así que no pude verificar en vivo la estructura exacta de esa
página desde este entorno. El scraper **no asume nada específico de OEFA**: en vez de
hardcodear IDs de formulario, del datatable o de columnas, los *descubre en tiempo de
ejecución* leyendo el HTML (ver [`src/lib/jsfParser.ts`](src/lib/jsfParser.ts)). Esto
es exactamente lo que pide el desafío ("Debes descubrir la estructura del sitio").

Dado que `jurisprudencia.pj.gob.pe` usa la misma convención de URL (`faces/...xhtml`)
típica de portales JSF del Estado peruano, es razonable esperar que el mismo motor
funcione ahí también — pero **debe verificarse con VPN activa** antes de darlo por
bueno. Corriendo `npm run scrape:pj` con VPN activa alcanza para probarlo; si algo no
calza (por ejemplo, si el sitio no usa PrimeFaces sino otro framework), el error de
`discoverForm`/`discoverTable` en consola indicará exactamente qué no se pudo
reconocer.

## Cómo funciona (arquitectura)

Los portales JSF/PrimeFaces con `server-side state saving` (como estos) funcionan así:

1. **GET inicial**: la página trae un token `javax.faces.ViewState` oculto en el
   formulario, atado a la sesión (`JSESSIONID`).
2. **Búsqueda** (click en "Buscar"): un POST AJAX (`javax.faces.partial.ajax=true`)
   con los campos del formulario + el ViewState. La respuesta es un XML
   `partial-response` con fragmentos HTML actualizados (la tabla de resultados) y un
   ViewState nuevo.
3. **Paginación**: otro POST AJAX, esta vez dirigido al propio datatable
   (`source=execute=render=<idDatatable>`) con parámetros `_first`, `_rows`,
   `_pagination=true`, etc. — la convención estándar de paginación de PrimeFaces.
4. **Descarga de PDF**: los links de descarga usan `mojarra.jsfcljs(...)`, que agrega
   un par de campos ocultos al formulario (identificando la fila) y hace un submit
   *clásico* (no AJAX). El servidor responde directamente con el binario del PDF.

`src/lib/jsfSession.ts` reproduce estos 3 tipos de request con `axios`, manteniendo
cookies y el ViewState actualizado entre llamadas. `src/lib/jsfParser.ts` hace todo el
"descubrimiento" con `cheerio`: encuentra el formulario JSF, el botón de búsqueda, el
datatable, sus columnas, y — por cada fila — los parámetros necesarios para descargar
su PDF.

```
src/
  config.ts          URLs de los sitios y parámetros ajustables (delays, reintentos)
  types.ts           Tipos compartidos (DocumentRecord, DownloadResult)
  scraper.ts          Orquestación: recorrer páginas, guardar JSON, descargar PDFs
  index.ts             CLI
  lib/
    httpClient.ts      Cliente axios con manejo manual de cookies (JSESSIONID)
    jsfParser.ts        Descubrimiento de formulario/tabla + parseo de filas y paginación
    jsfSession.ts        Sesión con estado: search(), goToPage(), downloadRow()
    retry.ts             Backoff exponencial ante 429 (respeta Retry-After si viene)
    pdfNaming.ts          Nombre de archivo descriptivo a partir de las columnas
    sanityChecks.ts        Validaciones post-corrida (ver sección "Sanity checks")
    logger.ts             Logging a consola + archivo en data/logs/
```

## Instalación

```bash
npm install
```

## Uso

```bash
# Sitio objetivo real del desafío (requiere VPN a Perú)
npm run scrape:pj

# Sitio alternativo, sin VPN (recomendado para probar que todo funciona)
npm run scrape:oefa

# Reintentar solo los PDFs que quedaron marcados como fallidos
npm run retry-failed -- --site=oefa
```

Flags disponibles (se pueden combinar):

| Flag | Efecto |
|---|---|
| `--site=oefa\|pj` | Sitio a scrapear (default: `pj`) |
| `--max-pages=N` | Corta después de N páginas (para pruebas rápidas) |
| `--max-downloads=N` | Descarga como máximo N PDFs (para pruebas rápidas) |
| `--no-download-pdfs` | Solo extrae los datos a JSON, sin descargar PDFs |
| `--retry-failed` | Reintenta las descargas registradas como fallidas |

Como pide el desafío, **no hace falta descargar todos los PDFs en una sola corrida**:
el JSON de salida se reescribe en disco después de *cada página* (no solo al final),
así que interrumpir el proceso a mitad de camino (Ctrl+C, un corte, etc.) no pierde lo
ya extraído. Lo mismo para las descargas de PDF: se puede interrumpir y reanudar — los
archivos ya descargados se detectan por nombre y se saltan — y `--retry-failed` retoma
los que fallaron.

## Salida

- `data/json/<sitio>-<timestamp>.json` — todos los documentos extraídos, con sus
  columnas tal como aparecen en el sitio.
- `data/pdfs/<sitio>/*.pdf` — un PDF por documento, nombrado con su número de
  expediente/resolución (sanitizado) + un sufijo corto derivado de los parámetros de
  descarga de esa fila (para garantizar nombre único incluso si dos documentos
  distintos comparten el mismo número de expediente, algo que pasa en la práctica
  con apelaciones sobre un mismo caso).
- `data/logs/<sitio>-run.log` — log completo de la corrida.
- `data/logs/failed-<sitio>.json` — documentos cuyo PDF no se pudo descargar tras
  agotar los reintentos (consumido por `--retry-failed`).

## Manejo de errores 429

`src/lib/retry.ts` envuelve cada request de paginación y de descarga: al recibir un
`429`, espera con backoff exponencial (`1s, 2s, 4s, 8s...` + jitter aleatorio,
respetando el header `Retry-After` si el servidor lo manda) hasta 5 reintentos por
defecto. Si se agotan los reintentos:
- en la **paginación**, se registra el error y se sigue con la página siguiente;
- en una **descarga**, el documento se marca como fallido en
  `data/logs/failed-<sitio>.json` para reintentarlo después con `--retry-failed`,
  y el scraper continúa con el siguiente documento.

## Sanity checks

Al final de cada corrida (no en `--retry-failed`), el scraper valida automáticamente
lo que extrajo y lo imprime en consola + lo guarda en
`data/logs/sanity-check-<sitio>.json`:

1. **Conteo extraído vs. total reportado por el sitio**: compara `records.length`
   contra el total que el propio paginador de PrimeFaces informa (`"Página X de Y (Z
   registros)"`). Si la corrida fue acotada con `--max-pages`, el desajuste es
   esperado y se marca como informativo, no como error.
2. **Duplicados por ID**: detecta filas repetidas usando el `param_uuid` de la
   descarga (identificador real y único por documento en el servidor) — **no** el
   "Número de expediente", porque ese campo puede repetirse legítimamente entre
   documentos distintos (apelaciones sobre un mismo expediente).
3. **% de nulos por columna**: para cada columna detectada en el sitio, qué
   porcentaje de filas la tienen vacía. Útil para notar si el parser se está
   comiendo una columna por error.
4. **PDFs reales**: abre cada `.pdf` descargado y confirma que empiece con la firma
   `%PDF-` (y que no sea un archivo sospechosamente chico) — para detectar el caso de
   que el servidor haya devuelto una página de error HTML guardada con extensión
   `.pdf` en vez del documento real.

Los checks están en [`src/lib/sanityChecks.ts`](src/lib/sanityChecks.ts) como
funciones puras e independientes entre sí, con tests manuales cubriendo los casos
borde (corrida parcial, expedientes repetidos legítimos vs. duplicados reales, PDFs
truncados/corruptos).

## Limitaciones conocidas

- El motor asume que el sitio es un JSF/PrimeFaces "clásico" con `p:dataTable`
  paginado y links de descarga vía `mojarra.jsfcljs`. Está **verificado
  end-to-end contra OEFA** (búsqueda, 1753 registros / 176 páginas, paginación,
  descarga y nombrado de PDFs, y el flujo de reintento).
- Contra `jurisprudencia.pj.gob.pe` el mecanismo de descubrimiento debería
  funcionar igual, pero **no se pudo confirmar en este entorno por el bloqueo sin
  VPN** — queda pendiente de una corrida real con `npm run scrape:pj`.
