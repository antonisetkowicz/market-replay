// Dev-server middleware: serves ../data (written by scripts/download-dukascopy.mjs) to the app.
//   GET /local/index.json            -> available series (from <dir>/meta.json, files verified on disk)
//   GET /local/<SYMBOL>/<file>.csv     -> that CSV
//   GET /local/<SYMBOL>/<file>.csv.gz  -> the same CSV, gunzipped on the fly (data on disk stays compressed; browser gets plain text/csv)
import { createReadStream, existsSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { createGunzip } from 'node:zlib'

const SAFE_DIR = /^[A-Za-z0-9_-]+$/
const SAFE_FILE = /^[A-Za-z0-9_.-]+\.csv(\.gz)?$/

export async function buildLocalIndex(dataDir) {
  if (!existsSync(dataDir)) return []
  const out = []
  for (const d of await readdir(dataDir)) {
    if (!SAFE_DIR.test(d)) continue
    let meta
    try { meta = JSON.parse(await readFile(path.join(dataDir, d, 'meta.json'), 'utf8')) } catch { continue }
    const files = []
    for (const f of Array.isArray(meta.files) ? meta.files : []) {
      if (typeof f?.file === 'string' && SAFE_FILE.test(f.file) && existsSync(path.join(dataDir, d, f.file))) files.push(f)
    }
    if (!files.length) continue
    out.push({
      symbol: d, appSymbol: meta.appSymbol, label: meta.label, source: meta.source, resolutionMinutes: meta.resolutionMinutes,
      from: Math.min(...files.map((f) => f.from)), to: Math.max(...files.map((f) => f.to)), count: files.reduce((n, f) => n + f.count, 0), files,
    })
  }
  return out
}

/** "/SYMBOL/file.csv" -> absolute path inside dataDir, or null when the request is not a plain csv / csv.gz under a series dir. */
export function resolveLocalFile(dataDir, urlPath) {
  const parts = decodeURIComponent(urlPath.split('?')[0]).split('/').filter(Boolean)
  if (parts.length !== 2 || !SAFE_DIR.test(parts[0]) || !SAFE_FILE.test(parts[1])) return null
  return path.join(dataDir, parts[0], parts[1])
}

/** Connect-style middleware for /local (exported for tests). Never throws: stream errors destroy the response instead of crashing the dev server. */
export function localHandler(dataDir) {
  return async (req, res, next) => {
    if (req.method !== 'GET') return next()
    try {
      const url = req.url ?? '/'
      res.setHeader('Cache-Control', 'no-cache')
      if (url.split('?')[0] === '/index.json') {
        res.setHeader('Content-Type', 'application/json')
        return res.end(JSON.stringify(await buildLocalIndex(dataDir)))
      }
      const file = resolveLocalFile(dataDir, url)
      const st = file ? await stat(file).catch(() => null) : null
      if (!file || !st?.isFile()) { res.statusCode = 404; return res.end('not found') }
      res.setHeader('Content-Type', 'text/csv; charset=utf-8')
      const src = createReadStream(file).on('error', () => res.destroy())
      res.on('close', () => src.destroy())
      if (file.endsWith('.gz')) src.pipe(createGunzip().on('error', () => res.destroy())).pipe(res)   // chunked: decoded size unknown
      else { res.setHeader('Content-Length', st.size); src.pipe(res) }
    } catch (e) { res.statusCode = 400; res.end(`bad request: ${e.message}`) }
  }
}

export function localDataPlugin(dataDir) {
  return {
    name: 'market-replay-local-data',
    configureServer(server) { server.middlewares.use('/local', localHandler(dataDir)) },
  }
}
