(() => {
  'use strict';
  const script = document.currentScript;
  if (!(script instanceof HTMLScriptElement)) return;
  const embedId = script.dataset.embedId;
  if (!embedId || !/^[a-zA-Z0-9_-]{8,100}$/.test(embedId)) return;
  if (window.LotlWidget) { if (window.LotlWidget.embedId !== embedId) console.warn('Only one Law of the Land widget can be installed per page.'); return; }
  const app = new URL(script.src).origin, instanceId = crypto.randomUUID(), host = document.createElement('div'), request = new AbortController();
  host.id = 'lotl-widget-host'; host.style.display = 'none'; const shadow = host.attachShadow({ mode: 'open' });
  const css = document.createElement('link'); css.rel = 'stylesheet'; css.addEventListener('load', () => { host.style.display = ''; }, { once: true }); css.href = `${app}/widget.css`;
  const launcher = document.createElement('button'); launcher.type = 'button'; launcher.textContent = 'Ask a question'; launcher.setAttribute('aria-expanded', 'false'); launcher.setAttribute('aria-haspopup', 'dialog');
  const panel = document.createElement('section'); panel.hidden = true; panel.id = `lotl-${instanceId}`; launcher.setAttribute('aria-controls', panel.id);
  const loading = document.createElement('p'); loading.setAttribute('role', 'status'); loading.textContent = 'Loading chat…';
  const closeButton = document.createElement('button'); closeButton.type = 'button'; closeButton.textContent = 'Close chat';
  const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = 'Try again'; retry.hidden = true;
  panel.append(loading, closeButton, retry); shadow.append(css, panel, launcher);
  let frame = null, timer, opened = false, ready = false, destroyed = false, configuration = null;
  function send(type) { frame?.contentWindow?.postMessage({ namespace: 'lotl-widget', version: 1, embedId, instanceId, type, payload: {} }, app); }
  function close() { opened = false; panel.hidden = true; launcher.setAttribute('aria-expanded', 'false'); send('closed'); launcher.focus(); }
  function failed() { clearTimeout(timer); frame?.remove(); frame = null; ready = false; loading.hidden = false; closeButton.hidden = false; retry.hidden = false; loading.textContent = "Chat couldn't load. Try again."; }
  function mount() {
    if (frame || destroyed) return;
    ready = false; retry.hidden = true; loading.hidden = false; closeButton.hidden = false; loading.textContent = 'Loading chat…';
    frame = document.createElement('iframe'); frame.title = configuration?.title || 'Organization chat'; frame.referrerPolicy = 'no-referrer'; frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox');
    frame.src = `${app}/embed/${encodeURIComponent(embedId)}?parentOrigin=${encodeURIComponent(location.origin)}&instanceId=${instanceId}`;
    frame.hidden = true; frame.addEventListener('error', failed, { once: true }); timer = setTimeout(failed, 10000); panel.append(frame);
  }
  function open() { if (destroyed || !configuration) return; opened = true; panel.hidden = false; launcher.setAttribute('aria-expanded', 'true'); if (!frame) mount(); if (ready) send('opened'); else closeButton.focus(); }
  function receive(event) {
    const d = event.data;
    if (event.origin !== app || event.source !== frame?.contentWindow || !d || typeof d !== 'object' || Array.isArray(d) || Object.keys(d).sort().join() !== 'embedId,instanceId,namespace,payload,type,version' || d.namespace !== 'lotl-widget' || d.version !== 1 || d.embedId !== embedId || d.instanceId !== instanceId || !d.payload || typeof d.payload !== 'object' || Array.isArray(d.payload) || Object.keys(d.payload).length) return;
    if (d.type === 'ready' && !ready) { ready = true; clearTimeout(timer); loading.hidden = true; closeButton.hidden = true; retry.hidden = true; frame.hidden = false; send('init'); if (opened) send('opened'); }
    else if (d.type === 'close' && ready) close();
  }
  function key(event) { if (event.key === 'Escape' && opened) close(); }
  function destroy() { destroyed = true; request.abort(); clearTimeout(timer); window.removeEventListener('message', receive); shadow.removeEventListener('keydown', key); host.remove(); if (window.LotlWidget?.instanceId === instanceId) delete window.LotlWidget; }
  launcher.addEventListener('click', () => opened ? close() : open()); closeButton.addEventListener('click', close); retry.addEventListener('click', mount); window.addEventListener('message', receive); shadow.addEventListener('keydown', key);
  window.LotlWidget = { embedId, instanceId, open, close, destroy }; css.addEventListener('error', destroy, { once: true });
  fetch(`${app}/api/embed/${encodeURIComponent(embedId)}/config`, { credentials: 'omit', cache: 'no-store', signal: AbortSignal.any([request.signal, AbortSignal.timeout(10000)]) })
    .then(response => response.ok ? response.json() : Promise.reject(new Error('unavailable')))
    .then(config => { if (destroyed) return; if (!config || typeof config.title !== 'string' || !/^#[a-f0-9]{6}$/i.test(config.accent) || !['left', 'right'].includes(config.side)) return destroy(); configuration = config; launcher.textContent = config.title; launcher.setAttribute('aria-label', `Open ${config.title}`); host.dataset.side = config.side; host.style.setProperty('--lotl-accent', config.accent); if (document.body) document.body.append(host); else document.addEventListener('DOMContentLoaded', () => { if (!destroyed) document.body.append(host); }, { once: true }); })
    .catch(destroy);
})();
