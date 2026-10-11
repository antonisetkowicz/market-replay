import './style.css'
import { startApp } from './app'

startApp().catch((e) => {
  document.body.insertAdjacentHTML('beforeend', `<pre style="position:fixed;inset:60px 20px auto;color:#f23645;background:#1e222d;padding:12px;z-index:99">${String(e?.stack ?? e)}</pre>`)
  throw e
})
