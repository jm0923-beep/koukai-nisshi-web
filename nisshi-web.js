// Web (iPhone / iPad) implementation of window.nisshi.
// The Electron build gets the same API from src/main/preload.js; the
// renderer (src/renderer/*.js) is shared and does not know which one it runs on.
//
// Login uses Google's OAuth token flow in the browser (no client secret,
// no refresh token). An access token lasts about 1 hour:
//   - at the gate, login is a full-page redirect (works in Safari and in the
//     home-screen app alike);
//   - if the token runs out while the journal is open, a small panel asks the
//     user to tap "reconnect", which opens Google in a popup, so the unlocked
//     journal and anything being typed stay as they are.
(function(){
  "use strict";

  var CFG = window.NISSHI_WEB_CONFIG || {};
  var SCOPE = "https://www.googleapis.com/auth/drive.file";
  var API = "https://www.googleapis.com/drive/v3";
  var UPLOAD = "https://www.googleapis.com/upload/drive/v3";
  var FOLDER_NAME = "航海日誌";
  var FOLDER_MIME = "application/vnd.google-apps.folder";
  var JOURNAL_NAME = "koukai-nisshi.json";

  var TOKEN_KEY = "nisshi_web_token";       // sessionStorage: {token, expiresAt}
  var STATE_KEY = "nisshi_web_state";       // sessionStorage: state of a pending redirect login
  var RESULT_KEY = "nisshi_web_popup";      // localStorage: popup result when window.opener is lost
  var SIGNED_BEFORE_KEY = "nisshi_web_signed_before";   // localStorage: try a silent login on the next visit
  var SILENT_TRIED_KEY = "nisshi_web_silent_tried";     // sessionStorage: only one silent attempt per tab

  function codeError(code, message){
    var err = new Error(message || code);
    err.code = code;
    return err;
  }
  function ss(){ try{ return window.sessionStorage; } catch(e){ return null; } }
  function ls(){ try{ return window.localStorage; } catch(e){ return null; } }
  function getItem(store, key){ try{ return store ? store.getItem(key) : null; } catch(e){ return null; } }
  function setItem(store, key, v){ try{ if(store){ store.setItem(key, v); } } catch(e){} }
  function removeItem(store, key){ try{ if(store){ store.removeItem(key); } } catch(e){} }

  function randomState(){
    var a = new Uint8Array(16);
    crypto.getRandomValues(a);
    return Array.prototype.map.call(a, function(b){ return ("0" + b.toString(16)).slice(-2); }).join("");
  }
  function callbackUrl(){ return new URL("callback.html", location.href).href; }
  function appUrl(){ return new URL("./", location.href).href; }

  function authUrl(state, silent){
    var p = new URLSearchParams({
      client_id: CFG.clientId,
      redirect_uri: callbackUrl(),
      response_type: "token",
      scope: SCOPE,
      include_granted_scopes: "true",
      state: state
    });
    if(silent){ p.set("prompt", "none"); }
    return "https://accounts.google.com/o/oauth2/v2/auth?" + p.toString();
  }

  /* ---------------- token ---------------- */
  var token = null;
  var tokenExpiresAt = 0;

  function storeToken(t, expiresInSec){
    token = t;
    tokenExpiresAt = Date.now() + Math.max(60, Number(expiresInSec) || 3600) * 1000;
    setItem(ss(), TOKEN_KEY, JSON.stringify({ token: token, expiresAt: tokenExpiresAt }));
    setItem(ls(), SIGNED_BEFORE_KEY, "1");
    removeItem(ss(), SILENT_TRIED_KEY);   // a later expiry in this tab may try silently again
  }
  function forgetToken(){
    token = null;
    tokenExpiresAt = 0;
    removeItem(ss(), TOKEN_KEY);
  }
  function tokenValid(){ return !!token && Date.now() < tokenExpiresAt - 60 * 1000; }

  (function restoreToken(){
    var raw = getItem(ss(), TOKEN_KEY);
    if(!raw){ return; }
    try{
      var t = JSON.parse(raw);
      token = t.token;
      tokenExpiresAt = t.expiresAt;
    } catch(e){ forgetToken(); }
  })();

  // callback.html leaves the result of a redirect login here before coming back.
  var redirectError = null;
  (function takeRedirectResult(){
    var raw = getItem(ss(), "nisshi_web_redirect_result");
    if(!raw){ return; }
    removeItem(ss(), "nisshi_web_redirect_result");
    var expected = null;
    try{ expected = JSON.parse(getItem(ss(), STATE_KEY)); } catch(e){}
    removeItem(ss(), STATE_KEY);
    var r;
    try{ r = JSON.parse(raw); } catch(e){ return; }
    if(!expected || r.state !== expected.state){ return; }
    if(r.access_token){ storeToken(r.access_token, r.expires_in); return; }
    // A silent attempt that needs the user to choose or consent is not an error worth showing.
    if(expected.silent){ return; }
    redirectError = r.error === "access_denied" ? "auth_denied" : (r.error || "auth_failed");
  })();

  function redirectToGoogle(silent){
    var state = randomState();
    setItem(ss(), STATE_KEY, JSON.stringify({ state: state, silent: !!silent }));
    location.assign(authUrl(state, silent));
    // The page is leaving; never settle.
    return new Promise(function(){});
  }

  /* ---------------- reconnect panel (token expired while the journal is open) ---------------- */
  var reconnectWaiters = null;   // array of {resolve, reject} while the panel is up

  function waitForReconnect(){
    return new Promise(function(resolve, reject){
      if(reconnectWaiters){ reconnectWaiters.push({ resolve: resolve, reject: reject }); return; }
      reconnectWaiters = [{ resolve: resolve, reject: reject }];
      showReconnectPanel();
    });
  }
  function settleReconnect(err){
    var list = reconnectWaiters || [];
    reconnectWaiters = null;
    hideReconnectPanel();
    list.forEach(function(w){ if(err){ w.reject(err); } else { w.resolve(); } });
  }

  var panel = null;
  function showReconnectPanel(){
    if(!panel){
      panel = document.createElement("div");
      panel.className = "modal-backdrop web-reconnect";
      panel.innerHTML =
        '<div class="modal">' +
          '<h3>Googleに接続し直してください</h3>' +
          '<p class="web-reconnect-text">Googleドライブへの接続の有効期限（約1時間）が切れました。' +
          '書いている内容はそのまま残っています。下のボタンを押すとGoogleの画面が開き、すぐに戻ってきます。</p>' +
          '<p class="web-reconnect-error" style="display:none;"></p>' +
          '<div class="modal-actions">' +
            '<button class="btn btn-ghost web-reconnect-cancel">やめる</button>' +
            '<button class="btn btn-primary web-reconnect-go">接続し直す</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(panel);
      panel.querySelector(".web-reconnect-go").addEventListener("click", reconnectByPopup);
      panel.querySelector(".web-reconnect-cancel").addEventListener("click", function(){
        settleReconnect(codeError("reauth", "Googleへの接続が切れました。"));
      });
    }
    panel.querySelector(".web-reconnect-error").style.display = "none";
    panel.querySelector(".web-reconnect-go").disabled = false;
    panel.style.display = "flex";
  }
  function hideReconnectPanel(){ if(panel){ panel.style.display = "none"; } }
  function showReconnectError(msg){
    if(!panel){ return; }
    var el = panel.querySelector(".web-reconnect-error");
    el.textContent = msg;
    el.style.display = "block";
    panel.querySelector(".web-reconnect-go").disabled = false;
  }

  var popupState = null;
  function reconnectByPopup(){
    popupState = randomState();
    removeItem(ls(), RESULT_KEY);
    // Must run inside the tap, or Safari blocks the popup.
    var w = window.open(authUrl(popupState, false), "nisshi_google_login");
    if(!w){
      showReconnectError("Googleの画面を開けませんでした。「やめる」を押してから、もう一度ログインしてください。");
      return;
    }
    panel.querySelector(".web-reconnect-go").disabled = true;
  }
  function takePopupResult(r){
    if(!r || !popupState || r.state !== popupState){ return; }
    popupState = null;
    removeItem(ls(), RESULT_KEY);
    if(r.access_token){
      storeToken(r.access_token, r.expires_in);
      settleReconnect(null);
    } else {
      showReconnectError("接続できませんでした（" + (r.error || "不明") + "）。もう一度お試しください。");
    }
  }
  window.addEventListener("message", function(e){
    if(e.origin !== location.origin || !e.data || e.data.type !== "nisshi-oauth"){ return; }
    takePopupResult(e.data.result);
  });
  // iOS may drop window.opener for the popup; the callback then writes to localStorage instead.
  window.addEventListener("storage", function(e){
    if(e.key !== RESULT_KEY || !e.newValue){ return; }
    try{ takePopupResult(JSON.parse(e.newValue)); } catch(err){}
  });
  // Coming back to the tab after finishing in the popup.
  document.addEventListener("visibilitychange", function(){
    if(document.visibilityState !== "visible" || !popupState){ return; }
    var raw = getItem(ls(), RESULT_KEY);
    if(raw){ try{ takePopupResult(JSON.parse(raw)); } catch(err){} }
  });

  function getToken(){
    if(tokenValid()){ return Promise.resolve(token); }
    if(!CFG.clientId){ return Promise.reject(codeError("not_configured", "クライアントIDが設定されていません。")); }
    // At the gate there is nothing to lose: go straight back to the login button.
    if(!document.getElementById("app") || document.getElementById("app").style.display !== "block"){
      forgetToken();
      return Promise.reject(codeError("reauth", "Googleにログインしていません。"));
    }
    return waitForReconnect().then(function(){ return token; });
  }

  /* ---------------- Drive REST (same behaviour as src/main/drive.js) ---------------- */
  var sleep = function(ms){ return new Promise(function(r){ setTimeout(r, ms); }); };

  function request(url, opts, attempt){
    opts = opts || {};
    attempt = attempt || 0;
    return getToken().then(function(t){
      var headers = Object.assign({}, opts.headers || {}, { Authorization: "Bearer " + t });
      return fetch(url, Object.assign({}, opts, { headers: headers })).then(function(res){
        if(res.status === 401 && attempt < 1){
          forgetToken();
          return request(url, opts, attempt + 1);
        }
        if((res.status === 429 || res.status >= 500) && attempt < 3){
          return sleep(1000 * Math.pow(2, attempt)).then(function(){ return request(url, opts, attempt + 1); });
        }
        if(!res.ok){
          return res.text().catch(function(){ return ""; }).then(function(text){
            throw codeError(res.status === 404 ? "not_found" : "drive_error", "Drive API " + res.status + ": " + text.slice(0, 300));
          });
        }
        return res;
      }, function(){
        if(attempt < 2){
          return sleep(800 * (attempt + 1)).then(function(){ return request(url, opts, attempt + 1); });
        }
        throw codeError("network", "Googleドライブに接続できませんでした。");
      });
    });
  }

  function quote(s){ return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'"); }

  function listFiles(q){
    var params = new URLSearchParams({
      q: q,
      fields: "files(id,name,headRevisionId,modifiedTime)",
      spaces: "drive",
      orderBy: "modifiedTime desc",
      pageSize: "100"
    });
    return request(API + "/files?" + params).then(function(res){ return res.json(); }).then(function(j){ return j.files || []; });
  }

  var folderId = null;
  var journalId = null;

  function ensureFolder(){
    if(folderId){ return Promise.resolve(folderId); }
    return listFiles("name='" + quote(FOLDER_NAME) + "' and mimeType='" + FOLDER_MIME + "' and trashed=false").then(function(found){
      if(found.length){ folderId = found[0].id; return folderId; }
      return request(API + "/files?fields=id", {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=UTF-8" },
        body: JSON.stringify({ name: FOLDER_NAME, mimeType: FOLDER_MIME })
      }).then(function(res){ return res.json(); }).then(function(j){ folderId = j.id; return folderId; });
    });
  }

  function findJournal(){
    return ensureFolder().then(function(folder){
      return listFiles("name='" + JOURNAL_NAME + "' and '" + folder + "' in parents and trashed=false");
    }).then(function(found){ return found[0] || null; });
  }

  function getMeta(id){
    return request(API + "/files/" + id + "?fields=id,headRevisionId,trashed").then(function(res){ return res.json(); });
  }

  function createFile(metadata, body, mime){
    var boundary = "nisshi" + randomState();
    var blob = new Blob([
      "--" + boundary + "\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n" + JSON.stringify(metadata) + "\r\n" +
      "--" + boundary + "\r\nContent-Type: " + mime + "\r\n\r\n",
      body,
      "\r\n--" + boundary + "--"
    ]);
    return request(UPLOAD + "/files?uploadType=multipart&fields=id,headRevisionId", {
      method: "POST",
      headers: { "Content-Type": "multipart/related; boundary=" + boundary },
      body: blob
    }).then(function(res){ return res.json(); });
  }

  function loadJournal(){
    return findJournal().then(function(f){
      if(!f){ journalId = null; return { exists: false }; }
      journalId = f.id;
      var tries = 0;
      function attempt(){
        var before;
        return getMeta(f.id).then(function(m){
          before = m.headRevisionId;
          return request(API + "/files/" + f.id + "?alt=media");
        }).then(function(res){ return res.text(); }).then(function(content){
          return getMeta(f.id).then(function(m){
            if(before === m.headRevisionId){ return { exists: true, content: content, revision: m.headRevisionId }; }
            if(++tries < 3){ return attempt(); }
            throw codeError("drive_error", "日誌ファイルが更新中のため読み込めませんでした。");
          });
        });
      }
      return attempt();
    });
  }

  function saveJournal(content, expectedRevision){
    if(!journalId){ return Promise.reject(codeError("journal_missing")); }
    return getMeta(journalId).catch(function(err){
      if(err.code === "not_found"){ throw codeError("journal_missing"); }
      throw err;
    }).then(function(meta){
      if(meta.trashed){ throw codeError("journal_missing"); }
      if(expectedRevision && meta.headRevisionId !== expectedRevision){ throw codeError("conflict"); }
      return request(UPLOAD + "/files/" + journalId + "?uploadType=media&fields=id,headRevisionId", {
        method: "PATCH",
        headers: { "Content-Type": "application/json; charset=UTF-8" },
        body: new Blob([String(content)])
      });
    }).then(function(res){ return res.json(); }).then(function(j){ return { revision: j.headRevisionId }; });
  }

  function createJournal(content){
    var folder;
    return ensureFolder().then(function(f){
      folder = f;
      return findJournal();
    }).then(function(existing){
      if(!existing){ return; }
      var stamp = new Date().toISOString().replace(/[:.]/g, "-");
      return request(API + "/files/" + existing.id + "?fields=id", {
        method: "PATCH",
        headers: { "Content-Type": "application/json; charset=UTF-8" },
        body: JSON.stringify({ name: "koukai-nisshi-置き換え前-" + stamp + ".json" })
      });
    }).then(function(){
      return createFile({ name: JOURNAL_NAME, parents: [folder], mimeType: "application/json" },
                        new Blob([String(content)]), "application/json; charset=UTF-8");
    }).then(function(created){
      journalId = created.id;
      return { revision: created.headRevisionId };
    });
  }

  function uploadImage(bytes, imageId){
    var safeId = String(imageId).replace(/[^A-Za-z0-9-]/g, "");
    return ensureFolder().then(function(folder){
      return createFile({ name: "img-" + safeId + ".bin", parents: [folder], mimeType: "application/octet-stream" },
                        new Blob([bytes]), "application/octet-stream");
    }).then(function(created){ return created.id; });
  }

  function downloadImage(fileId){
    return request(API + "/files/" + encodeURIComponent(fileId) + "?alt=media")
      .then(function(res){ return res.arrayBuffer(); })
      .then(function(buf){ return new Uint8Array(buf); });
  }

  function trashFiles(ids){
    return (ids || []).reduce(function(p, id){
      return p.then(function(){
        return request(API + "/files/" + encodeURIComponent(String(id)) + "?fields=id", {
          method: "PATCH",
          headers: { "Content-Type": "application/json; charset=UTF-8" },
          body: JSON.stringify({ trashed: true })
        }).catch(function(err){ if(err.code !== "not_found"){ throw err; } });
      });
    }, Promise.resolve());
  }

  /* ---------------- Google Drive: Google's file picker ---------------- */
  // Shown in its own window as part of a Google login (trigger_onepick), like
  // the Windows app does. An embedded picker does not work on iPhone: Safari
  // keeps Google's cookies away from a docs.google.com frame inside this page.
  // Files picked there become readable with drive.file.
  var MAX_PICKED_BYTES = 20 * 1000 * 1000;
  var PICK_KEY = "nisshi_web_pick";         // localStorage: popup result when window.opener is lost
  var pendingPick = null;                   // { state, resolve, reject } while the picker window is open

  function takePickResult(r){
    if(!r || !pendingPick || r.state !== pendingPick.state){ return; }
    var p = pendingPick;
    pendingPick = null;
    removeItem(ls(), PICK_KEY);
    if(r.access_token){ storeToken(r.access_token, r.expires_in); }
    if(r.error){
      if(r.error === "access_denied"){ p.resolve([]); } else { p.reject(codeError("pick_failed", r.error)); }
      return;
    }
    p.resolve(String(r.picked_file_ids || "").split(",").filter(Boolean));
  }
  window.addEventListener("message", function(e){
    if(e.origin !== location.origin || !e.data || e.data.type !== "nisshi-pick"){ return; }
    takePickResult(e.data.result);
  });
  window.addEventListener("storage", function(e){
    if(e.key !== PICK_KEY || !e.newValue){ return; }
    try{ takePickResult(JSON.parse(e.newValue)); } catch(err){}
  });
  document.addEventListener("visibilitychange", function(){
    if(document.visibilityState !== "visible" || !pendingPick){ return; }
    var raw = getItem(ls(), PICK_KEY);
    if(raw){ try{ takePickResult(JSON.parse(raw)); } catch(err){} }
  });

  // Must be called inside the tap: Safari only allows a popup opened right then.
  function openPicker(){
    if(pendingPick){ pendingPick.resolve([]); pendingPick = null; }
    var state = randomState();
    removeItem(ls(), PICK_KEY);
    var p = new URLSearchParams({
      client_id: CFG.clientId,
      redirect_uri: callbackUrl(),
      response_type: "token",
      scope: SCOPE,
      state: state,
      prompt: "consent",
      trigger_onepick: "true",
      allow_multiple: "true"
    });
    var w = window.open("https://accounts.google.com/o/oauth2/v2/auth?" + p.toString(), "nisshi_google_pick");
    if(!w){ return Promise.reject(codeError("popup_blocked", "Googleの画面を開けませんでした。")); }
    return new Promise(function(resolve, reject){ pendingPick = { state: state, resolve: resolve, reject: reject }; });
  }
  function cancelPick(){
    if(pendingPick){ pendingPick.resolve([]); pendingPick = null; }
    return Promise.resolve();
  }

  function fetchPickedFile(id){
    return request(API + "/files/" + encodeURIComponent(id) + "?fields=id,name,mimeType,size").then(function(res){ return res.json(); }).then(function(meta){
      var native = /^application\/vnd\.google-apps\./.test(meta.mimeType);
      if(!native && Number(meta.size) > MAX_PICKED_BYTES){ throw codeError("too_large", meta.name); }
      var url = native
        ? API + "/files/" + encodeURIComponent(id) + "/export?mimeType=application%2Fpdf"
        : API + "/files/" + encodeURIComponent(id) + "?alt=media";
      return request(url).then(function(res){ return res.arrayBuffer(); }).then(function(buf){
        if(buf.byteLength > MAX_PICKED_BYTES){ throw codeError("too_large", meta.name); }
        return {
          name: native ? meta.name + ".pdf" : meta.name,
          mime: native ? "application/pdf" : (meta.mimeType || "application/octet-stream"),
          bytes: new Uint8Array(buf)
        };
      });
    });
  }

  // Resolves with [{ name, mime, bytes }] ([] when cancelled).
  function pickDriveFiles(){
    return openPicker().then(function(ids){
      var out = [];
      return ids.reduce(function(p, id){
        return p.then(function(){ return fetchPickedFile(id).then(function(f){ out.push(f); }); });
      }, Promise.resolve()).then(function(){ return out; });
    });
  }

  /* ---------------- attached files: view inside the page ---------------- */
  // PDFs, images and text are shown in a full-screen panel; anything else can be saved to the device.
  function openFile(name, mime, bytesPromise){
    var box = document.createElement("div");
    box.className = "web-file-viewer";
    box.innerHTML =
      '<div class="web-file-bar">' +
        '<span class="web-file-name"></span>' +
        '<a class="btn btn-ghost btn-small web-file-save" style="display:none;">保存</a>' +
        '<button class="btn btn-primary btn-small web-file-close">閉じる</button>' +
      '</div>' +
      '<div class="web-file-body"><p class="web-file-msg">読み込んでいます…</p></div>';
    box.querySelector(".web-file-name").textContent = name;
    document.body.appendChild(box);
    var url = null;
    box.querySelector(".web-file-close").addEventListener("click", function(){
      box.remove();
      if(url){ setTimeout(function(){ URL.revokeObjectURL(url); }, 1000); }
    });
    return Promise.resolve(bytesPromise).then(function(bytes){
      url = URL.createObjectURL(new Blob([bytes], { type: mime || "application/octet-stream" }));
      var save = box.querySelector(".web-file-save");
      save.href = url;
      save.download = sanitizeFileName(name);
      save.style.display = "";
      var body = box.querySelector(".web-file-body");
      if(/^(application\/pdf|image\/|text\/)/.test(mime || "")){
        body.innerHTML = '<iframe class="web-file-frame" title=""></iframe>';
        body.querySelector("iframe").src = url;
      } else {
        body.innerHTML = '<p class="web-file-msg">このファイルはここでは表示できません。「保存」を押して端末に保存してから開いてください。</p>';
      }
    }, function(err){
      box.querySelector(".web-file-body").innerHTML = '<p class="web-file-msg">ファイルを読み込めませんでした。</p>';
      throw err;
    });
  }

  /* ---------------- files: download to the device ---------------- */
  function sanitizeFileName(name){ return String(name || "").replace(/[\\/:*?"<>|\x00-\x1f]/g, "_"); }

  function downloadBlob(blob, name){
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = sanitizeFileName(name);
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function(){ URL.revokeObjectURL(url); }, 60 * 1000);
  }

  // Minimal ZIP writer (stored, no compression) for Markdown + its images.
  var CRC_TABLE = (function(){
    var t = new Uint32Array(256);
    for(var n = 0; n < 256; n++){
      var c = n;
      for(var k = 0; k < 8; k++){ c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; }
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes){
    var c = 0xFFFFFFFF;
    for(var i = 0; i < bytes.length; i++){ c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8); }
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  function makeZip(files){
    var enc = new TextEncoder();
    var parts = [], central = [], offset = 0;
    var now = new Date();
    var dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    var dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    files.forEach(function(f){
      var name = enc.encode(f.name);
      var data = f.bytes;
      var crc = crc32(data);
      var local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 20, true);
      local.setUint16(6, 0x0800, true);            // file names are UTF-8
      local.setUint16(8, 0, true);
      local.setUint16(10, dosTime, true);
      local.setUint16(12, dosDate, true);
      local.setUint32(14, crc, true);
      local.setUint32(18, data.length, true);
      local.setUint32(22, data.length, true);
      local.setUint16(26, name.length, true);
      local.setUint16(28, 0, true);
      parts.push(local.buffer, name, data);
      var cd = new DataView(new ArrayBuffer(46));
      cd.setUint32(0, 0x02014b50, true);
      cd.setUint16(4, 20, true);
      cd.setUint16(6, 20, true);
      cd.setUint16(8, 0x0800, true);
      cd.setUint16(10, 0, true);
      cd.setUint16(12, dosTime, true);
      cd.setUint16(14, dosDate, true);
      cd.setUint32(16, crc, true);
      cd.setUint32(20, data.length, true);
      cd.setUint32(24, data.length, true);
      cd.setUint16(28, name.length, true);
      cd.setUint32(42, offset, true);
      central.push(cd.buffer, name);
      offset += 30 + name.length + data.length;
    });
    var cdSize = central.reduce(function(s, p){ return s + (p.byteLength !== undefined ? p.byteLength : p.length); }, 0);
    var end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, files.length, true);
    end.setUint16(10, files.length, true);
    end.setUint32(12, cdSize, true);
    end.setUint32(16, offset, true);
    return new Blob(parts.concat(central, [end.buffer]), { type: "application/zip" });
  }

  function saveTextFile(opts){
    var ext = (opts.extensions && opts.extensions[0] && opts.extensions[0] !== "*") ? opts.extensions[0] : "";
    var name = String(opts.defaultName || "file");
    if(ext && !new RegExp("\\." + ext + "$", "i").test(name)){ name += "." + ext; }
    downloadBlob(new Blob([String(opts.text)], { type: "text/plain;charset=utf-8" }), name);
    return Promise.resolve(true);
  }

  function saveMarkdown(opts){
    var name = String(opts.defaultName || "航海日誌.md");
    if(!/\.md$/i.test(name)){ name += ".md"; }
    var images = Array.isArray(opts.images) ? opts.images : [];
    var base = name.replace(/\.md$/i, "");
    var dirName = base + "_images";
    var md = String(opts.md).split("{{IMGDIR}}").join(dirName);
    if(!images.length){
      downloadBlob(new Blob([md], { type: "text/markdown;charset=utf-8" }), name);
      return Promise.resolve(true);
    }
    var files = [{ name: sanitizeFileName(name), bytes: new TextEncoder().encode(md) }];
    images.forEach(function(img){
      files.push({ name: dirName + "/" + sanitizeFileName(img.name), bytes: new Uint8Array(img.bytes) });
    });
    downloadBlob(makeZip(files), base + ".zip");
    return Promise.resolve(true);
  }

  /* ---------------- print ---------------- */
  // Prints the A4 HTML through a hidden frame. On iPhone / iPad the print
  // sheet also offers saving as PDF (share button → "ファイルに保存").
  function printHtml(html){
    return new Promise(function(resolve, reject){
      var frame = document.createElement("iframe");
      frame.setAttribute("aria-hidden", "true");
      frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden;";
      var url = URL.createObjectURL(new Blob([String(html)], { type: "text/html;charset=utf-8" }));
      frame.onload = function(){
        // Give images a moment to decode before the print sheet snapshots the page.
        setTimeout(function(){
          try{
            frame.contentWindow.focus();
            frame.contentWindow.print();
            resolve(true);
          } catch(e){
            reject(codeError("print_failed", String(e && e.message || e)));
          }
          setTimeout(function(){ frame.remove(); URL.revokeObjectURL(url); }, 60 * 1000);
        }, 300);
      };
      frame.src = url;
      document.body.appendChild(frame);
    });
  }

  /* ---------------- API ---------------- */
  window.nisshi = {
    isWeb: true,

    status: function(){
      if(!CFG.clientId){
        return Promise.resolve({ configured: false, configPath: "web/config.js", configError: null, signedIn: false });
      }
      if(redirectError){
        var e = redirectError;
        redirectError = null;
        // initGate clears the error line first, so write it once the gate has settled.
        setTimeout(function(){
          var el = document.getElementById("gateError");
          if(!el){ return; }
          el.textContent = e === "auth_denied" ? "Googleでのアクセス許可がキャンセルされました。" : "Googleへのログインに失敗しました（" + e + "）。";
          el.style.display = "block";
        }, 0);
      }
      if(!tokenValid() && getItem(ls(), SIGNED_BEFORE_KEY) && !getItem(ss(), SILENT_TRIED_KEY)){
        // Logged in on this device before: try to get a new token without any taps.
        setItem(ss(), SILENT_TRIED_KEY, "1");
        return redirectToGoogle(true);
      }
      return Promise.resolve({ configured: true, configPath: "", configError: null, signedIn: tokenValid() });
    },
    openConfig: function(){ return Promise.reject(codeError("unsupported")); },
    importClientFile: function(){ return Promise.reject(codeError("unsupported")); },

    login: function(){
      if(!CFG.clientId){ return Promise.reject(codeError("not_configured")); }
      return redirectToGoogle(false);
    },
    cancelLogin: function(){ return Promise.resolve(); },
    logout: function(){
      // Only forgets the token on this device. Revoking it at Google would
      // also sign out the Windows app, which shares the same Google project.
      forgetToken();
      removeItem(ls(), SIGNED_BEFORE_KEY);
      folderId = null;
      journalId = null;
      return Promise.resolve();
    },

    loadJournal: loadJournal,
    saveJournal: saveJournal,
    createJournal: createJournal,
    uploadImage: uploadImage,
    downloadImage: downloadImage,
    trashFiles: trashFiles,

    pickDriveFiles: pickDriveFiles,
    cancelPick: cancelPick,
    openFile: openFile,

    saveTextFile: saveTextFile,
    saveMarkdown: saveMarkdown,
    printHtml: printHtml,
    savePdf: function(opts){ return printHtml(opts.html); }
  };

  /* ---------------- wording that differs from the Windows app ---------------- */
  function setText(id, text){ var el = document.getElementById(id); if(el){ el.textContent = text; } }
  var authText = document.querySelector("#gateAuthView .gate-text");
  if(authText){
    authText.textContent = "Googleドライブに接続します。ボタンを押すとGoogleの画面に移るので、Googleアカウントでログインしてアクセスを許可してください。許可するのは、このアプリが作ったファイルへのアクセスだけです。";
  }
  // The Windows-only controls stay in the page (app.js wires them up) but are hidden.
  var configView = document.getElementById("gateConfigView");
  if(configView){
    Array.prototype.forEach.call(configView.children, function(el){ el.style.display = "none"; });
    var note = document.createElement("p");
    note.className = "gate-text";
    note.textContent = "Web版の設定（GoogleのクライアントID）がまだ入っていません。";
    configView.insertBefore(note, configView.firstChild);
  }
  setText("btnLogout", "Googleとの接続を解除");
})();
