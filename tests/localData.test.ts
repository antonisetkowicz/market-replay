import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { gzipSync } from 'node:zlib'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { describe, expect, it } from 'vitest'
// @ts-expect-error plain .mjs (dev-server helper, not part of the app bundle)
import { buildLocalIndex, resolveLocalFile, localHandler } from '../scripts/localData.mjs'
import { filesToLoad, parseLocalIndex, fetchLocalIndex } from '../src/data/localData'
import { datasetsFor, yahooDatasets } from '../src/data/datasets'
import { INSTRUMENTS } from '../src/instruments'

const entry = { symbol: 'USATECHIDXUSD', appSymbol: 'NQ', label: 'NQ CFD', source: 's', resolutionMinutes: 1, from: 1000, to: 5000, count: 3,
  files: [{ file: 'a_2025.csv', from: 1000, to: 3000, count: 2 }, { file: 'a_2026.csv', from: 4000, to: 5000, count: 1 }] }

describe('parseLocalIndex (external input)', () => {
  it('accepts a valid entry', () => expect(parseLocalIndex([entry])).toHaveLength(1))
  it('drops malformed entries and unsafe file names', () => {
    const bad = [{ ...entry, symbol: '../x' }, { ...entry, resolutionMinutes: 0 }, { ...entry, files: [{ file: '../../etc/passwd', from: 1, to: 2, count: 1 }] }, null, 5]
    expect(parseLocalIndex(bad as unknown[])).toEqual([])
    const mixed = parseLocalIndex([{ ...entry, files: [...entry.files, { file: 'x/../y.csv', from: 1, to: 2, count: 1 }] }])
    expect(mixed[0]!.files).toHaveLength(2)
    expect(parseLocalIndex([{ ...entry, files: [{ file: 'EURUSD_1m_2025.csv.gz', from: 1, to: 2, count: 1 }] }])).toHaveLength(1)
  })
  it('rejects non-array', () => expect(() => parseLocalIndex({})).toThrow())
  it('fetchLocalIndex returns [] on 404 / network error / html', async () => {
    expect(await fetchLocalIndex((async () => new Response('x', { status: 404 })) as typeof fetch)).toEqual([])
    expect(await fetchLocalIndex((async () => { throw new Error('down') }) as typeof fetch)).toEqual([])
    expect(await fetchLocalIndex((async () => new Response('<html>', { headers: { 'content-type': 'text/html' } })) as typeof fetch)).toEqual([])
    expect(await fetchLocalIndex((async () => new Response(JSON.stringify([entry]), { headers: { 'content-type': 'application/json' } })) as typeof fetch)).toHaveLength(1)
  })
})

describe('filesToLoad', () => {
  const s = parseLocalIndex([entry])[0]!
  it('loads everything with no archive', () => expect(filesToLoad(s, null)).toHaveLength(2))
  it('skips files already covered', () => {
    expect(filesToLoad(s, { from: 1000, to: 5000 })).toEqual([])
    expect(filesToLoad(s, { from: 1000, to: 3000 }).map((f) => f.file)).toEqual(['a_2026.csv'])
    expect(filesToLoad(s, { from: 4000, to: 5000 }).map((f) => f.file)).toEqual(['a_2025.csv'])
  })
})

describe('datasets keep sources separate', () => {
  it('lists Yahoo futures, CFD and imports as distinct, labelled sets', () => {
    const nq = INSTRUMENTS[0]!
    const ds = datasetsFor(nq, parseLocalIndex([entry]), [{ symbol: 'NQ.import', intervalMinutes: 3, count: 1, from: 0, to: 1 }, { symbol: 'ES.import', intervalMinutes: 1, count: 1, from: 0, to: 1 }])
    expect(ds.map((d) => d.kind)).toEqual(['yahoo', 'yahoo', 'local', 'imported'])
    expect(new Set(ds.map((d) => d.storeSymbol)).size).toBe(3)
    expect(ds[2]!.label).toMatch(/not futures/i)
    expect(yahooDatasets(nq)[0]!.label).toMatch(/futures · Yahoo/)
  })
})

