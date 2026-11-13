"use strict";

// 動画ファイル on the web (v1.0.203): the service worker that lets <video> play a video kept on Drive encrypted.
//
// The player asks for parts of ./nisshi-video/<token> (Range requests; Safari asks for nothing else). This worker
// knows nothing about the video: for each part it asks the page that opened it (nisshi-web.js, "nisshi-video"
// messages), which downloads the encrypted pieces from Drive, decrypts them with the video's key and hands back
// the plain bytes. So the key, the Google token and Drive itself stay in the page (its login, retries and
// reconnect panel work as for images), nothing is stored on the device, and a worker the browser stopped and
// started again simply asks again. Every other request is left alone (no caching).

const INFO_TIMEOUT = 10 * 1000;  // a page that does not answer this soon (frozen in the background) is not the one
const PART = 2 * 1024 * 1024;    // plain bytes asked of the page at a time

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
// A page loaded past this worker (a forced reload) asks to be taken before it plays.
self.addEventListener("message", (e) => { if (e.data === "claim") e.waitUntil(self.clients.claim()); });

self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (u.origin !== self.location.origin) return;
  const m = /\/nisshi-video\/([0-9a-f]{32})$/.exec(u.pathname);
  if (!m) return;
  e.respondWith(serve(e, m[1]));
});

// A part has no time limit: the page retries Drive itself and, when the Google login has run out, waits for
// the reconnect panel's tap; the player drops the stream if it no longer wants it.
function ask(client, msg, timeout) {
  return new Promise((resolve, reject) => {
    const ch = new MessageChannel();
    const timer = timeout ? setTimeout(() => reject(new Error("timeout")), timeout) : 0;
    ch.port1.onmessage = (ev) => {
      clearTimeout(timer);
      const d = ev.data || {};
      if (d.ok) resolve(d); else reject(new Error(d.code || "error"));
    };
    client.postMessage(Object.assign({ type: "nisshi-video" }, msg), [ch.port2]);
  });
}

// The page that knows this token: the one that made the request, else any open page of the journal.
async function pageFor(e, token) {
  const own = e.clientId ? await self.clients.get(e.clientId) : null;
  const all = await self.clients.matchAll({ type: "window" });
  const tried = own ? [own].concat(all.filter((c) => c.id !== own.id)) : all;
  // All asked at once; the first that knows the token answers (the others: not this page, locked or frozen).
  return new Promise((resolve) => {
    let left = tried.length;
    if (!left) { resolve(null); return; }
    tried.forEach((c) => {
      ask(c, { op: "info", token }, INFO_TIMEOUT).then(
        (info) => resolve({ client: c, size: info.size, mime: info.mime }),
        () => { if (--left === 0) resolve(null); }
      );
    });
  });
}

async function serve(e, token) {
  const page = await pageFor(e, token);
  if (!page) return new Response("", { status: 404 });
  const size = page.size;
  const m = /bytes=(\d*)-(\d*)/.exec(e.request.headers.get("range") || "");
  let start = m && m[1] ? Number(m[1]) : 0;
  let end = m && m[2] ? Number(m[2]) : size - 1;
  if (m && !m[1] && m[2]) { start = Math.max(0, size - Number(m[2])); end = size - 1; }   // the last n bytes
  if (start >= size) {
    return new Response("", { status: 416, headers: { "Content-Range": `bytes */${size}` } });
  }
  end = Math.min(end, size - 1);
  // As in video.js: the whole range asked for is answered, as a stream that asks the page for the next part
  // only when the player wants more. The first part is read before answering, so a video that cannot be read
  // fails here, not halfway.
  let next = start;
  async function take() {
    const to = Math.min(end, next + PART - 1);
    const d = await ask(page.client, { op: "range", token, start: next, end: to });
    next = to + 1;
    return new Uint8Array(d.bytes);
  }
  let head;
  try {
    head = await take();
  } catch (err) {
    return new Response("", { status: 502 });
  }
  const body = new ReadableStream({
    async pull(controller) {
      if (head) { controller.enqueue(head); head = null; }
      else if (next > end) { controller.close(); return; }
      else {
        try { controller.enqueue(await take()); }
        catch (err) { controller.error(err); return; }
      }
      if (next > end && !head) controller.close();
    }
  }, { highWaterMark: 0 });
  return new Response(body, {
    status: 206,
    headers: {
      "Content-Type": page.mime,
      "Content-Length": String(end - start + 1),
      "Content-Range": `bytes ${start}-${end}/${size}`,
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store"
    }
  });
}
