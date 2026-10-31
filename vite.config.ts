/// <reference types="vitest/config" />
import { defineConfig, loadEnv, type Plugin } from 'vite'
import { readFileSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { basename } from 'node:path'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8'))

function tryGit(cmd: string): string {
  try { return execSync(cmd).toString().trim() } catch { return '' }
}
// Build identity shown in the About dialog. Cloudflare Pages injects
// CF_PAGES_COMMIT_SHA in CI; fall back to local git for dev builds. This updates
// on every push to master with no version-bump commits required.
const buildSha = (process.env.CF_PAGES_COMMIT_SHA || tryGit('git rev-parse --short HEAD')).slice(0, 7) || 'dev'
const buildDate = new Date().toISOString().slice(0, 10) // YYYY-MM-DD

/**
 * Build the Content-Security-Policy and inject it into index.html (replacing the
 * `<!-- INJECT_CSP -->` marker). The policy is the runtime backstop behind the
 * import sanitizer (core/svg-sanitize.ts): no external/inline scripts, and the
 * network surface narrowed so a crafted SVG can't beacon out.
 *
 * Production drops the things only the dev server needs — Vite HMR's `ws:`/`wss:`
 * wildcards — and the `blob:`/`data:` connect-src entries nothing actually
 * fetches (fonts/images load from same-origin bundled assets; downloads use
 * <a href blob:>, which isn't connect-src). The shipped policy is therefore just
 * `self`. The same policy is set as a real HTTP header in public/_headers, which
 * additionally carries frame-ancestors / nosniff.
 *
 * Google Drive (lib/google-drive.ts) is the ONE third party, and only in a build
 * with VITE_GOOGLE_CLIENT_ID / VITE_GOOGLE_API_KEY set: Google Identity Services
 * and the Picker are scripts Google serves (there is no npm bundle), the Picker is
 * an iframe from docs.google.com, GIS injects a stylesheet from its own origin,
 * and file contents go to googleapis.com. An unconfigured build ships none of
 * those hosts. Note GIS also needs the Cross-Origin-Opener-Policy in _headers to
 * be `same-origin-allow-popups`, or its sign-in popup can't hand the token back.
 */
function buildCsp(isDev: boolean, drive: boolean): string {
  // Vite HMR needs a websocket to the dev server (and an http connect for the
  // ping); neither exists in production.
  const connectExtra = isDev ? " ws: wss: http://localhost:*" : ''
  const g = (hosts: string) => (drive ? ` ${hosts}` : '')
  return [
    "default-src 'self'",
    `script-src 'self'${g('https://accounts.google.com https://apis.google.com')}`,
    // The PDF.js import worker is a bundled same-origin asset; browsers may spin
    // it up via a blob URL, so allow both. Worker code is still same-origin.
    "worker-src 'self' blob:",
    `style-src 'self' 'unsafe-inline'${g('https://accounts.google.com')}`, // editor sets inline styles pervasively
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    // The app runs no server: production fetches nothing but its own assets (and,
    // when Drive is on, Google's), so a crafted file can't beacon anywhere (#182).
    `connect-src 'self'${connectExtra}${g('https://www.googleapis.com https://accounts.google.com https://apis.google.com')}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    drive ? "frame-src https://accounts.google.com https://docs.google.com" : "frame-src 'none'",
  ].join('; ')
}

function cspPlugin(isDev: boolean, drive: boolean): Plugin {
  const tag = `<meta http-equiv="Content-Security-Policy" content="${buildCsp(isDev, drive)}" />`
  return {
    name: 'inject-csp',
    transformIndexHtml(html) {
      return html.replace('<!-- INJECT_CSP -->', tag)
    },
  }
}

/**
 * Make an INSTALLED PWA reliably pick up a new icon/app version on the next
 * deploy — without the OS taskbar icon or the service-worker cache pinning the
 * old assets. Everything is keyed to `version` (the build SHA, which changes on
 * every push to master), so:
 *   - the SW cache name becomes `buzzquill-<sha>`; its `activate` handler deletes
 *     every other cache, forcing a fresh fetch of the app shell + icons;
 *   - the manifest icon URLs get `?v=<sha>`, so the browser re-evaluates the PWA
 *     icons when the manifest changes (and the SW treats them as new URLs, not
 *     stale-while-revalidate hits);
 *   - the index.html favicon / apple-touch-icon hrefs get `?v=<sha>` too, so the
 *     browser-tab and iOS icons refresh past any HTTP cache.
 * Build-only: the dev server never registers the SW (see main.ts), and rewriting
 * the emitted files keeps `public/sw.js` a clean, valid fallback in source.
 */
function pwaVersionPlugin(version: string, isDev: boolean): Plugin {
  const stamp = (url: string) => url + (url.includes('?') ? '&' : '?') + 'v=' + version
  const distUrl = (f: string) => new URL(`./dist/${f}`, import.meta.url)
  return {
    name: 'pwa-version',
    transformIndexHtml(html) {
      if (isDev) return html
      // Version favicon + apple-touch-icon hrefs (NOT the manifest link, whose URL
      // can factor into PWA install identity — the manifest stays fresh via the
      // no-cache header in public/_headers instead).
      return html.replace(
        /(<link\b[^>]*\brel="(?:icon|apple-touch-icon)"[^>]*\bhref=")([^"]+)(")/g,
        (_m, pre, href, post) => pre + stamp(href) + post,
      )
    },
    closeBundle() {
      if (isDev) return
      try {
        const p = distUrl('sw.js')
        writeFileSync(p, readFileSync(p, 'utf-8').replace(/const CACHE = '[^']*';/, `const CACHE = 'buzzquill-${version}';`))
      } catch { /* build without a service worker — nothing to stamp */ }
      try {
        const p = distUrl('manifest.webmanifest')
        const m = JSON.parse(readFileSync(p, 'utf-8'))
        if (Array.isArray(m.icons)) m.icons = m.icons.map((ic: { src: string }) => ({ ...ic, src: stamp(ic.src) }))
        writeFileSync(p, JSON.stringify(m, null, 2) + '\n')
      } catch { /* no manifest — nothing to stamp */ }
    },
  }
}

/**
 * `import url from '…/face.woff2?ttf'` gives the URL of the same font as a plain
 * TTF, decoded here with Google's reference WOFF2 decoder (wawoff2). Text
 * outlining reads glyphs with opentype.js, which can't read WOFF2 — and the
 * variable faces the canvas renders with ship only as WOFF2. Decoding at build
 * time keeps the decoder (WebAssembly, which the app's CSP doesn't allow) out of
 * the browser. Built: an emitted asset. Dev: served from memory.
 */
function woff2ToTtfPlugin(): Plugin {
  const served = new Map<string, Uint8Array>()
  let isBuild = false
  // wawoff2 hands back a view into its WebAssembly heap, which the next decode
  // reuses — and Vite loads modules concurrently, so two decodes interleaving
  // across an await zeroed the first font. One at a time, copied out before the next.
  let queue: Promise<unknown> = Promise.resolve()
  const decode = (bytes: Uint8Array): Promise<Uint8Array> => {
    const wawoff2 = createRequire(import.meta.url)('wawoff2') as { decompress(b: Uint8Array): Promise<Uint8Array> }
    const run = queue.then(async () => new Uint8Array(await wawoff2.decompress(bytes)).slice())
    queue = run.catch(() => undefined)
    return run
  }
  return {
    name: 'woff2-to-ttf',
    enforce: 'pre',
    configResolved(config) { isBuild = config.command === 'build' },
    async load(id) {
      if (!id.endsWith('.woff2?ttf')) return null
      const file = id.slice(0, -'?ttf'.length)
      const ttf = await decode(readFileSync(file))
      const name = basename(file).replace(/\.woff2$/, '.ttf')
      if (isBuild) {
        const ref = this.emitFile({ type: 'asset', name, source: ttf })
        return `export default import.meta.ROLLUP_FILE_URL_${ref};`
      }
      const url = `/@ttf/${name}`
      served.set(url, ttf)
      return `export default ${JSON.stringify(url)};`
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const bytes = req.url ? served.get(req.url.split('?')[0]) : undefined
        if (!bytes) return next()
        res.setHeader('Content-Type', 'font/ttf')
        res.end(Buffer.from(bytes))
      })
    },
  }
}

export default defineConfig(({ mode }) => {
  // Drive is a build-time switch: the CSP opens Google's hosts only when the two
  // public identifiers are present (see .env.example / lib/google-config.ts).
  const env = loadEnv(mode, process.cwd(), 'VITE_')
  const driveConfigured = Boolean(env.VITE_GOOGLE_CLIENT_ID && env.VITE_GOOGLE_API_KEY)
  return {
  base: './',
  plugins: [woff2ToTtfPlugin(), cspPlugin(mode === 'development', driveConfigured), pwaVersionPlugin(buildSha, mode === 'development')],
  resolve: {
    alias: {
      // Force every `import 'paper'` (ours + paperjs-offset's) to the CORE build.
      // paper-full bundles PaperScript's parser, which calls `new Function()` at
      // load and is blocked by our CSP (script-src 'self'). Aliasing here also
      // guarantees a single shared paper instance across the app + the offset
      // plugin (two instances break geometry ops).
      paper: 'paper/dist/paper-core.js',
    },
  },
  // Surface the package version to the app (shown in the About dialog).
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_SHA__: JSON.stringify(buildSha),
    __BUILD_DATE__: JSON.stringify(buildDate),
  },
  server: {
    port: 5180,
    strictPort: true,
  },
  preview: {
    port: 5180,
    strictPort: true,
  },
  // Fast, browserless unit layer for the pure core modules (path geometry,
  // sanitization). DOM-dependent behaviour (getBBox, live-SVG transforms) stays
  // in the Playwright suite, which runs against real Chrome. `npm run test:unit`.
  test: {
    include: ['test/unit/**/*.test.ts'],
    environment: 'node',
  },
}
})