describe('dev-server data helpers', () => {
  it('index comes from meta.json and only lists files that exist', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'mr-'))
    await mkdir(path.join(dir, 'USATECHIDXUSD'))
    await writeFile(path.join(dir, 'USATECHIDXUSD', 'a_2025.csv'), 'timestamp,open,high,low,close,volume\n')
    await writeFile(path.join(dir, 'USATECHIDXUSD', 'meta.json'), JSON.stringify({ appSymbol: 'NQ', label: 'L', source: 'S', resolutionMinutes: 1, files: entry.files }))
    const idx = await buildLocalIndex(dir)
    expect(idx).toHaveLength(1)
    expect(idx[0].files.map((f: { file: string }) => f.file)).toEqual(['a_2025.csv'])
    expect(await buildLocalIndex(path.join(dir, 'missing'))).toEqual([])
  })
  it('only resolves <SYMBOL>/<file>.csv', () => {
    expect(resolveLocalFile('/d', '/NQ/a_2025.csv')).toBe('/d/NQ/a_2025.csv')
    expect(resolveLocalFile('/d', '/NQ/a_2025.csv.gz')).toBe('/d/NQ/a_2025.csv.gz')
    for (const bad of ['/NQ/a.csv.gz.tmp', '/NQ/../../etc/passwd', '/NQ/meta.json', '/a/b/c.csv', '/..%2F/x.csv', '/NQ/.csv', '/']) expect(resolveLocalFile('/d', bad)).toBeNull()
  })
})

describe('/local middleware (real http)', () => {
  it('serves csv, 404s traversal / directories / non-files, survives bad escapes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'mr-http-'))
    const dir = path.join(root, 'data'); await mkdir(path.join(dir, 'NQ', 'dir.csv'), { recursive: true })
    await writeFile(path.join(dir, 'NQ', 'a.csv'), 'timestamp,open,high,low,close,volume\n')
    await writeFile(path.join(dir, 'NQ', 'b.csv.gz'), gzipSync('timestamp,open\n1,2\n'))
    await writeFile(path.join(dir, 'NQ', 'broken.csv.gz'), 'not gzip at all')
    await writeFile(path.join(root, 'secret.csv'), 'top secret')
    const handler = localHandler(dir)
    const server = http.createServer((req, res) => {
      const m = /^\/local(\/.*)$/.exec(req.url ?? '')
      if (!m) { res.statusCode = 404; return res.end() }
      req.url = m[1]; void handler(req, res, () => { res.statusCode = 404; res.end('next') })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const { port } = server.address() as { port: number }
    const get = async (p: string) => { const r = await fetch(`http://127.0.0.1:${port}${p}`); return { status: r.status, body: await r.text() } }
    try {
      expect(await get('/local/NQ/a.csv')).toMatchObject({ status: 200 })
      expect(await get('/local/NQ/b.csv.gz')).toEqual({ status: 200, body: 'timestamp,open\n1,2\n' })   // gunzipped for the browser
      await get('/local/NQ/broken.csv.gz').catch(() => null)                                            // corrupt gz must not crash the server
      for (const bad of ['/local/NQ/dir.csv', '/local/NQ/..%2f..%2fsecret.csv', '/local/..%2fsecret.csv', '/local/NQ/%2e%2e/%2e%2e/secret.csv', '/local/NQ/a.csv%00.png', '/local/NQ/nope.csv', '/local/NQ/b.csv.gz.tmp', '/local/NQ/..%2fb.csv.gz'])
        expect((await get(bad)).status, bad).toBe(404)
      expect((await get('/local/%ZZ')).status).toBe(400)
      expect((await get('/local/NQ/a.csv')).status).toBe(200) // still alive
    } finally { server.close() }
  })
})
