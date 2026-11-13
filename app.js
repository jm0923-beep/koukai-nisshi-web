(function(){
  "use strict";

  var api = window.nisshi;
  // v1.0.191: on iPhone / iPad (the web version) the records are only read. Writing there is the memo and the
  // TO DO list; no new record, no editor, no copy, no delete, no plan, category or tag changes.
  var READ_ONLY = !!(api && api.isWeb);
  // v1.0.197: Windows のアプリだけに付く目印。左の欄を広げる CSS（style.css 末尾）がこれを見る。
  if(!READ_ONLY){ document.documentElement.classList.add("desktop-app"); }
  // 記録の窓 (v1.0.216, Windows app only): this page shows one record in a window of its own (main.js
  // openRecordWindow). No list, sidebar, memo, lock or quit here; it gets the key from the main window.
  var RECORD_WIN = !!(api && api.records && /[?&]record=1(&|$)/.test(location.search));
  if(RECORD_WIN){ document.documentElement.classList.add("record-win"); }
  // The main window of the Windows app, which may open record windows.
  var CAN_OPEN_WINDOWS = !!(api && api.records) && !RECORD_WIN && !READ_ONLY;
  // v1.0.192: iPhone (and other phones) have no zoom buttons on the reading screen. iPad keeps them.
  var IS_PHONE = READ_ONLY && /iPhone|iPod|Android.+Mobile/i.test(navigator.userAgent || "");

  var THEME_KEY = "koukai_nisshi_theme";
  var MAX_IMAGE_BYTES = 500 * 1000;   // 添付画像1枚あたりの上限（500KB）
  var MAX_IMAGE_EDGE = 2400;          // 長辺がこれを超える画像は、まずこの大きさに縮小する
  var IMAGE_TYPES = ["image/png","image/jpeg","image/webp","image/gif","image/bmp"];

  function noop(){}

  /* ---------------- theme ---------------- */
  var savedTheme = null;
  try{ savedTheme = localStorage.getItem(THEME_KEY); } catch(e){}
  if(savedTheme){ document.documentElement.setAttribute("data-theme", savedTheme); }
  document.getElementById("themeToggle").addEventListener("click", function(){
    var current = document.documentElement.getAttribute("data-theme");
    var next;
    if(current === "dark"){ next = "light"; }
    else if(current === "light"){ next = "dark"; }
    else {
      var prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
      next = prefersDark ? "light" : "dark";
    }
    document.documentElement.setAttribute("data-theme", next);
    try{ localStorage.setItem(THEME_KEY, next); } catch(e){}
    // Category colours are resolved at render time; the editor is left alone
    // so switching themes never discards what is being typed.
    renderCategories();
    if(currentView !== "editor"){ renderMain(); }
  });

  /* ---------------- crypto helpers ---------------- */
  function bytesToB64(bytes){
    var bin = "";
    for(var i=0;i<bytes.length;i+=0x8000){
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i+0x8000));
    }
    return btoa(bin);
  }
  function bufToB64(buf){ return bytesToB64(new Uint8Array(buf)); }
  function b64ToBytes(b64){
    var bin = atob(b64);
    var bytes = new Uint8Array(bin.length);
    for(var i=0;i<bin.length;i++){ bytes[i] = bin.charCodeAt(i); }
    return bytes;
  }
  function b64ToBuf(b64){ return b64ToBytes(b64).buffer; }
  function randomBytes(len){
    var arr = new Uint8Array(len);
    crypto.getRandomValues(arr);
    return arr;
  }
  function genId(){
    if(crypto.randomUUID){ return crypto.randomUUID(); }
    return "id-" + Date.now() + "-" + Math.random().toString(16).slice(2);
  }

  function deriveKeyFromPassword(password, saltBytes){
    var enc = new TextEncoder();
    return crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]).then(function(keyMaterial){
      return crypto.subtle.deriveKey(
        { name:"PBKDF2", salt: saltBytes, iterations: 210000, hash:"SHA-256" },
        keyMaterial,
        { name:"AES-GCM", length:256 },
        // v1.0.216: the main window hands it (in memory, through main.js) to the record windows it opens.
        true,
        ["encrypt","decrypt"]
      );
    });
  }

  function encryptJson(key, obj){
    var enc = new TextEncoder();
    var iv = randomBytes(12);
    var data = enc.encode(JSON.stringify(obj));
    return crypto.subtle.encrypt({name:"AES-GCM", iv:iv}, key, data).then(function(cipherBuf){
      return { iv: bufToB64(iv), data: bufToB64(cipherBuf) };
    });
  }
  function decryptJson(key, blob){
    var dec = new TextDecoder();
    var iv = new Uint8Array(b64ToBuf(blob.iv));
    var cipherBuf = b64ToBuf(blob.data);
    return crypto.subtle.decrypt({name:"AES-GCM", iv:iv}, key, cipherBuf).then(function(plainBuf){
      return JSON.parse(dec.decode(plainBuf));
    });
  }

  // Images are stored as one binary file each: 12-byte IV followed by the AES-GCM ciphertext.
  function encryptBytes(key, bytes){
    var iv = randomBytes(12);
    return crypto.subtle.encrypt({name:"AES-GCM", iv:iv}, key, bytes).then(function(cipherBuf){
      var out = new Uint8Array(12 + cipherBuf.byteLength);
      out.set(iv, 0);
      out.set(new Uint8Array(cipherBuf), 12);
      return out;
    });
  }
  function decryptBytes(key, packed){
    var u = new Uint8Array(packed);
    return crypto.subtle.decrypt({name:"AES-GCM", iv:u.subarray(0,12)}, key, u.subarray(12)).then(function(plain){
      return new Uint8Array(plain);
    });
  }

  /* ---------------- default categories ---------------- */
  function defaultCategories(){
    return [
      { id:"cat-work",    name:"業務メモ", color:"cat-navy" },
      { id:"cat-draft",   name:"公開下書き",      color:"dusk" },
      { id:"cat-private", name:"プライベート",     color:"cat-orange" }
    ];
  }

  function resolveColor(token){
    if(!token){ token = "ink-faint"; }
    if(token.charAt(0) === "#" || token.indexOf("rgb") === 0){ return token; }
    var v = getComputedStyle(document.documentElement).getPropertyValue("--"+token).trim();
    return v || "#8B93A0";
  }

  /* ================================================================
     STORAGE BACKEND — Google Drive
     The whole journal lives in one JSON file on Drive with the same
     shape as the old app's encrypted backup:
       { version, salt, verifier, categories, entries:[{id,iv,data}],
         images:{ <imageId>: <Drive file id> } }
     Attached images are separate encrypted files on Drive; the journal
     only maps image ids to Drive file ids.
     Every change goes through persist(mutate): it applies `mutate` to a
     copy of the journal and uploads it. If another PC changed the file
     since we last read it, the fresh copy is pulled, decrypted, and the
     same mutation is re-applied on top of it before uploading again.
  ================================================================ */
  var doc = null;        // journal as stored on Drive (entries still encrypted)
  var docRev = null;     // Drive revision id of the journal we last read or wrote
  var writeChain = Promise.resolve();
  var pendingWrites = 0;

  function normalizeDoc(d){
    d = d || {};
    return {
      version: 2,
      salt: d.salt,
      verifier: d.verifier,
      categories: Array.isArray(d.categories) ? d.categories : defaultCategories(),
      entries: Array.isArray(d.entries) ? d.entries.map(function(e){ return { id:e.id, iv:e.iv, data:e.data }; }) : [],
      images: (d.images && typeof d.images === "object") ? d.images : {}
    };
  }

  // The save state in the top bar, as a cloud only (v1.0.126): turning arrows inside it while saving,
  // a tick when everything is on Drive, "!" when a save failed. The words are its tooltip.
  // The memo and the TO DO list count too: a change that is waiting or on its way shows as saving.
  var syncState = "";
  var SYNC_CLOUD = '<path class="sync-cloud" d="M7.5 19h9.25a4.25 4.25 0 0 0 .55-8.46 6 6 0 0 0-11.6 1.3A3.6 3.6 0 0 0 7.5 19z"/>';
  var SYNC_MARKS = {
    saving: '<g class="sync-spin"><path d="M9.2 13.6a3 3 0 0 1 5-2.3"/><path d="M14.8 14.4a3 3 0 0 1-5 2.3"/><path d="M14.4 9.9v1.6h-1.6"/><path d="M9.6 18.1v-1.6h1.6"/></g>',
    saved: '<path d="M9.3 14.4l1.9 1.9 3.6-3.8"/>',
    error: '<path d="M12 11.2v3"/><path d="M12 16.6v.1"/>'
  };
  var SYNC_WORDS = { saving: "保存中…", saved: "ドライブに保存済み", error: "保存できませんでした" };
  function setSync(state){
    syncState = state;
    showSync();
  }
  function showSync(){
    var el = document.getElementById("syncStatus");
    var state = syncState === "error" || (syncState && sheetsFailed()) ? "error" : syncState && sheetsBusy() ? "saving" : syncState;
    if(el.getAttribute("data-state") === state){ return; }   // keeps the arrows turning smoothly
    el.setAttribute("data-state", state);
    el.classList.toggle("error", state === "error");
    var words = state ? "☁ " + SYNC_WORDS[state] : "";
    el.title = words;
    el.setAttribute("aria-label", words);
    el.innerHTML = state ? '<svg viewBox="0 0 24 24" aria-hidden="true">' + SYNC_CLOUD + SYNC_MARKS[state] + '</svg>' : "";
  }

  function queueWrite(fn){
    pendingWrites++;
    setSync("saving");
    var job = writeChain.then(fn);
    writeChain = job.catch(noop);
    return job.then(function(r){
      pendingWrites--;
      if(!pendingWrites){ setSync("saved"); }
      return r;
    }, function(err){
      pendingWrites--;
      setSync("error");
      throw err;
    });
  }

  // salt: the journal's salt when the caller encrypted what `mutate` adds. If the passphrase was
  // changed on this PC since, that data is under the old key and could never be read again (a record
  // would stop the whole journal from opening), so the write is refused instead ("key_changed").
  function persist(mutate, salt){
    return queueWrite(function(){ return attemptWrite(mutate, false, salt); });
  }
  function attemptWrite(mutate, retried, salt){
    if(salt && doc.salt !== salt){ return Promise.reject({ code:"key_changed" }); }
    var next = JSON.parse(JSON.stringify(doc));
    mutate(next);
    return api.saveJournal(JSON.stringify(next), docRev).then(function(res){
      doc = next;
      docRev = res.revision;
      if(api.records){ api.records.changed(); }   // the other windows of this PC read it again (v1.0.216)
      if(retried){ showToast(api.records ? "ほかの窓・別のPCでの変更を取り込んでから保存しました" : "別のPCでの変更を取り込んでから保存しました"); }
    }, function(err){
      if(err && err.code === "conflict" && !retried){
        return refreshFromRemote().then(function(){ return attemptWrite(mutate, true, salt); });
      }
      throw err;
    });
  }

  function refreshFromRemote(){
    return api.loadJournal().then(function(res){
      if(!res.exists){ return Promise.reject({ code:"journal_missing" }); }
      var fresh = normalizeDoc(JSON.parse(res.content));
      if(fresh.salt !== doc.salt){ return Promise.reject({ code:"rekeyed" }); }
      return decryptEntriesWith(sessionKey, fresh.entries).then(function(list){
        doc = fresh;
        docRev = res.revision;
        liveEntries = list;
      });
    });
  }

  function upsertBlob(d, id, enc){
    var blob = { id:id, iv:enc.iv, data:enc.data };
    var idx = d.entries.findIndex(function(e){ return e.id === id; });
    if(idx >= 0){ d.entries[idx] = blob; } else { d.entries.push(blob); }
  }

  function errorMessage(err, fallback){
    var code = err && err.code;
    if(code === "network"){ return "Googleドライブに接続できませんでした。通信状況をご確認ください。"; }
    if(code === "conflict"){ return "別のPCで同時に更新されたため保存できませんでした。もう一度お試しください。"; }
    if(code === "journal_missing"){ return "Googleドライブ上の日誌ファイルが見つかりません。"; }
    if(code === "key_changed"){ return "合言葉の変更と重なったため保存できませんでした。もう一度保存してください。"; }
    // 動画ファイル (v1.0.201, video.js)
    if(code === "quota"){ return "Googleドライブの空きが足りないため、動画を送れませんでした。記録は保存していません。"; }
    if(code === "no_file" || code === "file_changed" || code === "too_large"){ return err.message + "（記録は保存していません）"; }
    if(code === "cancelled"){ return "動画を送るのをやめたため、記録は保存していません。"; }
    return fallback;
  }
  // Appends the technical reason so a screenshot of the toast is enough to diagnose a failure.
  function withDetail(message, err){
    var detail = err && (err.message || err.name);
    return detail ? message + "（" + String(detail).slice(0, 160) + "）" : message;
  }
  function handleWriteError(err, fallback){
    if(err && err.code === "rekeyed"){
      lockApp("別のPCで合言葉が変更されました。新しい合言葉でロックを解除してください。");
      return;
    }
    if(err && err.code === "reauth"){
      lockApp("Googleアカウントへの接続が切れました。もう一度ログインしてください。");
      return;
    }
    showToast(errorMessage(err, withDetail(fallback, err)), 6000);
  }

  function runSeq(items, fn){
    return items.reduce(function(p, item){ return p.then(function(){ return fn(item); }); }, Promise.resolve());
  }
  function values(obj){ return Object.keys(obj).map(function(k){ return obj[k]; }); }

  /* ---------------- app state ---------------- */
  var sessionKey = null;     // CryptoKey, only in memory
  var liveEntries = [];      // decrypted entries in memory
  var currentCategory = "all";
  var currentSearch = "";
  var currentDate = "";      // "YYYY-MM-DD" picked in the calendar, "" = every day
  var currentTags = [];      // tags picked in the sidebar: records must carry all of them
  var LIST_PAGE_SIZE = 10;   // records per page of the list (v1.0.112)
  var listPage = 1;          // 1 = the newest records
  var listPageKey = "";      // the filters listPage belongs to; a different filter starts again at page 1
  var calMonth = "";         // "YYYY-MM" shown in the calendar
  var currentView = "list";  // "list" | "editor" | "view"
  var openEntryId = null;
  var pendingEditorImages = null;   // stored images the next editor screen attaches as copies (「画像を別の記録へ」, v1.0.69)
  var pendingCopy = null;           // a whole record copied by 「この記録をコピー」 (v1.0.111): the next new editor starts from it
  var openPickers = [];             // close functions of the image pickers on screen; locking closes them (they show decrypted pictures)
  var pendingRestoreFromGate = false;
  var editorDirty = false;
  var editorSave = null;     // saves the open editor; set by renderEditor
  // The editor's save on its way (v1.0.175): since v1.0.172 a save first waits up to 5 seconds for the pictures
  // of videos, and meanwhile the editor still counted as not saved. Locking or leaving then asked about unsaved
  // changes and the save ran after the lock (an error), and 「保存して終了」 saved a new record a second time.
  // Now a second save joins the one running, and leaving, locking and quitting wait for it (waitEditorSave).
  var editorSaving = null, afterEditorSave = null;
  function waitEditorSave(fn){
    if(!(currentView === "editor" && editorSaving)) return false;
    var first = !afterEditorSave;
    afterEditorSave = fn;   // clicked again meanwhile: only the last one goes on
    if(first){
      showToast("保存が終わるのを待っています…", 4000);
      editorSaving.then(noop, noop).then(function(){
        var f = afterEditorSave;
        afterEditorSave = null;
        if(f){ f(); }
      });
    }
    return true;
  }
  var activeRich = null;     // the body editor while the editor is open (rich-editor.js)
  function closeRich(){
    if(activeRich){ activeRich.destroy(); activeRich = null; }
  }

  /* ---------------- toast ---------------- */
  var toastTimer = null;
  function showToast(msg, ms){
    var el = document.getElementById("toast");
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function(){ el.classList.remove("show"); }, ms || 2600);
  }

  /* ---------------- gate flow ---------------- */
  var gateEl = document.getElementById("gate");
  var appEl = document.getElementById("app");
  var gateError = document.getElementById("gateError");
  var gateStages = {
    loading: document.getElementById("gateLoading"),
    fatal:   document.getElementById("gateFatal"),
    config:  document.getElementById("gateConfigView"),
    auth:    document.getElementById("gateAuthView"),
    setup:   document.getElementById("gateSetupView"),
    unlock:  document.getElementById("gateUnlockView"),
    closed:  document.getElementById("gateClosedView")
  };
  var gateStage = "loading";

  function showGateError(msg){
    gateError.textContent = msg;
    gateError.style.display = "block";
  }
  function clearGateError(){
    gateError.style.display = "none";
    gateError.textContent = "";
  }
  function setGateStage(stage, loadingText){
    gateStage = stage;
    Object.keys(gateStages).forEach(function(k){
      gateStages[k].style.display = k === stage ? "block" : "none";
    });
    document.getElementById("gateLoadingText").textContent = loadingText || "確認しています…";
    if(stage === "unlock"){ setTimeout(function(){ document.getElementById("unlockPw").focus(); }, 0); }
    if(stage === "setup"){ setTimeout(function(){ document.getElementById("setupPw1").focus(); }, 0); }
  }

  function initGate(message){
    clearGateError();
    setGateStage("loading");
    api.status().then(function(st){
      if(!st.configured){
        document.getElementById("configPathLabel").textContent = st.configPath;
        setGateStage("config");
        if(st.configError){ showGateError(st.configError); }
        return;
      }
      if(!st.signedIn){
        setGateStage("auth");
        return;
      }
      return openJournal();
    }).then(function(){
      if(message){ showGateError(message); }
    }).catch(handleGateFailure);
  }

  function openJournal(){
    setGateStage("loading", "Googleドライブから日誌を読み込んでいます…");
    return api.loadJournal().then(function(res){
      if(res.exists){
        doc = normalizeDoc(JSON.parse(res.content));
        docRev = res.revision;
        setGateStage(doc.verifier ? "unlock" : "setup");
      } else {
        doc = null;
        docRev = null;
        setGateStage("setup");
      }
    });
  }

  function handleGateFailure(err){
    var code = err && err.code;
    if(code === "reauth"){
      setGateStage("auth");
      showGateError("Googleアカウントへの接続が切れました。もう一度ログインしてください。");
      return;
    }
    if(code === "bad_client"){
      api.status().then(function(st){
        document.getElementById("configPathLabel").textContent = st.configPath;
      }).catch(noop);
      setGateStage("config");
      showGateError("クライアントIDまたはシークレットがGoogleに受け付けられませんでした。設定ファイルの内容をご確認ください。");
      return;
    }
    // A genuine read failure must never be treated as "no journal yet" —
    // doing so could lead to overwriting an existing journal with a new
    // setup. Show a retry state instead.
    document.getElementById("gateFatalDetail").textContent = (err && err.message) ? err.message : "";
    setGateStage("fatal");
  }

  document.getElementById("gateRetryBtn").addEventListener("click", function(){ initGate(); });
  document.getElementById("reloadConfigBtn").addEventListener("click", function(){ initGate(); });
  var importClientBtn = document.getElementById("importClientBtn");
  importClientBtn.addEventListener("click", function(){
    clearGateError();
    importClientBtn.disabled = true;
    api.importClientFile().then(function(imported){
      if(imported){ initGate(); }
    }).catch(function(err){
      showGateError((err && err.code === "bad_client_file" && err.message) ? err.message : "ファイルを読み込めませんでした。");
    }).then(function(){ importClientBtn.disabled = false; });
  });
  document.getElementById("openConfigBtn").addEventListener("click", function(){
    api.openConfig().catch(function(){ showGateError("設定ファイルを開けませんでした。上のパスをエクスプローラーで開いてください。"); });
  });

  var loginBtn = document.getElementById("loginBtn");
  var authWaiting = document.getElementById("authWaiting");
  loginBtn.addEventListener("click", function(){
    clearGateError();
    loginBtn.disabled = true;
    authWaiting.style.display = "block";
    api.login().then(function(){
      return openJournal();
    }).catch(function(err){
      var code = err && err.code;
      if(code === "auth_cancelled"){ return; }
      if(code === "auth_denied"){ showGateError("Googleでのアクセス許可がキャンセルされました。"); return; }
      if(code === "auth_timeout"){ showGateError("時間内に認証が完了しませんでした。もう一度お試しください。"); return; }
      if(gateStage === "auth" && code !== "bad_client"){
        showGateError("Googleへのログインに失敗しました。" + (err && err.message ? "（" + err.message + "）" : ""));
        return;
      }
      handleGateFailure(err);
    }).then(function(){
      loginBtn.disabled = false;
      authWaiting.style.display = "none";
    });
  });
  document.getElementById("cancelLoginBtn").addEventListener("click", function(){ api.cancelLogin(); });

  var setupBtn = document.getElementById("setupSubmit");
  setupBtn.addEventListener("click", function(){
    clearGateError();
    var pw1 = document.getElementById("setupPw1").value;
    var pw2 = document.getElementById("setupPw2").value;
    if(!pw1 || pw1.length < 4){ showGateError("4文字以上の合言葉を決めてください。"); return; }
    if(pw1 !== pw2){ showGateError("2つの入力が一致しません。"); return; }
    setupBtn.disabled = true;
    var salt = randomBytes(16);
    deriveKeyFromPassword(pw1, salt).then(function(key){
      return encryptJson(key, { ok:true, createdAt: new Date().toISOString() }).then(function(verifier){
        var fresh = normalizeDoc({ salt: bufToB64(salt), verifier: verifier, categories: defaultCategories() });
        return api.createJournal(JSON.stringify(fresh)).then(function(res){
          doc = fresh;
          docRev = res.revision;
          sessionKey = key;
          liveEntries = [];
          document.getElementById("setupPw1").value = "";
          document.getElementById("setupPw2").value = "";
          enterApp();
        });
      });
    }).catch(function(err){
      if(err && err.code === "reauth"){ handleGateFailure(err); return; }
      showGateError(errorMessage(err, "初期化に失敗しました。もう一度お試しください。"));
    }).then(function(){ setupBtn.disabled = false; });
  });

  var unlockBtn = document.getElementById("unlockSubmit");
  unlockBtn.addEventListener("click", function(){
    clearGateError();
    var pw = document.getElementById("unlockPw").value;
    if(!pw){ showGateError("合言葉を入力してください。"); return; }
    unlockBtn.disabled = true;
    var salt = new Uint8Array(b64ToBuf(doc.salt));
    deriveKeyFromPassword(pw, salt).then(function(key){
      return decryptJson(key, doc.verifier).then(function(){
        sessionKey = key;
      }, function(){
        return Promise.reject({ reason:"wrongPassword" });
      });
    }).then(function(){
      return decryptAllEntries().catch(function(){
        return Promise.reject({ reason:"loadFailed" });
      });
    }).then(function(){
      document.getElementById("unlockPw").value = "";
      enterApp();
    }).catch(function(err){
      sessionKey = null;
      if(err && err.reason === "loadFailed"){
        showGateError("記録の復号に失敗しました。日誌ファイルが壊れている可能性があります。");
      } else {
        showGateError("合言葉が正しくないようです。");
      }
    }).then(function(){ unlockBtn.disabled = false; });
  });

  function submitOnEnter(inputId, button){
    document.getElementById(inputId).addEventListener("keydown", function(e){
      if(e.key === "Enter" && !e.isComposing){ button.click(); }
    });
  }
  submitOnEnter("unlockPw", unlockBtn);
  submitOnEnter("setupPw2", setupBtn);

  document.getElementById("showRestoreFromGate").addEventListener("click", function(){
    pendingRestoreFromGate = true;
    document.getElementById("fileInput").click();
  });
  document.getElementById("showRestoreFromSetup").addEventListener("click", function(){
    pendingRestoreFromGate = true;
    document.getElementById("fileInput").click();
  });

  function decryptAllEntries(){
    return decryptEntriesWith(sessionKey, doc.entries).then(function(list){ liveEntries = list; });
  }

  function enterApp(){
    hideAllPasswords();
    gateEl.style.display = "none";
    appEl.style.display = "block";
    setSync("saved");
    renderCategories();
    currentView = "list";
    currentCategory = "all";
    currentDate = "";
    currentTags = [];
    renderMain();
    renameOldCategories();
    sideTodoFailed = false;
    renderSideTodo();
    // A change the lock sent may still be on its way (unlocked again at once): read each sheet after it has
    // reached Drive (v1.0.138). Read before, the older file was shown, and the next change saved over the newer one.
    SHEETS.forEach(function(s){
      var key = sessionKey;
      s.chain.then(function(){ if(key === sessionKey){ return loadSheet(s); } }).catch(noop).then(function(){
        if(s === todo && key === sessionKey && !todo.ready){ sideTodoFailed = true; renderSideTodo(); }
      });
    });
    prefetchRecentImages();
  }

  // Windows app only: after unlocking, fetch the images of the most recently written records in the
  // background (they are kept on this PC, still encrypted), so opening a record with many images is fast
  // even the first time on this PC. Newest records first, at most 300 images.
  function prefetchRecentImages(){
    if(!api.prefetchImages || !doc || !doc.images) return;
    var ids = [];
    liveEntries.slice().sort(function(a, b){
      return (b.updatedAt || b.date || "").localeCompare(a.updatedAt || a.date || "");
    }).forEach(function(e){
      (e.images || []).forEach(function(img){
        var fileId = doc.images[img.id];
        if(fileId && ids.length < 300 && ids.indexOf(fileId) < 0){ ids.push(fileId); }
      });
    });
    if(ids.length){ api.prefetchImages(ids).catch(noop); }
  }

  // Category names the owner asked to change after journals were already created with them.
  var CATEGORY_RENAMES = { "業務メモ（FX）": "業務メモ" };
  // Colours the owner chose later: 業務 bright navy, プライベート orange (only the old default colours are replaced).
  var CATEGORY_RECOLORS = { "cat-work": { from: "brass", to: "cat-navy" }, "cat-private": { from: "teal", to: "cat-orange" } };
  function staleCategory(c){
    var rc = CATEGORY_RECOLORS[c.id];
    return CATEGORY_RENAMES[c.name] || (rc && c.color === rc.from);
  }
  function renameOldCategories(){
    var stale = (doc.categories || []).some(staleCategory);
    if(!stale) return;
    persist(function(d){
      d.categories.forEach(function(c){
        if(CATEGORY_RENAMES[c.name]){ c.name = CATEGORY_RENAMES[c.name]; }
        var rc = CATEGORY_RECOLORS[c.id];
        if(rc && c.color === rc.from){ c.color = rc.to; }
      });
    }).then(function(){
      renderCategories();
      if(currentView !== "editor"){ renderMain(); }
    }).catch(noop);
  }

  // stage "closed": show the "終了しました" card instead of asking for the passphrase.
  function lockApp(message, stage){
    // A record window (v1.0.216) has no gate of its own: it goes (the passphrase was changed elsewhere, Google
    // signed out). The main window says why when it is used next.
    // With writing not saved yet it stays (Google signed out: after the main window's login a save here works again).
    if(RECORD_WIN){
      if(window.__nisshiBusy()){
        showToast((message ? message + " " : "") + "この窓の書きかけは残っています。本体の窓でロックを解除してから、この窓でもう一度「保存する」を押してください。", 12000);
        return;
      }
      window.ImageEditor.closeWindow();
      closeVideoPlayer();
      sessionKey = null;
      editorDirty = false;
      appEl.style.display = "none";
      api.records.closeSelf().catch(function(){ try { window.close(); } catch(e){} });
      return;
    }
    // The record windows go with the lock (the lock and quit buttons have asked about them first:
    // recordWindowsFirst). One with writing not saved stays only when the app locks by itself (Google signed out).
    if(CAN_OPEN_WINDOWS){ api.records.closeAll(false).catch(noop); api.records.claim(null); }
    // The editor window shows a decrypted picture: it goes with the lock.
    window.ImageEditor.closeWindow();
    // A playing YouTube video (v1.0.171) would go on sounding behind the lock screen (its window, v1.0.173).
    closeVideoPlayer();
    forgetVideos();   // 動画ファイル (v1.0.201): their keys, and an upload still running
    SHEETS.forEach(resetSheet);
    openPickers.slice().forEach(function(close){ close(); });
    sessionKey = null;
    setSideOpen(false);   // the ☰ drawer (v1.0.206)
    resetSites();
    renderSideTodo();   // empty: the items go with the lock
    editorSave = null;
    editorSaving = afterEditorSave = null;   // a save waiting for video pictures gives up (doSave)
    closeRich();
    liveEntries = [];
    openEntryId = null;
    pendingEditorImages = null;
    pendingCopy = null;
    currentView = "list";
    editorDirty = false;
    clearImageCache();
    document.getElementById("unlockPw").value = "";
    hideAllPasswords();
    appEl.style.display = "none";
    gateEl.style.display = "flex";
    if(stage === "closed"){
      clearGateError();
      setGateStage("closed");
      return;
    }
    initGate(message);
  }

  document.getElementById("lockBtn").addEventListener("click", function(){
    guardLeave(function(){ recordWindowsFirst("ロック", function(){ lockApp(); }); });
  });

  // Before the main window locks, quits, or changes the whole journal (passphrase, backup) (v1.0.216): the
  // record windows close; one with something not saved comes to the front and is asked about here.
  // what: 「ロック」「終了」… as in 「保存せずにロックする」.
  function recordWindowsFirst(what, go){
    if(!CAN_OPEN_WINDOWS){ go(); return; }
    api.records.closeAll(false).then(function(left){
      if(!left){ go(); return; }
      openConfirmModal("別の窓に、保存していない記録があります",
        "その窓を前に出しました。保存してから、もう一度" + what + "してください。このまま" + what + "すると、その窓の保存していない内容は失われます。",
        function(){ api.records.closeAll(true).catch(noop).then(go); }, "保存せずに" + what + "する", true);
    }, function(){ go(); });
  }

  /* ---------------- quit ---------------- */
  // Saves (or, if the user chooses, discards) the open editor, waits for every
  // write to reach Drive, then closes: the Windows app quits; the web version
  // locks and says it is safe to close the page (a browser tab cannot close itself).
  document.getElementById("quitBtn").addEventListener("click", function(){
    recordWindowsFirst("終了", onQuit);   // the record windows first (v1.0.216)
  });
  function onQuit(){
    if(waitEditorSave(onQuit)) return;   // a save on its way first (v1.0.175)
    if(currentView === "editor" && editorDirty){
      var wrap = document.createElement("div");
      wrap.className = "modal-backdrop";
      wrap.innerHTML =
        '<div class="modal">' +
          '<h3>保存していない変更があります</h3>' +
          '<p class="help">編集中の記録を保存してから終了しますか？</p>' +
          '<div class="modal-actions quit-actions">' +
            '<button class="btn btn-ghost btn-small" id="quitCancel">キャンセル</button>' +
            '<button class="btn btn-danger btn-small" id="quitDiscard">保存せずに終了</button>' +
            '<button class="btn btn-primary btn-small" id="quitSave">保存して終了</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(wrap);
      wrap.querySelector("#quitCancel").addEventListener("click", function(){ wrap.remove(); });
      wrap.querySelector("#quitDiscard").addEventListener("click", function(){
        wrap.remove();
        editorDirty = false;
        finishQuit();
      });
      wrap.querySelector("#quitSave").addEventListener("click", function(){
        wrap.remove();
        editorSave().then(finishQuit, function(err){
          if(err && err.code === "busy"){ showToast("画像の処理が終わってから、もう一度お試しください。", 4000); }
        });
      });
      return;
    }
    finishQuit();
  }

  function finishQuit(){
    var busy = document.createElement("div");
    busy.className = "modal-backdrop";
    busy.innerHTML = '<div class="modal"><p class="quit-busy">Googleドライブへの保存を確かめています…</p></div>';
    document.body.appendChild(busy);
    // Changes in the memo and TO DO windows that have not been sent yet go first.
    SHEETS.forEach(function(s){ keepTyped(s); if(s.timer){ flushSheet(s); } });
    Promise.all(SHEETS.map(function(s){ return s.chain; })).then(function(){ return writeChain; }).then(function(){
      busy.remove();
      if(pendingWrites > 0 || sheetsFailed() || document.getElementById("syncStatus").classList.contains("error")){
        openConfirmModal("保存できていない内容があるかもしれません",
          "直前の保存に失敗しています。このまま終了すると、その内容は失われます。通信状況を確かめて、もう一度保存することをおすすめします。",
          closeApp, "それでも終了する");
        return;
      }
      closeApp();
    });
  }
  function closeApp(){
    if(typeof api.quit === "function"){
      editorDirty = false;
      api.quit();
      return;
    }
    lockApp(null, "closed");
    try { window.close(); } catch(e){}
  }
  document.getElementById("reopenBtn").addEventListener("click", function(){ initGate(); });

  /* ---------------- categories ---------------- */
  function catById(id){
    return (doc.categories || []).filter(function(c){ return c.id === id; })[0];
  }
  function catName(id){
    var c = catById(id);
    return c ? c.name : "未分類";
  }
  function catColor(id){
    var c = catById(id);
    return c ? c.color : "ink-faint";
  }

  function renderCategories(){
    if(!sessionKey){ return; }
    var list = document.getElementById("catList");
    var counts = {};
    liveEntries.forEach(function(e){ counts[e.category] = (counts[e.category]||0)+1; });
    var html = "";
    html += '<li class="cat-item '+(currentCategory==="all"?"active":"")+'" data-cat="all">' +
              '<span class="cat-dot" style="background:var(--ink-faint)"></span>' +
              '<span class="cat-name">すべて</span>' +
              '<span class="cat-count">'+liveEntries.length+'</span></li>';
    (doc.categories||[]).forEach(function(c){
      html += '<li class="cat-item '+(currentCategory===c.id?"active":"")+'" data-cat="'+escapeHtml(c.id)+'">' +
                '<span class="cat-dot" style="background:'+resolveColor(c.color)+'"></span>' +
                '<span class="cat-name">'+escapeHtml(c.name)+'</span>' +
                '<span class="cat-count">'+(counts[c.id]||0)+'</span>' +
                '<button type="button" class="cat-del" data-del="'+escapeHtml(c.id)+'" title="このカテゴリを削除" aria-label="カテゴリ「'+escapeHtml(c.name)+'」を削除">×</button></li>';
    });
    list.innerHTML = html;
    Array.prototype.forEach.call(list.querySelectorAll(".cat-del"), function(b){
      b.addEventListener("click", function(ev){
        ev.stopPropagation();
        confirmDeleteCategory(b.getAttribute("data-del"));
      });
    });
    Array.prototype.forEach.call(list.querySelectorAll(".cat-item"), function(item){
      item.addEventListener("click", function(){
        guardLeave(function(){
          currentCategory = item.getAttribute("data-cat");
          currentDate = "";
          currentView = "list";
          renderCategories();
          renderMain();
        });
      });
    });
    renderCalendar();
    renderTags();
  }

  /* ---------------- calendar (sidebar) ---------------- */
  // A small month calendar under the categories. Days with records are marked;
  // pointing at one shows the titles, choosing one lists that day's records.
  var WEEKDAYS = ["日","月","火","水","木","金","土"];
  // Open from the start: since v1.0.206 a phone shows it in the ☰ drawer, which has the room
  // (it was folded there because it sat above the list).
  var calCollapsed = false;

  function entriesByDate(){
    var by = {};
    liveEntries.forEach(function(e){ (by[e.date] = by[e.date] || []).push(e); });
    return by;
  }
  function pad2(n){ return String(n).padStart(2, "0"); }

  // One month: its name, then the grid of days. A day with records is bold, a day with plans (v1.0.154) is underlined in blue (v1.0.156).
  function calMonthHtml(y, m, by, today){
    var planned = plans.ready ? plans.value : {};
    var first = new Date(y, m - 1, 1).getDay();
    var days = new Date(y, m, 0).getDate();
    var html = '<p class="cal-month">'+y+'年'+m+'月</p><div class="cal-grid">';
    WEEKDAYS.forEach(function(w, i){ html += '<span class="cal-wd'+(i===0?" sun":i===6?" sat":"")+'">'+w+'</span>'; });
    for(var i = 0; i < first; i++){ html += '<span class="cal-blank"></span>'; }
    for(var d = 1; d <= days; d++){
      var key = y + "-" + pad2(m) + "-" + pad2(d);
      var cls = "cal-day" + (by[key] ? " has" : "") + (planned[key] ? " plan" : "") + (key === today ? " today" : "") + (key === currentDate ? " on" : "");
      var dow = (first + d - 1) % 7;
      if(dow === 0){ cls += " sun"; } else if(dow === 6){ cls += " sat"; }
      html += '<button type="button" class="'+cls+'" data-date="'+key+'">'+d+'</button>';
    }
    return html + '</div>';
  }

  // The month before calMonth on top, then calMonth (v1.0.116), then the month after it (v1.0.154, for plans).
  // ‹ › move all three by a month.
  function renderCalendar(){
    var box = document.getElementById("miniCal");
    if(!box || !sessionKey) return;
    if(!calMonth){ calMonth = (currentDate || todayStr()).slice(0, 7); }
    var y = Number(calMonth.slice(0, 4)), m = Number(calMonth.slice(5, 7));
    var py = m === 1 ? y - 1 : y, pm = m === 1 ? 12 : m - 1;
    var ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1;
    var by = entriesByDate();
    var today = todayStr();
    var html = '<div class="cal-head">' +
                 '<button type="button" class="cal-toggle" id="calToggle">📅 カレンダー <span>'+(calCollapsed ? "▸" : "▾")+'</span></button>' +
                 (calCollapsed ? '' :
                   '<span class="cal-nav">' +
                     '<button type="button" class="cal-move" data-move="-1" title="前の月">‹</button>' +
                     '<button type="button" class="cal-move" data-move="1" title="次の月">›</button>' +
                   '</span>') +
               '</div>';
    if(!calCollapsed){
      html += calMonthHtml(py, pm, by, today) + calMonthHtml(y, m, by, today) + calMonthHtml(ny, nm, by, today);
    }
    box.innerHTML = html;

    document.getElementById("calToggle").addEventListener("click", function(){
      calCollapsed = !calCollapsed;
      renderCalendar();
    });
    Array.prototype.forEach.call(box.querySelectorAll(".cal-move"), function(b){
      b.addEventListener("click", function(){
        var dt = new Date(y, m - 1 + Number(b.getAttribute("data-move")), 1);
        calMonth = dt.getFullYear() + "-" + pad2(dt.getMonth() + 1);
        renderCalendar();
      });
    });
    Array.prototype.forEach.call(box.querySelectorAll(".cal-day"), function(b){
      var key = b.getAttribute("data-date");
      b.addEventListener("mouseenter", function(){ showCalTip(b, by[key], plans.ready ? plans.value[key] : null); });
      b.addEventListener("mouseleave", hideCalTip);
      b.addEventListener("click", function(){
        hideCalTip();
        guardLeave(function(){
          currentDate = currentDate === key ? "" : key;
          currentCategory = "all";
          currentView = "list";
          renderCategories();
          renderMain();
        });
      });
    });
  }

  /* ---------------- tags ---------------- */
  // entry.tags: free words chosen by the owner. The sidebar lists every tag in use;
  // picking tags narrows the list to records carrying all of them.
  function cleanTag(s){ return String(s || "").replace(/^[#＃\s]+/, "").replace(/\s+/g, " ").trim().slice(0, 30); }
  function tagCounts(){
    var counts = {};
    liveEntries.forEach(function(e){ (e.tags || []).forEach(function(t){ counts[t] = (counts[t] || 0) + 1; }); });
    return counts;
  }
  function allTags(){
    var counts = tagCounts();
    return Object.keys(counts).sort(function(a, b){ return counts[b] - counts[a] || a.localeCompare(b, "ja"); });
  }
  function tagChips(tags, cls){
    return (tags || []).map(function(t){
      return '<button type="button" class="tag-chip '+(cls || "")+'" data-tag="'+escapeHtml(t)+'">#'+escapeHtml(t)+'</button>';
    }).join("");
  }
  // Picking a tag (from the sidebar or a record) shows the list narrowed by it.
  function toggleTag(t, only){
    if(RECORD_WIN){ return; }   // a record window has no list to narrow (v1.0.216)
    guardLeave(function(){
      var i = currentTags.indexOf(t);
      if(only){ currentTags = [t]; }
      else if(i >= 0){ currentTags.splice(i, 1); }
      else { currentTags.push(t); }
      currentView = "list";
      renderCategories();
      renderMain();
    });
  }
  function renderTags(){
    var box = document.getElementById("sideTags");
    if(!box || !sessionKey) return;
    var counts = tagCounts();
    var tags = allTags();
    currentTags = currentTags.filter(function(t){ return counts[t]; });
    if(!tags.length){ box.innerHTML = ""; return; }
    box.innerHTML = '<p class="side-section-label">タグ</p><div class="tag-list">' + tags.map(function(t){
      return '<button type="button" class="tag-chip side'+(currentTags.indexOf(t) >= 0 ? " on" : "")+'" data-tag="'+escapeHtml(t)+'">#'+escapeHtml(t)+
             ' <span class="tag-count">'+counts[t]+'</span></button>';
    }).join("") + '<button type="button" class="tag-manage" id="tagManageBtn" title="タグの名前を直す・削除する">✎ タグを編集</button></div>';
    Array.prototype.forEach.call(box.querySelectorAll(".tag-chip"), function(b){
      b.addEventListener("click", function(){ toggleTag(b.getAttribute("data-tag")); });
    });
    document.getElementById("tagManageBtn").addEventListener("click", function(){
      // The editor keeps its own copy of the record's tags, so leave it before changing tags everywhere.
      guardLeave(function(){
        if(currentView === "editor"){ currentView = "list"; renderMain(); }
        openTagManager();
      });
    });
  }

  // Renames or removes a tag on every record. `from` is the old tag; `to` is the new
  // name, or "" to take the tag off. A record that already has `to` keeps it once.
  function retagAll(from, to){
    return queueWrite(function(){ return attemptRetag(from, to, false); });
  }
  function attemptRetag(from, to, retried){
    var changed = liveEntries.filter(function(e){ return (e.tags || []).indexOf(from) >= 0; }).map(function(e){
      var tags = [];
      e.tags.forEach(function(t){
        var n = t === from ? to : t;
        if(n && tags.indexOf(n) < 0){ tags.push(n); }
      });
      return Object.assign({}, e, { tags: tags });
    });
    if(!changed.length){ return Promise.resolve(0); }
    return Promise.all(changed.map(function(e){ return encryptJson(sessionKey, entryPayload(e)); })).then(function(encs){
      var next = JSON.parse(JSON.stringify(doc));
      changed.forEach(function(e, i){ upsertBlob(next, e.id, encs[i]); });
      return api.saveJournal(JSON.stringify(next), docRev).then(function(res){
        doc = next;
        docRev = res.revision;
        changed.forEach(upsertLive);
        if(api.records){ api.records.changed(); }   // the other windows read it again, as after persist (v1.0.223)
        if(retried){ showToast("別のPCでの変更を取り込んでから保存しました"); }
        return changed.length;
      }, function(err){
        // Another PC saved in between: reload, then apply the change to the fresh records.
        if(err && err.code === "conflict" && !retried){
          return refreshFromRemote().then(function(){ return attemptRetag(from, to, true); });
        }
        throw err;
      });
    });
  }

  function openTagManager(){
    var wrap = document.createElement("div");
    wrap.className = "modal-backdrop";
    document.body.appendChild(wrap);
    var busy = false;

    function draw(){
      var counts = tagCounts();
      var tags = allTags();
      wrap.innerHTML =
        '<div class="modal tag-manager">' +
          '<h3>タグの編集</h3>' +
          '<p class="help">名前を直して「変更」を押すと、そのタグが付いたすべての記録で名前が変わります。すでにあるタグの名前にすると、2つのタグが1つにまとまります。' +
            '「削除」を押すと、すべての記録からそのタグが外れます（記録そのものは消えません）。</p>' +
          (tags.length ? '<div class="tag-rows">' + tags.map(function(t, i){
            return '<div class="tag-row" data-i="'+i+'">' +
                     '<span class="tag-row-hash">#</span>' +
                     '<input type="text" class="tag-row-input" maxlength="30" value="'+escapeHtml(t)+'" data-tag="'+escapeHtml(t)+'" aria-label="タグの名前">' +
                     '<span class="tag-row-count">'+counts[t]+'件</span>' +
                     '<button type="button" class="btn btn-ghost btn-small tag-row-rename" disabled>変更</button>' +
                     '<button type="button" class="btn btn-ghost btn-small tag-row-delete">削除</button>' +
                   '</div>';
          }).join("") + '</div>' : '<p class="help">タグが付いた記録はありません。</p>') +
          '<div class="modal-actions"><button class="btn btn-primary btn-small" id="tagManagerClose">閉じる</button></div>' +
        '</div>';
      wrap.querySelector("#tagManagerClose").addEventListener("click", function(){ if(!busy){ wrap.remove(); } });
      Array.prototype.forEach.call(wrap.querySelectorAll(".tag-row"), function(row){
        var input = row.querySelector(".tag-row-input");
        var old = input.getAttribute("data-tag");
        var renameBtn = row.querySelector(".tag-row-rename");
        input.addEventListener("input", function(){
          var n = cleanTag(input.value);
          renameBtn.disabled = !n || n === old;
        });
        input.addEventListener("keydown", function(e){
          if(e.key === "Enter" && !e.isComposing && !renameBtn.disabled){ e.preventDefault(); renameBtn.click(); }
        });
        renameBtn.addEventListener("click", function(){
          var n = cleanTag(input.value);
          if(!n || n === old){ return; }
          if(counts[n]){
            openConfirmModal("「#" + n + "」とまとめますか？",
              "「#" + n + "」はすでにあります。「#" + old + "」が付いた" + counts[old] + "件の記録は「#" + n + "」に変わり、2つのタグが1つになります。",
              function(){ apply(old, n, "「#" + old + "」を「#" + n + "」にまとめました"); }, "まとめる", false);
          } else {
            apply(old, n, "タグの名前を「#" + n + "」に変えました");
          }
        });
        row.querySelector(".tag-row-delete").addEventListener("click", function(){
          openConfirmModal("「#" + old + "」を削除しますか？",
            "このタグが付いた" + counts[old] + "件の記録から「#" + old + "」を外します。記録そのものは消えません。",
            function(){ apply(old, "", "「#" + old + "」を削除しました"); });
        });
      });
    }

    function apply(from, to, doneText){
      busy = true;
      Array.prototype.forEach.call(wrap.querySelectorAll("button, input"), function(el){ el.disabled = true; });
      retagAll(from, to).then(function(){
        // Keep the sidebar filter pointing at the renamed tag.
        currentTags = currentTags.map(function(t){ return t === from ? to : t; })
          .filter(function(t, i, a){ return t && a.indexOf(t) === i; });
        renderCategories();
        renderMain();
        showToast(doneText);
      }).catch(function(err){
        handleWriteError(err, "タグを保存できませんでした。通信状況をご確認ください。");
      }).then(function(){
        busy = false;
        if(!sessionKey){ wrap.remove(); return; }   // locked by an error
        draw();
      });
    }

    draw();
  }

  var calTip = null;
  // The day's plans (v1.0.154) first, then the titles of its records.
  function showCalTip(anchor, entries, dayPlans){
    hideCalTip();
    entries = entries || [];
    dayPlans = dayPlans || [];
    if(!entries.length && !dayPlans.length) return;
    calTip = document.createElement("div");
    calTip.className = "cal-tip";
    var planRows = dayPlans.slice(0, 6), shown = entries.slice(0, Math.max(2, 8 - planRows.length));
    calTip.innerHTML = planRows.map(function(p){
      return '<div class="cal-tip-row cal-tip-plan"><span class="cal-tip-dot"></span>' +
             (p.time ? '<span class="cal-tip-time mono">' + escapeHtml(p.time) + '</span>' : '') +
             '<span class="cal-tip-title">' + escapeHtml(p.text) + '</span></div>';
    }).join("") + (dayPlans.length > planRows.length ? '<div class="cal-tip-more">予定はほか '+(dayPlans.length - planRows.length)+' 件</div>' : '') +
    (planRows.length && shown.length ? '<div class="cal-tip-sep"></div>' : '') +
    shown.map(function(e){
      return '<div class="cal-tip-row"><span class="cal-tip-dot" style="background:'+resolveColor(catColor(e.category))+'"></span>' +
             '<span class="cal-tip-title">' + escapeHtml(e.title || "（無題）") + '</span>' + attachBadges(e) +
             (function(v){ return v.length ? listVideoThumbHtml(e, v) : ""; })(videoIdsIn(e.body)) + '</div>';   // v1.0.188
    }).join("") + (entries.length > shown.length ? '<div class="cal-tip-more">ほか '+(entries.length - shown.length)+' 件</div>' : '');
    document.body.appendChild(calTip);
    loadListVideoThumbs(calTip);
    // To the right of the day, where the mouse pointer (which hangs down and to the right) is not.
    // Above the day when there is no room on the right (narrow screens).
    var r = anchor.getBoundingClientRect();
    var w = calTip.offsetWidth, h = calTip.offsetHeight;
    var left, top;
    if(r.right + 28 + w <= window.innerWidth - 8){
      left = r.right + 28;
      top = Math.min(Math.max(8, r.top + r.height / 2 - h / 2), window.innerHeight - h - 8);
    } else {
      left = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), window.innerWidth - w - 8);
      top = r.top - h - 8;
      if(top < 8){ top = r.bottom + 28; }
    }
    calTip.style.left = left + "px";
    calTip.style.top = top + "px";
  }
  function hideCalTip(){
    if(calTip){ calTip.remove(); calTip = null; }
  }

  // v1.0.118: a category with no records in it can be deleted. One that still holds records cannot,
  // so no record ends up as 未分類 (the entries are encrypted one by one, so they are moved in the editor).
  // The last category stays (a new record takes one), and so does the one picked in the open editor.
  function confirmDeleteCategory(id){
    var cat = catById(id);
    if(!cat){ return; }
    var inUse = function(){ return liveEntries.filter(function(e){ return e.category === id; }).length; };
    var n = inUse();
    if(n){
      showToast("「" + cat.name + "」には記録が" + n + "件あります。記録のカテゴリを変えてから削除してください", 5000);
      return;
    }
    if((doc.categories || []).length <= 1){
      showToast("カテゴリは1つ以上必要です。先に新しいカテゴリを追加してください", 5000);
      return;
    }
    var edCat = currentView === "editor" && document.getElementById("editCategory");
    if(edCat && edCat.value === id){
      showToast("編集中の記録のカテゴリが「" + cat.name + "」です。カテゴリを変えるか、編集を終えてから削除してください", 5000);
      return;
    }
    openConfirmModal(
      "カテゴリ「" + cat.name + "」を削除しますか？",
      "このカテゴリに記録はありません。削除しても記録には影響しません。",
      function(){
        var kept = false;
        persist(function(d){
          // Saved again after taking in another PC's changes: liveEntries is that PC's list by now.
          if(inUse()){ kept = true; return; }
          d.categories = d.categories.filter(function(c){ return c.id !== id; });
        }).then(function(){
          if(kept){
            renderCategories();
            if(currentView !== "editor"){ renderMain(); }
            showToast("別のPCで「" + cat.name + "」に記録が入ったため、削除しませんでした", 6000);
            return;
          }
          if(currentCategory === id){ currentCategory = "all"; }
          var opt = currentView === "editor" && document.querySelector('#editCategory option[value="' + CSS.escape(id) + '"]');
          if(opt){ opt.remove(); }
          renderCategories();
          if(currentView !== "editor"){ renderMain(); }
          showToast("削除しました");
        }).catch(function(err){
          handleWriteError(err, "カテゴリの削除に失敗しました");
        });
      }
    );
  }

  document.getElementById("addCatBtn").addEventListener("click", function(){
    var input = document.getElementById("newCatName");
    var name = input.value.trim();
    if(!name) return;
    var palette = ["brass","teal","dusk"];
    var cat = { id: genId(), name: name, color: palette[(doc.categories||[]).length % palette.length] };
    persist(function(d){
      if(!d.categories.some(function(c){ return c.id === cat.id; })){ d.categories.push(cat); }
    }).then(function(){
      input.value = "";
      renderCategories();
      if(currentView !== "editor"){ renderMain(); }
    }).catch(function(err){
      handleWriteError(err, "カテゴリの保存に失敗しました");
    });
  });
  document.getElementById("newCatName").addEventListener("keydown", function(e){
    if(e.key === "Enter" && !e.isComposing){ document.getElementById("addCatBtn").click(); }
  });

  /* ---------------- helpers ---------------- */
  function escapeHtml(s){
    return String(s||"").replace(/[&<>"']/g, function(c){
      return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];
    });
  }
  function todayStr(){
    var d = new Date();
    var mm = String(d.getMonth()+1).padStart(2,"0");
    var dd = String(d.getDate()).padStart(2,"0");
    return d.getFullYear()+"-"+mm+"-"+dd;
  }
  function fmtDate(s){
    if(!s) return "";
    var parts = s.split("-");
    if(parts.length!==3) return s;
    return parts[0]+"."+parts[1]+"."+parts[2];
  }
  function pad2(n){ return String(n).padStart(2, "0"); }
  function localDay(d){ return d.getFullYear() + "-" + pad2(d.getMonth()+1) + "-" + pad2(d.getDate()); }
  function clock(d){ return d.getHours() + ":" + pad2(d.getMinutes()); }
  // 記入時刻: when the entry was first saved. The day is shown only when it differs from the entry's date.
  function writtenLabel(e){
    var iso = e && (e.createdAt || e.updatedAt);
    if(!iso) return "";
    var d = new Date(iso);
    if(isNaN(d)) return "";
    return "記入 " + (localDay(d) === e.date ? "" : (d.getMonth()+1) + "/" + d.getDate() + " ") + clock(d);
  }
  // 通し番号 (v1.0.114, the owner's choice): the oldest record is No.1, by date, then by when it was
  // first written. Counted over every record whatever the filter, and never stored, so deleting a
  // record renumbers the rest. A record not saved yet (no id) gets the number it would take.
  function entryNo(e){
    var at = function(x){ return x.createdAt || x.updatedAt || "￿"; };
    var n = 1;
    liveEntries.forEach(function(x){
      if(e.id && x.id === e.id) return;
      var d = (x.date || "").localeCompare(e.date || "");
      if(d < 0 || (d === 0 && (at(x) < at(e) || (at(x) === at(e) && String(x.id) < String(e.id))))){ n++; }
    });
    return n;
  }
  function entryNoHtml(e){
    return '<span class="entry-no"><span class="entry-no-label">No.</span>'+entryNo(e)+'</span>';
  }
  // The list's date (v1.0.206): "11/09" in this year, "2025.11.09" in another.
  function listDate(s){
    var p = String(s || "").split("-");
    if(p.length !== 3){ return fmtDate(s); }
    return Number(p[0]) === new Date().getFullYear() ? p[1] + "/" + p[2] : fmtDate(s);
  }
  // The list's time: "17:47" when written on the record's day, else "記入 11/10 9:05" as before.
  function listWrittenLabel(e){
    return writtenLabel(e).replace(/^記入 (\d+:\d\d)$/, "$1");
  }
  // Shown only when the entry was edited at least a minute after it was first written.
  function updatedLabel(e){
    if(!e || !e.createdAt || !e.updatedAt) return "";
    var c = new Date(e.createdAt), u = new Date(e.updatedAt);
    if(isNaN(c) || isNaN(u) || u - c < 60000) return "";
    return "更新 " + (u.getMonth()+1) + "/" + u.getDate() + " " + clock(u);
  }

  // Every Drive file an attached image owns: the displayed image, plus the
  // untouched original when it has been annotated or cropped.
  // A composite (several images merged into one) also owns its source images.
  function imageFileKeys(img){
    var keys = [img.id];
    if(img.edit && img.edit.originalId){ keys.push(img.edit.originalId); }
    if(img.composite){
      img.composite.sources.forEach(function(src){ keys.push.apply(keys, imageFileKeys(src)); });
    }
    return keys;
  }
  // What is stored (encrypted) inside the entry for each image.
  function storedImageMeta(img){
    var m = { id:img.id, mime:img.mime, name:img.name, width:img.width, height:img.height, size:img.size };
    if(img.ref){ m.ref = img.ref; }
    if(img.src){ m.src = img.src; }   // fingerprint of the file it came from: finds the same image added twice (v1.0.213)
    if(img.paper){ m.paper = { mmPerPx: img.paper.mmPerPx }; }
    if(img.ytThumb){ m.ytThumb = img.ytThumb; }   // the picture of a YouTube video (v1.0.172)
    if(img.duration){ m.duration = img.duration; }   // that of a 動画ファイル: its length in seconds (v1.0.201)
    if(img.pdfThumb){ m.pdfThumb = img.pdfThumb; m.pages = img.pages || 0; }   // page 1 of a PDF in the body (v1.0.205)
    if(img.edit){
      m.edit = {
        originalId: img.edit.originalId, originalMime: img.edit.originalMime,
        originalWidth: img.edit.originalWidth, originalHeight: img.edit.originalHeight,
        originalSize: img.edit.originalSize, crop: img.edit.crop, shapes: img.edit.shapes
      };
    }
    if(img.composite){
      m.composite = { sources: img.composite.sources.map(storedImageMeta), layout: img.composite.layout };
    }
    return m;
  }
  // In-memory files (not yet on Drive) that saving `img` must upload, including nested sources.
  function pendingUploads(img, out){
    if(img.isNew && img.bytes){ out.push({ id: img.id, bytes: img.bytes, url: img.url }); }
    if(img.edit && img.edit.originalBytes){
      out.push({ id: img.edit.originalId, bytes: img.edit.originalBytes, url: img.edit.originalUrl });
    }
    if(img.composite){ img.composite.sources.forEach(function(src){ pendingUploads(src, out); }); }
    return out;
  }

  function fmtSize(bytes){
    if(bytes < 1000) return bytes + "B";
    if(bytes >= 1000 * 1000) return (bytes/1000/1000).toFixed(1) + "MB";
    return Math.round(bytes/1000) + "KB";
  }

  /* ---------------- attached files (PDF and others) ---------------- */
  // entry.files = [{ id, name, mime, size }]. Each file is stored like an
  // image: encrypted, one Drive file, listed in doc.images under its id.
  var MAX_FILE_BYTES = 20 * 1000 * 1000;
  function storedFileMeta(f){
    var m = { id:f.id, name:f.name, mime:f.mime, size:f.size };
    if(f.ref){ m.ref = f.ref; }   // its number for "[PDF1]" in the body (v1.0.205)
    return m;
  }
  function isPdfFile(f){ return !!f && (/pdf/i.test(f.mime || "") || /\.pdf$/i.test(f.name || "")); }
  function fileIcon(f){ return isPdfFile(f) ? "📄" : "📎"; }
  // The cards shown after the images (viewer, paper view and print).
  function fileCardsHtml(files){
    if(!files || !files.length) return "";
    return '<div class="files">' + files.map(function(f){
      return '<span class="file-card" data-file="'+escapeHtml(f.id)+'">'+fileIcon(f)+' '+escapeHtml(f.name || "ファイル") +
             ' <span class="file-size">('+fmtSize(f.size || 0)+')</span></span>';
    }).join("") + '</div>';
  }
  /* ---------------- side panel (Windows app, wide window) ---------------- */
  // On a wide screen the record moves to the left and an attachment or image
  // opens in the empty space on the right, instead of another window.
  var sideUrl = null;        // blob: URL made for the panel (revoked when it closes)
  // What the panel shows: { entryId, imgId } or { entryId, fileId }. It survives switching between
  // reading and editing the same record, so the owner can write while looking at the image.
  var sideCurrent = null;
  // Set while the edit screen is open: the panel then works on the draft (not the saved record).
  var editorSideHooks = null;
  function canSide(){ return !api.isWeb && (currentView === "view" || currentView === "editor") && window.innerWidth >= 1150; }
  function closeSide(){
    var layout = document.querySelector(".viewer-layout");
    if(layout){ layout.classList.remove("split"); layout.style.gridTemplateColumns = ""; }
    var inner = document.querySelector(".content-inner");
    if(inner){ inner.classList.remove("wide"); }
    var panel = document.getElementById("sidePanel");
    if(panel){ panel.innerHTML = ""; }
    if(sideUrl){ URL.revokeObjectURL(sideUrl); sideUrl = null; }
    sideCurrent = null;
    markShown(null);
    Array.prototype.forEach.call(document.querySelectorAll(".paper-fit"), fitPaper);
  }
  // After the screen is redrawn (reading ⇄ editing, or saving), show the same image or PDF again.
  function restoreSide(keep){
    if(!keep || keep.entryId !== openEntryId || !canSide()) return;
    var view = currentView;
    function still(){ return currentView === view && openEntryId === keep.entryId && document.getElementById("sidePanel"); }
    if(view === "editor" && editorSideHooks){
      if(keep.imgId){ var dimg = editorSideHooks.imageById(keep.imgId); if(dimg){ editorSideHooks.show(dimg); } }
      else { var df = editorSideHooks.fileById(keep.fileId); if(df){ openAttachment(df); } }
      return;
    }
    var entry = currentEntry();
    if(!entry) return;
    // The reading screen shows no image in the panel (v1.0.177): back from editing, it is not opened full-screen either.
    if(keep.imgId && view === "view") return;
    if(keep.imgId){
      var img = (entry.images || []).filter(function(x){ return x.id === keep.imgId; })[0];
      if(!img) return;
      imageUrl(img).then(function(url){
        if(!still()) return;
        var el = document.querySelector('.view-card .thumb[data-img="'+CSS.escape(img.id)+'"] img');
        showImage(url, img.name, el, img);
      }).catch(noop);
    } else {
      var f = (entry.files || []).filter(function(x){ return x.id === keep.fileId; })[0];
      if(f){ openAttachment(f); }
    }
  }
  // The border between the record and the panel can be dragged left and right (the owner's request,
  // like TradingView's split charts). The left share is remembered; double-click returns to half and half.
  var SPLIT_KEY = "nisshi.sideSplit", SPLIT_MIN = 0.2, SPLIT_MAX = 0.8;
  function splitShare(){
    var v = NaN;
    try { v = parseFloat(localStorage.getItem(SPLIT_KEY)); } catch(e){}
    return isFinite(v) ? Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, v)) : 0.5;
  }
  function applySplit(layout, share){
    layout.style.gridTemplateColumns = "minmax(0, " + share + "fr) 20px minmax(0, " + (1 - share) + "fr)";
  }
  function refitPapers(){ Array.prototype.forEach.call(document.querySelectorAll(".paper-fit"), fitPaper); }
  function addSplitter(layout, panel){
    var bar = layout.querySelector(".side-splitter");
    if(bar) return;
    bar = document.createElement("div");
    bar.className = "side-splitter";
    bar.title = "左右にドラッグして広さを変えます（ダブルクリックで半分ずつに戻す）";
    layout.insertBefore(bar, panel);
    var share = splitShare(), frame = 0;
    bar.addEventListener("pointerdown", function(e){
      if(e.button !== 0) return;
      e.preventDefault();
      try { bar.setPointerCapture(e.pointerId); } catch(err){}
      document.body.classList.add("splitting");   // the PDF frame must not swallow the drag
      var box = layout.getBoundingClientRect();
      function move(ev){
        share = Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, (ev.clientX - box.left - 10) / (box.width - 20)));
        applySplit(layout, share);
        if(!frame){ frame = requestAnimationFrame(function(){ frame = 0; refitPapers(); }); }
      }
      function up(){
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", up);
        document.body.classList.remove("splitting");
        try { localStorage.setItem(SPLIT_KEY, String(share)); } catch(e){}
        refitPapers();
      }
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", up);
    });
    bar.addEventListener("dblclick", function(){
      share = 0.5;
      try { localStorage.setItem(SPLIT_KEY, "0.5"); } catch(e){}
      applySplit(layout, share);
      refitPapers();
    });
  }
  // opts: { name, image: url } or { name, pdf: Promise<bytes>, file }
  function openSide(opts){
    var layout = document.querySelector(".viewer-layout");
    var panel = document.getElementById("sidePanel");
    if(!layout || !panel) return false;
    if(sideUrl){ URL.revokeObjectURL(sideUrl); sideUrl = null; }
    layout.classList.add("split");
    addSplitter(layout, panel);
    applySplit(layout, splitShare());
    document.querySelector(".content-inner").classList.add("wide");
    sideCurrent = opts.img ? { entryId: openEntryId, imgId: opts.img.id }
                : opts.file ? { entryId: openEntryId, fileId: opts.file.id } : null;
    // ✎ 書き込み: on the edit screen it changes the draft (kept with 保存する); when reading, the record is saved at once.
    var annotateFn = !opts.img ? null
      : currentView === "editor" && editorSideHooks ? function(){ editorSideHooks.annotate(opts.img.id); }
      : currentEntry() ? function(){ annotateSaved(currentEntry(), opts.img); } : null;
    var editable = !!annotateFn;
    // 別の記録へ (v1.0.69): when reading, this image can be attached to another record too.
    var sendable = !!(opts.img && currentView === "view" && currentEntry());
    panel.innerHTML =
      '<div class="side-head"><span class="side-name"></span>' +
        (editable ? '<button type="button" class="btn btn-ghost btn-small" id="sideAnnotate" title="この画像に書き込み・トリミングをして、日誌に反映します">✎ 書き込み</button>' : '') +
        (sendable ? '<button type="button" class="btn btn-ghost btn-small" id="sideSend" title="この画像を、ほかの記録や新しい記録にも添付します">別の記録へ</button>' : '') +
        (opts.file ? '<button type="button" class="btn btn-ghost btn-small" id="sideExternal" title="Windowsのアプリで開く">別のアプリで開く</button>' : '') +
        '<button type="button" class="btn btn-primary btn-small" id="sideClose">✕ 閉じる</button></div>' +
      '<div class="side-body"><p class="side-msg">読み込んでいます…</p></div>';
    panel.querySelector(".side-name").textContent = opts.name || "";
    panel.querySelector("#sideClose").addEventListener("click", closeSide);
    if(opts.file){
      panel.querySelector("#sideExternal").addEventListener("click", function(){ openAttachment(opts.file, true); });
    }
    if(editable){
      panel.querySelector("#sideAnnotate").addEventListener("click", annotateFn);
    }
    if(sendable){
      panel.querySelector("#sideSend").addEventListener("click", function(){
        var e = currentEntry();
        if(e){ openSendImagesModal(e, opts.img.id); }
      });
    }
    var body = panel.querySelector(".side-body");
    if(opts.image){
      body.innerHTML = '<img class="side-img" alt="">';
      body.querySelector("img").src = opts.image;
    } else {
      opts.pdf.then(function(bytes){
        if(!body.isConnected) return;
        sideUrl = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
        body.innerHTML = '<iframe class="side-frame" title=""></iframe>';
        body.querySelector("iframe").src = sideUrl + "#view=FitH&navpanes=0";
      }, function(err){
        body.innerHTML = '<p class="side-msg">読み込めませんでした。</p>';
        showToast(withDetail("ファイルを開けませんでした", err), 6000);
      });
    }
    Array.prototype.forEach.call(document.querySelectorAll(".paper-fit"), fitPaper);
    return true;
  }
  // Images in the record: on the edit screen the side panel when there is room, the full-screen view otherwise.
  // el: the image clicked; it is outlined while it is the one shown in the panel.
  // img: the attached image, so the panel can offer ✎ 書き込み.
  // v1.0.177: the reading screen always shows it full-screen in front (the owner's request). The panel, with
  // its ✎ 書き込み, looked like the edit screen opening by itself; writing is only after 「編集する」 now.
  function showImage(url, name, el, img){
    if(currentView !== "view" && canSide() && openSide({ name: name || (img && img.name) || "", image: url, img: img })){
      markShown(el);
      return;
    }
    openLightbox(url, name || (img && img.name) || "", img);
  }
  function currentEntry(){
    return currentView === "view" ? liveEntries.filter(function(e){ return e.id === openEntryId; })[0] || null : null;
  }

  // ✎ 書き込み from the side panel: the same editor as in the edit screen, saved to the
  // record right away. The untouched original is kept, so 「元の画像に戻す」 still works.
  // 記録の窓 (v1.0.216): another window has this record in its editor (v1.0.223). Its next save writes its own copy
  // of the record back: a delete here was undone by it (with the images already in the trash), and a picture
  // written on here was replaced by the old one, which ✎ 書き込み had moved to the trash. That window comes to the
  // front instead, and nothing is done here. Only for a window not editing the record itself.
  function editedElsewhere(id){
    if(!api.records || !id || currentView === "editor"){ return false; }
    if(api.records.claim(id)){ api.records.claim(null); return false; }
    showToast("この記録は別の窓で編集中です。その窓を前に出しました。そちらで保存してから、もう一度お試しください", 7000);
    return true;
  }
  function annotateSaved(entry, img){
    if(editedElsewhere(entry.id)){ return; }
    // Still one image in two places (being split, or the split failed): writing now would change both.
    if(placedAgain(entry).indexOf(img.ref) >= 0){
      if(splitTried[entry.id] !== "busy"){ delete splitTried[entry.id]; splitSavedDuplicates(entry); }
      showToast("この画像は本文の2か所に置かれているため、別々の画像に分けています。分け終わってから、もう一度「✎ 書き込み」を押してください", 7000);
      return;
    }
    var orig = img.edit ? {
      id: img.edit.originalId, mime: img.edit.originalMime, width: img.edit.originalWidth,
      height: img.edit.originalHeight, size: img.edit.originalSize
    } : { id: img.id, mime: img.mime, width: img.width, height: img.height, size: img.size };
    var entryId = entry.id;
    // The editor window stays open after 反映: each later 反映 replaces the image the previous one saved.
    function apply(r){
      // Opened in another window's editor meanwhile (v1.0.223): that window's save would undo this.
      if(editedElsewhere(entryId)){ return Promise.reject({ code:"busy", handled:true }); }
      // The record may have changed while the editor window was open: apply to the latest one.
      var entry = liveEntries.filter(function(e){ return e.id === entryId; })[0];
      if(!entry || !(entry.images || []).some(function(x){ return x.id === img.id; })){
        showToast("記録が変わっていたため、画像への書き込みを反映できませんでした", 6000);
        return Promise.reject({ code:"gone", handled:true });
      }
      var newImg, newImages = [];
      var ready;
      if(r.empty){
        // 元の画像に戻す: the original becomes the displayed image again.
        newImg = { id: orig.id, mime: orig.mime, name: img.name, width: orig.width, height: orig.height, size: orig.size };
        ready = Promise.resolve();
      } else {
        showToast("画像を保存しています…", 60000);
        ready = compressImage(new File([r.blob], "edited.png", { type:"image/png" })).then(function(res){
          return res.blob.arrayBuffer().then(function(ab){
            newImg = {
              id: genId(), mime: res.mime, name: img.name, width: res.width, height: res.height, size: res.blob.size,
              edit: { originalId: orig.id, originalMime: orig.mime, originalWidth: orig.width, originalHeight: orig.height,
                      originalSize: orig.size, crop: r.crop, shapes: r.shapes }
            };
            newImages.push({ id: newImg.id, bytes: new Uint8Array(ab), url: URL.createObjectURL(res.blob) });
          });
        });
      }
      return ready.then(function(){
        if(img.ref){ newImg.ref = img.ref; }
        if(img.src){ newImg.src = img.src; }   // still the same picture for the 同じ画像 question (v1.0.213, as replaceDraft)
        if(img.paper){ newImg.paper = img.paper; }
        if(img.composite){ newImg.composite = img.composite; }
        var stored = storedImageMeta(newImg);
        var next = Object.assign({}, entry, {
          images: (entry.images || []).map(function(x){ return x.id === img.id ? stored : x; }),
          updatedAt: new Date().toISOString()
        });
        // The free layout is keyed by image id: carry this image's place over.
        if(entry.layout && entry.layout.items && entry.layout.items[img.id] && newImg.id !== img.id){
          next.layout = JSON.parse(JSON.stringify(entry.layout));
          next.layout.items[newImg.id] = next.layout.items[img.id];
          delete next.layout.items[img.id];
          if(next.layout.order){ next.layout.order = next.layout.order.map(function(id){ return id === img.id ? newImg.id : id; }); }
        }
        // The old edited picture is no longer used (the original always stays).
        var removed = img.edit && img.id !== newImg.id ? [img.id] : [];
        return saveEntry(next, newImages, removed).then(function(){
          img = stored;
          newImages.forEach(function(u){ imageUrlCache[u.id] = Promise.resolve(u.url); });
          showToast("画像の変更を日誌に反映しました");
          renderMain();
          return imageUrl(stored).then(function(u){
            var el = document.querySelector('.view-card .thumb[data-img="'+CSS.escape(stored.id)+'"] img');
            showImage(u, stored.name, el, stored);
          });
        });
      }).catch(function(err){
        if(err && err.handled){ throw err; }
        handleWriteError(err, "画像への書き込みを反映できませんでした。");
        throw { code: err && err.code, handled:true };
      });
    }
    imageUrl({ id: orig.id, mime: orig.mime }).then(function(url){
      return openImageEditor({ key: entryId + "/" + orig.id, url: url, crop: img.edit && img.edit.crop, shapes: img.edit && img.edit.shapes,
                               mmPerPx: img.paper && img.paper.mmPerPx, onApply: apply });
    }).then(function(r){
      if(r){ return apply(r); }
    }).catch(function(err){
      if(err && err.handled) return;
      handleWriteError(err, "画像への書き込みを反映できませんでした。");
    });
  }
  // Refs the body places a second (third, ...) time, one per extra place, in the order they are written.
  function placedAgain(entry){
    var images = entry.images || [], seen = [], again = [];
    String(entry.body || "").split("\n").forEach(function(line){
      if(!MARKER_LINE.test(line)) return;
      markersIn(line).forEach(function(m){
        if(!imageByRef(images, m.ref)) return;
        if(seen.indexOf(m.ref) >= 0){ again.push(m.ref); } else { seen.push(m.ref); }
      });
    });
    return again;
  }
  // A record saved before v1.0.129 can place one image twice in the text, and writing on it from the
  // reading screen changed both places (v1.0.129 split them only in the edit screen, kept by 保存する).
  // v1.0.130: when such a record is read, every later place gets its own copy, saved at once.
  var splitTried = {};   // entry id -> "busy", "done" or "failed" (this run of the app)
  // entry id -> the split still running. The edit screen's 保存 waits for it (v1.0.134): the split saves the
  // record as it was read, so finishing after the edit screen's save would have put the old text back.
  var splitRuns = {};
  function splitSavedDuplicates(entry){
    var again = placedAgain(entry);
    if(!again.length || splitTried[entry.id]) return;
    splitTried[entry.id] = "busy";
    var copies = [];
    var run = runSeq(again, function(ref){
      return copyStoredImage(imageByRef(entry.images, ref)).then(function(c){ copies.push(c); });
    }).then(function(){
      var latest = liveEntries.filter(function(e){ return e.id === entry.id; })[0];
      // Locked meanwhile (or deleted): not "busy" for good, or ✎ 書き込み would wait for it until a restart.
      if(!latest){ delete splitTried[entry.id]; return; }
      // Changed meanwhile (or opened in the edit screen, which splits its own draft): try again next time.
      if(latest.body !== entry.body || JSON.stringify(latest.images) !== JSON.stringify(entry.images) ||
         (currentView === "editor" && openEntryId === entry.id)){
        delete splitTried[entry.id];
        return;
      }
      var next = 1;
      (latest.images || []).forEach(function(img){ if(img.ref >= next){ next = img.ref + 1; } });
      copies.forEach(function(c){ c.ref = next++; });
      // The same walk as placedAgain: the k-th extra place gets the k-th copy.
      var images = latest.images || [], seen = [], k = 0;
      var body = String(latest.body || "").split("\n").map(function(line){
        if(!MARKER_LINE.test(line)) return line;
        return line.replace(MARKER, function(m, n){
          var ref = Number(n);
          if(!imageByRef(images, ref)) return m;
          if(seen.indexOf(ref) < 0){ seen.push(ref); return m; }
          return m.replace(/\d+/, String(copies[k++].ref));
        });
      }).join("\n");
      // Each copy sits after its image (and the copies of it before) in the list, as 「本文へ」 does.
      var list = images.map(storedImageMeta), family = {};
      copies.forEach(function(c, i){
        var fam = family[again[i]] = family[again[i]] || [again[i]], at = list.length - 1;
        list.forEach(function(x, j){ if(fam.indexOf(x.ref) >= 0){ at = j; } });
        list.splice(at + 1, 0, storedImageMeta(c));
        fam.push(c.ref);
      });
      var uploads = [];
      copies.forEach(function(c){ pendingUploads(c, uploads); });
      return saveEntry(Object.assign({}, latest, { body: body, images: list }), uploads, []).then(function(){
        splitTried[entry.id] = "done";
        uploads.forEach(function(u){ imageUrlCache[u.id] = Promise.resolve(u.url); });
        showToast("同じ画像が本文の" + (again.length + 1) + "か所にあったため、写しを作って分けました。これからはそれぞれ別に書き込めます", 7000);
        if(currentView === "view" && openEntryId === entry.id){ renderMain(); }
      });
    }).catch(function(err){
      // Not tried again by redrawing (a toast on every redraw would be in the way), only by ✎ 書き込み.
      splitTried[entry.id] = "failed";
      showToast(withDetail("同じ画像を2か所に置いた記録を、別々の画像に分けられませんでした", err), 6000);
    });
    splitRuns[entry.id] = run;
    run.then(function(){ if(splitRuns[entry.id] === run){ delete splitRuns[entry.id]; } });
  }
  function markShown(el){
    Array.prototype.forEach.call(document.querySelectorAll(".side-shown"), function(x){ x.classList.remove("side-shown"); });
    if(el){ el.classList.add("side-shown"); }
  }

  // Opens an attachment: the Windows app hands it to its usual program, the web version shows it.
  // On a wide Windows screen a PDF opens in the side panel instead (external: always the usual program).
  function openAttachment(f, external){
    if(!external && isPdfFile(f) && canSide()){
      if(openSide({ name: f.name, pdf: f.bytes ? Promise.resolve(f.bytes) : imagePlainBytes(f), file: f })){ markShown(null); return; }
    }
    var bytes = f.bytes ? Promise.resolve(f.bytes) : imagePlainBytes(f);
    api.openFile(f.name || "file", f.mime || "application/octet-stream", bytes).catch(function(err){
      showToast(withDetail("ファイルを開けませんでした", err), 6000);
    });
  }
  function bindFileCards(root, files){
    Array.prototype.forEach.call(root.querySelectorAll(".file-card[data-file]"), function(card){
      var f = (files || []).filter(function(x){ return x.id === card.getAttribute("data-file"); })[0];
      if(!f) return;
      card.classList.add("clickable");
      card.title = "開く";
      card.addEventListener("click", function(){ openAttachment(f); });
    });
  }
  function snippet(text){
    var plain = stripTextStyle(String(text||"")).replace(VIDEO_ANY, " ▶動画 ").replace(MARKER, " ").replace(/[#*_>-]/g," ").replace(/\s+/g," ").trim();
    return plain.length > 90 ? plain.slice(0,90)+"…" : plain;
  }

  /* ---------------- images inside the body text ---------------- */
  // A body line made only of markers such as "[画像2]", "[画像1 小]" or
  // "[画像1][画像3]" shows those attached images at that point of the text
  // (several on one line sit side by side). Markers point at img.ref, a small
  // number that stays with the image through annotation, so the text never
  // has to mention Drive ids. Images no marker points at are shown after the
  // body as before.
  // An optional position may follow the size: 左寄せ / 中央 (the default) / 右寄せ, or
  // 左回り込み / 右回り込み, which put the image at that side and let the text
  // that follows run beside it.
  var MARKER_LINE = /^\s*(\[画像\s*\d+(?:\s*[大中小])?(?:\s*(?:左寄せ|中央|右寄せ|左回り込み|右回り込み))?\]\s*)+$/;
  var MARKER = /\[画像\s*(\d+)(?:\s*([大中小]))?(?:\s*(左寄せ|中央|右寄せ|左回り込み|右回り込み))?\]/g;
  var SIZE_CLASS = { "大":"l", "中":"m", "小":"s" };
  var ALIGN_CLASS = { "左寄せ":"al-l", "右寄せ":"al-r", "左回り込み":"float fl-l", "右回り込み":"float fl-r" };
  // 白紙 (v1.0.133): img.paper = { mmPerPx } (the printed size of a pixel of the untouched blank). A
  // blank shows at its own printed width whatever its 小・中・大, so text written on it in points is
  // as large as the body. The width is that of the picture as cropped, in % of the 180mm text column.
  var COLUMN_MM = 180;
  function paperPct(img){
    if(!img || !img.paper || !(img.paper.mmPerPx > 0)) return 0;
    var w = img.edit ? (img.edit.crop ? img.edit.crop.w : img.edit.originalWidth) : img.width;
    return Math.min(100, Math.round(w * img.paper.mmPerPx / COLUMN_MM * 10000) / 100);
  }
  // A white PNG of w × h: the untouched picture of a blank (白紙・描画). { bytes, url, size }.
  function blankPng(w, h){
    var canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    var ctx = canvas.getContext("2d");
    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(0, 0, w, h);
    return new Promise(function(resolve){ canvas.toBlob(resolve, "image/png"); }).then(function(blob){
      if(!blob){ return Promise.reject({ code:"unreadable" }); }
      return blob.arrayBuffer().then(function(ab){
        return { bytes: new Uint8Array(ab), url: URL.createObjectURL(blob), size: blob.size };
      });
    });
  }
  // The share of the row beside a floating blank that the dashed frame of the editor covers (style.css).
  function paperRest(pct){ return Math.round((100 - pct) / pct * 10000) / 100; }

  // 中 is written out so the choice is visible; 中央 (the default position) is not.
  function markerText(ref, size, align){
    return "[画像" + ref + " " + (size || "中") + (align && align !== "中央" ? " " + align : "") + "]";
  }

  function markersIn(line){
    var out = [];
    line.replace(MARKER, function(m, n, sz, al){ out.push({ ref: Number(n), size: sz || "", align: al || "" }); });
    return out;
  }
  function imageByRef(images, ref){
    return (images||[]).filter(function(img){ return img.ref === ref; })[0] || null;
  }

  // YouTube の動画 (v1.0.171): a body line made only of "[動画 中 https://youtu.be/ID]" (size and 左寄せ・右寄せ
  // as for an image; the address may carry ?t=seconds) puts the video there. The reading screen plays it in
  // place when it is clicked (youtube-nocookie.com, VIDEO_EMBED); the editor, print and PDF show its picture
  // (i.ytimg.com) with the address under it. Nothing is stored but the line, and older versions show it as text.
  // Since v1.0.173 it may also be 左回り込み / 右回り込み, as an image: the text after it runs beside it (versions
  // before that show such a line as text), and a click plays it in a window of its own (openVideoPlayer).
  // 動画ファイル (v1.0.201): "[動画 中 ファイル:<id>]" is a video from the PC, kept on Drive encrypted (video.js in the
  // main process). Its key and Drive id are in its 動画の札 (doc.images[<id>], loadVideoMeta); its picture is an
  // image with ytThumb = <id>, as a YouTube one's. Ids of these are UUIDs, YouTube's are 11 letters (isFileVideoId).
  var VIDEO_LINE = /^\s*\[動画\s*([大中小])?\s*(左寄せ|中央|右寄せ|左回り込み|右回り込み)?\s*(https?:\/\/[^\s\]]+|ファイル:[A-Za-z0-9-]+)\s*\]\s*$/;
  var VIDEO_FILE_PREFIX = "ファイル:";
  function isFileVideoId(id){ return !/^[A-Za-z0-9_-]{11}$/.test(String(id || "")); }
  var VIDEO_ANY = /\[動画[^\]\n]*\]/g;
  var VIDEO_EMBED = "https://www.youtube-nocookie.com/embed/";
  var VIDEO_PLAY_MARK = "data:image/svg+xml," + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="70" height="48" viewBox="0 0 70 48">' +
    '<rect width="70" height="48" rx="14" fill="#E62117"/><path d="M28 14 48 24 28 34Z" fill="#fff"/></svg>');
  // { id, start } for a YouTube address (watch, youtu.be, shorts, live, embed), or null.
  function parseYouTube(s){
    var u;
    try{ u = new URL(String(s || "").trim()); } catch(e){ return null; }
    if(!/^https?:$/.test(u.protocol)) return null;
    var host = u.hostname.toLowerCase().replace(/^(www|m|music)\./, "");
    var p = u.pathname.split("/"), id = null;
    if(host === "youtu.be"){ id = p[1]; }
    else if(host === "youtube.com" || host === "youtube-nocookie.com"){
      if(p[1] === "watch"){ id = u.searchParams.get("v"); }
      else if(/^(shorts|embed|live|v)$/.test(p[1])){ id = p[2]; }
    }
    if(!id || !/^[A-Za-z0-9_-]{11}$/.test(id)) return null;
    return { id: id, start: videoSeconds(u.searchParams.get("t") || u.searchParams.get("start") || "") };
  }
  // "90", "90s", "1m30s" or "1h2m3s" → seconds.
  function videoSeconds(t){
    if(/^\d+$/.test(t)) return Number(t);
    var m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(t);
    return t && m ? Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0) : 0;
  }
  function videoUrl(v){ return "https://youtu.be/" + v.id + (v.start ? "?t=" + v.start : ""); }
  // The video a body line puts there ({ id, start, size, align }), or null.
  function videoIn(line){
    var m = VIDEO_LINE.exec(line);
    var v = !m ? null : m[3].indexOf(VIDEO_FILE_PREFIX) === 0 ? { id: m[3].slice(VIDEO_FILE_PREFIX.length), start: 0, file: true }
      : parseYouTube(m[3].replace(/&amp;/g, "&"));
    if(!v) return null;
    v.size = m[1] || "中";
    v.align = m[2] && m[2] !== "中央" ? m[2] : "";
    return v;
  }
  function videoText(v){
    return "[動画 " + (v.size || "中") + (v.align && v.align !== "中央" ? " " + v.align : "") + " " +
           (v.file ? VIDEO_FILE_PREFIX + v.id : videoUrl(v)) + "]";
  }
  // 動画の絵 (v1.0.172): an attached image with img.ytThumb = the video's id is that video's picture, saved with the
  // record (like any image) so it still shows offline and after the video is taken off YouTube. It is never listed,
  // counted, placed or put on a board as an image (realImages). The editor fetches one for each video in the body
  // (ensureVideoThumbs) and saving drops those of videos no longer there. Older versions see it as an image kept as material.
  function realImages(list){ return (list || []).filter(function(img){ return !img.ytThumb && !img.pdfThumb; }); }   // PDF の絵も (v1.0.205)
  function videoThumbFor(images, ytId){
    return (images || []).filter(function(img){ return img.ytThumb === ytId; })[0] || null;
  }
  // 区切り線 (v1.0.194): a body line made only of "[区切り線 破線 ふつう #E53935]" draws a line across the text
  // column there: its kind (実線・破線・点線), thickness (細い・ふつう・太い) and colour (one of BODY_COLORS or any
  // #rrggbb; none = the colour of the text). It is one line high, so it sits between two lines of text. It ends
  // the text beside a wrapped image, as an image line does. Older versions show the line as text.
  var RULE_LINE = /^\s*\[区切り線(?:\s+(実線|破線|点線))?(?:\s+(細い|ふつう|太い))?(?:\s+(#[0-9a-fA-F]{6}))?\s*\]\s*$/;
  var RULE_ANY = /\[区切り線[^\]\n]*\]/g;
  var RULE_KIND = { "実線":"solid", "破線":"dashed", "点線":"dotted" };
  var RULE_PT = { "細い":1, "ふつう":2, "太い":3.5 };
  function ruleIn(line){
    var m = RULE_LINE.exec(line);
    return m ? { style: m[1] || "実線", width: m[2] || "細い", color: m[3] ? m[3].toUpperCase() : "" } : null;
  }
  function ruleText(r){ return "[区切り線 " + r.style + " " + r.width + (r.color ? " " + r.color : "") + "]"; }
  function ruleInnerHtml(r){
    return '<hr style="border-top:' + RULE_PT[r.width] + 'pt ' + RULE_KIND[r.style] + ' ' + (r.color || "currentColor") + '">';
  }
  // PDF in the body (v1.0.205): a body line made only of "[PDF1 中 右寄せ]" puts the attached PDF whose f.ref is 1
  // there (sizes and positions as an image; 回り込み too). It shows page 1 (an image with pdfThumb = the ref and
  // pages = its page count, saved with the record like a video's picture and left out of realImages) and the
  // file's name; a click opens the PDF. It is drawn and edited as a video row is (the same row classes, the editor's
  // opts.video with v.pdf), so moving, sizes, wrapping, page breaks and print need nothing new. A PDF placed in the
  // body has no name card after the body. Older versions show the line as text.
  var PDF_LINE = /^\s*\[PDF(\d+)\s*([大中小])?\s*(左寄せ|中央|右寄せ|左回り込み|右回り込み)?\s*\]\s*$/;
  var PDF_ANY = /\[PDF\d+[^\]\n]*\]/g;
  function pdfIn(line){
    var m = PDF_LINE.exec(line);
    if(!m) return null;
    return { pdf: true, ref: Number(m[1]), id: "pdf" + m[1], start: 0, size: m[2] || "中", align: m[3] && m[3] !== "中央" ? m[3] : "" };
  }
  function pdfText(p){ return "[PDF" + p.ref + " " + (p.size || "中") + (p.align && p.align !== "中央" ? " " + p.align : "") + "]"; }
  function pdfRefsIn(body){
    var refs = [];
    String(body || "").split("\n").forEach(function(l){ var p = pdfIn(l); if(p && refs.indexOf(p.ref) < 0){ refs.push(p.ref); } });
    return refs;
  }
  function fileByRef(files, ref){ return (files || []).filter(function(f){ return f.ref === ref; })[0] || null; }
  function pdfThumbFor(images, ref){ return (images || []).filter(function(img){ return img.pdfThumb === ref; })[0] || null; }
  // Every attached file gets a number of its own (kept; the first holder of a duplicate keeps it), as images do.
  // body: a new number is also above those still written in it, so a "[PDF1]" left there (undone after its file
  // was taken off) never turns into another PDF. reserved: numbers of files taken off with × that 戻す can bring
  // back (v1.0.215), never given to another.
  function ensureFileRefs(files, body, reserved){
    var used = [];
    (files || []).forEach(function(f){ if(f.ref && used.indexOf(f.ref) < 0){ used.push(f.ref); } else { f.ref = 0; } });
    var all = used.concat(pdfRefsIn(body), reserved || []);
    var next = all.length ? Math.max.apply(null, all) + 1 : 1;
    (files || []).forEach(function(f){ if(!f.ref){ f.ref = next++; } });
  }
  // The files shown as name cards after the body: those not placed in it.
  function filesAfterBody(files, body){
    var placed = pdfRefsIn(body);
    return (files || []).filter(function(f){ return !(f.ref && placed.indexOf(f.ref) >= 0 && isPdfFile(f)); });
  }
  // info: { name, pages, pic: { src } | { imgId }, width, height } or null (its file is not attached any more).
  function pdfInnerHtml(p, info){
    if(!info){ return '<div class="pdf-box pdf-missing">📄</div><figcaption class="pdf-cap">（外された PDF）</figcaption>'; }
    var ratio = info.width && info.height ? ' width="' + info.width + '" height="' + info.height + '"' : '';
    return '<div class="pdf-box" data-pdf="' + p.ref + '" title="押すと PDF を開きます">' +
             '<img class="pdf-thumb"' + (info.pic && info.pic.src ? ' src="' + escapeHtml(info.pic.src) + '"' : '') +
               (info.pic && !info.pic.src && info.pic.imgId ? ' data-thumb-id="' + escapeHtml(info.pic.imgId) + '"' : '') +
               ratio + ' alt="PDF の1ページ目" draggable="false">' +
           '</div>' +
           '<figcaption class="pdf-cap"><span class="pdf-mark">📄</span> ' + escapeHtml(info.name || "PDF") +
             (info.pages ? ' <span class="pdf-pages">（' + info.pages + 'ページ）</span>' : '') + '</figcaption>';
  }
  function pdfRowHtml(p, info){ return videoRowHtml(p, info); }
  // v1.0.211: a PDF is as tall as an image of its size is wide (the owner: an upright page by its long side, a
  // sideways one by its short side, both the 小・中・大 of an image). Its width is that height times the page's
  // shape, in % of the column (a wrapped one: of the column too, on its row), never wider than the column.
  // Before, it was as wide as an image, so an upright A4 page at 中 was 1.4 times as tall as the column is wide.
  var PDF_SIZE_PCT = { row: { s: 36, m: 62, l: 100 }, float: { s: 36, m: 50, l: 62 } };
  var PDF_UPRIGHT_H = 0.36;   // an upright page's height over an image's width of the same size (v1.0.212)
  function pdfPct(p, info){
    var w = info && info.width, h = info && info.height;
    var k = w > 0 && h > 0 ? w / h : 210 / 297;   // no picture yet: an upright A4 page
    var floating = /float/.test(ALIGN_CLASS[p.align] || "");
    var base = PDF_SIZE_PCT[floating ? "float" : "row"][SIZE_CLASS[p.size] || "m"];
    // v1.0.212 (the owner): a sideways page is as wide as an image (base). An upright one is as tall as the short
    // side of the owner's sideways images of that size (about 4-5 lines at 小): base x PDF_UPRIGHT_H. In
    // v1.0.211 it was as tall as an image is wide, so 小 was 12-13 lines.
    if(k >= 1){ return base; }
    return Math.min(100, Math.round(base * PDF_UPRIGHT_H * k * 100) / 100);
  }
  // pdfInfo for mdToHtml from a record: the saved picture to fill in later (loadVideoPics).
  function laterPdfInfo(e){
    return function(ref){
      var f = fileByRef(e.files, ref);
      if(!f) return null;
      var t = pdfThumbFor(e.images, ref);
      return { name: f.name, pages: t && t.pages, pic: t ? { imgId: t.id } : null, width: t && t.width, height: t && t.height };
    };
  }
  // A click on a placed PDF on the reading screen (screen or paper layout) opens it as its name card does
  // (openAttachment). Bound once on viewRoot, like bindVideos: the record is the one open now.
  function bindPdfBoxes(root){
    root.addEventListener("click", function(e){
      if(!e.target.closest || e.target.closest(".rich-editor")) return;
      var box = e.target.closest(".pdf-box[data-pdf]");
      var entry = currentEntry();
      if(!box || !root.contains(box) || !entry) return;
      var f = fileByRef(entry.files, Number(box.getAttribute("data-pdf")));
      if(!f) return;
      e.preventDefault();
      e.stopPropagation();
      openAttachment(f);
    });
  }
  // 1280×720 pictures fill the 16:9 box; the 480×360 ones have black bands that the box crops off.
  function isWideThumb(img){ return !!(img && img.width && img.height && img.width / img.height > 1.6); }
  function videoIdsIn(body){
    var ids = [];
    String(body || "").split("\n").forEach(function(l){
      var v = videoIn(escapeHtml(l));
      if(v && ids.indexOf(v.id) < 0){ ids.push(v.id); }
    });
    return ids;
  }
  // Only the 動画ファイル in a body (v1.0.201).
  function fileVideoIdsIn(body){ return videoIdsIn(body).filter(isFileVideoId); }
  // A 動画ファイル has no picture on YouTube: an empty (black) box when its own is missing.
  function remoteThumbUrl(ytId){ return isFileVideoId(ytId) ? "" : "https://i.ytimg.com/vi/" + ytId + "/hqdefault.jpg"; }
  // The largest picture YouTube has for the video (1280×720, else 480×360), as a new draft image to save.
  function fetchVideoThumb(ytId){
    function get(name){
      return fetch("https://i.ytimg.com/vi/" + ytId + "/" + name + ".jpg", { mode: "cors", credentials: "omit", referrerPolicy: "no-referrer" })
        .then(function(r){
          if(!r.ok){ throw { code: "http_" + r.status }; }
          return r.blob();
        });
    }
    return get("maxresdefault").catch(function(){ return get("hqdefault"); }).then(function(blob){
      if(blob.size > MAX_IMAGE_BYTES){ throw { code: "too_large" }; }
      return Promise.all([createImageBitmap(blob), blob.arrayBuffer()]).then(function(r){
        var bmp = r[0], bytes = new Uint8Array(r[1]);
        var out = { id: genId(), mime: "image/jpeg", name: "YouTube の動画の絵（" + ytId + "）", width: bmp.width, height: bmp.height,
                    size: bytes.byteLength, isNew: true, bytes: bytes, ytThumb: ytId,
                    url: URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" })) };
        bmp.close();
        return out;
      });
    });
  }
  // Fills in the saved pictures of videos (pic.imgId, below): find(id) → the image, urlOf(img) → Promise<url>.
  // When it cannot be read, the picture comes from YouTube as before.
  function loadVideoPics(root, find, urlOf){
    Array.prototype.forEach.call(root.querySelectorAll("img.yt-thumb[data-thumb-id], img.pdf-thumb[data-thumb-id]"), function(el){
      var img = find(el.getAttribute("data-thumb-id"));
      el.removeAttribute("data-thumb-id");
      function remote(){
        var box = el.closest(".yt-box");
        el.classList.remove("wide");
        var u = box ? remoteThumbUrl(box.getAttribute("data-yt")) : "";
        if(u){ el.src = u; }
      }
      if(!img){ remote(); return; }
      urlOf(img).then(function(u){ if(u){ el.src = u; } else { remote(); } }, remote);
    });
  }
  // The picture with a play mark, and the address under it (also printed). Ids are only [A-Za-z0-9_-].
  // pic: the saved picture, { src } when its address is known, { imgId } to be filled in by loadVideoPics, with
  // wide for a 16:9 one; without it the picture comes from YouTube.
  function videoInnerHtml(v, pic){
    var src = pic && pic.src ? pic.src : pic && pic.imgId ? "" : remoteThumbUrl(v.id);
    var box = '<div class="yt-box" data-yt="' + escapeHtml(v.id) + '" data-start="' + (v.start || 0) + '"' + (v.file ? ' data-file="1"' : '') +
                ' title="クリックすると、動画の窓で再生します">' +
             '<img class="yt-thumb' + (pic && pic.wide ? ' wide' : '') + '"' + (src ? ' src="' + escapeHtml(src) + '"' : '') +
               (pic && !pic.src && pic.imgId ? ' data-thumb-id="' + escapeHtml(pic.imgId) + '"' : '') + ' alt="' + (v.file ? '動画' : 'YouTube の動画') + '" draggable="false">' +
             '<img class="yt-play" src="' + VIDEO_PLAY_MARK + '" alt="" draggable="false">' +
           '</div>';
    // 動画ファイル (v1.0.201): no address; the caption says what it is (printed too).
    if(v.file){
      return box + '<figcaption class="yt-cap"><span class="yt-mark">▶ 動画</span>' +
               (pic && pic.length ? ' <span class="yt-len">' + escapeHtml(pic.length) + '</span>' : '') + '</figcaption>';
    }
    return box +
           '<figcaption class="yt-cap"><span class="yt-mark">▶ YouTube</span> ' +
             '<span class="yt-url" data-url="' + escapeHtml(videoUrl(v)) + '" title="YouTube で開きます">' + escapeHtml(videoUrl(v)) + '</span>' +
           '</figcaption>';
  }
  // A wrapped one (左回り込み・右回り込み, v1.0.173) is sized on its row, as a wrapped image (inlineRowHtml).
  function videoRowHtml(v, pic){
    var cls = ALIGN_CLASS[v.align] || "";
    var sz = " sz-" + (SIZE_CLASS[v.size] || "m");
    var floating = /float/.test(cls);
    var pct = v.pdf ? pdfPct(v, pic) : 0;   // a PDF's own width (v1.0.211), as a blank's (inlineRowHtml)
    return '<div class="inline-row video-row' + (v.pdf ? ' pdf-row' : '') + (cls ? ' ' + cls : '') + (floating ? sz : '') + '"' +
             (pct && floating ? ' style="width:' + pct + '%"' : '') + '>' +
             '<figure class="inline-fig video-fig' + (floating ? '' : sz) + '"' +
               (pct && !floating ? ' style="flex:0 1 ' + pct + '%;width:' + pct + '%"' : '') + '>' +
               (v.pdf ? pdfInnerHtml(v, pic) : videoInnerHtml(v, pic)) + '</figure></div>';
  }
  // videoPic for mdToHtml from a record's images: the saved picture to fill in later (loadVideoPics).
  function laterVideoPic(images){
    return function(ytId){
      var t = videoThumbFor(images, ytId);
      return t ? { imgId: t.id, wide: isWideThumb(t), length: videoLength(t) } : null;
    };
  }
  // The length of a 動画ファイル ("18:03"), kept on its picture (thumb.duration, seconds).
  function videoLength(thumb){
    var s = thumb && Math.round(thumb.duration || 0);
    if(!s) return "";
    var h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, sec = s % 60;
    return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(sec).padStart(2, "0");
  }
  // A page in this PC's usual browser (the web version: a new tab).
  function openOutside(url){
    if(api.sites && api.sites.external){
      api.sites.external({ url: url }).catch(function(err){ showToast(withDetail("開けませんでした", err), 5000); });
    } else {
      window.open(url, "_blank", "noopener");
    }
  }
  // A click on a video's picture plays it in the video window (openVideoPlayer); a click on its address opens
  // it in the browser.
  function bindVideos(root){
    root.addEventListener("click", function(e){
      if(!e.target.closest || e.target.closest(".rich-editor")) return;
      var link = e.target.closest(".yt-url");
      if(link && root.contains(link)){ e.preventDefault(); openOutside(link.getAttribute("data-url")); return; }
      var box = e.target.closest(".yt-box");
      if(!box || !root.contains(box)) return;
      e.preventDefault();
      e.stopPropagation();
      openVideoPlayer({ id: box.getAttribute("data-yt"), start: Number(box.getAttribute("data-start")) || 0, file: box.hasAttribute("data-file") });
    });
  }

  /* ---------- 動画の窓 (v1.0.173) ---------- */
  // Until v1.0.172 a video played inside its picture, so it was as small as the picture or full screen. Now it
  // plays in one window over the page: dragged by its bar anywhere, resized by its edges and the grip at the
  // bottom right, with 「－」 最小化 (only the bar, at the bottom right; the sound goes on), 「□」 最大化 (the whole
  // window) and ✕. Each button turns into 「元に戻す」 (縮小) while it applies; a double click on the bar does the
  // same as 「□」. The place and size are remembered on this PC. Another video plays in the same window. It stays
  // open while records are changed (to listen while writing) and goes with the lock (closeVideoPlayer).
  var PLAYER_KEY = "nisshi.videoPlayer", PLAYER_MIN_W = 240, PLAYER_MIN_H = 135, PLAYER_BAR = 34;
  var player = null;   // { el, frame, box: {x,y,w,h}, mode: "" | "max" | "min", video }
  function playerBox(){
    var b = null;
    try { b = JSON.parse(localStorage.getItem(PLAYER_KEY)); } catch(e){}
    if(!b || !(b.w > 0) || !(b.h > 0)){
      // The first time: 640 wide at 16:9 (smaller on a narrow screen), at the bottom right.
      var w = Math.min(640, window.innerWidth - 24), h = Math.round(w * 9 / 16) + PLAYER_BAR;
      b = { x: window.innerWidth - w - 16, y: window.innerHeight - h - 16, w: w, h: h };
    }
    b = fitPlayerBox(b);
    // Opened, it is all in sight, even where it was left half out of the window last time.
    b.x = Math.max(0, Math.min(b.x, window.innerWidth - b.w));
    b.y = Math.max(0, Math.min(b.y, window.innerHeight - b.h));
    return b;
  }
  // Within the window: never larger than it, and the bar always where it can be grabbed.
  function fitPlayerBox(b){
    var W = window.innerWidth, H = window.innerHeight;
    var w = Math.max(Math.min(PLAYER_MIN_W, W), Math.min(b.w, W));
    var h = Math.max(Math.min(PLAYER_MIN_H + PLAYER_BAR, H), Math.min(b.h, H));
    var x = Math.min(Math.max(b.x, 80 - w), W - 80);
    var y = Math.min(Math.max(b.y, 0), H - PLAYER_BAR);
    return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
  }
  function placePlayer(){
    if(!player) return;
    var s = player.el.style, b = player.box;
    player.el.classList.toggle("max", player.mode === "max");
    player.el.classList.toggle("min", player.mode === "min");
    if(player.mode){ s.left = s.top = s.width = s.height = ""; }
    else { s.left = b.x + "px"; s.top = b.y + "px"; s.width = b.w + "px"; s.height = b.h + "px"; }
    var min = player.el.querySelector('[data-act="min"]'), max = player.el.querySelector('[data-act="max"]');
    min.textContent = player.mode === "min" ? "▭" : "－";
    min.title = player.mode === "min" ? "元に戻す（動画を見える大きさに戻します）" : "最小化（題の帯だけにします。音は続きます）";
    // While 最小化, only 「元に戻す」 (back to the size it had): no 最大化 beside it, two squares were confusing (v1.0.174).
    max.hidden = player.mode === "min";
    max.textContent = player.mode === "max" ? "❐" : "□";
    max.title = player.mode === "max" ? "元に戻す（縮小）" : "最大化（窓いっぱいにします）";
  }
  function setPlayerMode(mode){
    if(!player) return;
    player.mode = player.mode === mode ? "" : mode;
    placePlayer();
  }
  function rememberPlayerBox(){
    try { localStorage.setItem(PLAYER_KEY, JSON.stringify(player.box)); } catch(e){}
  }
  function videoEmbedUrl(v){
    return VIDEO_EMBED + v.id + "?autoplay=1&rel=0&playsinline=1" + (v.start ? "&start=" + v.start : "");
  }
  // Windows app (v1.0.189): a window of its own like the memo's (main.js allows the name "video": always on
  // top, in the taskbar, －/□/✕ of Windows, Snap, its place and size remembered), so it can go to another
  // display. The web version keeps the window over the page (below).
  var videoWin = null;   // { win, frame, video }
  // What plays in the window: YouTube's player, or (動画ファイル, v1.0.201) a <video> whose address comes
  // later (src: Promise<url>) — the window opens at once and shows 「読み込んでいます…」 meanwhile.
  function videoWindowFrame(d, v, src){
    if(!v.file){
      var f = d.createElement("iframe");
      f.title = "YouTube の動画";
      f.setAttribute("allow", "autoplay; encrypted-media; picture-in-picture; fullscreen");
      f.setAttribute("allowfullscreen", "");
      f.setAttribute("referrerpolicy", "strict-origin-when-cross-origin");
      f.src = videoEmbedUrl(v);
      return f;
    }
    var box = d.createElement("div");
    box.className = "vf";
    var note = d.createElement("p");
    note.textContent = "動画を読み込んでいます…";
    box.appendChild(note);
    function failed(err){
      if(!box.isConnected) return;
      note.textContent = err && err.message && (err.code === "broken" || err.code === "too_large") ? err.message : "動画を開けませんでした。通信状況をご確認ください。";
      note.hidden = false;
    }
    Promise.resolve(src).then(function(url){
      if(!box.isConnected) return;
      var el = d.createElement("video");
      var triedWhole = false, gotSome = false;
      el.controls = true;
      el.autoplay = true;
      el.setAttribute("playsinline", "");
      el.addEventListener("error", function(){
        if(!box.isConnected) return;
        // Web version (v1.0.203): a browser that did not let video-sw.js answer the player (nothing came from
        // that address at all) gets the whole video read into memory instead. A video that did play and then
        // failed (the line dropped) is not read whole: that could be hundreds of MB on a phone.
        if(!triedWhole && !gotSome && api.videos && api.videos.whole && /nisshi-video\//.test(el.getAttribute("src") || "")){
          triedWhole = true;
          note.textContent = "動画を読み込んでいます…";
          note.hidden = false;
          api.videos.whole(el.getAttribute("src"), function(r){
            if(box.isConnected){ note.textContent = "動画を読み込んでいます " + Math.floor(r * 100) + "%"; }
          }).then(function(blobUrl){
            if(!box.isConnected) return;
            el.src = blobUrl;
            start();
          }, function(err){ el.remove(); failed(err); });
          return;
        }
        el.remove();
        failed({ message: "この動画は再生できませんでした。通信状況をご確認ください。", code: "broken" });
      });
      el.addEventListener("loadedmetadata", function(){ gotSome = true; });
      el.addEventListener("loadeddata", function(){ note.hidden = true; });
      el.addEventListener("playing", function(){ note.hidden = true; });
      // iPhone / iPad do not start a video with sound by themselves (the tap that opened it is long past):
      // its ▶ is then left for a tap, and the note must not cover it.
      function start(){
        var p = el.play();
        if(p && p.catch){ p.catch(function(err){ if(err && err.name === "NotAllowedError"){ note.hidden = true; } }); }
      }
      el.src = url;
      box.appendChild(el);
      start();
    }, failed);
    return box;
  }
  function openVideoWindow(v, src){
    if(videoWin && !videoWin.win.closed){
      if(videoWin.video.id !== v.id || videoWin.video.start !== v.start){
        videoWin.video = v;
        var nf = videoWindowFrame(videoWin.win.document, v, src);
        videoWin.frame.replaceWith(nf);
        videoWin.frame = nf;
      }
      // Minimized or behind other windows: the main process brings it back.
      (api.showSheet ? api.showSheet("video") : Promise.reject()).catch(function(){ videoWin.win.focus(); });
      return;
    }
    var w = window.open("", "video");
    if(!w){ return; }
    var d = w.document;
    d.title = "▶ 動画 — 航海日誌";
    d.documentElement.lang = "ja";
    var st = d.createElement("style");
    st.textContent = "html,body{height:100%;margin:0;background:#000;overflow:hidden}iframe{display:block;width:100%;height:100%;border:0}" +
      ".vf{position:relative;width:100%;height:100%}.vf video{display:block;width:100%;height:100%;background:#000}" +
      ".vf p{position:absolute;left:0;right:0;top:45%;margin:0;text-align:center;color:#ddd;font:14px 'Yu Gothic UI',sans-serif;pointer-events:none}";
    d.head.appendChild(st);
    var f = videoWindowFrame(d, v, src);
    d.body.appendChild(f);
    var mine = { win: w, frame: f, video: v };
    videoWin = mine;
    w.addEventListener("pagehide", function(){ if(videoWin === mine){ videoWin = null; } });
  }

  /* ---------- 動画ファイル (v1.0.201) ---------- */
  // 動画の札: { v:1, fileId, key, size, chunk, mime, name } — stored like an image (encrypted with the passphrase,
  // doc.images[<video id>]), so a passphrase change and a backup carry it as they do an image, and older versions
  // leave it alone. The video itself (vid-<id>.bin) is listed nowhere else: it goes to the Drive trash with its 札.
  var videoMetas = {};    // video id -> Promise<札>, until the lock
  var localVideos = {};   // video id -> { file, path, url, mime, name } chosen on this PC (kept after saving, to play it from the PC)
  var videoProgress = null;   // what to do with the upload's progress (the save button shows it)
  // Videos are added and sent only by the Windows app; the web version only plays them (v1.0.203).
  var canAddVideos = !!(api.videos && api.videos.upload);
  if(canAddVideos){ api.videos.onProgress(function(p){ if(videoProgress){ videoProgress(p); } }); }
  function loadVideoMeta(id){
    if(videoMetas[id]) return videoMetas[id];
    var fileId = doc && doc.images[id];
    if(!fileId || !sessionKey){ return Promise.reject({ code: "broken", message: "この動画の札が見つかりません（もう1台のPCで入れたばかりなら、少し待ってから開き直してください）。" }); }
    var p = api.downloadImage(fileId).then(function(packed){ return decryptBytes(sessionKey, packed); }).then(function(bytes){
      return JSON.parse(new TextDecoder().decode(bytes));
    });
    videoMetas[id] = p;
    p.catch(function(){ if(videoMetas[id] === p){ delete videoMetas[id]; } });
    return p;
  }
  // The address the player plays: the file itself while it is not saved yet, else from Drive (video.js).
  function fileVideoSrc(id){
    if(localVideos[id]) return Promise.resolve(localVideos[id].url);
    return loadVideoMeta(id).then(function(m){
      return api.videos.play({ fileId: m.fileId, key: m.key, size: m.size, chunk: m.chunk, mime: m.mime });
    });
  }
  function forgetVideos(){
    videoMetas = {};
    Object.keys(localVideos).forEach(function(id){ URL.revokeObjectURL(localVideos[id].url); });
    localVideos = {};
    if(api.videos){ api.videos.forget().catch(noop); }
  }
  // Videos no record uses any more (none of liveEntries but `except` has them in its body).
  function unusedVideos(ids, except){
    return ids.filter(function(id){
      return !liveEntries.some(function(e){ return e.id !== except && fileVideoIdsIn(e.body).indexOf(id) >= 0; });
    });
  }
  // The video files of those videos, to go to the trash with their 札 after the record is saved:
  // { ids, files }. A video whose 札 cannot be read now (offline) keeps its 札, so it is not left on Drive
  // with nothing pointing at it; it is simply no longer in the record.
  function videoFilesOf(ids){
    return Promise.all(ids.map(function(id){
      return loadVideoMeta(id).then(function(m){ return m.fileId ? { id: id, file: m.fileId } : null; }, function(){ return null; });
    })).then(function(list){
      list = list.filter(Boolean);
      return { ids: list.map(function(x){ return x.id; }), files: list.map(function(x){ return x.file; }) };
    });
  }
  // A video from this PC: checks that it plays here, makes its picture (the frame at 1 second, on a black 16:9
  // sheet) and its length. Resolves { url, width, height, duration, blob (JPEG) }.
  function probeVideo(file){
    return new Promise(function(resolve, reject){
      var url = URL.createObjectURL(file);
      var el = document.createElement("video");
      var finished = false;
      var timer = setTimeout(fail, 30000);
      function fail(){
        if(finished) return;
        finished = true;
        clearTimeout(timer);
        URL.revokeObjectURL(url);
        el.removeAttribute("src");
        reject({ code: "unplayable" });
      }
      el.muted = true;
      el.preload = "auto";
      el.addEventListener("error", fail);
      el.addEventListener("loadedmetadata", function(){
        if(!el.videoWidth){ fail(); return; }
        // A recording that does not say how long it is (duration Infinity) still plays: the picture at 1 second.
        el.currentTime = isFinite(el.duration) ? Math.min(1, el.duration / 3) : 1;
      });
      el.addEventListener("seeked", function(){
        if(finished) return;
        var W = 1280, H = 720, c = document.createElement("canvas");
        c.width = W; c.height = H;
        var g = c.getContext("2d");
        g.fillStyle = "#000";
        g.fillRect(0, 0, W, H);
        var s = Math.min(W / el.videoWidth, H / el.videoHeight);
        var w = el.videoWidth * s, h = el.videoHeight * s;
        g.drawImage(el, (W - w) / 2, (H - h) / 2, w, h);
        c.toBlob(function(blob){
          if(finished) return;
          finished = true;
          clearTimeout(timer);
          if(!blob){ URL.revokeObjectURL(url); reject({ code: "unplayable" }); return; }
          resolve({ url: url, width: el.videoWidth, height: el.videoHeight, duration: el.duration, blob: blob });
        }, "image/jpeg", 0.85);
      }, { once: true });
      el.src = url;
    });
  }
  // A video file chosen in the editor → done({ id, file:true }, thumb) once it is checked; thumb is its picture,
  // a new draft image. Nothing goes to Drive until the record is saved.
  var MAX_VIDEO_BYTES = 2 * 1000 * 1000 * 1000;   // the same limit as video.js (checked again there)
  function prepareVideoFile(file, done){
    if(!canAddVideos){ showToast("動画ファイルは、パソコンのアプリで入れられます"); return; }
    if(file.size > MAX_VIDEO_BYTES){ showToast("この動画は大きすぎます（1本 2GB まで）", 5000); return; }
    var path = "";
    try { path = api.videos.filePath(file); } catch(e){}
    if(!path){ showToast("この動画ファイルの場所が分かりませんでした（パソコンの中のファイルを選んでください）", 5000); return; }
    showToast("動画を確かめています…", 30000);
    probeVideo(file).then(function(p){
      return p.blob.arrayBuffer().then(function(ab){
        var id = genId();
        localVideos[id] = { file: file, path: path, url: p.url, mime: /^video\//.test(file.type) ? file.type : "video/mp4", name: file.name || "動画" };
        var bytes = new Uint8Array(ab);
        var thumb = { id: genId(), mime: "image/jpeg", name: "動画の絵（" + (file.name || "動画") + "）", width: 1280, height: 720,
                      size: bytes.byteLength, isNew: true, bytes: bytes, ytThumb: id, duration: isFinite(p.duration) ? Math.round(p.duration) : 0,
                      url: URL.createObjectURL(p.blob) };
        showToast("動画を入れました。保存すると、Googleドライブへ送ります（送り終わるまでパソコンの動画は消さないでください）", 6000);
        done({ id: id, start: 0, file: true }, thumb);
      });
    }, function(){
      showToast("この動画は、アプリで再生できない形式でした。MP4（H.264）の動画を選んでください。", 7000);
    });
  }

  function openVideoPlayer(v){
    if(v.file && !api.videos){ showToast("動画ファイルは、パソコンのアプリで再生できます", 4000); return; }
    // YouTube (v1.0.204): never inside the diary any more. An embedded player gets no YouTube cookies, so the
    // owner's Premium did not apply and ads played (v1.0.199). Windows: the usual browser's small window
    // (main.js app:youtube); web: YouTube itself (on iPhone / iPad the YouTube app), both signed in.
    if(!v.file){
      if(api.openYoutube){
        api.openYoutube({ id: v.id, start: v.start || 0 }).then(function(r){
          showToast(r && r.app ? "▶ " + (r.browser === "msedge" ? "Edge" : "ブラウザ") + " の窓で再生します" : "▶ ブラウザで再生します", 3000);
        }, function(err){ showToast(withDetail("動画を開けませんでした", err), 5000); });
      } else {
        openOutside(videoUrl(v));
      }
      return;
    }
    if(siteApi){ openVideoWindow(v, v.file ? fileVideoSrc(v.id) : null); return; }
    // The web version (動画ファイル too since v1.0.203): the window over the page.
    if(player){
      // The same video again: only brought back from 最小化. Another one: it replaces the one playing.
      if(player.video.id !== v.id || player.video.start !== v.start){
        player.video = v;
        var nf = videoWindowFrame(document, v, v.file ? fileVideoSrc(v.id) : null);
        player.frame.replaceWith(nf);
        player.frame = nf;
        labelPlayer();
      }
      if(player.mode === "min"){ player.mode = ""; }
      placePlayer();
      return;
    }
    var el = document.createElement("div");
    el.className = "yt-player";
    el.setAttribute("role", "dialog");
    el.innerHTML =
      '<div class="yt-player-bar" title="つまんで動かせます（ダブルクリックで最大化・元に戻す）">' +
        '<span class="yt-player-title">▶ YouTube</span>' +
        '<button type="button" data-act="open" title="いつものブラウザの YouTube で開きます">↗</button>' +
        '<button type="button" data-act="min"></button>' +
        '<button type="button" data-act="max"></button>' +
        '<button type="button" data-act="close" class="yt-player-close" title="閉じる（再生を止めます）">✕</button>' +
      '</div>' +
      '<div class="yt-player-body"></div>' +
      ["n", "s", "e", "w", "ne", "nw", "se", "sw"].map(function(d){
        return '<div class="yt-player-edge e-' + d + '" data-edge="' + d + '"></div>';
      }).join("") +
      '<div class="yt-player-grip" data-edge="se" title="つまんで大きさを変えられます"></div>';
    var f = videoWindowFrame(document, v, v.file ? fileVideoSrc(v.id) : null);
    el.querySelector(".yt-player-body").appendChild(f);
    player = { el: el, frame: f, box: playerBox(), mode: "", video: v };
    labelPlayer();
    document.body.appendChild(el);
    placePlayer();

    el.querySelector(".yt-player-bar").addEventListener("click", function(e){
      var b = e.target.closest("button");
      if(!b) return;
      var act = b.getAttribute("data-act");
      if(act === "close"){ closeVideoPlayer(); }
      else if(act === "open"){ openOutside(videoUrl(player.video)); }
      else { setPlayerMode(act); }
    });
    el.querySelector(".yt-player-bar").addEventListener("dblclick", function(e){
      if(!e.target.closest("button")){ setPlayerMode(player.mode === "min" ? "min" : "max"); }
    });
    // Dragging the bar moves it, dragging an edge or the grip resizes it. The video would take the pointer
    // while it passes over it, so it takes none during the drag (.busy).
    el.addEventListener("pointerdown", function(e){
      if(e.button !== 0 || !player) return;
      var edge = e.target.getAttribute && e.target.getAttribute("data-edge");
      var onBar = !edge && e.target.closest(".yt-player-bar") && !e.target.closest("button");
      if(!edge && !onBar) return;
      if(player.mode === "max" && !onBar) return;
      if(player.mode === "min" && edge) return;
      e.preventDefault();
      var start = { x: e.clientX, y: e.clientY, box: Object.assign({}, player.box) };
      var target = e.target;
      try { target.setPointerCapture(e.pointerId); } catch(err){}
      el.classList.add("busy");
      function move(ev){
        if(!player) return;   // closed by the lock meanwhile
        // Dragged out of 最大化 or 最小化 (a few pixels, so a click or double click does not), it is the window
        // at its own size again, its bar under the pointer.
        if(player.mode){
          if(Math.abs(ev.clientX - start.x) + Math.abs(ev.clientY - start.y) < 6) return;
          var r = el.getBoundingClientRect();
          var grab = Math.min(start.box.w - 60, Math.max(60, (start.x - r.left) / r.width * start.box.w));
          start.box.x = start.x - grab;
          start.box.y = start.y - PLAYER_BAR / 2;
          player.mode = "";
        }
        var dx = ev.clientX - start.x, dy = ev.clientY - start.y, b = Object.assign({}, start.box);
        if(onBar){ b.x += dx; b.y += dy; }
        else {
          if(/e/.test(edge)){ b.w = Math.max(PLAYER_MIN_W, start.box.w + dx); }
          if(/s/.test(edge)){ b.h = Math.max(PLAYER_MIN_H + PLAYER_BAR, start.box.h + dy); }
          if(/w/.test(edge)){ b.w = Math.max(PLAYER_MIN_W, start.box.w - dx); b.x = start.box.x + start.box.w - b.w; }
          if(/n/.test(edge)){ b.h = Math.max(PLAYER_MIN_H + PLAYER_BAR, start.box.h - dy); b.y = start.box.y + start.box.h - b.h; }
        }
        player.box = fitPlayerBox(b);
        placePlayer();
      }
      function up(){
        target.removeEventListener("pointermove", move);
        target.removeEventListener("pointerup", up);
        target.removeEventListener("pointercancel", up);
        el.classList.remove("busy");
        if(player){ rememberPlayerBox(); }
      }
      target.addEventListener("pointermove", move);
      target.addEventListener("pointerup", up);
      target.addEventListener("pointercancel", up);
    });
  }
  // The bar of the web video window says what plays: a 動画ファイル has no YouTube page to open (↗).
  function labelPlayer(){
    var file = !!player.video.file;
    player.el.setAttribute("aria-label", file ? "動画" : "YouTube の動画");
    player.el.querySelector(".yt-player-title").textContent = file ? "▶ 動画" : "▶ YouTube";
    player.el.querySelector('[data-act="open"]').hidden = file;
  }
  function closeVideoPlayer(){
    if(videoWin){
      try{ videoWin.win.close(); } catch(e){}
      videoWin = null;
    }
    if(!player) return;
    player.el.remove();   // the video stops with its frame
    player = null;
  }
  // A smaller window (or a phone turned) keeps the video window inside it.
  window.addEventListener("resize", function(){
    if(player){ player.box = fitPlayerBox(player.box); placePlayer(); }
  });
  // Refs of attached images that the body actually places (markers pointing at nothing are ignored).
  function inlineRefs(body, images){
    var refs = [];
    String(body||"").split("\n").forEach(function(line){
      if(!MARKER_LINE.test(line)) return;
      markersIn(line).forEach(function(m){
        if(imageByRef(images, m.ref) && refs.indexOf(m.ref) < 0){ refs.push(m.ref); }
      });
    });
    return refs;
  }
  // v1.0.108: only the images placed in the text belong to the record as shown and printed; the others
  // are material kept in the editor's list. The one exception is a record laid out with 「画像の配置」
  // (自由配置, e.layout) and no image in the text, which shows them on that board after the body.
  function imagesAfterBody(e){
    if(!e.layout || inlineRefs(e.body, e.images).length) return [];
    return realImages(e.images);   // not the pictures of videos (v1.0.172)
  }
  // Gives every image a unique ref, keeping existing ones (the first holder of a duplicate keeps it).
  // reserved: numbers of images taken off with × that 戻す can bring back (v1.0.215), never given to another.
  function ensureRefs(images, reserved){
    // The pictures of videos (v1.0.172) are never placed by a marker: no number of their own.
    images.forEach(function(img){ if(img.ytThumb || img.pdfThumb){ delete img.ref; } });
    images = realImages(images);
    var used = [];
    images.forEach(function(img){
      if(img.ref && used.indexOf(img.ref) < 0){ used.push(img.ref); } else { img.ref = 0; }
    });
    var all = used.concat(reserved || []);
    var next = all.length ? Math.max.apply(null, all) + 1 : 1;
    images.forEach(function(img){ if(!img.ref){ img.ref = next++; } });
  }
  function inlineRowHtml(images, line, figure){
    var found = markersIn(line).map(function(m){ return { img: imageByRef(images, m.ref), size: m.size, align: m.align }; })
      .filter(function(f){ return f.img; });
    if(!found.length) return null;
    // The row takes the first position written on it.
    var align = (found.filter(function(f){ return f.align; })[0] || {}).align || "";
    var cls = ALIGN_CLASS[align] || "";
    var floating = /float/.test(cls);
    // A floating row is as wide as its (first) size; its images share that width.
    // A blank (白紙) takes its own width instead (paperPct).
    var rowPct = floating ? paperPct(found[0].img) : 0;
    return '<div class="inline-row'+(found.length > 1 ? ' multi' : '')+(cls ? ' '+cls : '')+
             (floating ? ' sz-'+(SIZE_CLASS[found[0].size] || "m") : '')+'"'+
             (rowPct ? ' style="width:'+rowPct+'%"' : '')+'>' + found.map(function(f){
      var pct = floating ? 0 : paperPct(f.img);
      return '<figure class="inline-fig'+(floating ? '' : ' sz-'+(SIZE_CLASS[f.size] || "m"))+'"'+
             (pct ? ' style="flex:0 1 '+pct+'%;width:'+pct+'%"' : '')+'>' + figure(f.img) + '</figure>';
    }).join("") + '</div>';
  }

  // figure(img) returns the markup for one placed image; without it markers stay as text.
  // videoPic(ytId) (v1.0.172): the saved picture of a video (see videoInnerHtml), or null for YouTube's.
  // pdfInfo(ref) (v1.0.205): what a "[PDF1]" line shows (see pdfInnerHtml); without it the line stays as text.
  function mdToHtml(src, images, figure, videoPic, pdfInfo){
    var lines = escapeHtml(src||"").split("\n");
    // Empty lines at the very start or end are not shown (v1.0.61): the body editor does not keep
    // them either (rich-editor.js setBody / getBody), only older records still have them.
    // Those above an image or video at the very top are shown (v1.0.193): the editor keeps them, as the
    // space between the title and the picture (rich-editor.js dropLeadingBlanks).
    var lead = 0;
    while(lead < lines.length && !lines[lead].trim()){ lead++; }
    var firstLine = lead < lines.length ? lines[lead] : "";
    if(!((figure && (videoIn(firstLine) || MARKER_LINE.test(firstLine))) || (pdfInfo && pdfIn(firstLine)) || ruleIn(firstLine))){ lines.splice(0, lead); }
    while(lines.length && !lines[lines.length - 1].trim()){ lines.pop(); }
    var html = "";
    var inList = false;
    // A wrapped image (左回り込み・右回り込み) and the text after it, up to the next
    // image line or heading, form one group; what follows starts below both.
    var inWrap = false;
    function closeWrap(){
      if(inList){ html += "</ul>"; inList = false; }
      if(inWrap){ html += "</div>"; inWrap = false; }
    }
    lines.forEach(function(line){
      var l = line;
      var rule = ruleIn(l);
      if(rule){
        closeWrap();
        html += '<div class="body-rule">' + ruleInnerHtml(rule) + '</div>';
        return;
      }
      var vid = figure ? videoIn(l) : null;
      var pdf = !vid && pdfInfo ? pdfIn(l) : null;
      if(vid || pdf){
        closeWrap();
        var vrow = pdf ? pdfRowHtml(pdf, pdfInfo(pdf.ref)) : videoRowHtml(vid, videoPic ? videoPic(vid.id) : null);
        // A wrapped video and the text after it form one group, as a wrapped image (v1.0.173).
        if(/ float /.test(vrow.slice(0, 80))){ html += '<div class="wrap-group">'; inWrap = true; }
        html += vrow;
        return;
      }
      if(figure && MARKER_LINE.test(l)){
        var row = inlineRowHtml(images, l, figure);
        if(row){
          closeWrap();
          if(/ float /.test(row.slice(0, 80))){ html += '<div class="wrap-group">'; inWrap = true; }
          html += row;
          return;
        }
      }
      if(/^\s*-\s+/.test(l)){
        if(!inList){ html += "<ul>"; inList = true; }
        var item = inlineMd(l.replace(/^\s*-\s+/,""));
        html += "<li"+smallTextLineHeight(item)+">"+item+"</li>";
        return;
      } else if(inList){ html += "</ul>"; inList = false; }

      var h = l.match(/^(#{1,3})\s+(.*)$/);
      if(h){
        closeWrap();
        var level = h[1].length + 1;
        html += "<h"+level+">"+inlineMd(h[2])+"</h"+level+">";
        return;
      }
      // An empty line stays an empty line (v1.0.58), as the body editor shows it.
      if(l.trim()===""){ html += "<p><br></p>"; return; }
      // Half-width spaces at the start of a line indent it (v1.0.94); HTML would drop them.
      var para = inlineMd(leadingSpacesKept(l));
      html += "<p"+smallTextLineHeight(para)+">"+para+"</p>";
    });
    closeWrap();
    return html || NO_BODY_HTML;
  }
  var NO_BODY_HTML = "<p style=\"color:var(--ink-faint)\">（本文なし）</p>";
  // 「（本文なし）」 is for a record with nothing at all (v1.0.209). A record with an empty body and only
  // attached files or laid-out images after it shows them straight under the title.
  function bodyOrNothing(html, e){
    return html === NO_BODY_HTML && (imagesAfterBody(e).length || filesAfterBody(e.files, e.body).length) ? "" : html;
  }
  // Spaces at the start of a line as no-break spaces, which HTML shows. The body text keeps plain
  // spaces (rich-editor.js setBody does the same on opening and getBody turns them back).
  function leadingSpacesKept(s){
    return s.replace(/^ +/, function(m){ return new Array(m.length + 1).join(" "); });
  }
  // A paragraph (or list item) whose text is all smaller than the body (v1.0.92): its lines are
  // spaced for its largest letters instead of the body's size, at the same ratio (--lh-ratio).
  // html is one line from inlineMd. rich-editor.js fitLineHeights does the same while writing.
  function smallTextLineHeight(html){
    var sizes = [10.5], max = 0;
    var parts = html.split(/(<[^>]*>)/);
    parts.forEach(function(p){
      if(p.charAt(0) === "<"){
        if(/^<span /.test(p)){
          var f = /font-size:calc\([^)]*\)\s*\*\s*(\d+(?:\.\d+)?)\)/.exec(p);
          sizes.push(f ? Number(f[1]) : sizes[sizes.length - 1]);
        } else if(p === "</span>" && sizes.length > 1){ sizes.pop(); }
        return;
      }
      if(p.trim()){ max = Math.max(max, sizes[sizes.length - 1]); }
    });
    if(!max || max >= 10.5) return "";
    return ' style="line-height:calc(var(--body-pt, 0.0952em) * ' + max + ' * var(--lh-ratio, 1.6))"';
  }
  // s is one line, already escaped. The size and colour spans come last: their CSS has a "*".
  function inlineMd(s){
    return textStyleHtml(s
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/\*(.+?)\*/g, "<em>$1</em>")
      .replace(/&lt;u&gt;(.+?)&lt;\/u&gt;/g, "<u>$1</u>")   // 下線（v1.0.110）
      .replace(/&lt;s&gt;(.+?)&lt;\/s&gt;/g, "<s>$1</s>"));   // 取り消し線（削除の意味）
  }

  // Text size and colour (v1.0.49) are kept in the body as HTML spans, which Markdown
  // readers also show:  <span style="color:#E53935; font-size:14pt">…</span>
  // Only a colour (#rgb / #rrggbb) and a size in points are understood; any other span stays
  // as plain text. Sizes are points of the printed page, where the body is 10.5pt; on screen
  // they scale with the body (--body-pt in style.css and PRINT_CSS). rich-editor.js writes them.
  var STYLE_TAG = /&lt;span style=&quot;([^&]*)&quot;&gt;|&lt;\/span&gt;/g;
  // The choices in the editor (the body is 10.5). Colours that read on both the light and dark look.
  var BODY_FONT_SIZES = [8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 24, 28, 36, 48];
  var lastCustomColor = null;   // the last colour chosen with 「その他の色」, kept while the app runs
  var BODY_COLORS = [
    { v:"#E53935", n:"赤" }, { v:"#EF6C00", n:"オレンジ" }, { v:"#C49A00", n:"黄土" }, { v:"#2E9E44", n:"緑" },
    { v:"#1E88E5", n:"青" }, { v:"#8E44AD", n:"紫" }, { v:"#D81B60", n:"ピンク" }, { v:"#8A8A8A", n:"灰" }
  ];
  function textStyleCss(style){
    var css = [], ok = true;
    style.split(";").forEach(function(d){
      var m = d.trim();
      if(!m) return;
      var c = /^color:\s*(#[0-9a-fA-F]{3}|#[0-9a-fA-F]{6})$/.exec(m);
      var f = /^font-size:\s*(\d+(?:\.\d+)?)pt$/.exec(m);
      if(c){ css.push("color:" + c[1]); }
      else if(f && Number(f[1]) >= 4 && Number(f[1]) <= 200){ css.push("font-size:calc(var(--body-pt, 0.0952em) * " + Number(f[1]) + ")"); }
      else { ok = false; }
    });
    return ok && css.length ? css.join(";") : null;
  }
  // The spans of one escaped line turned back into elements. Every span is closed on its own
  // line; a stray closing tag is left as text.
  function textStyleHtml(s){
    var open = 0;
    var out = s.replace(STYLE_TAG, function(tag, style){
      if(style !== undefined){
        var css = textStyleCss(style);
        if(css === null) return tag;
        open++;
        return '<span style="' + css + '">';
      }
      if(!open) return tag;
      open--;
      return "</span>";
    });
    while(open-- > 0){ out += "</span>"; }
    return out;
  }
  // The body without size, colour and underline (and 区切り線), for searching and the list's preview.
  function stripTextStyle(text){
    return String(text).replace(/<span style="[^"<>]*">|<\/span>|<\/?[us]>/g, "").replace(RULE_ANY, " ").replace(PDF_ANY, " ");
  }

  /* ---------------- generic confirm modal ---------------- */
  function openConfirmModal(title, help, onConfirm, okLabel, danger){
    var wrap = document.createElement("div");
    wrap.className = "modal-backdrop";
    wrap.innerHTML =
      '<div class="modal">' +
        '<h3>'+escapeHtml(title)+'</h3>' +
        '<p class="help">'+escapeHtml(help)+'</p>' +
        '<div class="modal-actions">' +
          '<button class="btn btn-ghost btn-small" id="modalCancel">キャンセル</button>' +
          '<button class="btn '+(danger===false?"btn-primary":"btn-danger")+' btn-small" id="modalOk">'+escapeHtml(okLabel || "削除する")+'</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(wrap);
    wrap.querySelector("#modalCancel").addEventListener("click", function(){ wrap.remove(); });
    wrap.querySelector("#modalOk").addEventListener("click", function(){ wrap.remove(); onConfirm(); });
  }

  // The image annotation editor. In the Windows app it opens in its own window (it can go to
  // another display), so the main window stays usable meanwhile. imgedContext remembers the
  // screen it was opened from: leaving that screen closes it (see guardLeave / renderMain).
  var imgedContext = null;
  function openImageEditor(opts){
    if(!api.isWeb && !window.ImageEditor.isOpen()){ imgedContext = { view: currentView, entryId: openEntryId }; }
    return window.ImageEditor.open(Object.assign({ separateWindow: !api.isWeb }, opts));
  }
  function closeImageEditorIfMoved(){
    if(!window.ImageEditor.isOpen() || !imgedContext) return;
    if(currentView === imgedContext.view && openEntryId === imgedContext.entryId) return;
    var lost = window.ImageEditor.hasUnapplied();
    window.ImageEditor.closeWindow();
    if(lost){ showToast("画面を移動したため、画像への書き込みの画面を閉じました（反映していない書き込みは失われました）", 6000); }
  }

  // Ask before leaving the editor with unsaved changes.
  function guardLeave(proceed){
    // 保存 pressed and still on its way: it is not "unsaved", so wait for it instead of asking (v1.0.175).
    if(waitEditorSave(function(){ guardLeave(proceed); })) return;
    // The editor window belongs to this screen: ask only if it has drawing not yet applied.
    if(window.ImageEditor.hasUnapplied()){
      openConfirmModal("画像への書き込みの画面に、反映していない書き込みがあります", "このまま移動すると、まだ「書き込みを反映」していない書き込みは失われます。", function(){
        window.ImageEditor.closeWindow();
        guardLeave(proceed);
      }, "反映せずに移動する");
      return;
    }
    // Everything in it is applied: it just closes with the screen (only once we really leave).
    function go(){ window.ImageEditor.closeWindow(); proceed(); }
    if(currentView === "editor" && editorDirty){
      openConfirmModal("保存していない変更があります", "このまま移動すると、編集中の内容と追加した画像は失われます。", function(){
        editorDirty = false;
        go();
      }, "保存せずに移動する");
      return;
    }
    go();
  }

  /* ---------------- images: compression ---------------- */
  function canvasToBlob(canvas, type, quality){
    return new Promise(function(resolve, reject){
      canvas.toBlob(function(b){ if(b){ resolve(b); } else { reject({ code:"encode_failed" }); } }, type, quality);
    });
  }

  function hasTransparency(bmp){
    var s = Math.min(1, 256 / Math.max(bmp.width, bmp.height));
    var c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(bmp.width*s));
    c.height = Math.max(1, Math.round(bmp.height*s));
    var ctx = c.getContext("2d");
    ctx.drawImage(bmp, 0, 0, c.width, c.height);
    var data = ctx.getImageData(0, 0, c.width, c.height).data;
    for(var i=3;i<data.length;i+=4){ if(data[i] < 255){ return true; } }
    return false;
  }

  // Returns { blob, mime, width, height } with blob.size <= MAX_IMAGE_BYTES.
  // - Small PNG/WebP/GIF files are kept as they are.
  // - Everything else is re-encoded (which also drops EXIF data such as
  //   GPS location): JPEG for opaque images, WebP when there is
  //   transparency. Quality is stepped down first, then the image is
  //   shrunk by 25% per round until it fits.
  function compressImage(file){
    return createImageBitmap(file, { imageOrientation:"from-image" }).catch(function(){
      return Promise.reject({ code:"unreadable" });
    }).then(function(bmp){
      var keepOriginal = file.size <= MAX_IMAGE_BYTES && file.type !== "image/jpeg" && file.type !== "image/bmp";
      if(keepOriginal){
        var kept = { blob:file, mime:file.type, width:bmp.width, height:bmp.height };
        bmp.close();
        return kept;
      }
      var alpha = file.type !== "image/jpeg" && hasTransparency(bmp);
      var type = alpha ? "image/webp" : "image/jpeg";
      var scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bmp.width, bmp.height));
      var qualities = [0.9, 0.82, 0.74, 0.66, 0.58, 0.5];

      function tryScale(round){
        if(round >= 12){ return Promise.reject({ code:"too_large" }); }
        var w = Math.max(1, Math.round(bmp.width*scale));
        var h = Math.max(1, Math.round(bmp.height*scale));
        var canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        var ctx = canvas.getContext("2d");
        if(!alpha){ ctx.fillStyle = "#FFFFFF"; ctx.fillRect(0, 0, w, h); }
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(bmp, 0, 0, w, h);
        function tryQuality(i){
          if(i >= qualities.length){
            scale *= 0.75;
            return tryScale(round+1);
          }
          return canvasToBlob(canvas, type, qualities[i]).then(function(blob){
            if(blob.size <= MAX_IMAGE_BYTES){ return { blob:blob, mime:type, width:w, height:h }; }
            return tryQuality(i+1);
          });
        }
        return tryQuality(0);
      }
      return tryScale(0).then(function(r){ bmp.close(); return r; }, function(e){ bmp.close(); throw e; });
    });
  }

  function extForMime(mime){
    return { "image/png":"png", "image/jpeg":"jpg", "image/webp":"webp", "image/gif":"gif" }[mime] || "img";
  }

  /* ---------------- images: Drive + cache ---------------- */
  var imageUrlCache = {};   // imageId -> Promise<blob: URL>

  function imagePlainBytes(img){
    var fileId = doc && doc.images[img.id];
    if(!fileId){ return Promise.reject({ code:"not_found" }); }
    return api.downloadImage(fileId).then(function(packed){ return decryptBytes(sessionKey, packed); });
  }
  function imageUrl(img){
    if(!imageUrlCache[img.id]){
      var p = imagePlainBytes(img).then(function(plain){
        return URL.createObjectURL(new Blob([plain], { type: img.mime || "image/jpeg" }));
      });
      imageUrlCache[img.id] = p;
      p.catch(function(){ if(imageUrlCache[img.id] === p){ delete imageUrlCache[img.id]; } });
    }
    return imageUrlCache[img.id];
  }
  function dropCachedImage(id){
    var p = imageUrlCache[id];
    if(!p) return;
    delete imageUrlCache[id];
    p.then(function(url){ URL.revokeObjectURL(url); }).catch(noop);
  }
  function clearImageCache(){
    Object.keys(imageUrlCache).forEach(dropCachedImage);
  }

  // img: the attached image shown. On the reading screen it gets 「別の記録へ」 (v1.0.71), like the side panel.
  function openLightbox(url, caption, img){
    var wrap = document.createElement("div");
    wrap.className = "lightbox";
    var from = img && currentView === "view" ? currentEntry() : null;
    var sendable = !READ_ONLY && !!(from && (from.images || []).some(function(x){ return x.id === img.id; }));
    // A close button of its own, so the window's ✕ (which quits the app) is never the obvious way back.
    wrap.innerHTML = '<button type="button" class="lightbox-close">✕ 閉じる</button>' +
      (sendable ? '<button type="button" class="lightbox-send" title="この画像を、ほかの記録や新しい記録にも添付します">別の記録へ</button>' : '') +
      '<img alt=""><div class="lightbox-caption"></div>';
    wrap.querySelector("img").src = url;
    wrap.querySelector(".lightbox-caption").textContent = caption || "";
    function onKey(e){ if(e.key === "Escape"){ close(); } }
    function close(){
      wrap.remove();
      document.removeEventListener("keydown", onKey);
      openPickers = openPickers.filter(function(f){ return f !== close; });
    }
    // It shows a decrypted picture: locking closes it.
    openPickers.push(close);
    wrap.addEventListener("click", close);
    if(sendable){
      wrap.querySelector(".lightbox-send").addEventListener("click", function(e){
        e.stopPropagation();
        close();
        openSendImagesModal(from, img.id);
      });
    }
    document.addEventListener("keydown", onKey);
    document.body.appendChild(wrap);
  }

  // noClick: the caller handles clicks itself (the edit screen shows the draft). Until v1.0.70 the edit
  // screen got both, so one click opened two full-screen views where there is no side panel.
  function loadThumbInto(container, img, urlPromise, noClick){
    var el = container.querySelector("img");
    urlPromise.then(function(url){
      if(!el.isConnected) return;
      el.src = url;
      if(!noClick){ el.addEventListener("click", function(){ showImage(url, img.name, el, img); }); }
      var loading = container.querySelector(".thumb-loading");
      if(loading){ loading.remove(); }
    }).catch(function(){
      if(!container.isConnected) return;
      var loading = container.querySelector(".thumb-loading");
      if(loading){ loading.remove(); }
      container.classList.add("thumb-error");
    });
  }

  // 「画像を別の記録へ」(v1.0.69): from the record being read, pick some of its images and a record to
  // attach them to (or a new one). That record's edit screen then opens with copies of them added,
  // so they can be placed in the text before saving. preId: the image shown in the side panel, picked at first.
  // 「過去の記録から」(v1.0.68): the picked images are copied into this record as new files, so
  // deleting either record never takes the other's image. Annotations and merges come along
  // (originals and sources are copied too), so they can still be rewritten or undone here.
  function copyStoredImage(img){
    var ids = {};
    function blobUrl(bytes, mime){ return URL.createObjectURL(new Blob([bytes], { type: mime })); }
    function copy(src){
      var id = genId();
      ids[src.id] = id;
      // Only the picture itself is a must: if the untouched original or a merge's source cannot be read,
      // the copy is a plain picture (as it looks) instead of failing.
      // A draft image not saved yet (v1.0.129, a second placing of it) has its bytes in memory.
      var gets = [src.bytes ? Promise.resolve(src.bytes) : imagePlainBytes(src)];
      if(src.edit && src.edit.originalId){
        gets.push(src.edit.originalBytes ? Promise.resolve(src.edit.originalBytes) : imagePlainBytes({ id: src.edit.originalId }).catch(function(){ return null; }));
      }
      var subs = src.composite ? Promise.all(src.composite.sources.map(copy)).catch(function(){ return null; }) : Promise.resolve(null);
      return Promise.all([Promise.all(gets), subs]).then(function(r){
        var bytes = new Uint8Array(r[0][0]), mime = src.mime || "image/jpeg";
        var out = { id: id, mime: mime, name: src.name, width: src.width, height: src.height, size: bytes.byteLength,
                    isNew: true, bytes: bytes, url: blobUrl(bytes, mime) };
        if(src.paper){ out.paper = { mmPerPx: src.paper.mmPerPx }; }
        if(src.src){ out.src = src.src; }
        if(src.ytThumb){ out.ytThumb = src.ytThumb; }
        if(src.duration){ out.duration = src.duration; }
        if(src.pdfThumb){ out.pdfThumb = src.pdfThumb; out.pages = src.pages || 0; }
        if(src.edit && src.edit.originalId && r[0][1]){
          var ob = new Uint8Array(r[0][1]), om = src.edit.originalMime || mime;
          out.edit = {
            originalId: genId(), originalMime: om, originalWidth: src.edit.originalWidth,
            originalHeight: src.edit.originalHeight, originalSize: ob.byteLength,
            originalBytes: ob, originalUrl: blobUrl(ob, om),
            crop: src.edit.crop ? JSON.parse(JSON.stringify(src.edit.crop)) : src.edit.crop,
            shapes: JSON.parse(JSON.stringify(src.edit.shapes || []))
          };
        }
        if(src.composite && r[1]){ out.composite = { sources: r[1], layout: remapLayout(src.composite.layout) }; }
        return out;
      });
    }
    // A merge's layout names its sources by id: point it at the copies.
    function remapLayout(layout){
      if(!layout || !layout.items) return layout ? JSON.parse(JSON.stringify(layout)) : layout;
      var out = JSON.parse(JSON.stringify(layout)), items = {};
      Object.keys(out.items).forEach(function(k){ items[ids[k] || k] = out.items[k]; });
      out.items = items;
      if(Array.isArray(out.order)){ out.order = out.order.map(function(k){ return ids[k] || k; }); }
      return out;
    }
    return copy(img);
  }

  // 「この記録をコピー」(v1.0.111): the whole record, images and files as new Drive files (as 「過去の記録から」
  // does, so deleting either record never takes the other's), opens as a new record on the chosen date.
  // Nothing is stored until it is saved there. Images keep their ref, so the markers in the body still point at them.
  // ▶ YouTube in the editor (v1.0.171): the address of the video → done({ id, start }).
  // text (v1.0.202): { title, help, ok } in place of the usual words (「🖼 YouTube の絵にする」 asks with it too).
  function openVideoModal(done, text){
    text = text || {};
    var wrap = document.createElement("div");
    wrap.className = "modal-backdrop";
    wrap.innerHTML =
      '<div class="modal">' +
        '<h3>' + escapeHtml(text.title || "YouTube の動画を入れる") + '</h3>' +
        '<p class="help">' + escapeHtml(text.help || ("YouTube で動画を開き、上のアドレス（または「共有」→「コピー」）をここに貼り付けてください。" +
          "本文の今の場所に動画が入り、記録の画面で押すと再生できます。印刷・PDF では動画の絵とアドレスが出ます。")) + '</p>' +
        '<div class="field"><label>動画のアドレス</label><input type="url" id="vdUrl" placeholder="https://www.youtube.com/watch?v=…" autocomplete="off"></div>' +
        '<p class="help" id="vdStatus" style="margin:0;"></p>' +
        '<div class="modal-actions">' +
          '<button class="btn btn-ghost btn-small" id="vdCancel">キャンセル</button>' +
          '<button class="btn btn-primary btn-small" id="vdOk">' + escapeHtml(text.ok || "入れる") + '</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(wrap);
    var input = wrap.querySelector("#vdUrl");
    function close(){
      wrap.remove();
      document.removeEventListener("keydown", onKey, true);
      openPickers = openPickers.filter(function(f){ return f !== close; });
    }
    openPickers.push(close);
    function onKey(ev){
      if(ev.key === "Escape" && !ev.isComposing){ ev.preventDefault(); ev.stopPropagation(); close(); }
    }
    document.addEventListener("keydown", onKey, true);
    function ok(){
      var v = parseYouTube(input.value);
      if(!v){
        wrap.querySelector("#vdStatus").textContent = input.value.trim()
          ? "YouTube の動画のアドレスではないようです。youtube.com か youtu.be で始まるアドレスを貼り付けてください。"
          : "アドレスを貼り付けてください。";
        input.focus();
        return;
      }
      close();
      done(v);
    }
    wrap.querySelector("#vdCancel").addEventListener("click", close);
    wrap.querySelector("#vdOk").addEventListener("click", ok);
    input.addEventListener("keydown", function(ev){ if(ev.key === "Enter" && !ev.isComposing){ ev.preventDefault(); ok(); } });
    input.focus();
  }

  function openCopyEntryModal(entry){
    var wrap = document.createElement("div");
    wrap.className = "modal-backdrop";
    var nImg = realImages(entry.images).length, nFile = (entry.files || []).length;
    wrap.innerHTML =
      '<div class="modal">' +
        '<h3>この記録をコピー</h3>' +
        '<p class="help">「' + escapeHtml(entry.title || "（無題）") + '」を' +
          (nImg || nFile ? '画像' + nImg + '枚・ファイル' + nFile + '件ごと' : '') +
          'コピーして、新しい記録の編集画面を開きます。保存すると新しい記録として残ります。元の記録はそのままです。</p>' +
        '<div class="field"><label>新しい記録の日付</label><input type="date" id="cpDate" value="' + todayStr() + '"></div>' +
        '<p class="help" id="cpStatus" style="margin:0;"></p>' +
        '<div class="modal-actions">' +
          '<button class="btn btn-ghost btn-small" id="cpCancel">キャンセル</button>' +
          '<button class="btn btn-primary btn-small" id="cpOk">コピーして開く</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(wrap);
    var stopped = false;
    function close(){
      stopped = true;
      wrap.remove();
      document.removeEventListener("keydown", onKey, true);
      openPickers = openPickers.filter(function(f){ return f !== close; });
    }
    openPickers.push(close);
    function onKey(ev){
      if(ev.key === "Escape" && !ev.isComposing){ ev.preventDefault(); ev.stopPropagation(); close(); }
    }
    document.addEventListener("keydown", onKey, true);
    wrap.querySelector("#cpCancel").addEventListener("click", close);
    wrap.querySelector("#cpOk").addEventListener("click", function(){
      var date = wrap.querySelector("#cpDate").value || todayStr();
      var okBtn = wrap.querySelector("#cpOk");
      okBtn.disabled = true;
      wrap.querySelector("#cpDate").disabled = true;
      wrap.querySelector("#cpStatus").textContent = "コピーしています…";
      var failed = 0, ids = {};
      var images = Promise.all((entry.images || []).map(function(img){
        return copyStoredImage(img).then(function(c){
          if(img.ref){ c.ref = img.ref; }
          ids[img.id] = c.id;
          return c;
        }, function(){ failed++; return null; });
      }));
      var files = Promise.all((entry.files || []).map(function(f){
        return imagePlainBytes({ id: f.id }).then(function(plain){
          var bytes = new Uint8Array(plain);
          return { id: genId(), name: f.name, mime: f.mime, size: bytes.byteLength, isNew: true, bytes: bytes, ref: f.ref || 0 };
        }, function(){ failed++; return null; });
      }));
      Promise.all([images, files]).then(function(r){
        if(stopped || !sessionKey) return;
        close();
        // 自由配置 names the images by id: point it at the copies.
        var layout = null;
        if(entry.layout){
          layout = JSON.parse(JSON.stringify(entry.layout));
          if(layout.items){
            var items = {};
            Object.keys(layout.items).forEach(function(k){ if(ids[k]){ items[ids[k]] = layout.items[k]; } });
            layout.items = items;
          }
          if(Array.isArray(layout.order)){ layout.order = layout.order.map(function(k){ return ids[k]; }).filter(Boolean); }
        }
        guardLeave(function(){
          pendingCopy = {
            title: entry.title || "", category: entry.category, date: date, body: entry.body || "",
            tags: (entry.tags || []).slice(), images: r[0].filter(Boolean), files: r[1].filter(Boolean), layout: layout
          };
          openEntryId = null;
          currentView = "editor";
          renderMain();
          showToast("コピーしました" + (failed ? "（" + failed + "件は読み込めませんでした）" : "") + "。保存すると新しい記録として残ります", failed ? 7000 : 5000);
        });
      });
    });
  }

  function openSendImagesModal(entry, preId){
    var images = realImages(entry.images);
    if(!images.length) return;
    var picked = images.filter(function(img){ return img.id === preId; });
    if(!picked.length && images.length === 1){ picked = images.slice(); }
    var targets = liveEntries.filter(function(e){ return e.id !== entry.id; })
      .sort(function(a, b){ return (b.date || "").localeCompare(a.date || "") || (b.updatedAt || "").localeCompare(a.updatedAt || ""); });
    var target = null;   // "new" or a record id
    var wrap = document.createElement("div");
    wrap.className = "modal-backdrop";
    wrap.innerHTML =
      '<div class="modal past-modal send-modal">' +
        '<h3>画像を別の記録へ添付</h3>' +
        '<p class="help">この記録の画像はそのまま残り、選んだ記録にはコピーが入ります。添付先の編集画面が開くので、本文の好きな所に置いてから保存してください。</p>' +
        '<div class="send-step">① 添付する画像（押して選ぶ）</div>' +
        '<div class="past-grid send-images">' + images.map(function(img, i){
          var on = picked.indexOf(img) >= 0;
          return '<button type="button" class="past-thumb' + (on ? " on" : "") + '" data-i="' + i + '" aria-pressed="' + on + '" title="' + escapeHtml(img.name || "") + '">' +
                   '<img alt=""><span class="past-check">✓</span><span class="send-ref mono">画像' + escapeHtml(String(img.ref || i + 1)) + '</span></button>';
        }).join("") + '</div>' +
        '<div class="send-step">② 添付先の記録</div>' +
        '<input type="search" class="past-filter" id="sendFilter" placeholder="タイトル・日付・タグで絞り込む">' +
        '<div class="past-list send-targets" id="sendTargets"></div>' +
        '<div class="modal-actions">' +
          '<span class="past-count" id="sendCount"></span>' +
          '<button class="btn btn-ghost btn-small" id="sendCancel">キャンセル</button>' +
          '<button class="btn btn-primary btn-small" id="sendOk" disabled>添付して開く</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(wrap);
    var okBtn = wrap.querySelector("#sendOk"), list = wrap.querySelector("#sendTargets");
    Array.prototype.forEach.call(wrap.querySelectorAll(".send-images .past-thumb"), function(b){
      var img = images[Number(b.getAttribute("data-i"))];
      imageUrl(img).then(function(url){ b.querySelector("img").src = url; }, function(){ b.classList.add("past-error"); });
      b.addEventListener("click", function(){
        var at = picked.indexOf(img);
        if(at >= 0){ picked.splice(at, 1); } else { picked.push(img); }
        b.classList.toggle("on", at < 0);
        b.setAttribute("aria-pressed", String(at < 0));
        sync();
      });
    });
    function row(id, date, title, extra){
      return '<button type="button" class="send-target' + (target === id ? " on" : "") + '" data-id="' + escapeHtml(id) + '">' +
               '<span class="mono">' + escapeHtml(date) + '</span> <span class="send-title">' + escapeHtml(title) + '</span>' +
               (extra ? '<span class="send-extra">' + escapeHtml(extra) + '</span>' : '') + '</button>';
    }
    function render(){
      var words = wrap.querySelector("#sendFilter").value.toLowerCase().split(/[\s　]+/).filter(Boolean);
      var html = words.length ? "" : row("new", fmtDate(todayStr()), "＋ 新しい記録", "今日の日付で作ります");
      targets.forEach(function(e){
        var hay = [fmtDate(e.date), e.date || "", e.title || "（無題）", catName(e.category)].concat(e.tags || []).join(" ").toLowerCase();
        if(!words.every(function(w){ return hay.indexOf(w) >= 0; })) return;
        var n = realImages(e.images).length;
        html += row(e.id, fmtDate(e.date), e.title || "（無題）", n ? "画像" + n + "枚" : "");
      });
      list.innerHTML = html || '<p class="past-empty">見つかりませんでした</p>';
    }
    list.addEventListener("click", function(ev){
      var b = ev.target.closest(".send-target");
      if(!b) return;
      target = b.getAttribute("data-id");
      Array.prototype.forEach.call(list.querySelectorAll(".send-target"), function(x){ x.classList.toggle("on", x === b); });
      sync();
    });
    function sync(){
      okBtn.disabled = !picked.length || !target;
      var name = target === "new" ? "新しい記録" : target ? "「" + ((targets.filter(function(e){ return e.id === target; })[0] || {}).title || "（無題）") + "」" : "";
      wrap.querySelector("#sendCount").textContent = !picked.length ? "画像を選んでください" : !target ? picked.length + "枚を選んでいます。添付先を選んでください"
        : picked.length + "枚を" + name + "へ";
    }
    function close(){
      wrap.remove();
      document.removeEventListener("keydown", onKey, true);
      openPickers = openPickers.filter(function(f){ return f !== close; });
    }
    openPickers.push(close);
    function onKey(ev){
      if(ev.key === "Escape" && !ev.isComposing){ ev.preventDefault(); ev.stopPropagation(); close(); }
    }
    document.addEventListener("keydown", onKey, true);
    wrap.querySelector("#sendFilter").addEventListener("input", render);
    wrap.querySelector("#sendCancel").addEventListener("click", close);
    okBtn.addEventListener("click", function(){
      // In the record's own order, whatever order they were picked in.
      var send = images.filter(function(img){ return picked.indexOf(img) >= 0; });
      var to = target;
      close();
      if(!sessionKey) return;
      guardLeave(function(){
        pendingEditorImages = send;
        openEntryId = to === "new" ? null : to;
        currentView = "editor";
        renderMain();
      });
    });
    render();
    sync();
  }

  // 「過去の記録から」(v1.0.68): picks images of other records, newest first. Thumbnails load as they
  // scroll into view, a few at a time. Resolves with the picked image metadata ([] when cancelled).
  function pickPastImages(excludeId){
    // Not the pictures of YouTube videos (v1.0.172): each group is a copy of the record with its images only.
    var groups = liveEntries.filter(function(e){ return e.id !== excludeId; })
      .map(function(e){ return Object.assign({}, e, { images: realImages(e.images) }); })
      .filter(function(e){ return e.images.length; })
      .sort(function(a, b){ return (b.date || "").localeCompare(a.date || "") || (b.updatedAt || "").localeCompare(a.updatedAt || ""); });
    return new Promise(function(resolve){
      var wrap = document.createElement("div");
      wrap.className = "modal-backdrop";
      wrap.innerHTML =
        '<div class="modal past-modal">' +
          '<h3>過去の記録から画像を添付</h3>' +
          '<p class="help">押して選び（何枚でも）、「添付する」を押します。この記録にはコピーが入るので、元の記録の画像はそのまま残ります。書き込みのある画像は、続けて書き直せます。</p>' +
          '<input type="search" class="past-filter" id="pastFilter" placeholder="タイトル・日付・タグで絞り込む（例：2026.10　相場）">' +
          '<div class="past-list" id="pastList"></div>' +
          '<div class="modal-actions">' +
            '<span class="past-count" id="pastCount"></span>' +
            '<button class="btn btn-ghost btn-small" id="pastCancel">キャンセル</button>' +
            '<button class="btn btn-primary btn-small" id="pastOk" disabled>添付する</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(wrap);
      var list = wrap.querySelector("#pastList"), okBtn = wrap.querySelector("#pastOk"), countEl = wrap.querySelector("#pastCount");
      var picked = [];   // [{ e, i }] in the order chosen
      var queue = [], running = 0;
      function load(job){
        running++;
        imageUrl(job.img).then(function(url){ job.el.querySelector("img").src = url; },
                               function(){ job.el.classList.add("past-error"); })
          .then(function(){ running--; pump(); });
      }
      function pump(){
        while(running < 4 && queue.length){
          var job = queue.shift();
          if(job.el.isConnected){ load(job); }
        }
      }
      var seen = "IntersectionObserver" in window ? new IntersectionObserver(function(items){
        items.forEach(function(it){
          if(!it.isIntersecting) return;
          seen.unobserve(it.target);
          var g = groups[Number(it.target.getAttribute("data-e"))];
          queue.push({ el: it.target, img: g.images[Number(it.target.getAttribute("data-i"))] });
        });
        pump();
      }, { root: list, rootMargin: "200px" }) : null;
      function matches(e, words){
        var hay = [fmtDate(e.date), e.date || "", e.title || "（無題）", catName(e.category)].concat(e.tags || []).join(" ").toLowerCase();
        return words.every(function(w){ return hay.indexOf(w) >= 0; });
      }
      function render(){
        var words = wrap.querySelector("#pastFilter").value.toLowerCase().split(/[\s　]+/).filter(Boolean);
        if(seen){ seen.disconnect(); }
        queue = [];
        var html = "";
        groups.forEach(function(e, ei){
          if(!matches(e, words)) return;
          html += '<section class="past-entry"><div class="past-head"><span class="mono">' + escapeHtml(fmtDate(e.date)) + '</span> ' +
                    escapeHtml(e.title || "（無題）") + '</div><div class="past-grid">' +
                  e.images.map(function(img, i){
                    var on = picked.some(function(p){ return p.e === ei && p.i === i; });
                    return '<button type="button" class="past-thumb' + (on ? " on" : "") + '" data-e="' + ei + '" data-i="' + i + '" aria-pressed="' + on + '" title="' +
                             escapeHtml(img.name || "") + '"><img alt=""><span class="past-check">✓</span></button>';
                  }).join("") + '</div></section>';
        });
        list.innerHTML = html || '<p class="past-empty">' + (groups.length ? "見つかりませんでした" : "画像のある過去の記録がありません") + '</p>';
        Array.prototype.forEach.call(list.querySelectorAll(".past-thumb"), function(b){
          if(seen){ seen.observe(b); } else { queue.push({ el: b, img: groups[Number(b.getAttribute("data-e"))].images[Number(b.getAttribute("data-i"))] }); }
        });
        pump();
      }
      function sync(){
        okBtn.disabled = !picked.length;
        okBtn.textContent = picked.length ? "添付する（" + picked.length + "枚）" : "添付する";
        countEl.textContent = picked.length ? picked.length + "枚を選んでいます" : "";
      }
      list.addEventListener("click", function(ev){
        var b = ev.target.closest(".past-thumb");
        if(!b) return;
        var ei = Number(b.getAttribute("data-e")), i = Number(b.getAttribute("data-i"));
        var at = -1;
        picked.forEach(function(p, k){ if(p.e === ei && p.i === i){ at = k; } });
        if(at >= 0){ picked.splice(at, 1); } else { picked.push({ e: ei, i: i }); }
        b.classList.toggle("on", at < 0);
        b.setAttribute("aria-pressed", String(at < 0));
        sync();
      });
      wrap.querySelector("#pastFilter").addEventListener("input", render);
      function finish(result){
        if(seen){ seen.disconnect(); }
        queue = [];
        wrap.remove();
        document.removeEventListener("keydown", onKey, true);
        openPickers = openPickers.filter(function(f){ return f !== cancel; });
        resolve(result);
      }
      function cancel(){ finish([]); }
      openPickers.push(cancel);
      function onKey(ev){
        if(ev.key === "Escape" && !ev.isComposing){ ev.preventDefault(); ev.stopPropagation(); finish([]); }
      }
      document.addEventListener("keydown", onKey, true);
      wrap.querySelector("#pastCancel").addEventListener("click", function(){ finish([]); });
      okBtn.addEventListener("click", function(){
        finish(picked.map(function(p){ return groups[p.e].images[p.i]; }));
      });
      render();
      sync();
      // Not on a touch screen, where it would bring up the keyboard over the pictures.
      if(window.matchMedia && window.matchMedia("(pointer: fine)").matches){ wrap.querySelector("#pastFilter").focus(); }
    });
  }

  /* ---------------- rendering: list / editor / view ---------------- */
  var viewRoot = document.getElementById("viewRoot");
  bindVideos(viewRoot);   // YouTube の動画 (v1.0.171)
  bindPdfBoxes(viewRoot);   // 本文の PDF (v1.0.205)

  function filteredEntries(){
    var list = liveEntries.slice();
    if(currentCategory !== "all"){
      list = list.filter(function(e){ return e.category === currentCategory; });
    }
    if(currentDate){
      list = list.filter(function(e){ return e.date === currentDate; });
    }
    if(currentTags.length){
      list = list.filter(function(e){
        return currentTags.every(function(t){ return (e.tags || []).indexOf(t) >= 0; });
      });
    }
    if(currentSearch){
      var q = currentSearch.toLowerCase();
      list = list.filter(function(e){
        return (e.title||"").toLowerCase().indexOf(q) >= 0 ||
               stripTextStyle(e.body||"").toLowerCase().indexOf(q) >= 0 ||
               (e.tags||[]).some(function(t){ return t.toLowerCase().indexOf(q) >= 0; });
      });
    }
    list.sort(function(a,b){
      if(a.date === b.date){ return (b.updatedAt||"").localeCompare(a.updatedAt||""); }
      return b.date.localeCompare(a.date);
    });
    return list;
  }

  // The top bar's height as a CSS variable, for the rows that stay under it while the page scrolls
  // (.view-sticky in style.css).
  function syncTopbarH(){
    var bar = document.querySelector("header.topbar");
    if(bar){ document.documentElement.style.setProperty("--topbar-h", bar.getBoundingClientRect().height + "px"); }
  }
  window.addEventListener("resize", syncTopbarH);
  if(window.ResizeObserver && document.querySelector("header.topbar")){ new ResizeObserver(syncTopbarH).observe(document.querySelector("header.topbar"), { box: "border-box" }); }

  /* ---------------- ☰ the left column (v1.0.206, the owner's wish) ---------------- */
  // A portrait or narrow screen (iPhone, iPad upright, a narrow window) keeps the calendar, TO DO, categories
  // and tags in a drawer that ☰ slides in from the left (html.drawer-mode, body.side-open), so the list and
  // the records get the whole screen. A wide landscape screen keeps the column, and ☰ hides or shows it there
  // (body.side-hidden, remembered in localStorage).
  var DRAWER_MQ = window.matchMedia ? window.matchMedia("(max-width: 760px), (orientation: portrait) and (max-width: 1100px)") : null;
  var SIDE_HIDDEN_KEY = "nisshi.sideHidden";
  function drawerMode(){ return !!(DRAWER_MQ && DRAWER_MQ.matches); }
  function syncMenuBtn(){
    var b = document.getElementById("menuBtn");
    if(!b){ return; }
    var shown = drawerMode() ? document.body.classList.contains("side-open") : !document.body.classList.contains("side-hidden");
    b.setAttribute("aria-expanded", shown ? "true" : "false");
    b.classList.toggle("on", shown && drawerMode());
  }
  function setSideOpen(open){
    document.body.classList.toggle("side-open", !!open && drawerMode());
    syncMenuBtn();
  }
  function syncDrawerMode(){
    document.documentElement.classList.toggle("drawer-mode", drawerMode());
    if(!drawerMode()){ document.body.classList.remove("side-open"); }
    syncMenuBtn();
  }
  (function(){
    try{ document.body.classList.toggle("side-hidden", localStorage.getItem(SIDE_HIDDEN_KEY) === "1"); }catch(e){}
    syncDrawerMode();
    if(DRAWER_MQ){
      if(DRAWER_MQ.addEventListener){ DRAWER_MQ.addEventListener("change", syncDrawerMode); }
      else if(DRAWER_MQ.addListener){ DRAWER_MQ.addListener(syncDrawerMode); }
    }
    document.getElementById("menuBtn").addEventListener("click", function(){
      if(drawerMode()){ setSideOpen(!document.body.classList.contains("side-open")); return; }
      var hide = !document.body.classList.contains("side-hidden");
      document.body.classList.toggle("side-hidden", hide);
      try{ localStorage.setItem(SIDE_HIDDEN_KEY, hide ? "1" : "0"); }catch(e){}
      syncMenuBtn();
      // The page column got wider or narrower: the sheet's zoom and the sticky rows measure again,
      // and the reading screen changes to or from the A4 sheet when it should (the resize handlers).
      window.dispatchEvent(new Event("resize"));
    });
    document.getElementById("sideBackdrop").addEventListener("click", function(){ setSideOpen(false); });
    // Choosing something in the drawer shows it, so the drawer goes away; ‹ › of the calendar and
    // 「📅 カレンダー」 only change the drawer itself, so it stays.
    document.querySelector("nav.sidebar").addEventListener("click", function(e){
      if(drawerMode() && e.target.closest && e.target.closest(".cal-day, .cat-item, .tag-chip, .tag-manage, .side-todo-list, .tool-item button:not([aria-haspopup])")){
        setSideOpen(false);
      }
    });
    document.addEventListener("keydown", function(e){
      if(e.key === "Escape" && document.body.classList.contains("side-open") && !document.querySelector("body > .modal-backdrop")){
        setSideOpen(false);
      }
    });
  })();

  /* ---------------- the left column's width ---------------- */
  // v1.0.217-v1.0.222 let the owner drag the border between the left column and the page. v1.0.225 (the owner):
  // only ☰ opens and closes it, so the border no longer moves. A width kept by an earlier version is forgotten,
  // or a column dragged closed could not be opened any more.
  try{ localStorage.removeItem("nisshi.sideWidth"); }catch(e){}

  function renderMain(){
    // 記録の窓 (v1.0.216): it has no list. Where the main window would show the list (一覧へ戻る, after a
    // delete, leaving a new record), the window closes (leaving has asked about unsaved changes already).
    if(RECORD_WIN && sessionKey && currentView === "list"){
      editorDirty = false;
      closeRich();
      api.records.claim(null);
      window.ImageEditor.closeWindow();
      try { window.close(); } catch(e){}
      return;
    }
    // One window writes a record at a time (main.js records:claim): another window that has it in its
    // editor comes to the front instead, and this one shows the record.
    if(api.records && sessionKey){
      if(currentView === "editor" && openEntryId && !api.records.claim(openEntryId)){
        currentView = "view";
        pendingEditorImages = null;
        showToast("この記録は別の窓で編集中です。その窓を前に出しました", 5000);
      } else if(currentView !== "editor" || !openEntryId){
        api.records.claim(null);
      }
      if(RECORD_WIN){ api.records.showing(openEntryId); showRecordTitle(); }
    }
    syncTopbarH();
    closeImageEditorIfMoved();
    var keep = sideCurrent;
    if(currentView !== "list"){ keepTyped(plans); }   // the day's list goes: a plan written there is added (v1.0.155)
    closeRich();
    closeSide();
    editorSideHooks = null;
    var innerEl = document.querySelector(".content-inner");
    if(innerEl){ innerEl.classList.toggle("page-wide", currentView === "editor" || currentView === "view"); }
    // v1.0.190: the reading screen hides the top bar and the sidebar on iPhone / iPad (web.css only;
    // the Windows app has no rule for it). Set before drawing, so usePaperLayout measures the full width.
    document.body.classList.toggle("full-view", currentView === "view");
    if(currentView !== "list"){ setSideOpen(false); }   // a record opens over the ☰ drawer (v1.0.206)
    if(!sessionKey){ return; }
    if(READ_ONLY && currentView === "editor"){ currentView = openEntryId ? "view" : "list"; document.body.classList.toggle("full-view", currentView === "view"); }
    if(currentView === "editor"){ renderEditor(openEntryId); restoreSide(keep); return; }
    if(currentView === "view"){ renderViewer(openEntryId); restoreSide(keep); return; }
    renderList();
  }

  function renderList(){
    var all = filteredEntries();
    var key = JSON.stringify([currentCategory, currentDate, currentTags, currentSearch]);
    if(key !== listPageKey){ listPageKey = key; listPage = 1; }
    var pages = Math.max(1, Math.ceil(all.length / LIST_PAGE_SIZE));
    listPage = Math.min(Math.max(1, listPage), pages);
    var first = (listPage - 1) * LIST_PAGE_SIZE;
    var list = all.slice(first, first + LIST_PAGE_SIZE);
    var title = currentCategory === "all" ? "すべての記録" : catName(currentCategory);
    if(currentDate){
      var p = currentDate.split("-");
      title = Number(p[0]) + "年" + Number(p[1]) + "月" + Number(p[2]) + "日の記録";
    }
    var html = '<div class="view-sticky">';   // stays under the top bar while the list scrolls (v1.0.104)
    html += '<div class="list-head"><h2 class="serif">'+escapeHtml(title)+'</h2>' +
            (currentDate ? '<button class="btn btn-ghost btn-small" id="clearDateBtn">日付の絞り込みを解除</button>' : '') +
            '</div>';
    if(currentTags.length){
      html += '<div class="tag-filter"><span class="tag-filter-label">タグで絞り込み中：</span>' + tagChips(currentTags, "on") +
              '<button class="btn btn-ghost btn-small" id="clearTagsBtn">タグの絞り込みを解除</button></div>';
    }
    html += '<div class="search-row"><input type="text" id="searchInput" placeholder="タイトル・本文・タグを検索" value="'+escapeHtml(currentSearch)+'"></div>';
    html += '</div>';
    // A day picked in the calendar: its plans above its records (v1.0.154, renderPlanBox).
    if(currentDate){ html += '<section class="plan-box" id="planBox"></section>'; }

    if(list.length === 0 && currentDate){
      html += '<p class="day-empty">この日の記録はありません。</p>';
    } else if(list.length === 0){
      // the same pixel compass as in the top bar
      html += '<div class="empty-state"><span class="compass">' + document.querySelector(".brand .compass").innerHTML + '</span>' +
              '<p>まだここには何も記録されていません。</p>' +
              '<p>最初の一行から、航海日誌をはじめましょう。</p></div>';
    } else {
      list.forEach(function(e){
        var col = resolveColor(catColor(e.category));
        var clip = attachBadges(e);
        var vids = videoIdsIn(e.body);
        html += '<div class="entry-card'+((e.id in importantBusy ? importantBusy[e.id] : e.important) ? ' important' : '')+(vids.length ? ' has-video' : '')+'" data-id="'+escapeHtml(e.id)+'" style="border-left-color:'+col+'">' +
                  importantMarkHtml(e) +
                  '<div class="entry-main">' +
                  // v1.0.206 (the owner's choice): two lines, so more records fit on the screen. No part of the text
                  // and no category name (its colour stays at the left edge). v1.0.207: No.・date・time first again,
                  // then the title (the owner asked for the No. line back on top).
                  '<div class="entry-meta">' +
                    entryNoHtml(e) +
                    '<span class="entry-date mono">'+listDate(e.date)+'</span>' +
                    '<span class="entry-time">'+escapeHtml(listWrittenLabel(e))+'</span>' +
                    // As in the reading screen (v1.0.169): the owner looked for an evening's change by the time
                    // in the list, and a record written earlier and changed then showed only when it was written.
                    (updatedLabel(e) ? '<span class="entry-time">・'+escapeHtml(updatedLabel(e))+'</span>' : '') +
                    clip +
                    ((e.tags && e.tags.length) ? '<span class="entry-tags">'+tagChips(e.tags)+'</span>' : '') +
                  '</div>' +
                  '<div class="entry-title">'+escapeHtml(e.title || "（無題）")+'</div>' +
                  '</div>' +
                  (vids.length ? listVideoThumbHtml(e, vids) : '') +
                '</div>';
      });
      html += pagerHtml(listPage, pages, first, list.length, all.length);
    }
    // A plan being written in the add row (v1.0.155): it stays there for the same day, and goes to its own day otherwise.
    var planCarry = readPlanTyped();
    if(planCarry && planCarry.day !== currentDate){ keepTyped(plans); planCarry = null; }
    viewRoot.innerHTML = html;
    renderPlanBox(planCarry);
    loadListVideoThumbs(viewRoot);

    if(currentTags.length){
      document.getElementById("clearTagsBtn").addEventListener("click", function(){
        currentTags = [];
        renderCategories();
        renderList();
      });
    }
    // A tag on a card or in the filter bar: add it to / take it off the filter (the card itself is not opened).
    Array.prototype.forEach.call(viewRoot.querySelectorAll(".tag-chip"), function(b){
      b.addEventListener("click", function(ev){
        ev.stopPropagation();
        toggleTag(b.getAttribute("data-tag"));
      });
    });
    if(currentDate){
      document.getElementById("clearDateBtn").addEventListener("click", function(){
        currentDate = "";
        renderCategories();
        renderList();
      });
    }
    var search = document.getElementById("searchInput");
    // v1.0.207: renderList rebuilds the input, which ended the Japanese conversion after its first letter
    // (「k」 stayed a letter and romaji could not be typed). While a conversion is going on, wait for its end.
    // Chromium sends input (isComposing) and then compositionend; Safari sends compositionend first.
    var composing = false;
    function searchNow(){
      if(search.value === currentSearch) return;
      currentSearch = search.value;
      renderList();
      var s2 = document.getElementById("searchInput");
      s2.focus();
      s2.selectionStart = s2.selectionEnd = s2.value.length;
    }
    search.addEventListener("compositionstart", function(){ composing = true; });
    search.addEventListener("compositionend", function(){ composing = false; searchNow(); });
    search.addEventListener("input", function(ev){
      if(composing || ev.isComposing) return;
      searchNow();
    });
    // iPhone / iPad: the mark is only shown (web.css lets a tap on it open the record)
    Array.prototype.forEach.call(READ_ONLY ? [] : viewRoot.querySelectorAll(".entry-mark"), function(b){
      b.addEventListener("click", function(ev){
        ev.stopPropagation();
        toggleImportant(b.closest(".entry-card").getAttribute("data-id"));
      });
    });
    Array.prototype.forEach.call(viewRoot.querySelectorAll(".entry-card"), function(card){
      card.addEventListener("click", function(){
        openEntryId = card.getAttribute("data-id");
        currentView = "view";
        renderMain();
        window.scrollTo(0,0);
      });
      // 記録の窓 (v1.0.216): right-click → 「⧉ 別の窓で開く」; the wheel button opens it at once.
      if(CAN_OPEN_WINDOWS){
        card.addEventListener("contextmenu", function(ev){
          ev.preventDefault();
          openCardMenu(card.getAttribute("data-id"), ev.clientX, ev.clientY);
        });
        card.addEventListener("mousedown", function(ev){ if(ev.button === 1){ ev.preventDefault(); } });   // no autoscroll
        card.addEventListener("auxclick", function(ev){
          if(ev.button !== 1) return;
          ev.preventDefault();
          openInWindow(card.getAttribute("data-id"), "view");
        });
      }
    });
    Array.prototype.forEach.call(viewRoot.querySelectorAll(".pager [data-page]"), function(b){
      b.addEventListener("click", function(){
        listPage = Number(b.getAttribute("data-page"));
        renderList();
        // to the top of the list, not the page: on a phone the sidebar sits above it
        var bar = document.querySelector("header.topbar");
        var barH = (bar && /sticky|fixed/.test(getComputedStyle(bar).position)) ? bar.getBoundingClientRect().height : 0;
        window.scrollTo(0, Math.max(0, viewRoot.getBoundingClientRect().top + window.scrollY - barH));
      });
    });
  }

  // 重要マーク (v1.0.141): a brass ribbon at the card's top right. Unmarked cards show a faint ☆ there on hover.
  // importantBusy: entry id -> the mark being saved, shown even if the list is redrawn before the save ends.
  var importantBusy = {};
  function importantMarkHtml(e){
    var on = e.id in importantBusy ? importantBusy[e.id] : !!e.important;
    return '<button class="entry-mark'+(on ? ' on' : '')+'" title="'+(on ? '重要マークを外す' : '重要マークを付ける')+'" aria-pressed="'+(on ? 'true' : 'false')+'">' +
           '<span class="entry-mark-star">★</span></button>';
  }
  // Saved with the record (entry.important); the 更新 time stays as it was, since the record itself did not change.
  // saveEntry waits for a save of this record still running (✎ 書き込み) and changes only the mark (v1.0.143).
  function toggleImportant(id){
    var e = liveEntries.filter(function(x){ return x.id === id; })[0];
    if(!e || id in importantBusy) return;
    var was = !!e.important;
    // The card as it is now: the list may have been redrawn meanwhile.
    var paint = function(on){
      var card = viewRoot.querySelector('.entry-card[data-id="'+CSS.escape(id)+'"]');
      var btn = card && card.querySelector(".entry-mark");
      if(!btn) return;
      btn.classList.toggle("on", on);
      card.classList.toggle("important", on);
      btn.setAttribute("aria-pressed", on ? "true" : "false");
      btn.title = on ? "重要マークを外す" : "重要マークを付ける";
    };
    importantBusy[id] = !was;
    paint(!was);
    saveEntry(e, [], [], { important: !was }).then(function(){
      delete importantBusy[id];
    }, function(err){
      delete importantBusy[id];
      paint(was);
      handleWriteError(err, "重要マークを保存できませんでした。通信状況をご確認ください。");
    });
  }

  // Page links under the list, like a blog: newer ← 1 2 3 … → older. Shown only when there is more than one page.
  function pagerHtml(page, pages, first, shown, total){
    if(pages < 2){ return ""; }
    var nums = [];
    for(var i = 1; i <= pages; i++){
      if(i === 1 || i === pages || Math.abs(i - page) <= 2){ nums.push(i); }
      else if(nums[nums.length - 1] !== "…"){ nums.push("…"); }
    }
    var h = '<nav class="pager" aria-label="ページ">';
    h += page > 1 ? '<button class="pager-btn pager-step" data-page="'+(page - 1)+'">← 新しい記録</button>' : '<span class="pager-step"></span>';
    h += '<span class="pager-nums">';
    nums.forEach(function(n){
      if(n === "…"){ h += '<span class="pager-gap">…</span>'; }
      else if(n === page){ h += '<span class="pager-btn pager-now" aria-current="page">'+n+'</span>'; }
      else { h += '<button class="pager-btn" data-page="'+n+'">'+n+'</button>'; }
    });
    h += '</span>';
    h += page < pages ? '<button class="pager-btn pager-step" data-page="'+(page + 1)+'">過去の記録 →</button>' : '<span class="pager-step"></span>';
    h += '</nav><div class="pager-info">全'+total+'件中 '+(first + 1)+'〜'+(first + shown)+'件目</div>';
    return h;
  }

  // A small picture of the record's first video at the right of its card (v1.0.188): the picture saved with the
  // record (img.ytThumb), else YouTube's. With more videos, the count is on it.
  function listVideoThumbHtml(e, vids){
    var saved = videoThumbFor(e.images, vids[0]);
    var remote = remoteThumbUrl(vids[0]);
    return '<div class="entry-vthumb" title="動画' + (vids.length > 1 ? '（' + vids.length + '本）' : '') + 'があります">' +
             '<img class="entry-vthumb-pic' + (isWideThumb(saved) ? ' wide' : '') + '" alt="" draggable="false"' +
               (saved ? ' data-entry="' + escapeHtml(e.id) + '" data-thumb-id="' + escapeHtml(saved.id) + '"'
                      : remote ? ' src="' + remote + '"' : '') + ' data-yt="' + escapeHtml(vids[0]) + '">' +
             '<img class="entry-vthumb-play" src="' + VIDEO_PLAY_MARK + '" alt="" draggable="false">' +
             (vids.length > 1 ? '<span class="entry-vthumb-n">' + vids.length + '</span>' : '') +
           '</div>';
  }
  function loadListVideoThumbs(root){
    Array.prototype.forEach.call(root.querySelectorAll("img.entry-vthumb-pic[data-thumb-id]"), function(el){
      var id = el.getAttribute("data-thumb-id");
      var e = liveEntries.filter(function(x){ return x.id === el.getAttribute("data-entry"); })[0];
      var img = e && (e.images || []).filter(function(x){ return x.id === id; })[0];
      el.removeAttribute("data-thumb-id");
      function remote(){ el.classList.remove("wide"); var u = remoteThumbUrl(el.getAttribute("data-yt")); if(u){ el.src = u; } }
      if(!img){ remote(); return; }
      imageUrl(img).then(function(u){ if(u){ el.src = u; } else { remote(); } }, remote);
    });
  }

  // What is attached, told apart: 📷 images, 📄 PDFs, 📎 other files, ▶ YouTube videos in the body (v1.0.188)
  // (list and calendar popup).
  function attachCounts(e){
    var pdf = (e.files || []).filter(function(f){ return fileIcon(f) === "📄"; }).length;
    return { img: realImages(e.images).length, pdf: pdf, other: (e.files || []).length - pdf, video: videoIdsIn(e.body).length };
  }
  function attachBadges(e){
    var c = attachCounts(e);
    return (c.video ? '<span class="entry-clip entry-clip-video" title="動画 '+c.video+'本"><span class="yt-mark">▶</span> 動画 '+c.video+'</span>' : '') +
           (c.img ? '<span class="entry-clip" title="画像 '+c.img+'枚">📷 '+c.img+'</span>' : '') +
           (c.pdf ? '<span class="entry-clip" title="PDF '+c.pdf+'件">📄 '+c.pdf+'</span>' : '') +
           (c.other ? '<span class="entry-clip" title="ファイル '+c.other+'件">📎 '+c.other+'</span>' : '');
  }

  function openNewEntry(){
    if(READ_ONLY){ return; }
    guardLeave(function(){
      openEntryId = null;
      currentView = "editor";
      renderMain();
    });
  }

  function renderViewer(id){
    var entry = liveEntries.filter(function(e){ return e.id===id; })[0];
    if(!entry && RECORD_WIN){ currentView = "list"; renderMain(); return; }   // deleted in another window: this one closes
    if(!entry){ currentView="list"; document.body.classList.remove("full-view"); renderList(); return; }
    splitSavedDuplicates(entry);
    var vcol = resolveColor(catColor(entry.category));
    var images = entry.images || [];
    var paper = viewerPaper = usePaperLayout();
    var html = "";
    html += '<div class="view-sticky"><div class="editor-top">' +
              '<button class="back-link" id="backToList">' + (RECORD_WIN ? '✕ この窓を閉じる' : '← 一覧へ戻る') + '</button>' +
              '<div class="editor-actions">' +
                // v1.0.192: no zoom buttons on iPhone; the top bar is hidden here, so the memo button sits in this row
                (paper && !IS_PHONE ? zoomBarHtml() : '') +
                (READ_ONLY ? '<button class="btn btn-ghost btn-small" id="btnMemoView" title="メモと TO DO リストを開く">📝 メモ・TO DO</button>' +
                '<button class="btn btn-ghost btn-small" id="btnPrintOne">印刷・PDF</button>' : '<button class="btn btn-ghost btn-small" id="btnEditEntry">編集する</button>' +
                (CAN_OPEN_WINDOWS ? '<button class="btn btn-ghost btn-small" id="btnOwnWindow" title="この記録を別の窓に出します（この画面は一覧に戻ります）。窓を並べて見比べたり、別々に編集したりできます">⧉ 別の窓で開く</button>' : '') +
                '<button class="btn btn-ghost btn-small" id="btnCopyEntry" title="この記録を画像・ファイルごとコピーして、好きな日付の新しい記録にします">この記録をコピー</button>' +
                (realImages(images).length ? '<button class="btn btn-ghost btn-small" id="btnSendImages" title="この記録の画像を、ほかの記録や新しい記録にも添付します">画像を別の記録へ</button>' : '') +
                '<button class="btn btn-ghost btn-small" id="btnPrintOne">印刷・PDF</button>' +
                '<button class="btn btn-ghost btn-small" id="btnExportOne" title="この記録をMarkdownで書き出します">Markdown</button>' +
                '<button class="btn btn-danger btn-small" id="btnDeleteEntry">削除</button>') +
              '</div>' +
            '</div></div>';
    if(paper){
      viewRoot.innerHTML = '<div class="viewer-layout"><div class="viewer-main">' + html +
        '<div class="paper-view" id="paperHost"></div></div><aside class="side-panel" id="sidePanel"></aside></div>';
      var host = document.getElementById("paperHost");
      renderPaper(host, entry).then(function(){
        bindFileCards(host, entry.files);
        Array.prototype.forEach.call(host.querySelectorAll(".paper img:not(.yt-thumb):not(.yt-play):not(.pdf-thumb)"), function(im){
          im.classList.add("zoomable");
          im.addEventListener("click", function(){ showImage(im.src, "", im, (host._imgByUrl || {})[im.src]); });
        });
      }).catch(function(err){
        showToast(withDetail("紙面を表示できませんでした", err), 6000);
      });
      bindViewerButtons(entry);
      return;
    }
    html += '<div class="view-card">' +
              '<div class="view-meta">' +
                entryNoHtml(entry) +
                '<span class="entry-date mono">'+fmtDate(entry.date)+'</span>' +
                '<span class="entry-time">'+escapeHtml(writtenLabel(entry))+'</span>' +
                (updatedLabel(entry) ? '<span class="entry-time">・'+escapeHtml(updatedLabel(entry))+'</span>' : '') +
                '<span class="entry-badge" style="background:'+vcol+'22;color:'+vcol+'">'+escapeHtml(catName(entry.category))+'</span>' +
                tagChips(entry.tags) +
              '</div>' +
              '<h2 class="view-title serif">'+escapeHtml(entry.title || "（無題）")+'</h2>' +
              '<div class="view-body">'+bodyOrNothing(mdToHtml(entry.body, images, function(img){
                return '<div class="thumb inline-thumb" data-img="'+escapeHtml(img.id)+'"><img alt="'+escapeHtml(img.name)+'"><span class="thumb-loading">読み込み中…</span></div>';
              }, laterVideoPic(images), laterPdfInfo(entry)), entry)+'</div>';
    var after = imagesAfterBody(entry);
    var layout = after.length && entry.layout ? boardLayoutFor(after, entry.layout) : null;
    if(layout){
      html += '<div class="view-board-wrap">' + boardMarkup(after, layout, function(img){
        return '<div class="thumb board-thumb" data-img="'+escapeHtml(img.id)+'"><img alt="'+escapeHtml(img.name)+'"><span class="thumb-loading">…</span></div>';
      }) + '</div>';
    } else if(after.length){
      html += '<div class="view-images">' + after.map(function(img){
        return '<div class="thumb" data-img="'+escapeHtml(img.id)+'"><img alt="'+escapeHtml(img.name)+'"><span class="thumb-loading">読み込み中…</span></div>';
      }).join("") + '</div>';
    }
    html += fileCardsHtml(filesAfterBody(entry.files, entry.body));
    html += '</div>';
    viewRoot.innerHTML = '<div class="viewer-layout"><div class="viewer-main">' + html +
      '</div><aside class="side-panel" id="sidePanel"></aside></div>';
    bindFileCards(viewRoot, entry.files);
    loadVideoPics(viewRoot, function(id){ return images.filter(function(x){ return x.id === id; })[0] || null; }, imageUrl);

    images.forEach(function(img){
      // The same image may be placed more than once in the text.
      Array.prototype.forEach.call(viewRoot.querySelectorAll('.thumb[data-img="'+CSS.escape(img.id)+'"]'), function(box){
        loadThumbInto(box, img, imageUrl(img));
      });
    });
    bindViewerButtons(entry);
  }

  // Whether the reading screen shows the A4 sheet (true) or the screen-sized layout (false); null when
  // it is not shown. Until v1.0.89 the owner picked 「紙面（A4）」 or 「読みやすく」; since v1.0.90 the
  // width decides (usePaperLayout), as it does for the editor, so reading and writing look the same.
  var viewerPaper = null;

  function bindViewerButtons(entry){
    // A tag on the record: the list of records with that tag.
    Array.prototype.forEach.call(viewRoot.querySelectorAll(".view-meta .tag-chip"), function(b){
      b.addEventListener("click", function(){ toggleTag(b.getAttribute("data-tag"), true); });
    });
    document.getElementById("backToList").addEventListener("click", function(){ currentView="list"; renderMain(); });
    document.getElementById("btnPrintOne").addEventListener("click", function(){ openPrintOneModal(entry); });
    if(READ_ONLY){
      document.getElementById("btnMemoView").addEventListener("click", function(){ document.getElementById("memoBtn").click(); });
      return;
    }
    document.getElementById("btnEditEntry").addEventListener("click", function(){ currentView="editor"; renderMain(); });
    var ownBtn = document.getElementById("btnOwnWindow");
    if(ownBtn){ ownBtn.addEventListener("click", function(){ moveToWindow(entry.id, "view"); }); }
    document.getElementById("btnCopyEntry").addEventListener("click", function(){ openCopyEntryModal(entry); });
    var sendBtn = document.getElementById("btnSendImages");
    if(sendBtn){ sendBtn.addEventListener("click", function(){ openSendImagesModal(entry); }); }
    document.getElementById("btnExportOne").addEventListener("click", function(){ exportSingleEntryMd(entry); });
    document.getElementById("btnDeleteEntry").addEventListener("click", function(){ confirmDeleteEntry(entry.id); });
  }

  function renderEditor(id){
    var entry = id ? liveEntries.filter(function(e){ return e.id===id; })[0] : null;
    var isNew = !entry;
    // 「この記録をコピー」: a new record that starts as the copy (its images and files are new, not saved yet).
    var copied = isNew ? pendingCopy : null;
    pendingCopy = null;
    var draft = entry ? Object.assign({}, entry) : copied ? {
      id: null, title: copied.title, category: copied.category, date: copied.date, body: copied.body
    } : {
      id: null, title:"", category: currentCategory!=="all" ? currentCategory : (doc.categories[0] && doc.categories[0].id),
      date: todayStr(), body:""
    };
    var originalImageIds = [].concat.apply([], (entry && entry.images || []).map(imageFileKeys))
      .concat((entry && entry.files || []).map(function(f){ return f.id; }));
    var draftImages = copied ? copied.images : (entry && entry.images || []).map(function(img){ return Object.assign({}, img, { isNew:false }); });
    var draftFiles = copied ? copied.files : (entry && entry.files || []).map(function(f){ return Object.assign({}, f, { isNew:false }); });
    // Attachments taken off with × (v1.0.215): { kind: "image" | "file", item, at, off, gone }. The body's 戻す /
    // やり直す (rich opts.extra) keeps which of them are off at each step, and puts them back in their lists (at
    // their old place) before the body with their markers. gone: its Drive files were trashed by a save, so it
    // cannot come back. off is set only here, so other ways out of a list (a merge) are no step of 戻す.
    var detached = [];
    function detachedList(d){ return d.kind === "image" ? draftImages : draftFiles; }
    function detachedRefs(kind){
      return detached.filter(function(d){ return d.kind === kind && d.item.ref; }).map(function(d){ return d.item.ref; });
    }
    function takeOut(d){
      if(d.kind === "image"){ draftImages = draftImages.filter(function(x){ return x !== d.item; }); }
      else { draftFiles = draftFiles.filter(function(x){ return x !== d.item; }); }
      d.off = true;
    }
    // × on an image or a file: remembered, then out of its list (the caller takes it out of the body and renders).
    function detach(kind, item){
      var d = detached.filter(function(x){ return x.item === item; })[0];
      if(!d){ d = { kind: kind, item: item, gone: false }; detached.push(d); }
      d.at = detachedList(d).indexOf(item);
      takeOut(d);
    }
    var detachHistory = {
      get: function(){ return detached.filter(function(d){ return d.off; }); },
      same: function(a, b){
        return (a || []).length === (b || []).length && (a || []).every(function(d, i){ return d === b[i]; });
      },
      set: function(off){
        off = off || [];
        var moved = { image: false, file: false }, lost = [];
        detached.forEach(function(d){
          var want = off.indexOf(d) >= 0;
          if(d.gone && d.off && !want && !d.told){ d.told = true; lost.push(d.kind === "image" ? "画像" + d.item.ref : "「" + (d.item.name || "ファイル") + "」"); }
          if(d.gone || d.off === want) return;
          var list = detachedList(d);
          if(want){
            if(d.kind === "image" && sideCurrent && sideCurrent.imgId === d.item.id){ closeSide(); }
            takeOut(d);
          } else {
            d.off = false;
            // Not twice, and not beside what took its place (書き込み keeps the number on a new image).
            if(list.some(function(x){ return x === d.item || x.id === d.item.id || (d.item.ref && x.ref === d.item.ref); })) return;
            list.splice(Math.max(0, Math.min(d.at, list.length)), 0, d.item);
          }
          moved[d.kind] = true;
        });
        if(moved.image && thumbGrid && thumbGrid.isConnected){ renderThumbs(); }
        if(moved.file && fileList && fileList.isConnected){ renderFiles(); }
        if(lost.length){
          showToast(lost.join("・") + "は、外したあとに保存したため（Googleドライブのゴミ箱に移しました）、「戻す」では戻せません", 7000);
        }
      }
    };
    ensureFileRefs(draftFiles, draft.body);   // "[PDF1]" in the body (v1.0.205)
    // A new record written while tags are picked in the sidebar starts with those tags.
    var draftTags = entry ? (entry.tags || []).slice() : copied ? copied.tags : currentTags.slice();
    ensureRefs(draftImages, detachedRefs("image"));
    var draftLayout = copied ? copied.layout : entry && entry.layout ? JSON.parse(JSON.stringify(entry.layout)) : null;
    var edAfterKey = null;   // what edAfter shows now (refreshEdAfter)
    var compressing = 0;
    // Leaving a copy before it is saved asks first, like any other change.
    editorDirty = !!copied;

    var catOptions = (doc.categories||[]).map(function(c){
      return '<option value="'+escapeHtml(c.id)+'" '+(draft.category===c.id?"selected":"")+'>'+escapeHtml(c.name)+'</option>';
    }).join("");

    // On a wide screen the body is written on the A4 sheet (paperEd, below). The part from the
    // back/save row down to the text tools then stays at the top of the window while the sheet
    // scrolls under it (v1.0.101), so the tools can be reached while writing low on the page.
    var paperEd = usePaperLayout();
    var html = '<div class="editor-wrap">';
    if(paperEd){ html += '<div class="editor-sticky" id="edSticky">'; }
    html += '<div class="editor-top">' +
              // A new record in a record window (v1.0.229): leaving it closes the window, as the reading screen's button says.
              // v1.0.225 (the owner): the list in one press from the editor. Not for a new record (the button
              // beside it goes to the list already) nor in a record window (it has no list; the window would close).
              // v1.0.231 (the owner): 「一覧に戻る」 first, then 「記録へ戻る」.
              '<span class="back-links">' +
              (RECORD_WIN ? '' : '<button class="back-link" id="listFromEditor"' + (isNew ? ' hidden' : '') + '>← 一覧に戻る</button>') +
              '<button class="back-link" id="backFromEditor">'+(isNew ? (RECORD_WIN ? "✕ この窓を閉じる" : "← 一覧へ戻る") : "← 記録へ戻る")+'</button></span>' +
              '<div class="editor-actions">' +
                (paperEd ? zoomBarHtml() : '') +
                (CAN_OPEN_WINDOWS && !isNew ? '<button class="btn btn-ghost btn-small" id="edOwnWindow" title="この記録の編集を別の窓に移します（この画面は一覧に戻ります）。保存していない変更があるときは、先に保存してください">⧉ 別の窓で編集</button>' : '') +
                '<button class="btn btn-ghost btn-small" id="saveCloseBtn" title="保存して、記録の表示に戻ります">保存して閉じる</button>' +
                '<button class="btn btn-primary btn-small" id="saveEntryBtn" title="保存して、そのまま続けて編集できます">保存する</button>' +
              '</div>' +
            '</div>';
    html += '<input class="title-input serif" id="editTitle" type="text" placeholder="タイトル" value="'+escapeHtml(draft.title)+'">';
    html += '<div class="field-row">' +
              // v1.0.227：入力欄の上の「日付」「カテゴリ」「タグ」の案内の行は、場所を取るので消した（持ち主の希望）
              '<div class="field"><input type="date" id="editDate" title="日付" aria-label="日付" value="'+escapeHtml(draft.date)+'"></div>' +
              '<div class="field"><select id="editCategory" title="カテゴリ" aria-label="カテゴリ">'+catOptions+'</select></div>' +
            '</div>';
    html += '<div class="field tag-field">' +
              '<div class="tag-editor" id="tagEditor"><span id="tagChipsEd"></span>' +
                '<input type="text" id="tagInput" list="tagSuggest" autocomplete="off" title="タグ（言葉を入れてEnter。いくつでも付けられます）" aria-label="タグ" placeholder="タグを入れてEnter（例：相場メモ、家族）">' +
              '</div>' +
              '<datalist id="tagSuggest">' + allTags().map(function(t){ return '<option value="'+escapeHtml(t)+'">'; }).join("") + '</datalist>' +
            '</div>';
    // 本文の書式（v1.0.38）：太字。文字を選んで押すと太字になり、もう一度押すと元に戻る（Ctrl+B でも同じ）
    // v1.0.49：文字の大きさ（ポイント。本文は10.5）と文字の色
    // v1.0.78：戻す・やり直す（本文の文字・画像の置き方・回り込みの変更を1つずつ戻す。Ctrl+Z／Ctrl+Y でも同じ）
    html += '<div class="body-tools">' +
              '<button type="button" class="btn btn-ghost btn-small fmt-btn" id="undoBtn" title="本文を1つ前に戻す（Ctrl+Z）。何回でも戻せます" disabled>↶ 戻す</button>' +
              '<button type="button" class="btn btn-ghost btn-small fmt-btn" id="redoBtn" title="戻したのをやり直す（Ctrl+Y）" disabled>↷ やり直す</button>' +
              '<button type="button" class="btn btn-ghost btn-small fmt-btn" id="boldBtn" title="選んだ文字を太字にする（Ctrl+B）"><b>B</b> 太字</button>' +
              '<button type="button" class="btn btn-ghost btn-small fmt-btn" id="underlineBtn" title="選んだ文字に下線を付ける（Ctrl+U）。もう一度押すと外れます"><u>U</u> 下線</button>' +
              '<button type="button" class="btn btn-ghost btn-small fmt-btn" id="strikeBtn" title="選んだ文字の真ん中に線を引いて、削除の意味にする。もう一度押すと外れます"><s>S</s> 取り消し線</button>' +
              // v1.0.194：区切り線（カーソルのある行の下に入る。線を押すと色・線種・太さを変えられる）
              // v1.0.221：押すと線種（実線・破線・点線）の一覧が出て、選んだ線が入る。線の色は、線を押して「文字の色」で変える
              '<span class="fmt-pop-wrap">' +
                '<button type="button" class="btn btn-ghost btn-small fmt-btn" id="ruleBtn" title="カーソルのある行の下に、区切りの線を引きます（空の行なら、その行が線になります）。押すと線種を選べます。引いた線を押すと、「文字の色」で線の色を変えられます">― 区切り線 ▾</button>' +
                '<div class="fmt-palette fmt-rules" id="rulePalette" hidden>' +
                  [["実線", "solid"], ["破線", "dashed"], ["点線", "dotted"]].map(function(s){
                    return '<button type="button" class="fmt-rule-opt" data-style="'+s[0]+'" title="'+s[0]+'の区切り線を引きます">' +
                             '<span class="fmt-rule-sample" style="border-top-style:'+s[1]+'"></span>'+s[0]+'</button>';
                  }).join("") +
                '</div>' +
              '</span>' +
              // v1.0.233：本文の中に白い紙を入れて、その場で描く
              // v1.0.234: named 「✎ 描画」 (the owner's word), a 小 blank goes in at once, its frame sets the size
              '<button type="button" class="btn btn-ghost btn-small fmt-btn" id="drawPlaceBtn" title="本文のカーソルの位置に白い紙（小・約6.5cm）を入れて、その場で描きます（画像の書き込みと同じ道具）。紙の大きさは、描いている間に枠の右・下・右下のつまみで変えられます">✎ 描画</button>' +
              // v1.0.171：YouTube の動画（アドレスを本文に貼り付けても入る）
              '<button type="button" class="btn btn-ghost btn-small fmt-btn" id="videoBtn" title="YouTube の動画を、本文の今の場所に入れます（YouTube のアドレスを本文に貼り付けても入ります）"><span class="yt-mark">▶</span> YouTube</button>' +
              // v1.0.201：パソコンの動画ファイル（鍵をかけて Googleドライブへ。保存のときに送る）
              (canAddVideos ? '<button type="button" class="btn btn-ghost btn-small fmt-btn" id="videoFileBtn" title="パソコンの動画ファイルを、本文の今の場所に入れます。保存すると、合言葉の鍵をかけて Googleドライブへ送ります">🎞 動画ファイル</button>' +
                '<input type="file" id="videoFileInput" accept="video/*,.mp4,.m4v,.mov,.webm" style="display:none;">' : '') +
              // 大きさは一覧のボタン（ドロップダウンの欄だと、表示中の数字を選び直せず、キーボードの↓で
              // 最初の数字が付いたとたん本文に戻ってしまう）
              '<span class="fmt-pop-wrap">' +
                '<button type="button" class="btn btn-ghost btn-small fmt-btn" id="sizeBtn" title="選んだ文字の大きさ（本文の標準は10.5）">大きさ <span id="sizeBtnVal">10.5</span> ▾</button>' +
                '<div class="fmt-palette fmt-sizes" id="sizePalette" hidden>' +
                  BODY_FONT_SIZES.map(function(n){
                    return '<button type="button" class="fmt-size-opt" data-pt="'+n+'">'+n+(n === 10.5 ? '<small>標準</small>' : '')+'</button>';
                  }).join("") +
                '</div>' +
              '</span>' +
              '<span class="fmt-pop-wrap">' +
                '<button type="button" class="btn btn-ghost btn-small fmt-btn" id="colorBtn" title="選んだ文字の色"><span class="fmt-a" id="colorBtnA">A</span> 文字の色 ▾</button>' +
                '<div class="fmt-palette" id="colorPalette" hidden>' +
                  BODY_COLORS.map(function(c){
                    return '<button type="button" class="fmt-swatch" data-color="'+c.v+'" title="'+c.n+'" style="background:'+c.v+'"></button>';
                  }).join("") +
                  // 「その他の色」で最後に選んだ色。色の選択画面は同じ色を選び直しても何も起きないので、ここから使う
                  '<button type="button" class="fmt-swatch" id="colorRecent" title="前に「その他の色」で選んだ色"' +
                    (lastCustomColor ? ' data-color="'+lastCustomColor+'" style="background:'+lastCustomColor+'"' : ' hidden') + '></button>' +
                  '<button type="button" class="fmt-pal-btn" data-color="">標準の色に戻す</button>' +
                  '<label class="fmt-pal-btn">その他の色… <input type="color" id="colorCustom" value="'+(lastCustomColor || "#E53935")+'"></label>' +
                '</div>' +
              '</span>' +
            '</div>';
    if(paperEd){ html += '</div>'; }
    // On a wide screen the body is written on the A4 sheet, laid out exactly as 紙面 and print (v1.0.90):
    // same width, PRINT_CSS, the same zoom (fitPaper) and the page-break lines. The date line and the
    // title on the sheet follow the fields above (they are written there). Narrow screens keep the
    // screen-sized editor.
    var bodyHtml = '<div id="editBody" data-placeholder="今日あったこと、考えたこと、相場で気づいたこと…"></div>';
    if(paperEd){
      html += '<div class="paper-view ed-paper">' + '<style>' + scopedPrintCss("paper") + '</style>' +
                '<div class="paper-fit"><div class="paper-sheet" id="edSheet"><div class="paper"><section class="entry" id="edEntry">' +
                  '<div class="ed-paper-head" id="edPaperHead" title="日付・タイトル・カテゴリ・タグは上の欄で直します"></div>' +
                  bodyHtml +
                  '<div class="ed-after" id="edAfter" contenteditable="false" title="本文に置いていない画像とファイル。表示・印刷ではここに出ます"></div>' +
                '</section></div></div></div>' +
                '<p class="paper-note" id="edPaperNote"></p>' +
              '</div>';
    } else {
      html += bodyHtml;
    }
    html += '<div class="attach-area">' +
              '<div class="attach-head">' +
                '<span class="attach-label">画像</span>' +
                '<button class="btn btn-ghost btn-small" id="attachBtn">＋ 画像を添付</button>' +
                '<button class="btn btn-ghost btn-small" id="pastAttachBtn" title="前の記録に添付した画像を、この記録にも添付します">↺ 過去の記録から</button>' +
                '<button class="btn btn-ghost btn-small" id="blankAttachBtn" title="白い画像を1枚添付して、書き込みの画面を開きます">□ 白紙</button>' +
                '<button class="btn btn-ghost btn-small" id="layoutBtn">▦ 画像の配置</button>' +
                '<span class="attach-hint" id="layoutNote"></span>' +
                '<span class="attach-hint">ドラッグ＆ドロップ</span>' +
              '</div>' +
              '<div class="thumb-grid" id="thumbGrid"></div>' +
              '<input type="file" id="imageInput" accept="'+IMAGE_TYPES.join(",")+'" multiple style="display:none;">' +
            '</div>';
    html += '<div class="attach-area">' +
              '<div class="attach-head">' +
                '<span class="attach-label">ファイル</span>' +
                '<button class="btn btn-ghost btn-small" id="fileAttachBtn">＋ PDFなどを添付</button>' +
                (api.pickDriveFiles ? '<button class="btn btn-ghost btn-small" id="driveAttachBtn">Googleドライブから添付</button>' : '') +
                (api.pickPhotos ? '<button class="btn btn-ghost btn-small" id="photosAttachBtn">Googleフォトから添付</button>' : '') +
                '<span class="attach-hint">PDFなどは1つ20MBまで。印刷・紙面にはファイル名が載ります。Googleドライブから選んだ画像は画像として添付します。</span>' +
              '</div>' +
              '<div class="file-list" id="fileList"></div>' +
              '<input type="file" id="fileInput2" multiple style="display:none;">' +
            '</div>';
    html += '</div>';

    // The same frame as the reading screen, so an image can stay large on the right while writing.
    viewRoot.innerHTML = '<div class="viewer-layout"><div class="viewer-main">' + html +
      '</div><aside class="side-panel" id="sidePanel"></aside></div>';

    var wrapEl = viewRoot.querySelector(".editor-wrap");
    // The fixed part sits just under the top bar. Its bottom is kept as the page's scroll padding
    // (style.css), so a caret or row scrolled into view is not left hidden under it.
    var edSticky = document.getElementById("edSticky");
    if(edSticky){
      var placeSticky = function(){
        if(!edSticky.isConnected){ window.removeEventListener("resize", placeSticky); return; }
        var top = document.querySelector("header.topbar").getBoundingClientRect().height;
        edSticky.style.top = top + "px";
        document.documentElement.style.setProperty("--ed-sticky-bottom", (top + edSticky.offsetHeight + 8) + "px");
      };
      placeSticky();
      window.addEventListener("resize", placeSticky);
      if(window.ResizeObserver){ new ResizeObserver(placeSticky).observe(edSticky); }
    }
    var thumbGrid = document.getElementById("thumbGrid");
    var saveBtn = document.getElementById("saveEntryBtn");
    var saveCloseBtn = document.getElementById("saveCloseBtn");
    // dirtyGen counts the changes (v1.0.214): a save knows whether anything changed while it was on its way.
    var dirtyGen = 0;
    function markDirty(){ editorDirty = true; dirtyGen++; }

    // Tags: typed and added with Enter (or a comma), taken off with ×, renamed by clicking the tag.
    var tagInput = document.getElementById("tagInput");
    function renderDraftTags(){
      var box = document.getElementById("tagChipsEd");
      box.innerHTML = draftTags.map(function(t, i){
        return '<span class="tag-chip ed"><span class="tag-ed-text" data-i="'+i+'" title="押すと名前を直せます">#'+escapeHtml(t)+'</span>' +
               '<button type="button" data-i="'+i+'" title="タグを外す">×</button></span>';
      }).join("");
      Array.prototype.forEach.call(box.querySelectorAll("button"), function(b){
        b.addEventListener("click", function(){
          draftTags.splice(Number(b.getAttribute("data-i")), 1);
          markDirty();
          renderDraftTags();
        });
      });
      Array.prototype.forEach.call(box.querySelectorAll(".tag-ed-text"), function(s){
        s.addEventListener("click", function(){ editDraftTag(s.parentNode, Number(s.getAttribute("data-i"))); });
      });
      refreshEdHead();   // the tags on the A4 sheet's date line
    }
    // Turns one tag chip into a small text box. Enter or leaving the box keeps the new name,
    // Esc cancels, and an empty name takes the tag off.
    var pendingTagEdit = null;   // finishes the tag being renamed, if any
    function flushTagEdit(){
      if(pendingTagEdit){ var f = pendingTagEdit; pendingTagEdit = null; f(); }
    }
    function editDraftTag(chip, i){
      // Another tag is still being renamed: keep that first (the chips are redrawn, so click again).
      if(pendingTagEdit){ flushTagEdit(); return; }
      var old = draftTags[i];
      var done = false;
      chip.classList.add("editing");
      chip.innerHTML = '#<input type="text" class="tag-ed-input" maxlength="30" aria-label="タグの名前">';
      var input = chip.querySelector("input");
      input.value = old;
      input.style.width = Math.max(4, old.length + 2) + "em";
      input.focus();
      input.select();
      function finish(keep){
        if(done){ return; }
        done = true;
        pendingTagEdit = null;
        var n = keep ? cleanTag(input.value) : old;
        if(n !== old){
          var dup = draftTags.indexOf(n);
          if(!n || (dup >= 0 && dup !== i)){ draftTags.splice(i, 1); }   // emptied, or now the same as another tag
          else { draftTags[i] = n; }
          markDirty();
        }
        renderDraftTags();
      }
      input.addEventListener("keydown", function(e){
        if(e.isComposing){ return; }
        if(e.key === "Enter"){ e.preventDefault(); finish(true); }
        else if(e.key === "Escape"){ e.preventDefault(); finish(false); }
      });
      input.addEventListener("input", function(){ input.style.width = Math.max(4, input.value.length + 2) + "em"; });
      input.addEventListener("blur", function(){ finish(true); });
      pendingTagEdit = function(){ finish(true); };
    }
    function addTypedTags(){
      var parts = tagInput.value.split(/[,、，]/).map(cleanTag).filter(Boolean);
      tagInput.value = "";
      var added = false;
      parts.forEach(function(t){ if(draftTags.indexOf(t) < 0){ draftTags.push(t); added = true; } });
      if(added){ markDirty(); renderDraftTags(); }
    }
    tagInput.addEventListener("keydown", function(e){
      if(e.isComposing) return;
      if(e.key === "Enter"){ e.preventDefault(); addTypedTags(); }
      else if(e.key === "Backspace" && !tagInput.value && draftTags.length){ draftTags.pop(); markDirty(); renderDraftTags(); }
    });
    tagInput.addEventListener("input", function(){ if(/[,、，]/.test(tagInput.value)){ addTypedTags(); } });
    tagInput.addEventListener("change", addTypedTags);   // a suggestion picked from the list
    tagInput.addEventListener("blur", addTypedTags);
    renderDraftTags();
    // The body is written straight into the finished look (rich-editor.js).
    var rich = activeRich = window.RichEditor.create(document.getElementById("editBody"), {
      body: draft.body,
      paper: paperEd,
      escapeHtml: escapeHtml,
      inlineMd: inlineMd,
      markers: { isLine: function(l){ return MARKER_LINE.test(l); }, parse: markersIn, text: markerText },
      // A PDF in the body (v1.0.205) is a row of this kind too, with v.pdf and v.ref.
      video: {
        parse: function(l){ return videoIn(escapeHtml(l)) || pdfIn(l); },
        text: function(v){ return v.pdf ? pdfText(v) : videoText(v); }, fromUrl: parseYouTube,
        inner: function(v){ return v.pdf ? pdfInnerHtml(v, draftPdfInfo(v.ref)) : videoInnerHtml(v, draftVideoPic(v.id)); },
        pct: function(v){ return v.pdf ? pdfPct(v, draftPdfInfo(v.ref)) : 0; },   // a PDF's own width (v1.0.211)
        load: function(fig){
          loadVideoPics(fig, function(id){ return draftImages.filter(function(x){ return x.id === id; })[0] || null; }, draftUrl);
        },
        onInsert: function(v){ if(!v.pdf && !v.file){ ensureVideoThumb(v.id); } },
        // 「▶ 再生」 (v1.0.198): the same video window as the reading screen, kept open while writing.
        // A PDF: 「📄 開く」 opens it as its card in the file list does.
        open: function(v){
          if(v.pdf){ var f = fileByRef(draftFiles, v.ref); if(f){ openAttachment(f); } return; }
          openVideoPlayer({ id: v.id, start: v.start || 0, file: !!v.file });
        },
        // 「🎞 動画ファイルに差し替え」 (v1.0.201): a video from this PC in its place. Since v1.0.202 it keeps the
        // YouTube video's picture (the owner had put the same video on YouTube and wanted the same picture).
        replace: canAddVideos ? function(v, done){ chooseVideoFile(done, v); } : null,
        // 「🖼 YouTube の絵にする」 (v1.0.202): a 動画ファイル gets the picture of a YouTube video (one replaced
        // before this version kept its frame at 1 second).
        pic: canAddVideos ? function(v, done){ askYoutubePic(v, done); } : null
      },
      rule: { parse: ruleIn, text: ruleText, inner: ruleInnerHtml, colors: BODY_COLORS, keep: "#colorBtn, #colorPalette" },
      hasRef: function(ref){ return !!imageByRef(draftImages, ref); },
      paperPct: function(ref){ return paperPct(imageByRef(draftImages, ref)); },
      paperRest: paperRest,
      imageSize: function(ref){
        var img = imageByRef(draftImages, ref);
        return img ? { width: img.width, height: img.height } : null;
      },
      imageUrl: function(ref){
        var img = imageByRef(draftImages, ref);
        return img ? draftUrl(img) : Promise.resolve(null);
      },
      onChange: function(){ markDirty(); refreshInlineState(); scheduleEdBreaks(); syncFilePlaced(); },
      onHistory: function(){ updateUndoBtns(); },
      extra: detachHistory,   // 戻す brings back attachments taken off with × (v1.0.215)
      // v1.0.179：Ctrl を押しながら選んだ何か所もの文字に、Ctrl+B・Ctrl+U もまとめて効かせる
      onFormatKey: function(k){ (k === "b" ? boldBtn : underlineBtn).click(); },
      keepMulti: ".body-tools",
      onShow: function(ref){ var img = imageByRef(draftImages, ref); if(img){ showDraftSide(img); } },
      onSwap: function(ref, done){ openSwapPicker(ref, done); },
      // 「✎ ここに描く」 (v1.0.233): the 書き込み tools right over the image in the body
      onDraw: function(ref, el){ var img = imageByRef(draftImages, ref); if(img){ annotate(img, el); } },
      placeRef: placeRef
    });
    // 動画の絵 (v1.0.172): each video in the body gets its picture fetched into the draft, to be saved with the record.
    // Saving waits a little for those still coming (doSave) and fetches again those that failed before (offline).
    var thumbFetches = {};   // video id -> the fetch running
    // A PDF in the body (v1.0.205): its name, page count and page-1 picture from the draft.
    function draftPdfInfo(ref){
      var f = fileByRef(draftFiles, ref);
      if(!f) return null;
      var t = pdfThumbFor(draftImages, ref);
      return { name: f.name, pages: t && t.pages, width: t && t.width, height: t && t.height,
               pic: !t ? null : t.isNew ? { src: t.url } : { imgId: t.id } };
    }
    // Puts the attached PDF f into the body at the caret (or where it last was), and makes its page-1 picture
    // (saved with the record) when it has none yet. The picture fills in when it is ready.
    var pdfMaking = {};   // ref -> the picture being made
    // atEnd (v1.0.210): at the end of the body instead, with the caret on a line under it.
    function placePdf(f, atEnd){
      ensureFileRefs(draftFiles, rich.getBody(), detachedRefs("file"));
      var v = { pdf: true, ref: f.ref, id: "pdf" + f.ref };
      if(atEnd){ rich.appendVideo(v); } else { rich.insertVideo(v); }
      ensurePdfThumb(f);
    }
    function ensurePdfThumb(f){
      if(!window.PdfView || pdfThumbFor(draftImages, f.ref) || pdfMaking[f.ref]) return;
      var ref = f.ref;
      var bytes = f.bytes ? Promise.resolve(f.bytes) : imagePlainBytes(f);
      pdfMaking[ref] = bytes.then(function(b){ return window.PdfView.firstPage(b, 1000); }).then(function(r){
        return r.blob.arrayBuffer().then(function(ab){
          if(activeRich !== rich || pdfThumbFor(draftImages, ref) || fileByRef(draftFiles, ref) !== f) return;
          var u8 = new Uint8Array(ab);
          var t = { id: genId(), mime: "image/jpeg", name: "PDF の1ページ目（" + (f.name || "") + "）", width: r.width, height: r.height,
                    size: u8.byteLength, isNew: true, bytes: u8, pdfThumb: ref, pages: r.pages,
                    url: URL.createObjectURL(new Blob([u8], { type: "image/jpeg" })) };
          draftImages.push(t);
          rich.refreshVideos(function(v){ return v.pdf && v.ref === ref; });
          markDirty();
        });
      }).catch(function(err){
        showToast(withDetail("PDF の1ページ目を絵にできませんでした（名前だけ表示します）", err), 6000);
      }).then(function(){ delete pdfMaking[ref]; });
    }
    function draftVideoPic(ytId){
      var t = videoThumbFor(draftImages, ytId);
      if(!t) return null;
      return t.isNew ? { src: t.url, wide: isWideThumb(t), length: videoLength(t) } : { imgId: t.id, wide: isWideThumb(t), length: videoLength(t) };
    }
    // 🎞 動画ファイル (v1.0.201): asks for a video on this PC; done(v) once it is checked and its picture is in the draft.
    // from (v1.0.202): the YouTube video it replaces; its picture becomes the new one's (else the frame at 1 second).
    function chooseVideoFile(done, from){
      var input = document.getElementById("videoFileInput");
      if(!input) return;
      input.value = "";
      input.onchange = function(){
        var file = input.files && input.files[0];
        input.value = "";
        if(!file) return;
        prepareVideoFile(file, function(v, thumb){
          var pic = from && !from.file ? youtubePic(from.id).catch(function(){ return null; }) : Promise.resolve(null);
          pic.then(function(p){
            if(activeRich !== rich){ return; }   // this edit screen has gone meanwhile
            draftImages.push(p ? fileVideoThumb(v.id, p, thumb) : thumb);
            done(v);
          });
        });
      };
      input.click();
    }
    // The picture of a YouTube video as { bytes, width, height }: the one saved in this draft, else YouTube's.
    function youtubePic(ytId){
      var saved = videoThumbFor(draftImages, ytId);
      var p = !saved ? Promise.reject({ code: "none" }) : saved.isNew ? Promise.resolve(saved.bytes) : imagePlainBytes(saved);
      return p.then(function(bytes){
        return { bytes: new Uint8Array(bytes), width: saved.width, height: saved.height };
      }).catch(function(){
        return fetchVideoThumb(ytId).then(function(t){
          URL.revokeObjectURL(t.url);
          return { bytes: t.bytes, width: t.width, height: t.height };
        });
      });
    }
    // A new picture (p from youtubePic) for the 動画ファイル id; old: its picture until now, whose name and length it keeps.
    function fileVideoThumb(id, p, old){
      if(old && old.isNew && old.url){ URL.revokeObjectURL(old.url); }
      return { id: genId(), mime: "image/jpeg", name: (old && old.name) || "動画の絵", width: p.width, height: p.height,
               size: p.bytes.byteLength, isNew: true, bytes: p.bytes, ytThumb: id, duration: (old && old.duration) || 0,
               url: URL.createObjectURL(new Blob([p.bytes], { type: "image/jpeg" })) };
    }
    // 「🖼 YouTube の絵にする」: asks for the YouTube address, then done() once the picture is in the draft (the editor
    // redraws the row). Saving puts it on Drive and trashes the one before.
    function askYoutubePic(v, done){
      openVideoModal(function(yt){
        showToast("YouTube の絵を読み込んでいます…", 15000);
        youtubePic(yt.id).then(function(p){
          if(activeRich !== rich){ return; }
          var old = videoThumbFor(draftImages, v.id);
          if(old){ draftImages.splice(draftImages.indexOf(old), 1); }
          draftImages.push(fileVideoThumb(v.id, p, old));
          showToast("動画の絵を YouTube の絵にしました。保存すると残ります", 4000);
          done();
          markDirty();
        }, function(){
          showToast("YouTube の絵を読み込めませんでした（インターネットにつながっているか、アドレスが合っているか確かめてください）", 6000);
        });
      }, {
        title: "動画の絵を YouTube の絵にする",
        help: "同じ動画を YouTube に載せていれば、その動画のアドレスを貼り付けてください。YouTube で見えていた絵が、この動画の絵になります（動画そのものは変わりません）。",
        ok: "この絵にする"
      });
    }
    function ensureVideoThumb(yt){
      if(isFileVideoId(yt) || videoThumbFor(draftImages, yt) || thumbFetches[yt]) return;
      thumbFetches[yt] = fetchVideoThumb(yt).then(function(t){
        if(activeRich !== rich || videoThumbFor(draftImages, yt)) return;   // this edit screen has gone
        draftImages.push(t);
        Array.prototype.forEach.call(document.querySelectorAll('#editBody figure.video-fig[data-yt="' + yt + '"] img.yt-thumb'), function(el){
          el.src = t.url;
          el.classList.toggle("wide", isWideThumb(t));
        });
      }, noop).then(function(){ delete thumbFetches[yt]; });
    }
    function ensureVideoThumbs(body){ videoIdsIn(body).forEach(ensureVideoThumb); }
    ensureVideoThumbs(draft.body);
    // PDFs in the body without their picture yet (v1.0.205).
    pdfRefsIn(draft.body).forEach(function(ref){ var f = fileByRef(draftFiles, ref); if(f){ ensurePdfThumb(f); } });
    // The A4 sheet around the body (v1.0.90, paperEd): its date line and title, the page-break lines and the note under it.
    var edBreaksTimer = 0;
    setupEdPaper();
    function setupEdPaper(){
      if(!paperEd) return;
      var sheet = document.getElementById("edSheet"), head = document.getElementById("edPaperHead");
      var editBodyEl = document.getElementById("editBody");
      fitPaper(sheet.parentNode);
      refreshEdHead();
      ["editTitle", "editDate", "editCategory"].forEach(function(fid){
        var el = document.getElementById(fid);
        el.addEventListener("input", refreshEdHead);
        el.addEventListener("change", refreshEdHead);
      });
      // They are written in the fields above: a click on them goes there.
      head.addEventListener("mousedown", function(e){
        e.preventDefault();
        var t = document.getElementById(e.target.closest("h1") ? "editTitle" : "editDate");
        t.focus();
        t.scrollIntoView({ block: "nearest" });
      });
      // A click in the sheet's margins puts the caret at that end of the line beside it, and below the
      // text at the end of the text (the sheet itself is not editable, so the browser would do nothing).
      sheet.addEventListener("mousedown", function(e){
        if(editBodyEl.contains(e.target) || head.contains(e.target) || e.button !== 0) return;
        // Below a PDF's name card (v1.0.210): the card is after the body, so a line would open above it.
        // The PDFs whose cards are above the click go into the body as their page-1 picture, at the end,
        // and the caret goes under them, as a click below an image does. A click on a card still opens it.
        if(!e.target.closest(".file-card")){
          var below = Array.prototype.filter.call(sheet.querySelectorAll("#edAfter .file-card[data-file]"), function(c){
            return c.getBoundingClientRect().bottom <= e.clientY;
          }).map(function(c){
            return draftFiles.filter(function(f){ return f.id === c.getAttribute("data-file"); })[0];
          }).filter(isPdfFile);
          if(below.length){
            e.preventDefault();
            below.forEach(function(f){ placePdf(f, true); });
            renderFiles();
            return;
          }
        }
        // Below the text (v1.0.178): empty lines down to the click, and the caret there (rich-editor.js padTo).
        if(!e.target.closest(".ed-after") && rich.padTo(e.clientY)){ e.preventDefault(); return; }
        var r = editBodyEl.getBoundingClientRect();
        var range = null;
        if(e.clientY < r.bottom && e.clientY > r.top && document.caretRangeFromPoint){
          var x = Math.min(Math.max(e.clientX, r.left + 1), r.right - 1);
          range = document.caretRangeFromPoint(x, e.clientY);
          if(range && !editBodyEl.contains(range.startContainer)){ range = null; }
        }
        if(!range && e.clientY >= r.bottom){
          var last = editBodyEl.lastElementChild;
          while(last && last.classList.contains("ed-row")){ last = last.previousElementSibling; }
          if(last){
            range = document.createRange();
            range.selectNodeContents(last);
            range.collapse(false);
          }
        }
        if(!range) return;
        e.preventDefault();
        // preventScroll (v1.0.174): the first focus of the body put the caret at its start and scrolled the
        // page to the top, so a click below the text at the bottom of a long record lost its place (only the first time).
        editBodyEl.focus({ preventScroll: true });
        var sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      });
      editBodyEl.addEventListener("load", scheduleEdBreaks, true);   // an image finished loading
      if(window.ResizeObserver){ new ResizeObserver(scheduleEdBreaks).observe(document.getElementById("edEntry")); }
      if(document.fonts && document.fonts.ready){ document.fonts.ready.then(scheduleEdBreaks); }
      scheduleEdBreaks();
    }
    function refreshEdHead(){
      var head = document.getElementById("edPaperHead");
      if(!head) return;
      head.innerHTML = printHeadHtml({
        id: entry && entry.id,
        date: document.getElementById("editDate").value,
        title: document.getElementById("editTitle").value,
        category: document.getElementById("editCategory").value,
        tags: draftTags,
        createdAt: entry && entry.createdAt,
        updatedAt: entry && entry.updatedAt
      });
      scheduleEdBreaks();
    }
    // A timer, not requestAnimationFrame: that one does not run while the window is hidden or covered.
    function scheduleEdBreaks(){
      if(!paperEd || edBreaksTimer) return;
      edBreaksTimer = setTimeout(function(){
        edBreaksTimer = 0;
        var section = document.getElementById("edEntry");
        if(!section || !section.isConnected) return;
        Array.prototype.forEach.call(section.querySelectorAll(".paper-break"), function(el){ el.remove(); });
        var pages = markPageBreaks(section);
        // The images not placed in the text and the files are on the sheet too (edAfter), as printed.
        document.getElementById("edPaperNote").textContent = "A4 " + pages + " ページ（点線は印刷したときのページの区切りの目安）";
      }, 30);
    }
    // 戻す・やり直す（v1.0.78）。押してもカーソルが本文から外れないように mousedown を止める
    var undoBtn = document.getElementById("undoBtn"), redoBtn = document.getElementById("redoBtn");
    function updateUndoBtns(){
      if(!undoBtn || !undoBtn.isConnected || !rich) return;
      undoBtn.disabled = !rich.canUndo();
      redoBtn.disabled = !rich.canRedo();
    }
    [undoBtn, redoBtn].forEach(function(b){ b.addEventListener("mousedown", function(e){ e.preventDefault(); }); });
    undoBtn.addEventListener("click", function(){ rich.undo(); });
    redoBtn.addEventListener("click", function(){ rich.redo(); });

    // An attached image shown large: on the right beside the editor when there is room, full screen otherwise.
    // 太字のボタン。押してもカーソルや選んだ文字が本文から外れないように、mousedown を止める。
    // 太字は本文の文字では **太字** として保存される（rich-editor.js の inlineText）。読む画面・印刷・Markdown も同じ書き方
    var editBodyEl = document.getElementById("editBody"), boldBtn = document.getElementById("boldBtn");
    var sizeBtn = document.getElementById("sizeBtn"), sizeBtnVal = document.getElementById("sizeBtnVal");
    var sizePalette = document.getElementById("sizePalette"), colorBtn = document.getElementById("colorBtn");
    var colorBtnA = document.getElementById("colorBtnA"), palette = document.getElementById("colorPalette");
    var bodyRange = null, pendingPt = 10.5;   // 本文で最後に選んでいた範囲、最後に選んだ大きさ
    function selectionInBody(){
      var sel = window.getSelection();
      return !!(sel && sel.rangeCount && editBodyEl.contains(sel.getRangeAt(0).commonAncestorContainer));
    }
    // 太字・下線を付ける／外す。Ctrl を押しながら何か所も選んだとき（v1.0.179）は、全部がもう付いていれば
    // 全部から外し、そうでなければ全部に付ける（Word と同じ）。まとめて1回の「戻す」で戻る
    function toggleFormat(cmd){
      if(!selectionInBody()){ editBodyEl.focus(); }
      // 下線・取り消し線 go through rich.decorate (v1.0.196): the browser's own took one off when putting the other on
      var run = function(){ if(cmd === "bold"){ document.execCommand(cmd); } else { rich.decorate(cmd); } };
      if(!rich.pieceCount()){
        run();      // 変わると本文の input が起き、保存していない印も付く
      } else {
        var state = function(){ try{ return document.queryCommandState(cmd); } catch(e){ return false; } };
        var all = true;
        rich.forEachPiece(function(){ if(!state()){ all = false; } });
        rich.forEachPiece(function(){ if(state() === all){ run(); } });
      }
      updateBoldBtn();
    }
    boldBtn.addEventListener("mousedown", function(e){ e.preventDefault(); });
    boldBtn.addEventListener("click", function(){ toggleFormat("bold"); });
    // 下線（v1.0.110）：太字と同じ使い方。本文の文字では <u>下線</u> として保存される
    var underlineBtn = document.getElementById("underlineBtn");
    underlineBtn.addEventListener("mousedown", function(e){ e.preventDefault(); });
    underlineBtn.addEventListener("click", function(){ toggleFormat("underline"); });
    // 取り消し線：下線と同じ使い方。本文の文字では <s>取り消し</s> として保存される
    var strikeBtn = document.getElementById("strikeBtn");
    strikeBtn.addEventListener("mousedown", function(e){ e.preventDefault(); });
    strikeBtn.addEventListener("click", function(){ toggleFormat("strikeThrough"); });
    // ▶ YouTube (v1.0.171): asks for the address and puts the video where the caret was.
    var videoBtn = document.getElementById("videoBtn");
    videoBtn.addEventListener("mousedown", function(e){ e.preventDefault(); });
    videoBtn.addEventListener("click", function(){ openVideoModal(function(v){ rich.insertVideo(v); }); });
    // 🎞 動画ファイル (v1.0.201): a video from this PC where the caret was.
    var videoFileBtn = document.getElementById("videoFileBtn");
    if(videoFileBtn){
      videoFileBtn.addEventListener("mousedown", function(e){ e.preventDefault(); });
      videoFileBtn.addEventListener("click", function(){ chooseVideoFile(function(v){ rich.insertVideo(v); }); });
    }
    // ― 区切り線 (v1.0.194): below the line the caret is on. Since v1.0.221 the button opens the list of kinds
    // (実線・破線・点線, the owner's choice) and the one chosen goes in; the list is opened and closed with the
    // size and colour lists below (togglePop, closePalette).
    var ruleBtn = document.getElementById("ruleBtn"), rulePalette = document.getElementById("rulePalette");
    [ruleBtn, rulePalette].forEach(function(el){ el.addEventListener("mousedown", function(e){ e.preventDefault(); }); });
    rulePalette.addEventListener("click", function(e){
      var b = e.target.closest("button[data-style]");
      if(!b) return;
      rulePalette.hidden = true;
      rich.insertRule(b.getAttribute("data-style"));
    });
    // 今いる場所が太字なら、ボタンを押された見た目にする。編集画面を離れたら見張りをやめる
    // 大きさと色のボタンも、今いる場所の大きさ・色を表示する
    function updateBoldBtn(){
      if(!boldBtn.isConnected){ document.removeEventListener("selectionchange", updateBoldBtn); return; }
      var on = false;
      try{ on = selectionInBody() && document.queryCommandState("bold"); } catch(e){}
      boldBtn.classList.toggle("on", on);
      var un = false;
      try{ un = selectionInBody() && document.queryCommandState("underline"); } catch(e){}
      underlineBtn.classList.toggle("on", un);
      var st = false;
      try{ st = selectionInBody() && document.queryCommandState("strikeThrough"); } catch(e){}
      strikeBtn.classList.toggle("on", st);
      if(selectionInBody()){
        bodyRange = window.getSelection().getRangeAt(0).cloneRange();
        var node = bodyRange.startContainer;
        var el = node.nodeType === 1 ? node : node.parentNode;
        var cs = window.getComputedStyle(el);
        var pt = Math.round(parseFloat(cs.fontSize) / parseFloat(window.getComputedStyle(editBodyEl).fontSize) * 10.5 * 2) / 2;
        sizeBtnVal.textContent = isFinite(pt) ? String(pt) : "–";
        Array.prototype.forEach.call(sizePalette.querySelectorAll("[data-pt]"), function(o){ o.classList.toggle("on", Number(o.getAttribute("data-pt")) === pt); });
        colorBtnA.style.borderBottomColor = cs.color;
      }
    }
    document.addEventListener("selectionchange", updateBoldBtn);

    // 文字の大きさと色（v1.0.49）。ブラウザの書式コマンドで付けるので、Ctrl+Z で元に戻せる。
    // 大きさは一度「xxx-large」で付けてから、選んだポイント数（calc(var(--body-pt) * n)）に置き換える。
    // 本文の文字では <span style="font-size:14pt; color:#E53935"> として保存される（rich-editor.js の textStyle）
    // 大きさや色を選んでいる間に本文から外れた選択を戻す
    function restoreBodyRange(){
      editBodyEl.focus();
      if(bodyRange && editBodyEl.contains(bodyRange.commonAncestorContainer)){
        var sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(bodyRange);
      }
    }
    // Ctrl を押しながら何か所も選んだとき（v1.0.179）は、その全部に付ける
    function styleCommand(cmd, value){
      restoreBodyRange();
      rich.forEachPiece(function(){
        document.execCommand("styleWithCSS", false, true);
        document.execCommand(cmd, false, value);
        document.execCommand("styleWithCSS", false, false);   // 太字は <b> のまま
      });
    }
    function fixSizes(){
      Array.prototype.forEach.call(editBodyEl.querySelectorAll("[style*='xxx-large'], font[size='7']"), function(el){
        if(el.style.fontSize === "xxx-large" || (el.tagName === "FONT" && !el.style.fontSize)){
          el.style.fontSize = "calc(var(--body-pt) * " + pendingPt + ")";
        }
      });
    }
    // 文字を選ばずに選んだ大きさは、続けて打つ文字に付く（そのときもここで置き換える）
    editBodyEl.addEventListener("input", fixSizes);
    // ボタンと一覧は mousedown を止めて、押しても選んだ文字が本文から外れないようにする
    [sizeBtn, sizePalette, colorBtn].forEach(function(el){ el.addEventListener("mousedown", function(e){ e.preventDefault(); }); });
    palette.addEventListener("mousedown", function(e){ if(e.target.tagName !== "INPUT"){ e.preventDefault(); } });
    // 開いた一覧が画面の右からはみ出すとき（iPhone の幅など）は、左へずらす
    function togglePop(pop){
      [sizePalette, palette, rulePalette].forEach(function(p){ if(p !== pop){ p.hidden = true; } });
      pop.hidden = !pop.hidden;
      if(pop.hidden) return;
      pop.style.left = "0px";
      // innerWidth ではなく clientWidth：iPhone では、はみ出した一覧の分だけ innerWidth が広がる
      var r = pop.getBoundingClientRect(), over = r.right - (document.documentElement.clientWidth - 8);
      if(over > 0){ pop.style.left = -Math.min(over, Math.max(0, r.left - 8)) + "px"; }
    }
    sizeBtn.addEventListener("click", function(){ togglePop(sizePalette); });
    colorBtn.addEventListener("click", function(){ togglePop(palette); });
    ruleBtn.addEventListener("click", function(){
      Array.prototype.forEach.call(rulePalette.querySelectorAll("[data-style]"), function(o){ o.classList.toggle("on", o.getAttribute("data-style") === rich.ruleStyle()); });
      togglePop(rulePalette);
    });
    sizePalette.addEventListener("click", function(e){
      var b = e.target.closest("button[data-pt]");
      if(!b) return;
      pendingPt = Number(b.getAttribute("data-pt"));
      styleCommand("fontSize", "7");   // 変わると本文の input が起き、保存していない印も付く
      fixSizes();
      sizePalette.hidden = true;
      updateBoldBtn();
    });
    function applyColor(hex){
      // 区切り線を押して選んでいるときは、その線の色にする（v1.0.221。「標準の色」＝文字と同じ色）。次に引く線も同じ色
      if(rich.setRuleColor(hex)){ palette.hidden = true; return; }
      // 「標準の色」は本文の文字の色で塗る（本文の文字では色なしとして保存される）
      styleCommand("foreColor", hex || window.getComputedStyle(editBodyEl).color);
      palette.hidden = true;
      updateBoldBtn();
    }
    palette.addEventListener("click", function(e){
      var b = e.target.closest("button[data-color]");
      if(b){ applyColor(b.getAttribute("data-color")); }
    });
    document.getElementById("colorCustom").addEventListener("change", function(e){
      lastCustomColor = e.target.value.toUpperCase();
      var recent = document.getElementById("colorRecent");
      recent.setAttribute("data-color", lastCustomColor);
      recent.style.background = lastCustomColor;
      recent.hidden = false;
      applyColor(lastCustomColor);
    });
    // 一覧の外を押したら閉じる（Esc でも）。編集画面を離れたら見張りをやめる
    function closePalette(e){
      if(!palette.isConnected){
        document.removeEventListener("mousedown", closePalette);
        document.removeEventListener("keydown", closePalette);
        return;
      }
      [[palette, colorBtn], [sizePalette, sizeBtn], [rulePalette, ruleBtn]].forEach(function(pb){
        if(pb[0].hidden) return;
        if(e.type === "keydown" ? e.key === "Escape" : !pb[0].contains(e.target) && !pb[1].contains(e.target)){ pb[0].hidden = true; }
      });
    }
    document.addEventListener("mousedown", closePalette);
    document.addEventListener("keydown", closePalette);

    function showDraftSide(img){
      draftUrl(img).then(function(url){
        if(!thumbGrid.isConnected) return;
        if(canSide() && openSide({ name: img.name || "", image: url, img: img })){
          markShown(thumbGrid.querySelector('.thumb[data-img="'+CSS.escape(img.id)+'"] img'));
        } else {
          openLightbox(url, img.name);
        }
      }).catch(function(err){ showToast(withDetail("画像を表示できませんでした", err), 6000); });
    }
    editorSideHooks = {
      show: showDraftSide,
      imageById: function(id){ return draftImages.filter(function(x){ return x.id === id; })[0] || null; },
      fileById: function(id){ return draftFiles.filter(function(x){ return x.id === id; })[0] || null; },
      annotate: function(id){ var img = editorSideHooks.imageById(id); if(img){ annotate(img); } }
    };
    var hooksForThisEditor = editorSideHooks;

    function renderThumbs(){
      // Not the pictures of videos (v1.0.172): they are no images to place or edit.
      var listed = realImages(draftImages);
      var h = listed.map(function(img){
        return '<div class="thumb" draggable="true" data-img="'+escapeHtml(img.id)+'"><img alt="'+escapeHtml(img.name)+'" draggable="false"><span class="thumb-loading">読み込み中…</span>' +
               '<button class="thumb-edit" title="書き込み・トリミング">✎</button>' +
               '<button class="thumb-remove" title="添付を外す">×</button>' +
               (img.composite ? '<button class="thumb-split" title="合成を解除して元の画像に戻す">合成を解除</button>' : '') +
               '<button class="thumb-inline" title="本文のカーソルの位置に入れる">本文へ</button>' +
               '<span class="thumb-size mono"><b>画像'+img.ref+'</b> '+fmtSize(img.size)+(img.edit ? " ✎" : "")+(img.composite ? " ⧉" : "")+'</span></div>';
      }).join("");
      for(var i=0;i<compressing;i++){ h += '<div class="thumb thumb-pending">処理中…</div>'; }
      thumbGrid.innerHTML = h;
      listed.forEach(function(img, i){
        var box = thumbGrid.children[i];
        loadThumbInto(box, img, img.isNew ? Promise.resolve(img.url) : imageUrl(img), true);
        var pic = box.querySelector("img");
        pic.classList.add("zoomable");
        pic.title = "大きく表示";
        pic.addEventListener("click", function(){ showDraftSide(img); });
        if(sideCurrent && sideCurrent.imgId === img.id){ pic.classList.add("side-shown"); }
        box.querySelector(".thumb-edit").addEventListener("click", function(){ annotate(img); });
        if(img.composite){ box.querySelector(".thumb-split").addEventListener("click", function(){ splitComposite(img); }); }
        box.querySelector(".thumb-inline").addEventListener("click", function(){ insertMarker(img); });
        box.addEventListener("dragstart", function(e){
          // Dropped into the body, the image goes where it lands.
          e.dataTransfer.setData(window.RichEditor.DRAG_REF, String(img.ref));
          e.dataTransfer.effectAllowed = "copy";
        });
        box.querySelector(".thumb-remove").addEventListener("click", function(){
          if(sideCurrent && sideCurrent.imgId === img.id){ closeSide(); }
          detach("image", img);
          removeMarkers(img.ref);
          rich.recordStep();   // not in the text: a step of its own for 戻す (v1.0.215)
          markDirty();
          renderThumbs();
          showToast("画像" + img.ref + "の添付を外しました。本文の上の「↶ 戻す」（Ctrl+Z）で元に戻せます", 5000);
        });
      });
      refreshInlineState();
      saveBtn.disabled = saveCloseBtn.disabled = compressing > 0;
    }

    // The same rule as imagesAfterBody, except that the board (openBoard) offers every image of a body
    // without images, so a layout can be made; edAfter shows them only once there is one.
    function afterBodyImages(){
      return rich.refs().length ? [] : realImages(draftImages);
    }
    // Marks the thumbnails placed in the text, and limits the board to the rest.
    function refreshInlineState(){
      var refs = rich.refs().filter(function(r, i, all){ return all.indexOf(r) === i; });
      realImages(draftImages).forEach(function(img, i){
        var box = thumbGrid.children[i];
        if(box){ box.classList.toggle("placed", refs.indexOf(img.ref) >= 0); }
      });
      var rest = realImages(draftImages).length - refs.length;
      refreshEdAfter();
      document.getElementById("layoutBtn").disabled = refs.length > 0 || rest < 1 || compressing > 0;
      document.getElementById("layoutNote").textContent =
        refs.length ? "本文中に" + refs.length + "枚" + (rest ? "（ほかの" + rest + "枚は資料として添付のみ。表示・印刷には出ません）" : "") :
        (draftLayout && realImages(draftImages).length ? "自由配置で表示します" :
         realImages(draftImages).length ? "画像は資料として添付のみです。「本文へ」で入れた画像だけが表示・印刷に出ます" : "");
    }

    // The images not placed in the text and the attached files, after the body on the A4 sheet exactly as
    // the record shows and prints them (buildPrintSections). Without this they only showed up after saving.
    function refreshEdAfter(){
      var host = paperEd && document.getElementById("edAfter");
      if(!host) return;
      var after = draftLayout ? afterBodyImages() : [];
      var key = JSON.stringify([after.map(function(img){ return img.id; }), after.length ? draftLayout : null,
                                draftFiles.map(function(f){ return f.id || f.name; }), rich ? pdfRefsIn(rich.getBody()) : []]);
      if(key === edAfterKey) return;
      edAfterKey = key;
      var html = "";
      if(after.length && draftLayout){
        html = boardMarkup(after, boardLayoutFor(after, draftLayout), function(img){
          return '<img data-img="'+escapeHtml(img.id)+'" alt="">';
        });
      } else if(after.length){
        html = '<div class="images">' + after.map(function(img){
          return '<figure><img data-img="'+escapeHtml(img.id)+'" alt=""><figcaption>'+escapeHtml(img.name)+'</figcaption></figure>';
        }).join("") + '</div>';
      }
      host.innerHTML = html + fileCardsHtml(filesAfterBody(draftFiles, rich ? rich.getBody() : draft.body));
      after.forEach(function(img){
        var pic = host.querySelector('img[data-img="'+CSS.escape(img.id)+'"]');
        draftUrl(img).then(function(url){ if(url && pic && pic.isConnected){ pic.src = url; } }, noop);
      });
      scheduleEdBreaks();
    }
    // 「本文へ」: the image goes in at the caret (beside the chosen image, if one is chosen).
    function insertMarker(img){
      placeRef(img.ref, rich.insertImage);
    }
    // An attached image already in the text, placed once more (v1.0.129): the new place gets a copy of it
    // with its own number, so drawing on one does not change the other (before, both showed one image).
    // use(ref) puts the given image there.
    function placeRef(ref, use){
      var img = imageByRef(draftImages, ref);
      if(!img || rich.refs().indexOf(ref) < 0){ use(ref); return; }
      compressing++;
      renderThumbs();
      copyStoredImage(img).then(function(c){
        compressing--;
        if(!thumbGrid.isConnected) return;
        var at = draftImages.indexOf(img);
        draftImages.splice(at < 0 ? draftImages.length : at + 1, 0, c);
        ensureRefs(draftImages, detachedRefs("image"));
        markDirty();
        renderThumbs();
        use(c.ref);
        showToast("同じ画像をもう1か所に置くため、写しを「画像" + c.ref + "」として添付しました。それぞれ別に書き込めます", 6000);
      }, function(err){
        compressing--;
        if(thumbGrid.isConnected){ renderThumbs(); }
        showToast(withDetail("画像の写しを作れませんでした", err), 6000);
      });
    }
    // Removing an attachment also takes it out of the text.
    function removeMarkers(ref){
      rich.removeRef(ref);
    }
    // 「入れ替え」 on an image in the text (v1.0.104): choose which attached image takes its place.
    function openSwapPicker(ref, done){
      var cands = realImages(draftImages).filter(function(im){ return im.ref !== ref; });
      if(!cands.length){ showToast("入れ替える画像がありません。先に「＋ 画像を添付」で画像を追加してください。", 5000); return; }
      var wrap = document.createElement("div");
      wrap.className = "modal-backdrop";
      wrap.innerHTML =
        '<div class="modal swap-modal">' +
          '<h3>どの画像に入れ替えますか？</h3>' +
          '<p class="help">選んだ画像が、今の画像の場所に入ります。大きさ・右文章／左文章・横の文章はそのままです。今の画像は資料として添付に残ります（表示・印刷には出ません）。</p>' +
          '<div class="swap-grid">' + cands.map(function(im){
            return '<button type="button" class="swap-item" data-ref="'+im.ref+'"><img alt=""><span>画像'+im.ref+'</span></button>';
          }).join("") + '</div>' +
          '<div class="modal-actions"><button class="btn btn-ghost btn-small" id="swapCancel">やめる</button></div>' +
        '</div>';
      document.body.appendChild(wrap);
      var btns = wrap.querySelectorAll(".swap-item");
      cands.forEach(function(im, i){
        draftUrl(im).then(function(url){ if(url && btns[i].isConnected){ btns[i].querySelector("img").src = url; } }, noop);
      });
      wrap.addEventListener("click", function(e){
        var b = e.target.closest(".swap-item");
        if(b){ wrap.remove(); done(Number(b.getAttribute("data-ref"))); return; }
        if(e.target === wrap || e.target.id === "swapCancel"){ wrap.remove(); }
      });
    }

    // Swaps one draft image for another (after annotating or reverting).
    function replaceDraft(oldImg, newImg){
      var i = draftImages.indexOf(oldImg);
      if(i < 0) return;
      newImg.ref = oldImg.ref;
      // Annotated or reverted, it is still the same picture for the 同じ画像 question (v1.0.213).
      if(oldImg.src && !newImg.src){ newImg.src = oldImg.src; }
      draftImages[i] = newImg;
      markDirty();
      if(thumbGrid.isConnected){
        renderThumbs();
        rich.refreshImages();
        // The panel was showing the image just annotated: show the new version there.
        if(sideCurrent && sideCurrent.imgId === oldImg.id && editorSideHooks === hooksForThisEditor){ showDraftSide(newImg); }
      }
    }

    function draftUrl(img){
      return img.isNew ? Promise.resolve(img.url) : imageUrl(img);
    }

    // Opens the free-layout board for the attached images not placed in the text.
    function openBoard(){
      var boardImages = afterBodyImages();
      if(!boardImages.length) return;
      Promise.all(boardImages.map(draftUrl)).then(function(urls){
        var imgs = boardImages.map(function(img, i){
          return { id: img.id, url: urls[i], width: img.width, height: img.height, name: img.name };
        });
        return window.BoardEditor.open({ images: imgs, layout: draftLayout, guide: a4GuideFor(currentDraftForPrint()) });
      }).then(function(r){
        if(!r) return;
        if(r.action === "layout"){
          draftLayout = r.layout;
          markDirty();
          renderThumbs();
          return;
        }
        // Merge every image into one; the sources stay attached to it so the merge can be undone.
        compressing++;
        renderThumbs();
        return compressImage(new File([r.blob], "composite.jpg", { type:"image/jpeg" })).then(function(res){
          return res.blob.arrayBuffer().then(function(ab){
            var merged = {
              id: genId(), mime: res.mime, name: "合成画像（" + boardImages.length + "枚）",
              width: res.width, height: res.height, size: res.blob.size,
              isNew: true, bytes: new Uint8Array(ab), url: URL.createObjectURL(res.blob),
              composite: { sources: boardImages.slice(), layout: r.layout }
            };
            // Images placed in the text stay as they are; the merged one takes the first board image's slot.
            var at = draftImages.indexOf(boardImages[0]);
            draftImages = draftImages.filter(function(img){ return boardImages.indexOf(img) < 0; });
            draftImages.splice(Math.max(0, Math.min(at, draftImages.length)), 0, merged);
            ensureRefs(draftImages, detachedRefs("image"));
            draftLayout = null;
            markDirty();
          });
        }).then(function(){
          compressing--;
          if(thumbGrid.isConnected){ renderThumbs(); }
          showToast("1枚の画像に合成しました（元の画像は「合成を解除」で戻せます）", 4000);
        }, function(err){
          compressing--;
          if(thumbGrid.isConnected){ renderThumbs(); }
          throw err;
        });
      }).catch(function(err){
        showToast(withDetail("画像の配置を反映できませんでした", err), 6000);
      });
    }

    function splitComposite(img){
      var i = draftImages.indexOf(img);
      if(i < 0) return;
      var sources = img.composite.sources.map(function(src){ return Object.assign({ isNew:false }, src); });
      draftImages.splice.apply(draftImages, [i, 1].concat(sources));
      ensureRefs(draftImages, detachedRefs("image"));
      removeMarkers(img.ref);
      draftLayout = img.composite.layout || null;
      markDirty();
      renderThumbs();
      showToast("合成を解除して、元の画像と配置に戻しました");
    }

    // The entry as it would print right now (for the A4 guide line).
    function currentDraftForPrint(){
      return {
        title: document.getElementById("editTitle").value.trim(),
        date: document.getElementById("editDate").value || todayStr(),
        category: document.getElementById("editCategory").value,
        body: rich.getBody(),
        tags: draftTags,
        images: draftImages,
        files: draftFiles,   // for the PDFs in the body (v1.0.205)
        createdAt: entry && (entry.createdAt || entry.updatedAt) || new Date().toISOString(),
        updatedAt: entry && entry.updatedAt
      };
    }

    // Opens the annotation editor on the untouched original of `img` (with its
    // previous crop/shapes, if any) and replaces the draft with the result.
    // inlineEl (v1.0.233, 本文の中で描く): the <img> of this image in the body. The tools then work right over it
    // in the body instead of in the editor window, and what was drawn goes in when the drawing is finished.
    function annotate(img, inlineEl){
      if(inlineEl){
        if(window.ImageEditor.drawingInline()) return;
        if(window.ImageEditor.hasUnapplied()){
          showToast("画像への書き込みの画面に、反映していない書き込みがあります。先に「書き込みを反映」するか閉じてください", 6000);
          return;
        }
        window.ImageEditor.closeWindow();
      }
      var orig = img.edit ? {
        id: img.edit.originalId, mime: img.edit.originalMime, width: img.edit.originalWidth,
        height: img.edit.originalHeight, size: img.edit.originalSize,
        bytes: img.edit.originalBytes || null, url: img.edit.originalUrl || null
      } : {
        id: img.id, mime: img.mime, width: img.width, height: img.height, size: img.size,
        bytes: img.isNew ? img.bytes : null, url: img.isNew ? img.url : null
      };
      // The draft image the next 反映 replaces. The editor window stays open after 反映, so a
      // later 反映 replaces the previous result (always drawn on the same untouched original).
      var cur = img;
      // A blank whose frame was dragged to another size (v1.0.234, r.paper = { w, h }): a new white original of
      // that size takes the old one's place (the old one is trashed at the save, as with any picture no longer used),
      // and what was drawn is on it as usual. The printed size of its pixels (img.paper) stays.
      function apply(r){
        if(!r || !r.paper) return applyDrawn(r);
        var size = r.paper;
        return blankPng(size.w, size.h).then(function(b){
          orig = { id: genId(), mime: "image/png", width: size.w, height: size.h, size: b.size, bytes: b.bytes, url: b.url };
          return applyDrawn(Object.assign({}, r, { paper: null }));
        }, function(err){
          showToast(withDetail("紙の大きさを変えられませんでした", err), 6000);
          throw { code: err && err.code, handled:true };
        });
      }
      function applyDrawn(r){
        // The editor window can outlive this edit screen (or the image can be removed meanwhile).
        if(editorSideHooks !== hooksForThisEditor || draftImages.indexOf(cur) < 0){
          showToast("編集画面が変わっていたため、画像への書き込みを反映できませんでした", 6000);
          return Promise.reject({ code:"gone", handled:true });
        }
        var from = cur;
        if(r.empty){
          cur = {
            id: orig.id, mime: orig.mime, name: from.name, width: orig.width, height: orig.height, size: orig.size,
            isNew: !!orig.bytes, bytes: orig.bytes, url: orig.url, composite: from.composite
          };
          if(from.paper){ cur.paper = from.paper; }
          replaceDraft(from, cur);
          return Promise.resolve();
        }
        compressing++;
        renderThumbs();
        return compressImage(new File([r.blob], "edited.png", { type:"image/png" })).then(function(res){
          return res.blob.arrayBuffer().then(function(ab){
            var next = {
              id: genId(), mime: res.mime, name: from.name, width: res.width, height: res.height, size: res.blob.size,
              isNew: true, bytes: new Uint8Array(ab), url: URL.createObjectURL(res.blob),
              edit: {
                originalId: orig.id, originalMime: orig.mime, originalWidth: orig.width,
                originalHeight: orig.height, originalSize: orig.size,
                originalBytes: orig.bytes, originalUrl: orig.url,
                crop: r.crop, shapes: r.shapes
              },
              composite: from.composite
            };
            if(from.paper){ next.paper = from.paper; }
            if(draftImages.indexOf(from) < 0){ return Promise.reject({ code:"gone" }); }
            cur = next;
            replaceDraft(from, next);
          });
        }).then(function(){
          compressing--;
          if(thumbGrid.isConnected){ renderThumbs(); }
        }, function(err){
          compressing--;
          if(thumbGrid.isConnected){ renderThumbs(); }
          showToast(withDetail("画像への書き込みを反映できませんでした", err), 6000);
          throw { code: err && err.code, handled:true };
        });
      }
      var urlReady = orig.url ? Promise.resolve(orig.url) : imageUrl({ id: orig.id, mime: orig.mime });
      urlReady.then(function(url){
        if(inlineEl){
          var place = inlineDrawPlace(inlineEl);
          // A blank's frame being dragged (v1.0.234): the image in the body takes that size at once, so the text
          // under it moves as the paper grows. Put back from the draft (refreshImages) when it is not kept.
          if(img.paper && img.paper.mmPerPx > 0){
            place.resize = function(w, h){
              rich.previewPaper(inlineEl, Math.min(100, Math.round(w * img.paper.mmPerPx / COLUMN_MM * 10000) / 100), w, h);
            };
          }
          return window.ImageEditor.open({ url: url, crop: img.edit && img.edit.crop, shapes: img.edit && img.edit.shapes,
                                           mmPerPx: img.paper && img.paper.mmPerPx, inline: place });
        }
        return openImageEditor({ key: "draft/" + orig.id, url: url, crop: img.edit && img.edit.crop, shapes: img.edit && img.edit.shapes,
                                 mmPerPx: img.paper && img.paper.mmPerPx, onApply: apply });
      }).then(function(r){
        if(r){ return apply(r); }
        if(inlineEl && thumbGrid.isConnected){ rich.refreshImages(); }
      }).catch(function(err){
        if(inlineEl && thumbGrid.isConnected){ rich.refreshImages(); }
        if(err && err.handled) return;
        showToast(withDetail("画像への書き込みを反映できませんでした", err), 6000);
      });
    }

    // Where the picture drawn on in the body may show (v1.0.233): the page's scrolling area below the band that
    // stays at its top. The image is first brought fully into that area when it can be.
    function inlineDrawPlace(el){
      var scroller = null;
      for(var p = el.parentElement; p && p !== document.body; p = p.parentElement){
        var oy = getComputedStyle(p).overflowY;
        if((oy === "auto" || oy === "scroll") && p.scrollHeight > p.clientHeight + 1){ scroller = p; break; }
      }
      if(!scroller){ scroller = document.scrollingElement || document.documentElement; }
      function clip(){
        var r = scroller === document.scrollingElement || scroller === document.documentElement
          ? { top: 0, bottom: window.innerHeight, left: 0, right: window.innerWidth } : scroller.getBoundingClientRect();
        var c = { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
        var band = document.getElementById("edSticky") || document.querySelector(".editor-sticky");
        if(band && band.isConnected){ var b = band.getBoundingClientRect(); if(b.height > 0){ c.top = Math.max(c.top, b.bottom); } }
        return c;
      }
      // The bar (about 2 rows) sits just above the image since v1.0.234: scroll so both are below the band.
      var room = clip(), r = el.getBoundingClientRect(), barH = 110;
      var want = room.top + barH + 12;
      if(r.top < want || r.bottom > room.bottom){ scroller.scrollTop += r.top - want; }
      return { target: el, scroller: scroller, clip: clip };
    }

    var fileList = document.getElementById("fileList");
    // The file list says which PDFs are in the body: redrawn when that changes (v1.0.205).
    var placedKey = "";
    function syncFilePlaced(){
      if(!fileList || !rich) return;
      if(pdfRefsIn(rich.getBody()).join(",") !== placedKey){ renderFiles(); }
    }
    function renderFiles(){
      var placed = pdfRefsIn(rich.getBody());
      placedKey = placed.join(",");
      fileList.innerHTML = draftFiles.map(function(f, i){
        // A PDF (v1.0.205): 「本文へ」 puts it at the caret, as an image's; once there it says so.
        var toBody = !isPdfFile(f) ? '' : placed.indexOf(f.ref) >= 0
          ? '<span class="file-placed" title="本文に置いてあります。本文の中で PDF を押すと、大きさ・位置・移動・本文から外すができます">本文に表示中</span>'
          : '<button type="button" class="btn btn-ghost btn-small file-tobody" data-i="'+i+'" title="この PDF を、本文のカーソルの位置に 1ページ目の絵で入れます">本文へ</button>';
        return '<div class="file-row">' +
                 '<button type="button" class="file-open" data-i="'+i+'" title="開く">'+fileIcon(f)+' '+escapeHtml(f.name)+'</button>' +
                 '<span class="file-size">'+fmtSize(f.size)+'</span>' + toBody +
                 '<button type="button" class="file-remove" data-i="'+i+'" title="添付を外す">×</button>' +
               '</div>';
      }).join("");
      Array.prototype.forEach.call(fileList.querySelectorAll(".file-open"), function(b){
        b.addEventListener("click", function(){ openAttachment(draftFiles[Number(b.getAttribute("data-i"))]); });
      });
      Array.prototype.forEach.call(fileList.querySelectorAll(".file-tobody"), function(b){
        b.addEventListener("mousedown", function(e){ e.preventDefault(); });   // the caret stays in the body
        b.addEventListener("click", function(){
          placePdf(draftFiles[Number(b.getAttribute("data-i"))]);
          renderFiles();
        });
      });
      Array.prototype.forEach.call(fileList.querySelectorAll(".file-remove"), function(b){
        b.addEventListener("click", function(){
          var gone = draftFiles[Number(b.getAttribute("data-i"))];
          if(!gone) return;
          detach("file", gone);
          // Its place in the body goes with it (v1.0.205).
          if(gone.ref){ rich.removeVideos(function(v){ return v.pdf && v.ref === gone.ref; }); }
          rich.recordStep();   // not in the text: a step of its own for 戻す (v1.0.215)
          markDirty();
          renderFiles();
          showToast("「" + (gone.name || "ファイル") + "」の添付を外しました。本文の上の「↶ 戻す」（Ctrl+Z）で元に戻せます", 5000);
        });
      });
      refreshEdAfter();
    }
    function addAttachment(file){
      if(file.size > MAX_FILE_BYTES){
        showToast("「"+(file.name||"")+"」は大きすぎます（1つ20MBまで）", 5000);
        return;
      }
      compressing++;
      renderThumbs();
      file.arrayBuffer().then(function(ab){
        var added = { id: genId(), name: file.name || "file", mime: file.type || "application/octet-stream",
                      size: file.size, isNew: true, bytes: new Uint8Array(ab) };
        draftFiles.push(added);
        ensureFileRefs(draftFiles, rich.getBody(), detachedRefs("file"));
        // A PDF goes straight into the body at the caret (v1.0.205; 「本文から外す」 takes it out again).
        if(isPdfFile(added) && activeRich === rich){ placePdf(added); }
        markDirty();
      }).catch(function(){
        showToast("ファイルを読み込めませんでした（"+(file.name||"")+"）");
      }).then(function(){
        compressing--;
        if(fileList.isConnected){ renderThumbs(); renderFiles(); }
      });
    }

    // 同じ画像の二重取り込みの案内 (v1.0.213). A new image is the same as one already in this record when
    // its source file has the same fingerprint (img.src, SHA-256 of the file as picked, saved with the image),
    // or, for images saved before v1.0.213 (no src), when the shrunk picture has the same size and pixels
    // count (shrinking the same file gives the same bytes), also against the untouched original of an annotated one.
    function sameImage(c, b){
      if(c.src && b.src){ return c.src === b.src; }
      if(b.width === c.width && b.height === c.height && b.size === c.size){ return true; }
      var e = b.edit;
      return !!(e && e.originalWidth === c.width && e.originalHeight === c.height && e.originalSize === c.size);
    }
    function imageLabel(img){ return img.ref ? "画像" + img.ref : "「" + (img.name || "画像") + "」"; }
    // cands: new images not yet in draftImages. done(kept) gets those to add: all of them, or, when some are
    // already here (or picked twice in this batch), what the owner chooses in the question.
    function keepOrAskSame(cands, done){
      var have = realImages(draftImages).filter(function(b){ return !b.composite; });
      var lines = [], dup = [];
      cands.forEach(function(c, i){
        var hit = have.filter(function(b){ return sameImage(c, b); })[0];
        if(hit){ dup.push(c); lines.push("「" + (c.name || "画像") + "」は、すでに入っている" + imageLabel(hit) + "と同じです"); return; }
        var twin = cands.slice(0, i).filter(function(b){ return dup.indexOf(b) < 0 && sameImage(c, b); })[0];
        if(twin){ dup.push(c); lines.push("「" + (c.name || "画像") + "」を2回選んでいます"); }
      });
      if(!dup.length){ done(cands); return; }
      function drop(list){ list.forEach(function(c){ if(c.url){ URL.revokeObjectURL(c.url); } }); }
      var wrap = document.createElement("div");
      wrap.className = "modal-backdrop";
      wrap.innerHTML =
        '<div class="modal">' +
          '<h3>同じ画像がすでに入っています</h3>' +
          '<ul class="help" style="margin:0 0 8px;padding-left:1.2em;">' +
            lines.map(function(t){ return '<li>' + escapeHtml(t) + '</li>'; }).join("") + '</ul>' +
          '<p class="help">' + (dup.length < cands.length ? "ほかの画像はそのまま入れます。" : "") +
            '同じ画像を2枚入れるときだけ「それでも入れる」を押してください。</p>' +
          '<div class="modal-actions">' +
            '<button class="btn btn-ghost btn-small" data-act="all">それでも入れる</button>' +
            '<button class="btn btn-primary btn-small" data-act="skip">同じものは入れない</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(wrap);
      wrap.querySelector('[data-act="skip"]').focus();
      wrap.addEventListener("click", function(e){
        var b = e.target.closest("[data-act]");
        if(!b) return;
        wrap.remove();
        if(b.getAttribute("data-act") === "all"){ done(cands); return; }
        drop(dup);
        done(cands.filter(function(c){ return dup.indexOf(c) < 0; }), dup.length);
      });
    }
    function fingerprint(file){
      return file.arrayBuffer().then(function(ab){ return crypto.subtle.digest("SHA-256", ab); }).then(function(h){
        return Array.prototype.map.call(new Uint8Array(h).subarray(0, 16), function(x){ return (x < 16 ? "0" : "") + x.toString(16); }).join("");
      }).catch(function(){ return ""; });
    }

    // Images go to the images (shrunk, can be placed in the text); anything else is attached as a file.
    // inline: also put each image into the text at the caret (pasting into the body).
    // Since v1.0.213 the images of one pick are added together, after asking if some are already here.
    function addFiles(files, inline){
      var imgs = [];
      Array.prototype.forEach.call(files, function(file){
        if(IMAGE_TYPES.indexOf(file.type) < 0){
          addAttachment(file);
          return;
        }
        imgs.push(file);
      });
      if(!imgs.length) return;
      compressing += imgs.length;
      renderThumbs();
      Promise.all(imgs.map(function(file){
        return Promise.all([compressImage(file), fingerprint(file)]).then(function(r){
          var res = r[0];
          return res.blob.arrayBuffer().then(function(ab){
            var added = {
              id: genId(), mime: res.mime, name: file.name || "image",
              width: res.width, height: res.height, size: res.blob.size,
              isNew: true, bytes: new Uint8Array(ab), url: URL.createObjectURL(res.blob)
            };
            if(r[1]){ added.src = r[1]; }
            return added;
          });
        }).catch(function(err){
          showToast(err && err.code === "too_large" ? "この画像は500KB以下に縮小できませんでした" : "画像を読み込めませんでした（"+(file.name||"")+"）");
          return null;
        });
      })).then(function(list){
        compressing -= imgs.length;
        var cands = list.filter(Boolean);
        if(!thumbGrid.isConnected){ cands.forEach(function(c){ URL.revokeObjectURL(c.url); }); return; }
        renderThumbs();
        if(!cands.length) return;
        keepOrAskSame(cands, function(kept, skipped){
          if(!thumbGrid.isConnected) return;
          kept.forEach(function(added){
            draftImages.push(added);
            ensureRefs(draftImages, detachedRefs("image"));
            if(inline){ rich.insertImage(added.ref); }
          });
          if(kept.length){ markDirty(); }
          renderThumbs();
          if(skipped){ showToast("同じ画像" + skipped + "枚は入れませんでした", 4000); }
        });
      });
    }

    renderThumbs();
    renderFiles();
    // A record saved before v1.0.129 can have one image in the text twice: give each place its own copy.
    rich.splitDuplicates();

    var fileInput2 = document.getElementById("fileInput2");
    document.getElementById("fileAttachBtn").addEventListener("click", function(){ fileInput2.click(); });
    fileInput2.addEventListener("change", function(){
      var files = Array.prototype.slice.call(fileInput2.files);
      fileInput2.value = "";
      addFiles(files);
    });
    // Google Drive / Google Photos: picked in Google's own screen, then added like local files.
    function pickFrom(fn, waitText){
      var wait = document.createElement("div");
      wait.className = "modal-backdrop";
      wait.innerHTML = '<div class="modal"><h3>'+escapeHtml(waitText.title)+'</h3><p class="help">'+escapeHtml(waitText.help)+'</p>' +
                       '<div class="modal-actions"><button class="btn btn-ghost btn-small" id="pickCancel">中止</button></div></div>';
      if(waitText.show){ document.body.appendChild(wait); }
      var stopped = false;
      wait.querySelector("#pickCancel").addEventListener("click", function(){
        stopped = true;
        wait.remove();
        if(api.cancelPick){ api.cancelPick().catch(noop); }
      });
      fn().then(function(picked){
        wait.remove();
        if(stopped || !fileList.isConnected || !picked || !picked.length) return;
        addFiles(picked.map(function(p){ return new File([p.bytes], p.name, { type: p.mime }); }));
        showToast(picked.length + "件を追加しました");
      }).catch(function(err){
        wait.remove();
        var code = err && err.code;
        if(stopped || code === "auth_cancelled" || code === "picker_cancelled") return;
        if(code === "too_large"){ showToast("「"+(err.message||"")+"」は大きすぎます（1つ20MBまで）", 6000); return; }
        if(code === "auth_timeout"){ showToast("時間内に選ばれなかったため中止しました", 5000); return; }
        showToast(withDetail("取り込めませんでした", err), 8000);
      });
    }
    if(api.pickDriveFiles){
      document.getElementById("driveAttachBtn").addEventListener("click", function(){
        pickFrom(api.pickDriveFiles, {
          show: true,
          title: "Googleドライブで選んでください",
          help: "Googleの画面が開きます。許可を確認してからファイルを選ぶと、ここに取り込まれます。"
        });
      });
    }
    if(api.pickPhotos){
      document.getElementById("photosAttachBtn").addEventListener("click", function(){
        pickFrom(api.pickPhotos, {
          show: true,
          title: "Googleフォトで選んでください",
          help: "ブラウザにGoogleの画面が開きます。許可を確認すると続けてGoogleフォトが開くので、写真を選んで「完了」を押してください。選んだ写真がここに取り込まれます。"
        });
      });
    }

    ["editTitle","editDate","editCategory","editBody"].forEach(function(fid){
      document.getElementById(fid).addEventListener("input", markDirty);
    });

    // Copies stored images of other records into this one (「過去の記録から」, and 「画像を別の記録へ」 on the reading screen).
    function attachCopies(list){
      if(!list.length || !thumbGrid.isConnected) return;
      var slots = list.map(function(){ return null; }), failed = 0;
      compressing += list.length;
      // Leaving before the copies are in asks first, like any other change.
      markDirty();
      renderThumbs();
      Promise.all(list.map(function(img, k){
        return copyStoredImage(img).then(function(c){ slots[k] = c; }, function(){ failed++; });
      })).then(function(){
        compressing -= list.length;
        if(!thumbGrid.isConnected) return;
        renderThumbs();
        keepOrAskSame(slots.filter(Boolean), function(added, skipped){
          if(!thumbGrid.isConnected) return;
          added.forEach(function(c){ draftImages.push(c); });
          ensureRefs(draftImages, detachedRefs("image"));
          if(added.length){ markDirty(); }
          renderThumbs();
          var msg = added.length + "枚を添付しました" + (failed ? "（" + failed + "枚は読み込めませんでした）" : "") +
                    (skipped ? "（同じ画像" + skipped + "枚は入れませんでした）" : "");
          showToast(msg + (added.length ? "。「本文へ」で本文に置けます。保存すると記録に残ります" : ""), failed ? 7000 : 5000);
        });
      });
    }
    document.getElementById("pastAttachBtn").addEventListener("click", function(){
      pickPastImages(entry && entry.id).then(attachCopies);
    });
    // 「白紙」(v1.0.131): a white picture to draw on, attached like any image, then opened for 書き込み.
    // Since v1.0.133 it is chosen by its printed width (小・中・大 = the widths those sizes give a photo)
    // and keeps that width wherever it is placed (img.paper, paperPct), so its text is as large as the body.
    // Every blank has the same pixels per mm as the 1600-pixel 大 one.
    var BLANK_WIDTHS = [["小", 64.8, "約6.5cm"], ["中", 111.6, "約11cm"], ["大", 180, "18cm・本文の幅"]];
    var BLANK_SHAPES = [["横長", 3 / 4], ["縦長", 4 / 3], ["正方形", 1]];
    var BLANK_PX_PER_MM = 1600 / 180, BLANK_KEY = "blank-width";
    // place (v1.0.233, 「✎ 描く場所」): put it in the body at the caret and draw on it right there.
    function addBlank(mm, ratio, place){
      var w = Math.round(mm * BLANK_PX_PER_MM), h = Math.round(w * ratio);
      compressing++;
      renderThumbs();
      blankPng(w, h).then(function(b){
        return {
          id: genId(), mime: "image/png", name: "白紙", width: w, height: h, size: b.size,
          isNew: true, bytes: b.bytes, url: b.url,
          paper: { mmPerPx: mm / w }
        };
      }).then(function(added){
        compressing--;
        if(!thumbGrid.isConnected) return;
        draftImages.push(added);
        ensureRefs(draftImages, detachedRefs("image"));
        markDirty();
        renderThumbs();
        if(place){
          rich.insertImage(added.ref);
          drawWhenShown(added);
          return;
        }
        showToast("白紙を「画像" + added.ref + "」として添付しました。「本文へ」で本文に置けます", 5000);
        annotate(added);
      }, function(err){
        compressing--;
        if(thumbGrid.isConnected){ renderThumbs(); }
        showToast(withDetail("白紙を作れませんでした", err), 6000);
      });
    }
    // The blank placed by 「✎ 描画」 is drawn on as soon as its picture is in the body.
    function drawWhenShown(added){
      var tries = 0;
      (function wait(){
        if(!thumbGrid.isConnected || draftImages.indexOf(added) < 0) return;
        var el = rich.imageEl(added.ref);
        if(el && el.complete && el.naturalWidth && el.getBoundingClientRect().width > 0){ annotate(added, el); return; }
        if(++tries < 50){ setTimeout(wait, 60); }
      })();
    }
    document.getElementById("blankAttachBtn").addEventListener("click", function(){ openBlankChooser(false); });
    // ✎ 描く場所 (v1.0.233): the body's tools, next to 区切り線.
    var drawPlaceBtn = document.getElementById("drawPlaceBtn");
    if(drawPlaceBtn){
      drawPlaceBtn.addEventListener("mousedown", function(e){ e.preventDefault(); });   // the caret stays where it is
      // v1.0.234 (the owner's choice): no chooser, a 小・横長 blank at once; its frame sets the size while drawing.
      drawPlaceBtn.addEventListener("click", function(){ addBlank(BLANK_WIDTHS[0][1], BLANK_SHAPES[0][1], true); });
    }
    function openBlankChooser(place){
      var box = document.createElement("div");
      box.className = "modal-backdrop";
      var wi = 2;
      try { var kept = window.localStorage.getItem(BLANK_KEY); if(kept !== null && BLANK_WIDTHS[kept]){ wi = Number(kept); } } catch(e){}
      box.innerHTML = '<div class="modal"><h3>白紙</h3>' +
        '<p class="help">白い画像を1枚添付して、書き込みの画面を開きます。書いた文字は、どの大きさの白紙でも' +
          '日誌の本文と同じ大きさになります（本文は10.5）。白紙は本文に置いても、ここで選んだ幅のまま出ます。</p>' +
        '<div class="field"><label>大きさ（紙の幅）</label><div class="modal-actions" style="justify-content:flex-start;margin-top:0;">' +
          BLANK_WIDTHS.map(function(s, i){
            return '<button class="btn btn-small' + (i === wi ? ' btn-primary' : ' btn-ghost') + '" data-w="' + i + '">' +
                   s[0] + '（' + s[2] + '）</button>';
          }).join("") +
        '</div></div>' +
        '<div class="field"><label>向き（押すと作ります）</label><div class="modal-actions" style="justify-content:flex-start;margin-top:0;">' +
          BLANK_SHAPES.map(function(s, i){
            return '<button class="btn btn-small" data-i="' + i + '">' + s[0] + '</button>';
          }).join("") +
        '</div></div>' +
        '<div class="modal-actions"><button class="btn btn-ghost btn-small" data-i="">中止</button></div></div>';
      document.body.appendChild(box);
      Array.prototype.forEach.call(box.querySelectorAll("button[data-w]"), function(b){
        b.addEventListener("click", function(){
          wi = Number(b.getAttribute("data-w"));
          Array.prototype.forEach.call(box.querySelectorAll("button[data-w]"), function(x){
            var on = x === b;
            x.classList.toggle("btn-primary", on);
            x.classList.toggle("btn-ghost", !on);
          });
        });
      });
      Array.prototype.forEach.call(box.querySelectorAll("button[data-i]"), function(b){
        b.addEventListener("click", function(){
          box.remove();
          var s = BLANK_SHAPES[b.getAttribute("data-i")];
          if(!s) return;
          try { window.localStorage.setItem(BLANK_KEY, String(wi)); } catch(e){}
          addBlank(BLANK_WIDTHS[wi][1], s[1], place);
        });
      });
    }
    // Opened by 「画像を別の記録へ」: the images chosen there go in at once.
    if(pendingEditorImages){
      var sent = pendingEditorImages;
      pendingEditorImages = null;
      attachCopies(sent);
    }

    var imageInput = document.getElementById("imageInput");
    document.getElementById("attachBtn").addEventListener("click", function(){ imageInput.click(); });
    document.getElementById("layoutBtn").addEventListener("click", openBoard);
    imageInput.addEventListener("change", function(){
      var files = Array.prototype.slice.call(imageInput.files);
      imageInput.value = "";
      addFiles(files);
    });
    wrapEl.addEventListener("dragover", function(e){
      if(e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types, "Files") >= 0){
        e.preventDefault();
        wrapEl.classList.add("dragging");
      }
    });
    wrapEl.addEventListener("dragleave", function(e){
      if(!wrapEl.contains(e.relatedTarget)){ wrapEl.classList.remove("dragging"); }
    });
    wrapEl.addEventListener("drop", function(e){
      wrapEl.classList.remove("dragging");
      if(e.dataTransfer && e.dataTransfer.files.length){
        e.preventDefault();
        addFiles(e.dataTransfer.files);
      }
    });
    wrapEl.addEventListener("paste", function(e){
      var files = e.clipboardData ? Array.prototype.filter.call(e.clipboardData.files, function(f){ return /^image\//.test(f.type); }) : [];
      if(files.length){
        e.preventDefault();
        // Pasted into the body: the picture also appears there, at the caret.
        addFiles(files, document.getElementById("editBody").contains(e.target));
      }
    });

    document.getElementById("backFromEditor").addEventListener("click", function(){
      guardLeave(function(){
        if(isNew){ currentView="list"; } else { currentView="view"; openEntryId = entry.id; }
        renderMain();
      });
    });
    var listFromEditor = document.getElementById("listFromEditor");
    if(listFromEditor){
      listFromEditor.addEventListener("click", function(){
        guardLeave(function(){ currentView = "list"; renderMain(); });
      });
    }
    // ⧉ 別の窓で編集 (v1.0.216): what is not saved cannot go along, so it asks for a save first.
    var ownWin = document.getElementById("edOwnWindow");
    if(ownWin){
      ownWin.addEventListener("click", function(){
        if(editorSaving){ showToast("保存が終わってから、もう一度押してください", 4000); return; }
        if(editorDirty || window.ImageEditor.hasUnapplied()){
          showToast("保存していない変更があります。「保存する」を押してから、もう一度押してください", 6000);
          return;
        }
        moveToWindow(entry.id, "editor");
      });
    }
    // 保存する (v1.0.104) keeps this edit screen, so what is not saved yet stays as it is, the image editor
    // window included. 保存して閉じる saves and goes to the record, as saving did before.
    saveBtn.addEventListener("click", function(){ doSave(false).catch(noop); });
    saveCloseBtn.addEventListener("click", function(){
      // Closing ends this edit screen, so a drawing not yet applied in the editor window would be lost.
      // (Already applied: the window just closes along with the edit screen, via renderMain.)
      if(window.ImageEditor.hasUnapplied()){
        openConfirmModal("画像への書き込みがまだ反映されていません", "書き込みの画面で「書き込みを反映」を押してから保存してください。このまま保存して閉じると、反映していない書き込みは失われます。", function(){
          window.ImageEditor.closeWindow();
          doSave(true).catch(noop);
        }, "反映せずに保存して閉じる", false);
        return;
      }
      doSave(true).catch(noop);
    });
    editorSave = function(){ return compressing > 0 ? Promise.reject({ code:"busy" }) : doSave(false); };

    // Resolves once the entry is on Drive; rejects (after showing why) when it could not be saved.
    // closeAfter: go to the record afterwards; otherwise the edit screen goes on with the saved record.
    function doSave(closeAfter){
      // One save at a time (v1.0.175): a second one (「保存して終了」 while 保存 is on its way) joins it, or a new
      // record would be saved twice, as two records.
      if(editorSaving){ return editorSaving; }
      var key = sessionKey, run;
      // The pictures of the videos (v1.0.172): up to 5 seconds for those still being fetched, then saved without them.
      ensureVideoThumbs(rich.getBody());
      var waits = Object.keys(thumbFetches).map(function(k){ return thumbFetches[k]; });
      if(!waits.length){ run = doSaveNow(closeAfter); }
      else {
        saveBtn.disabled = saveCloseBtn.disabled = true;
        run = Promise.race([Promise.all(waits), new Promise(function(r){ setTimeout(r, 5000); })]).then(function(){
          // Locked meanwhile (or this edit screen has gone): nothing to save it with.
          if(key !== sessionKey || activeRich !== rich){ return Promise.reject({ code:"gone" }); }
          return doSaveNow(closeAfter);
        });
      }
      editorSaving = run;
      run.then(noop, noop).then(function(){ if(editorSaving === run){ editorSaving = null; } });
      return run;
    }
    function doSaveNow(closeAfter){
      var nowIso = new Date().toISOString();
      var bodyNow = rich.getBody();
      // One picture per video still in the body; those of videos taken out are not kept (v1.0.172).
      var videosNow = videoIdsIn(bodyNow), thumbsKept = [];
      // Likewise one page-1 picture per PDF still in the body and still attached (v1.0.205).
      var pdfsNow = pdfRefsIn(bodyNow).filter(function(ref){ return fileByRef(draftFiles, ref); }), pdfKept = [];
      draftImages = draftImages.filter(function(img){
        if(img.pdfThumb){
          if(pdfsNow.indexOf(img.pdfThumb) < 0 || pdfKept.indexOf(img.pdfThumb) >= 0) return false;
          pdfKept.push(img.pdfThumb);
          return true;
        }
        if(!img.ytThumb) return true;
        if(videosNow.indexOf(img.ytThumb) < 0 || thumbsKept.indexOf(img.ytThumb) >= 0) return false;
        thumbsKept.push(img.ytThumb);
        return true;
      });
      var newEntry = {
        id: draft.id || genId(),
        title: document.getElementById("editTitle").value.trim(),
        date: document.getElementById("editDate").value || todayStr(),
        category: document.getElementById("editCategory").value,
        body: bodyNow,
        tags: (flushTagEdit(), addTypedTags(), draftTags.slice()),
        images: draftImages.map(storedImageMeta),
        files: draftFiles.map(storedFileMeta),
        // 記入時刻 = first save; entries saved before this existed fall back to their last save.
        createdAt: (entry && (entry.createdAt || entry.updatedAt)) || nowIso,
        updatedAt: nowIso
      };
      // What is saved is fixed here. Changes made after this (typing on while a video is sent, which takes
      // minutes) are not in it: the record stays unsaved for them (v1.0.214; before, they were marked saved
      // and lost without a question when the screen was left).
      var savedGen = dirtyGen;
      var keptKeys = [].concat.apply([], draftImages.map(imageFileKeys))
        .concat(draftFiles.map(function(f){ return f.id; }));
      var removedIds = originalImageIds.filter(function(key){ return keptKeys.indexOf(key) < 0; });
      // Attachments taken off with × whose Drive files this save trashes: 戻す can no longer bring them back
      // (v1.0.215). Those added since the last save are still in memory and can (the next save sends them).
      var goneNow = detached.filter(function(d){
        if(!d.off || d.gone) return false;
        var keys = d.kind === "file" ? [d.item.id] : imageFileKeys(d.item);
        return keys.some(function(k){ return removedIds.indexOf(k) >= 0; });
      });
      goneNow.forEach(function(d){ d.gone = true; });
      // Files that exist only in memory so far: new/re-rendered images and not-yet-uploaded originals.
      var newImages = [];
      draftImages.forEach(function(img){
        pendingUploads(img, []).forEach(function(u){
          if(!doc.images[u.id] && !newImages.some(function(n){ return n.id === u.id; })){ newImages.push(u); }
        });
      });
      draftFiles.forEach(function(f){
        if(f.isNew && f.bytes && !doc.images[f.id]){ newImages.push({ id: f.id, bytes: f.bytes }); }
      });
      if(realImages(draftImages).length && draftLayout){
        newEntry.layout = BoardLayout.normalize(realImages(draftImages), draftLayout);
      }
      if(entry && entry.important){ newEntry.important = true; }
      // 動画ファイル (v1.0.201): new ones go to Drive first (each with its 札, a new image here); those taken out
      // of the body and in no other record (a copied record shares them) go to the trash with their 札.
      var fileVidsNow = fileVideoIdsIn(bodyNow);
      var toSend = fileVidsNow.filter(function(id){ return localVideos[id] && !doc.images[id]; });
      var vidsGone = unusedVideos(fileVideoIdsIn(entry && entry.body).filter(function(id){
        return fileVidsNow.indexOf(id) < 0 && doc.images[id];
      }), newEntry.id);
      var sentVideos = [];   // Drive ids of videos sent now: back to the trash if the record is not saved
      saveBtn.disabled = saveCloseBtn.disabled = true;
      saveBtn.textContent = "保存中…";
      return Promise.resolve(splitRuns[newEntry.id]).then(function(){
        return runSeq(toSend, function(id){
          var lv = localVideos[id], n = toSend.indexOf(id) + 1;
          var label = "動画を送っています" + (toSend.length > 1 ? "（" + n + "/" + toSend.length + "）" : "");
          saveBtn.textContent = label + "…";
          videoProgress = function(p){
            if(p.videoId === id && saveBtn.isConnected){ saveBtn.textContent = label + " " + Math.floor(p.sent / p.total * 100) + "%"; }
          };
          return api.videos.upload(lv.path, id).then(function(r){
            sentVideos.push(r.fileId);
            var meta = { v: 1, fileId: r.fileId, key: r.key, size: r.size, chunk: r.chunk, mime: lv.mime, name: lv.name };
            videoMetas[id] = Promise.resolve(meta);
            newImages.push({ id: id, bytes: new TextEncoder().encode(JSON.stringify(meta)) });
          });
        });
      }).then(function(){
        videoProgress = null;
        saveBtn.textContent = "保存中…";
        return videoFilesOf(vidsGone);
      }).then(function(gone){
        gone.ids.forEach(function(id){ if(removedIds.indexOf(id) < 0){ removedIds.push(id); } });
        return saveEntry(newEntry, newImages, removedIds).then(function(){
          sentVideos = [];
          gone.ids.forEach(function(id){ delete videoMetas[id]; });
          if(gone.files.length){ api.trashFiles(gone.files).catch(noop); }
        });
      }, function(err){
        videoProgress = null;
        throw err;
      }).then(function(){
        newImages.forEach(function(img){ if(img.url){ imageUrlCache[img.id] = Promise.resolve(img.url); } });
        var changedMeanwhile = dirtyGen !== savedGen;
        editorDirty = changedMeanwhile;
        // A new record gets its id only now: keep the image shown on the right.
        if(sideCurrent && sideCurrent.entryId === openEntryId){ sideCurrent.entryId = newEntry.id; }
        openEntryId = newEntry.id;
        // A new record is this window's to write from now on (v1.0.216), and a record window shows its new title.
        if(api.records && currentView === "editor"){ api.records.claim(openEntryId); }
        if(RECORD_WIN){ api.records.showing(openEntryId); showRecordTitle(); }
        renderCategories();
        // 保存して閉じる with changes made meanwhile: the screen stays, so they are not lost.
        if(closeAfter && !changedMeanwhile){
          currentView = "view";
          renderMain();
          showToast("保存しました");
          return;
        }
        // Stay here, now editing the saved record: a second save updates it (and moves out of Drive what was
        // taken off since), and the back link goes to it instead of the list.
        entry = newEntry;
        isNew = false;
        draft.id = newEntry.id;
        originalImageIds = keptKeys;
        if(imgedContext && imgedContext.view === "editor"){ imgedContext.entryId = openEntryId; }
        saveBtn.textContent = "保存する";
        saveBtn.disabled = saveCloseBtn.disabled = compressing > 0;
        document.getElementById("backFromEditor").textContent = "← 記録へ戻る";
        if(document.getElementById("listFromEditor")){ document.getElementById("listFromEditor").hidden = false; }
        var written = document.getElementById("edWritten");
        if(written){ written.textContent = writtenLabel(newEntry); }
        refreshEdHead();
        showToast(changedMeanwhile ? "保存しました。ただし、保存の途中で書き足した分はまだ保存していません。もう一度「保存する」を押してください" :
                  "保存しました（このまま続けて編集できます）", changedMeanwhile ? 8000 : undefined);
      }).catch(function(err){
        // Videos sent for a record that was not saved (v1.0.201): nothing points at them.
        if(sentVideos.length){ api.trashFiles(sentVideos).catch(noop); sentVideos = []; }
        goneNow.forEach(function(d){ d.gone = false; });   // not trashed: 戻す can bring them back
        if(saveBtn.isConnected){
          saveBtn.disabled = saveCloseBtn.disabled = false;
          saveBtn.textContent = "保存する";
        }
        handleWriteError(err, "保存に失敗しました。通信状況をご確認ください。");
        throw err;
      });
    }
  }

  function entryPayload(e){
    return {
      title: e.title, date: e.date, category: e.category,
      body: e.body, images: e.images || [], files: e.files || [], tags: e.tags || [], layout: e.layout || null,
      createdAt: e.createdAt, updatedAt: e.updatedAt,
      important: e.important ? true : undefined
    };
  }

  function upsertLive(entry){
    var idx = liveEntries.findIndex(function(e){ return e.id === entry.id; });
    if(idx >= 0){ liveEntries[idx] = entry; } else { liveEntries.push(entry); }
  }

  // Saves of one record run one after another (v1.0.143), each written from what the one before left.
  // 重要マーク: only toggleImportant changes it (opts.important), and it then saves the latest record with
  // just that changed; every other save keeps the mark the latest record has. Before, a mark set while
  // ✎ 書き込み's save was still running was undone by it, or put the replaced (trashed) image back.
  var entrySaves = {};
  function saveEntry(entry, newImages, removedIds, opts){
    var id = entry.id;
    var run = Promise.resolve(entrySaves[id]).then(noop, noop).then(function(){
      var latest = liveEntries.filter(function(e){ return e.id === id; })[0];
      if(opts && "important" in opts){
        if(!latest){ return Promise.reject({ code:"gone" }); }
        entry = Object.assign({}, latest);
        if(opts.important){ entry.important = true; } else { delete entry.important; }
      } else if(latest){
        entry = Object.assign({}, entry);
        if(latest.important){ entry.important = true; } else { delete entry.important; }
      }
      return writeEntry(entry, newImages, removedIds);
    });
    entrySaves[id] = run;
    run.then(noop, noop).then(function(){ if(entrySaves[id] === run){ delete entrySaves[id]; } });
    return run;
  }

  // 1) upload newly attached images, 2) write the journal, 3) move detached
  //    images to the Drive trash. Uploaded images are trashed again if the
  //    journal write fails so no orphans are left behind.
  function writeEntry(entry, newImages, removedIds){
    var uploaded = {};
    var committed = false;
    var salt = doc.salt;
    return runSeq(newImages, function(img){
      return encryptBytes(sessionKey, img.bytes).then(function(enc){
        return api.uploadImage(enc, img.id);
      }).then(function(fileId){ uploaded[img.id] = fileId; });
    }).then(function(){
      return encryptJson(sessionKey, entryPayload(entry));
    }).then(function(enc){
      var toTrash = [];
      return persist(function(d){
        toTrash = [];
        upsertBlob(d, entry.id, enc);
        Object.keys(uploaded).forEach(function(k){ d.images[k] = uploaded[k]; });
        removedIds.forEach(function(k){
          if(d.images[k]){ toTrash.push(d.images[k]); delete d.images[k]; }
        });
      }, salt).then(function(){
        committed = true;
        upsertLive(entry);
        removedIds.forEach(dropCachedImage);
        if(toTrash.length){ api.trashFiles(toTrash).catch(noop); }
      });
    }).catch(function(err){
      var orphans = values(uploaded);
      if(!committed && orphans.length){ api.trashFiles(orphans).catch(noop); }
      throw err;
    });
  }

  function confirmDeleteEntry(id){
    openConfirmModal(
      "この記録を削除しますか？",
      "削除すると元に戻せません（添付画像はGoogleドライブのゴミ箱に移動します）。心配な場合は先にバックアップを書き出しておいてください。",
      function(){
        if(editedElsewhere(id)){ return; }   // its save would bring the record back (v1.0.223)
        var entry = liveEntries.filter(function(e){ return e.id === id; })[0];
        var imgIds = [].concat.apply([], (entry && entry.images || []).map(imageFileKeys))
          .concat((entry && entry.files || []).map(function(f){ return f.id; }));
        // 動画ファイル (v1.0.201): its 札 and the video go too, unless another record (a copy) has it.
        var vids = unusedVideos(fileVideoIdsIn(entry && entry.body).filter(function(v){ return doc.images[v]; }), id);
        var toTrash = [], vidFiles = [];
        videoFilesOf(vids).then(function(gone){
          vids = gone.ids;   // one whose 札 cannot be read now keeps it (videoFilesOf)
          vidFiles = gone.files;
          imgIds = imgIds.concat(vids);
          return persist(function(d){
            toTrash = [];
            d.entries = d.entries.filter(function(e){ return e.id !== id; });
            imgIds.forEach(function(k){
              if(d.images[k]){ toTrash.push(d.images[k]); delete d.images[k]; }
            });
          });
        }).then(function(){
          liveEntries = liveEntries.filter(function(e){ return e.id !== id; });
          imgIds.forEach(dropCachedImage);
          vids.forEach(function(v){ delete videoMetas[v]; });
          toTrash = toTrash.concat(vidFiles);
          if(toTrash.length){ api.trashFiles(toTrash).catch(noop); }
          currentView = "list";
          renderCategories();
          renderMain();
          showToast("削除しました");
        }).catch(function(err){
          handleWriteError(err, "削除に失敗しました。通信状況をご確認ください。");
        });
      }
    );
  }

  /* ---------------- export: encrypted backup ---------------- */
  // Same format as the old app's backup, plus `imageData` holding each
  // image's encrypted bytes (base64) so a backup is self-contained.
  function exportBackup(){
    var ids = Object.keys(doc.images);
    var imageData = {};
    var missing = 0;
    showToast(ids.length ? "画像を含めてバックアップを準備しています…" : "バックアップを準備しています…", 60000);
    return runSeq(ids, function(imgId){
      return api.downloadImage(doc.images[imgId]).then(function(bytes){
        imageData[imgId] = bytesToB64(new Uint8Array(bytes));
      }, function(err){
        if(err && err.code === "not_found"){ missing++; return; }
        throw err;
      });
    }).then(function(){
      var backup = {
        version: 2,
        salt: doc.salt,
        verifier: doc.verifier,
        categories: doc.categories,
        entries: doc.entries,
        imageData: imageData
      };
      return api.saveTextFile({
        defaultName: "koukai-nisshi-backup-"+todayStr()+".json",
        text: JSON.stringify(backup),
        filterName: "バックアップ（JSON）",
        extensions: ["json"]
      });
    }).then(function(saved){
      if(!saved){ showToast("書き出しを中止しました"); return; }
      showToast(missing ? "バックアップを書き出しました（見つからない画像が"+missing+"件ありました）" : "バックアップを書き出しました", 4000);
    }).catch(function(err){
      showToast(errorMessage(err, withDetail("書き出しに失敗しました", err)), 4000);
    });
  }

  /* ---------------- export: markdown ---------------- */
  // Images are written next to the .md file; main replaces {{IMGDIR}} with
  // the folder name it actually uses.
  function oneImageMarkdown(img){
    return "![" + (img.name||"image").replace(/[\[\]]/g,"") + "](<{{IMGDIR}}/" + img.id + "." + extForMime(img.mime) + ">)";
  }
  // Images not placed in the text, listed after the body.
  function imageMarkdown(e){
    return imagesAfterBody(e).map(oneImageMarkdown).join("\n");
  }
  // The body with each marker line turned into the images it places.
  function bodyMarkdown(e){
    return String(e.body||"").split("\n").map(function(line){
      var v = videoIn(line);
      if(v) return v.file ? "▶ 動画（航海日誌のアプリで再生できます）" : "[▶ YouTube の動画](" + videoUrl(v) + ")";
      var p = pdfIn(line);
      if(p){ var pf = fileByRef(e.files, p.ref); return pf ? "📄 " + (pf.name || "PDF") + "（添付の PDF）" : ""; }
      // 区切り線: a Markdown rule ("---" under a line of text would make it a heading)
      if(ruleIn(line)) return "* * *";
      if(!MARKER_LINE.test(line)) return line;
      var imgs = markersIn(line).map(function(m){ return imageByRef(e.images, m.ref); }).filter(Boolean);
      return imgs.length ? imgs.map(oneImageMarkdown).join(" ") : line;
    }).join("\n");
  }

  function buildMarkdown(entries, headerLabel){
    var out = "# 航海日誌 — "+headerLabel+"\n\n";
    out += "書き出し日: "+todayStr()+"\n\n---\n\n";
    entries.forEach(function(e){
      out += "## "+(e.title || "（無題）")+"\n\n";
      out += "- 日付: "+e.date+"\n";
      out += "- カテゴリ: "+catName(e.category)+"\n";
      if(e.tags && e.tags.length){ out += "- タグ: "+e.tags.map(function(t){ return "#"+t; }).join(" ")+"\n"; }
      out += "\n";
      out += bodyMarkdown(e) + "\n\n";
      var imgs = imageMarkdown(e);
      if(imgs){ out += imgs + "\n\n"; }
      var files = fileMarkdown(e);
      if(files){ out += files + "\n\n"; }
      out += "---\n\n";
    });
    return out;
  }

  // Attached files are written into the same folder as the images, prefixed with their id.
  function attachedFileName(f){
    return f.id + "-" + String(f.name || "file").replace(/[\\/:*?"<>|\x00-\x1f]/g, "_");
  }
  function fileMarkdown(e){
    return (e.files||[]).map(function(f){
      return "- " + fileIcon(f) + " [" + String(f.name || "file").replace(/[\[\]]/g, "") + "](<{{IMGDIR}}/" + attachedFileName(f) + ">)";
    }).join("\n");
  }

  function collectImageFiles(entries){
    var files = [];
    var all = [];
    entries.forEach(function(e){
      realImages(e.images).forEach(function(img){ all.push({ item: img, name: img.id + "." + extForMime(img.mime) }); });
      (e.files||[]).forEach(function(f){ all.push({ item: f, name: attachedFileName(f) }); });
    });
    if(all.length){ showToast("画像・ファイルを準備しています…", 60000); }
    return runSeq(all, function(a){
      return imagePlainBytes(a.item).then(function(bytes){
        files.push({ name: a.name, bytes: bytes });
      }, function(){ /* 取得できないものは書き出しから外す */ });
    }).then(function(){ return files; });
  }

  function saveMarkdown(defaultName, md, entries){
    return collectImageFiles(entries).then(function(files){
      return api.saveMarkdown({ defaultName: defaultName, md: md, images: files });
    });
  }

  function exportMarkdown(){
    var opts = (doc.categories||[]).map(function(c){ return {id:c.id, name:c.name}; });
    openMarkdownExportModal(opts);
  }

  function openMarkdownExportModal(catOpts){
    var wrap = document.createElement("div");
    wrap.className = "modal-backdrop";
    var radios = '<label><input type="radio" name="mdcat" value="all" checked> すべてのカテゴリ</label>';
    catOpts.forEach(function(c){
      radios += '<label><input type="radio" name="mdcat" value="'+escapeHtml(c.id)+'"> '+escapeHtml(c.name)+'</label>';
    });
    wrap.innerHTML =
      '<div class="modal">' +
        '<h3>Markdownで書き出す</h3>' +
        '<p class="help">選んだカテゴリの記録を、1つのMarkdownファイルにまとめて書き出します。添付画像は同じ場所のフォルダーに書き出されます。ブログなどへ流用する下書きとしてお使いください。</p>' +
        '<div class="radio-row">'+radios+'</div>' +
        '<div class="modal-actions">' +
          '<button class="btn btn-ghost btn-small" id="mdCancel">キャンセル</button>' +
          '<button class="btn btn-primary btn-small" id="mdOk">書き出す</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(wrap);
    wrap.querySelector("#mdCancel").addEventListener("click", function(){ wrap.remove(); });
    wrap.querySelector("#mdOk").addEventListener("click", function(){
      var picked = wrap.querySelector('input[name="mdcat"]:checked').value;
      var entries = liveEntries.slice().sort(function(a,b){ return a.date.localeCompare(b.date); });
      var label = "すべてのカテゴリ";
      if(picked !== "all"){
        entries = entries.filter(function(e){ return e.category === picked; });
        label = catName(picked);
      }
      wrap.remove();
      var filename = "koukai-nisshi-"+(picked==="all"?"all":picked)+"-"+todayStr()+".md";
      saveMarkdown(filename, buildMarkdown(entries, label), entries).then(function(saved){
        showToast(saved ? "Markdownを書き出しました" : "書き出しを中止しました");
      }).catch(function(err){
        showToast(errorMessage(err, withDetail("書き出しに失敗しました", err)), 6000);
      });
    });
  }

  function exportSingleEntryMd(entry){
    var md = "# "+(entry.title||"（無題）")+"\n\n" +
             "- 日付: "+entry.date+"\n" +
             "- カテゴリ: "+catName(entry.category)+"\n" +
             ((entry.tags && entry.tags.length) ? "- タグ: "+entry.tags.map(function(t){ return "#"+t; }).join(" ")+"\n" : "") + "\n" +
             bodyMarkdown(entry) + "\n";
    var imgs = imageMarkdown(entry);
    if(imgs){ md += "\n" + imgs + "\n"; }
    var attached = fileMarkdown(entry);
    if(attached){ md += "\n" + attached + "\n"; }
    var safeName = (entry.title||"entry").replace(/[\\/:*?"<>|]/g,"_").slice(0,40);
    var filename = entry.date+"-"+safeName+".md";
    saveMarkdown(filename, md, [entry]).then(function(saved){
      showToast(saved ? "書き出しました" : "書き出しを中止しました");
    }).catch(function(err){
      showToast(errorMessage(err, withDetail("書き出しに失敗しました", err)), 6000);
    });
  }

  /* ---------------- print / PDF (A4) ---------------- */
  // The printable page is a standalone HTML document rendered by the main
  // process in a hidden, script-less window. Images are inlined as data:
  // URLs; each entry starts on a new page.
  var PRINT_CSS =
    "@page{ size:A4; margin:16mm 15mm; }" +
    "*{ box-sizing:border-box; }" +
    "body{ margin:0; color:#1B2233; background:#fff; font-family:'Yu Gothic UI','Yu Gothic','Meiryo',sans-serif; font-size:10.5pt; line-height:1.8; }" +
    ".entry{ break-after:page; page-break-after:always; }" +
    ".entry:last-child{ break-after:auto; page-break-after:auto; }" +
    ".meta{ display:flex; gap:12px; font-size:9pt; color:#5B6473; border-bottom:1px solid #D9D3C0; padding-bottom:4px; margin-bottom:10px; }" +
    ".meta .entry-no{ font-family:Georgia,'Yu Mincho',serif; font-weight:700; font-size:11pt; line-height:1; color:#9C7A3C; align-self:center; letter-spacing:.02em; }" +
    ".meta .entry-no-label{ font-size:.75em; margin-right:1px; }" +
    "h1{ font-size:16pt; line-height:1.4; margin:0 0 12px; }" +
    // Text sizes chosen in the body are points here (see textStyleCss).
    // Line spacing (v1.0.92, the owner's choice): 1.6 (was 1.8), and lines broken with Enter are as far
    // apart as lines that wrap: paragraphs and lists have no spacing of their own (a wider gap is an
    // empty line). Only an image placed after text keeps .8em above it (rows below, wrap-group).
    // --lh-ratio is also used for a paragraph of only smaller text (smallTextLineHeight).
    ".body{ --body-pt:1pt; --lh-ratio:1.6; line-height:var(--lh-ratio); }" +
    ".body p{ margin:0; }" +
    ".body h2,.body h3,.body h4{ margin:1.1em 0 .4em; line-height:1.4; }" +
    ".body ul{ padding-left:1.4em; margin:0; }" +
    ".body p + .inline-row,.body ul + .inline-row,.body p + .wrap-group,.body ul + .wrap-group{ margin-top:.8em; }" +
    // Larger text is spaced a little closer for its size (the body's own lines are not affected:
    // a smaller span never makes its line taller than the paragraph's).
    ".body span[style*='font-size']{ line-height:1.4; }" +
    ".images{ margin-top:14px; }" +
    ".images figure{ margin:0 0 12px; break-inside:avoid; page-break-inside:avoid; text-align:center; }" +
    ".images img{ max-width:100%; max-height:125mm; }" +
    ".images figcaption{ font-size:8pt; color:#8B93A0; }";

  PRINT_CSS +=
    ".board{ position:relative; width:100%; margin-top:14px; break-inside:avoid; page-break-inside:avoid; }" +
    ".board-item{ position:absolute; }" +
    ".board-item img{ display:block; width:100%; height:100%; }";

  // Attached files (PDF and others): their names only.
  PRINT_CSS +=
    ".files{ margin-top:12px; break-inside:avoid; page-break-inside:avoid; }" +
    ".file-card{ display:inline-block; border:1px solid #D9D3C0; border-radius:3px; padding:2px 10px; margin:0 6px 6px 0; font-size:9.5pt; }" +
    ".file-size{ color:#8B93A0; font-size:8.5pt; }";

  // Images placed in the text: one row per marker line, never split across pages.
  PRINT_CSS +=
    ".inline-row{ display:flex; justify-content:center; align-items:flex-start; gap:4mm; margin:0 0 .8em; break-inside:avoid; page-break-inside:avoid; }" +
    ".inline-fig{ margin:0; flex:none; }" +
    ".inline-fig.sz-l{ width:100%; }" +
    ".inline-fig.sz-m{ width:62%; }" +
    ".inline-fig.sz-s{ width:36%; }" +
    // Several on one line keep their own size (v1.0.182, as style.css): three 小 fit side by side.
    ".inline-row.multi .inline-fig{ flex:0 1 auto; min-width:0; }" +
    ".inline-row.multi .inline-fig.sz-s{ width:calc((100% - 8mm) / 3); }" +
    ".inline-row.multi .inline-fig.sz-m{ width:calc((100% - 4mm) / 2); }" +
    ".inline-row.multi .inline-fig.sz-l{ width:100%; }" +
    ".inline-fig img,.inline-fig .ph{ display:block; width:100%; height:auto; max-height:240mm; object-fit:contain; margin:0 auto; }" +
    // 左寄せ・右寄せ, and 左回り込み・右回り込み (text after it runs beside the image).
    ".inline-row.al-l{ justify-content:flex-start; }" +
    ".inline-row.al-r{ justify-content:flex-end; }" +
    ".inline-row.fl-l{ float:left; margin:.3em 5mm 3mm 0; }" +
    ".inline-row.fl-r{ float:right; margin:.3em 0 3mm 5mm; }" +
    ".inline-row.float.sz-s{ width:36%; }" +
    ".inline-row.float.sz-m{ width:50%; }" +
    ".inline-row.float.sz-l{ width:62%; }" +
    ".inline-row.float .inline-fig{ flex:1 1 0; width:auto; min-width:0; }" +
    // The text beside it ignores the 3mm below the image (v1.0.91): a line that starts below the
    // image runs the full width. What follows the group still starts 3mm below it (clear uses the margin).
    ".inline-row.float{ shape-outside:inset(0 0 3mm 0) margin-box; }" +
    // Every image row starts below the images before it (a wrapped one included).
    ".inline-row{ clear:both; }" +
    ".wrap-group{ display:flow-root; break-inside:avoid; page-break-inside:avoid; }" +
    ".body::after{ content:''; display:block; clear:both; }";

  // YouTube の動画 (v1.0.171): the picture at 16:9 with a play mark, the address under it. The same rules
  // are put on the app's own page (VIDEO_CSS below), so the screens look like the print.
  var VIDEO_CSS =
    "figure.inline-fig.video-fig .yt-box{ position:relative; aspect-ratio:16 / 9; overflow:hidden; background:#000; border-radius:4px; }" +
    // The web version's PDF (html2canvas) knows neither object-fit nor inline SVG, so the 4:3 picture is cropped by
    // its place (as tall as 4/3 of the box, its black bands outside) and the play mark is an SVG picture.
    "figure.inline-fig.video-fig .yt-box img.yt-thumb{ position:absolute; left:0; top:-16.667%; display:block; width:100%; height:133.334%; max-height:none; margin:0; }" +
    // A saved 1280×720 picture (v1.0.172) is 16:9 already.
    "figure.inline-fig.video-fig .yt-box img.yt-thumb.wide{ top:0; height:100%; }" +
    "figure.inline-fig.video-fig .yt-box iframe{ display:block; width:100%; height:100%; border:0; margin:0; }" +
    // Centred: 15% of the width, 48/70 as tall.
    "figure.inline-fig.video-fig .yt-box img.yt-play{ position:absolute; left:42.5%; top:50%; display:block; width:15%; height:auto; max-height:none; margin:-5.14% 0 0 0; }" +
    "figure.inline-fig.video-fig .yt-cap{ margin-top:.3em; font-size:.8em; line-height:1.4; color:#5B6473; text-align:center; overflow-wrap:anywhere; }" +
    "figure.inline-fig.video-fig .yt-mark{ color:#C4302B; font-weight:700; margin-right:.3em; }" +
    // A PDF in the body (v1.0.205): page 1 on a white sheet with a thin frame, its name under it.
    "figure.inline-fig.video-fig .pdf-box{ position:relative; background:#fff; border:1px solid #CFC8B4; border-radius:2px; overflow:hidden; box-shadow:0 1px 3px rgba(0,0,0,.12); }" +
    "figure.inline-fig.video-fig .pdf-box img.pdf-thumb{ display:block; width:100%; height:auto; max-height:none; margin:0; }" +
    // Not loaded yet: the page's own shape when it is known (width / height on the img), else upright A4.
    "figure.inline-fig.video-fig .pdf-box img.pdf-thumb:not([src]):not([width]){ aspect-ratio:210 / 297; }" +
    "figure.inline-fig.video-fig .pdf-missing{ aspect-ratio:210 / 297; display:flex; align-items:center; justify-content:center; font-size:2em; color:#9AA0A6; }" +
    "figure.inline-fig.video-fig .pdf-cap{ margin-top:.3em; font-size:.8em; line-height:1.4; color:#5B6473; text-align:center; overflow-wrap:anywhere; }" +
    "figure.inline-fig.video-fig .pdf-pages{ color:#8A909A; }";
  // 区切り線 (v1.0.194, ruleIn): one line high (the body's line spacing), the line in its middle across the column.
  // The kind, thickness and colour are on the hr itself (ruleInnerHtml). Also on the app's own page, as VIDEO_CSS.
  VIDEO_CSS +=
    ".body-rule{ clear:both; display:flex; align-items:center; height:calc(var(--lh-ratio, 1.6) * 1em); margin:0; break-inside:avoid; page-break-inside:avoid; }" +
    ".body-rule hr{ flex:1 1 auto; height:0; margin:0; padding:0; border:0; border-top-style:solid; }";
  PRINT_CSS += VIDEO_CSS;
  (function(){
    var st = document.createElement("style");
    st.textContent = VIDEO_CSS;
    document.head.appendChild(st);
  })();

  // The saved layout covers every attached image; once some are placed in the
  // text, the board shows only the rest and drops the empty space they leave below.
  function boardLayoutFor(images, layout){
    var l = BoardLayout.normalize(images, layout);
    var ids = images.map(function(img){ return img.id; });
    var dropped = Object.keys(layout.items || {}).some(function(id){ return ids.indexOf(id) < 0; });
    if(dropped){ l.h = Math.min(l.h, BoardLayout.bottom(images, l) + 0.02); }
    return l;
  }

  // Absolutely positioned images inside a box whose height is layout.h × its width.
  function boardMarkup(images, layout, inner){
    var byId = {};
    images.forEach(function(img){ byId[img.id] = img; });
    return '<div class="board" style="padding-top:'+(layout.h * 100).toFixed(4)+'%">' +
      layout.order.filter(function(id){ return byId[id]; }).map(function(id){
        var it = layout.items[id];
        var hPct = it.w * BoardLayout.ratio(byId[id]) / layout.h * 100;
        return '<div class="board-item" style="left:'+(it.x*100).toFixed(4)+'%;top:'+(it.y/layout.h*100).toFixed(4)+'%;' +
               'width:'+(it.w*100).toFixed(4)+'%;height:'+hPct.toFixed(4)+'%">' + inner(byId[id]) + '</div>';
      }).join("") + '</div>';
  }

  // Where (as a fraction of the page's content width) the A4 page holding the
  // end of this entry's text runs out — the board editor draws its guide there.
  var A4_CONTENT_W_MM = 210 - 30, A4_CONTENT_H_MM = 297 - 32;
  // PRINT_CSS limited to elements inside `.<scope>`, so the printed look can be reproduced inside the app.
  function scopedPrintCss(scope){
    return PRINT_CSS.replace(/@page\{[^}]*\}/, "").replace(/(^|\})\s*([^{}]+)\{/g, function(m, brace, sel){
      return brace + sel.split(",").map(function(s){
        s = s.trim();
        if(s === "body"){ return "." + scope; }
        if(s === "*"){ return "." + scope + ",." + scope + " *"; }
        return "." + scope + " " + s;
      }).join(",") + "{";
    });
  }
  function a4GuideFor(e){
    var box = document.createElement("div");
    box.className = "pmeasure";
    box.style.cssText = "position:absolute;left:-20000px;top:0;visibility:hidden;width:" + A4_CONTENT_W_MM + "mm;";
    box.innerHTML = '<style>' + scopedPrintCss("pmeasure") + '</style><section class="entry">' + printSectionHead(e, function(img){
      // Same box as the printed <img>: full width of its slot at the image's aspect ratio.
      return '<div class="ph" style="aspect-ratio:'+(img.width || 4)+' / '+(img.height || 3)+'"></div>';
    }, null, laterPdfInfo(e)) + '</section>';   // a PDF in the body is measured at its printed size, not as a line of text (v1.0.214)
    document.body.appendChild(box);
    var mm = pagedHeightMm(box.querySelector(".entry"));
    box.remove();
    var used = mm % A4_CONTENT_H_MM;
    var left = A4_CONTENT_H_MM - used - 4 - 6;        // 4mm board top margin + 6mm safety margin
    if(left < 30){ left = A4_CONTENT_H_MM - 4; }      // not enough room: the board starts on the next page
    return left / A4_CONTENT_W_MM;
  }

  // Height of the entry once printed, counting the space left at the bottom of a
  // page when an image row does not fit and moves to the next page.
  function pagedHeightMm(section){
    var pxPerMm = 96 / 25.4, pageH = A4_CONTENT_H_MM * pxPerMm;
    var top0 = section.getBoundingClientRect().top;
    var shift = 0;
    Array.prototype.forEach.call(section.querySelectorAll(".inline-row"), function(row){
      var r = row.getBoundingClientRect();
      var start = r.top - top0 + shift, h = r.height;
      if(h > pageH) return;                                  // taller than a page: it cannot move anywhere better
      var pageEnd = (Math.floor(start / pageH) + 1) * pageH;
      if(start + h > pageEnd + 0.5){ shift += pageEnd - start; }
    });
    return (section.getBoundingClientRect().height + shift) / pxPerMm;
  }

  function imageDataUrl(img){
    return imagePlainBytes(img).then(function(bytes){
      return "data:" + (img.mime || "image/jpeg") + ";base64," + bytesToB64(bytes);
    }, function(){ return null; });
  }

  // figure(img) renders an image placed in the text; it returns "" for images that could not be loaded.
  // videoPic: the saved pictures of videos (v1.0.172, see mdToHtml).
  function printSectionHead(e, figure, videoPic, pdfInfo){
    return printHeadHtml(e) + '<div class="body">'+bodyOrNothing(mdToHtml(e.body, e.images, figure, videoPic, pdfInfo), e)+'</div>';
  }
  // The date line and the title, as printed (the editor's sheet shows them too, v1.0.90).
  function printHeadHtml(e){
    return '<div class="meta">'+entryNoHtml(e)+'<span>'+escapeHtml(fmtDate(e.date))+'</span>' +
             '<span>'+escapeHtml(writtenLabel(e))+(updatedLabel(e) ? '・'+escapeHtml(updatedLabel(e)) : '')+'</span>' +
             '<span>'+escapeHtml(catName(e.category))+'</span>' +
             ((e.tags && e.tags.length) ? '<span>'+e.tags.map(function(t){ return "#" + escapeHtml(t); }).join(" ")+'</span>' : '') +
           '</div>' +
           '<h1>'+escapeHtml(e.title || "（無題）")+'</h1>';
  }

  // One <section class="entry"> per record, exactly as printed.
  // urlFor(img) resolves to the image's URL, or null when it cannot be loaded.
  function buildPrintSections(entries, urlFor){
    var sections = [];
    return runSeq(entries, function(e){
      var urls = {};
      var images = e.images || [];
      return runSeq(images, function(img){
        return urlFor(img).then(function(u){ if(u){ urls[img.id] = u; } });
      }).then(function(){
        var shown = imagesAfterBody(e).filter(function(img){ return urls[img.id]; });
        var imgs = "";
        if(shown.length && e.layout){
          imgs = boardMarkup(shown, boardLayoutFor(shown, e.layout), function(img){
            return '<img src="'+urls[img.id]+'">';
          });
        } else if(shown.length){
          imgs = '<div class="images">' + shown.map(function(img){
            return '<figure><img src="'+urls[img.id]+'"><figcaption>'+escapeHtml(img.name)+'</figcaption></figure>';
          }).join("") + '</div>';
        }
        sections.push('<section class="entry">' + printSectionHead(e, function(img){
          return urls[img.id] ? '<img src="'+urls[img.id]+'">' : '';
        }, function(ytId){
          var t = videoThumbFor(images, ytId);
          return t && urls[t.id] ? { src: urls[t.id], wide: isWideThumb(t), length: videoLength(t) } : null;
        }, function(ref){
          var f = fileByRef(e.files, ref);
          if(!f) return null;
          var t = pdfThumbFor(images, ref);
          return { name: f.name, pages: t && t.pages, pic: t && urls[t.id] ? { src: urls[t.id] } : null, width: t && t.width, height: t && t.height };
        }) + imgs + fileCardsHtml(filesAfterBody(e.files, e.body)) + '</section>');
      });
    }).then(function(){ return sections; });
  }

  function buildPrintHtml(entries){
    return buildPrintSections(entries, imageDataUrl).then(function(sections){
      return '<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>航海日誌</title>' +
             '<style>'+PRINT_CSS+'</style></head><body>' + sections.join("") + '</body></html>';
    });
  }

  /* ---------------- paper view (the printed A4 look, inside the app) ---------------- */
  var MM_PX = 96 / 25.4;
  var PAPER_W_PX = 210 * MM_PX;

  // The sheet is enlarged up to PAPER_MAX_SCALE on a wide screen (v1.0.78), so it is easy to read, and shrunk
  // to fit a narrower one, but not below PAPER_MIN_SCALE (v1.0.90): with the side panel open the sheet
  // may then stick out a little and scroll sideways. Where even that does not fit (a phone, a narrow
  // window), records are read and written in the screen-sized layout instead (usePaperLayout).
  // v1.0.154: the owner found the margins beside the sheet too wide, so the page column (.content-inner.page-wide
  // in style.css) and the largest fitted sheet went from 1080px (×1.36) to PAPER_MAX_W. Keep the two the same.
  var PAPER_MAX_W = 1360;
  var PAPER_MAX_SCALE = PAPER_MAX_W / PAPER_W_PX, PAPER_MIN_SCALE = 0.8;
  // v1.0.190: on iPhone / iPad (web) the sheet is never enlarged past its printed size. With the reading
  // screen full width (body.full-view) an iPad's sheet would grow to x1.4; the owner wanted smaller,
  // easier text there. 拡大・縮小 still enlarges it.
  if(api.isWeb){ PAPER_MAX_SCALE = 1; }
  // 拡大・縮小ボタン (v1.0.142): the owner's own multiplier on top of the fitted size, kept per PC.
  // Above 1 the sheet also uses the margins beside the page column (spreadPaper), and a sheet wider than
  // that scrolls sideways (.paper-view). The column itself keeps its width (v1.0.144): when it widened
  // (page-zoomed), the buttons above the sheet jumped sideways, so they could not be pressed again and again.
  var PAPER_USER_KEY = "koukai-paper-zoom", PAPER_USER_MIN = 0.6, PAPER_USER_MAX = 2, PAPER_USER_STEP = 0.1;
  var paperUser = 1;
  // v1.0.192: iPhone has no zoom buttons, so a size chosen there before stays out of use
  try{ var pu = parseFloat(localStorage.getItem(PAPER_USER_KEY)); if(!IS_PHONE && pu >= PAPER_USER_MIN && pu <= PAPER_USER_MAX){ paperUser = pu; } }catch(e){}
  function zoomBarHtml(){
    return '<span class="zoom-bar">' +
             '<button type="button" class="btn btn-ghost btn-small zoom-btn" data-z="out" title="紙面を小さくします">－ 縮小</button>' +
             '<button type="button" class="btn btn-ghost btn-small zoom-btn zoom-pct" data-z="reset" title="ちょうどよい大きさに戻します">' + Math.round(paperUser * 100) + '%</button>' +
             '<button type="button" class="btn btn-ghost btn-small zoom-btn" data-z="in" title="紙面を大きくします。画面の余白も使います">＋ 拡大</button>' +
           '</span>';
  }
  document.addEventListener("click", function(ev){
    var b = ev.target.closest ? ev.target.closest(".zoom-btn") : null;
    if(!b){ return; }
    var z = b.getAttribute("data-z");
    var next = z === "reset" ? 1 : Math.round((paperUser + (z === "in" ? PAPER_USER_STEP : -PAPER_USER_STEP)) * 10) / 10;
    paperUser = Math.max(PAPER_USER_MIN, Math.min(PAPER_USER_MAX, next));
    try{ localStorage.setItem(PAPER_USER_KEY, String(paperUser)); }catch(e){}
    Array.prototype.forEach.call(document.querySelectorAll(".zoom-pct"), function(p){ p.textContent = Math.round(paperUser * 100) + "%"; });
    // v1.0.217: the middle of what is seen sideways stays in the middle (it went to the sheet's left edge),
    // so a sheet that first gets wider than the window opens at its centre
    Array.prototype.forEach.call(document.querySelectorAll(".paper-fit"), function(fit){
      var view = fit.parentNode;
      var mid = view.scrollWidth > view.clientWidth + 1 ? (view.scrollLeft + view.clientWidth / 2) / view.scrollWidth : 0.5;
      fitPaper(fit);
      if(view.scrollWidth > view.clientWidth + 1){ view.scrollLeft = mid * view.scrollWidth - view.clientWidth / 2; }
    });
  });
  function usePaperLayout(){
    var w = viewRoot.clientWidth || window.innerWidth;
    return w >= PAPER_W_PX * PAPER_MIN_SCALE;
  }
  // CSS zoom, not a transform (v1.0.90): the editor is written on the sheet, and with zoom the page
  // around it, the caret and the scrolling follow its real size. Only the look on screen: the printed
  // page is the same. The reading screen and the editor are fitted the same way, so they match.
  function fitPaper(fit){
    var sheet = fit.firstChild, view = fit.parentNode;
    view.style.marginLeft = view.style.marginRight = view.style.width = "";   // measure the column, not the spread
    var band = stickyBandOf(view);
    if(band){ band.style.marginLeft = band.style.marginRight = band.style.paddingLeft = band.style.paddingRight = ""; }
    var avail = view.clientWidth;
    if(!avail){ return; }   // hidden (a site is shown): keep the last size until it is seen again
    var s = Math.max(PAPER_MIN_SCALE, Math.min(PAPER_MAX_SCALE, avail / PAPER_W_PX)) * paperUser;
    sheet.style.zoom = String(s);
    fit.style.width = (PAPER_W_PX * s) + "px";
    if(paperUser > 1){ spreadPaper(view); }
    syncHBar(view);
  }
  // v1.0.217: a sheet wider than its box scrolls sideways, but that scroll bar is at the sheet's bottom, out of sight
  // under a long record, so the owner could not move a zoomed sheet sideways. A second bar (.paper-hbar) right after
  // the sheet sticks to the bottom of the window and scrolls it; the sheet's own bar is hidden meanwhile.
  function syncHBar(view){
    var bar = view.nextElementSibling;
    if(!bar || !bar.classList.contains("paper-hbar")){
      bar = document.createElement("div");
      bar.className = "paper-hbar";
      bar.innerHTML = "<div></div>";
      view.parentNode.insertBefore(bar, view.nextSibling);
      // each follows the other; the 1px leeway stops them nudging each other over fractions of a pixel
      bar.addEventListener("scroll", function(){ if(Math.abs(view.scrollLeft - bar.scrollLeft) >= 1){ view.scrollLeft = bar.scrollLeft; } });
      view.addEventListener("scroll", function(){ if(Math.abs(bar.scrollLeft - view.scrollLeft) >= 1){ bar.scrollLeft = view.scrollLeft; } });
    }
    var over = view.scrollWidth > view.clientWidth + 1;
    view.classList.toggle("hbar-on", over);
    view.classList.toggle("can-pan", over);
    bar.classList.toggle("on", over);
    if(!over){ return; }
    bar.style.width = view.style.width;
    bar.style.marginLeft = view.style.marginLeft;
    bar.style.marginRight = view.style.marginRight;
    bar.firstChild.style.width = view.scrollWidth + "px";
    bar.scrollLeft = view.scrollLeft;
  }
  // Grabbing a zoomed sheet moves it: on the reading screen with the left button (as a hand), in the editor with the
  // wheel button only, because the left button there selects text. Sideways moves the sheet, up and down the page.
  // A grab that moved swallows the click that follows, so it does not open an image.
  (function(){
    var pan = null;
    document.addEventListener("pointerdown", function(e){
      if(e.pointerType !== "mouse" || (e.button !== 0 && e.button !== 1)){ return; }
      var view = e.target.closest ? e.target.closest(".paper-view.can-pan") : null;
      if(!view){ return; }
      var editing = view.classList.contains("ed-paper");
      if(e.button === 0 && (editing || e.target.closest("a, button, input, textarea, select, [contenteditable]"))){ return; }
      // no auto-scroll circle (wheel button), no text selection or image drag (left button); a click still follows
      e.preventDefault();
      pan = { view: view, x: e.clientX, y: e.clientY, left: view.scrollLeft, top: window.scrollY, moved: false, id: e.pointerId };
    }, true);
    document.addEventListener("pointermove", function(e){
      if(!pan || e.pointerId !== pan.id){ return; }
      // v1.0.220: the button let go where no pointerup came (outside the window): the grab ends here, or the
      // sheet kept following the bare mouse
      if(!e.buttons){ end(); return; }
      var dx = e.clientX - pan.x, dy = e.clientY - pan.y;
      if(!pan.moved){
        if(Math.abs(dx) < 4 && Math.abs(dy) < 4){ return; }
        pan.moved = true;
        document.body.classList.add("paper-panning");
      }
      e.preventDefault();
      pan.view.scrollLeft = pan.left - dx;
      window.scrollTo(window.scrollX, pan.top - dy);
    }, true);
    function end(e){
      if(!pan || (e && e.pointerId !== pan.id)){ return; }
      var moved = pan.moved;
      pan = null;
      document.body.classList.remove("paper-panning");
      if(moved){
        var swallow = function(ev){ ev.preventDefault(); ev.stopPropagation(); };
        window.addEventListener("click", swallow, true);
        window.addEventListener("auxclick", swallow, true);
        setTimeout(function(){ window.removeEventListener("click", swallow, true); window.removeEventListener("auxclick", swallow, true); }, 0);
      }
    }
    document.addEventListener("pointerup", end, true);
    document.addEventListener("pointercancel", end, true);
    document.addEventListener("dragstart", function(e){
      if(e.target.closest && e.target.closest(".paper-view.can-pan:not(.ed-paper)")){ e.preventDefault(); }
    }, true);
  })();
  // Widens the sheet's box into the margins on both sides of the page column, up to the padding of the
  // main area. Not when the side panel is open: the sheet then scrolls sideways in its own half.
  function spreadPaper(view){
    var main = view.closest ? view.closest("main.content") : null;
    if(!main || view.closest(".viewer-layout.split")){ return; }
    var cs = getComputedStyle(main), m = main.getBoundingClientRect(), v = view.getBoundingClientRect();
    var mLeft = m.left + main.clientLeft + parseFloat(cs.paddingLeft);
    var mRight = m.left + main.clientLeft + main.clientWidth - parseFloat(cs.paddingRight);
    var left = Math.max(0, Math.floor(v.left - mLeft)), right = Math.max(0, Math.floor(mRight - v.right));
    if(!left && !right){ return; }
    view.style.width = "auto";
    view.style.marginLeft = -left + "px";
    view.style.marginRight = -right + "px";
    // The band that stays under the top bar (title, date, tools) widens by the same amount, its contents
    // kept in place by the same padding (v1.0.145). Otherwise the sheet scrolling up showed on both
    // sides of it, so the band looked sunk into the page.
    var band = stickyBandOf(view);
    if(band){
      band.style.marginLeft = -left + "px"; band.style.paddingLeft = left + "px";
      band.style.marginRight = -right + "px"; band.style.paddingRight = right + "px";
    }
  }
  function stickyBandOf(view){
    var col = view.closest ? view.closest(".viewer-main") : null;
    return col ? col.querySelector(":scope > .view-sticky, :scope > .editor-wrap > .editor-sticky") : null;
  }
  window.addEventListener("resize", function(){
    Array.prototype.forEach.call(document.querySelectorAll(".paper-fit"), fitPaper);
    // The reading screen changes between the sheet and the screen-sized layout as the window gets wide or narrow.
    // (The editor keeps the one it opened with, so nothing being written is lost.)
    if(currentView === "view" && viewerPaper !== null && viewerPaper !== usePaperLayout()){ renderMain(); }
  });

  // Draws where the printed pages end. Rows of images and the board are never
  // split, so when one does not fit it starts the next page (as in print);
  // text breaks between lines.
  function markPageBreaks(section){
    var breaks = pageBreaks(section);
    breaks.ys.forEach(function(y, i){
      var el = document.createElement("div");
      el.className = "paper-break";
      el.style.top = y + "px";
      el.innerHTML = '<span>ここから ' + (i + 2) + ' ページ目</span>';
      section.appendChild(el);
    });
    return breaks.pages;
  }

  // Where each printed page after the first begins, in px from the top of the
  // section as laid out on screen (unscaled): { ys:[…], pages:n }.
  function pageBreaks(section){
    var pageH = A4_CONTENT_H_MM * MM_PX;
    var top0 = section.getBoundingClientRect().top;
    // The sheet may be zoomed (CSS zoom, v1.0.90): boxes on screen are zoomed, line heights are not.
    var k = (section.offsetWidth && section.getBoundingClientRect().width / section.offsetWidth) || 1;
    var blocks = section.querySelectorAll(".meta, h1, .body p, .body h2, .body h3, .body h4, .body li, .body .inline-row, .body .wrap-group, .board, .images figure, .files");
    var shift = 0, next = pageH;
    var ys = [];
    function line(y){
      ys.push(y);
      next += pageH;
    }
    Array.prototype.forEach.call(blocks, function(b){
      var r = b.getBoundingClientRect();
      var top = (r.top - top0) / k, h = r.height / k;
      // In the editor the last line of a wrapped image's group also holds the block that clears the
      // image (data-group-end, style.css), so it reaches the image's bottom: only its lines count, as
      // in 紙面 (where the group's div.wrap-group holds the image instead).
      if(b.tagName === "P" && b.hasAttribute("data-group-end")){
        var rg = document.createRange();
        rg.selectNodeContents(b);
        var rr = rg.getBoundingClientRect(), lh0 = parseFloat(getComputedStyle(b).lineHeight) || 20;
        if(rr.height){ h = Math.min(h, Math.ceil((rr.bottom - r.top) / k / lh0 - 0.01) * lh0); }
      }
      // A wrapped image and the text beside it (v1.0.103): print keeps the group (.wrap-group,
      // break-inside:avoid) on one page when it fits on one, so it moves whole to the next page,
      // not the text on this one and only the image on the next. In the paper view the group is a
      // div; in the editor it runs from the floating row to the line marked data-group-end.
      var grp = false;
      if(b.classList.contains("wrap-group")){ grp = h <= pageH; }
      else if(b.classList.contains("float") && b.parentNode && !b.parentNode.classList.contains("wrap-group")){
        var ge = b.nextElementSibling;
        while(ge && !ge.hasAttribute("data-group-end")){ ge = ge.nextElementSibling; }
        if(ge){
          var gh = (ge.getBoundingClientRect().bottom - r.top) / k;
          if(gh > h && gh <= pageH){ h = gh; }
          grp = h <= pageH;
        }
      }
      while(top + shift >= next){ line(Math.min(top, next - shift)); }
      var keep = grp || (!/^(P|H[1-4]|LI)$/.test(b.tagName) && h <= pageH);
      if(keep){
        if(top + shift + h > next + 0.5){
          shift += next - (top + shift);
          line(top);
        }
        return;
      }
      var lh = parseFloat(getComputedStyle(b).lineHeight) || 20;
      while(top + shift + h > next + 0.5){
        var lines = Math.floor((next - (top + shift)) / lh);
        var y = top + Math.max(0, lines) * lh;
        shift += next - (y + shift);
        line(y);
      }
    });
    var total = section.getBoundingClientRect().height / k + shift;
    return { ys: ys, pages: Math.max(ys.length + 1, Math.ceil((total - 0.5) / pageH)) };
  }

  /* ---------------- PDF made in the page (web version) ---------------- */
  // iPhone Safari ignores print() from a page (above all when opened from the
  // home screen), so the web version builds the PDF itself: each record is
  // laid out exactly like the paper view, cut at the same page breaks,
  // photographed page by page with html2canvas and packed into a PDF.
  var PDF_SCALE = 2;
  function loadHtml2canvas(){
    if(window.html2canvas){ return Promise.resolve(); }
    return new Promise(function(resolve, reject){
      var s = document.createElement("script");
      s.src = "html2canvas.min.js";
      s.onload = resolve;
      s.onerror = function(){ reject({ code:"load_failed", message:"PDFを作る部品を読み込めませんでした" }); };
      document.head.appendChild(s);
    });
  }
  function canvasJpeg(canvas){
    return canvasToBlob(canvas, "image/jpeg", 0.86).then(function(b){ return b.arrayBuffer(); }).then(function(ab){
      return { bytes: new Uint8Array(ab), w: canvas.width, h: canvas.height };
    });
  }

  // entries → [{ bytes, w, h }] (one JPEG per A4 page). progress(done) is called per page.
  function renderPdfPages(entries, progress){
    var pages = [];
    var pageH = A4_CONTENT_H_MM * MM_PX;
    return loadHtml2canvas().then(function(){
      return runSeq(entries, function(e){
        var host = document.createElement("div");
        host.style.cssText = "position:absolute;left:0;top:0;z-index:-1;width:" + A4_CONTENT_W_MM + "mm;background:#fff;";
        return buildPrintSections([e], function(img){
          return imageUrl(img).catch(function(){ return null; });
        }).then(function(sections){
          host.innerHTML = '<style>' + scopedPrintCss("paper") + '</style><div class="paper">' + sections.join("") + '</div>';
          document.body.appendChild(host);
          var imgs = host.querySelectorAll("img");
          return Promise.all(Array.prototype.map.call(imgs, function(im){
            return im.complete ? null : new Promise(function(res){ im.onload = im.onerror = res; });
          }));
        }).then(function(){
          var section = host.querySelector(".entry");
          var total = section.getBoundingClientRect().height;
          var starts = [0].concat(pageBreaks(section).ys);
          var slices = [];
          starts.forEach(function(s, i){
            var end = i + 1 < starts.length ? starts[i + 1] : total;
            // A stretch longer than a page (nothing to keep together) is cut at page height.
            for(var y = s; y < end - 0.5; y += pageH){ slices.push([y, Math.min(end, y + pageH)]); }
          });
          if(!slices.length){ slices.push([0, Math.max(1, total)]); }
          var r = section.getBoundingClientRect();
          return runSeq(slices, function(sl){
            return window.html2canvas(section, {
              // useCORS: a YouTube video's picture comes from i.ytimg.com, which allows it (v1.0.171).
              scale: PDF_SCALE, backgroundColor: "#ffffff", logging: false, useCORS: true,
              x: r.left + window.scrollX, y: r.top + window.scrollY + sl[0],
              width: r.width, height: Math.max(1, sl[1] - sl[0])
            }).then(function(shot){
              var page = document.createElement("canvas");
              page.width = Math.round(210 * MM_PX * PDF_SCALE);
              page.height = Math.round(297 * MM_PX * PDF_SCALE);
              var ctx = page.getContext("2d");
              ctx.fillStyle = "#ffffff";
              ctx.fillRect(0, 0, page.width, page.height);
              ctx.drawImage(shot, Math.round(15 * MM_PX * PDF_SCALE), Math.round(16 * MM_PX * PDF_SCALE));
              return canvasJpeg(page);
            }).then(function(jpg){
              pages.push(jpg);
              if(progress){ progress(pages.length); }
            });
          });
        }).then(function(){ host.remove(); }, function(err){ host.remove(); throw err; });
      });
    }).then(function(){ return pages; });
  }

  // A minimal PDF: one full-page JPEG per A4 page.
  function makePdf(pages){
    var enc = new TextEncoder();
    var chunks = [], offsets = [], size = 0;
    function put(x){ var b = typeof x === "string" ? enc.encode(x) : x; chunks.push(b); size += b.length; }
    function obj(n, body){ offsets[n] = size; put(n + " 0 obj\n"); body(); put("\nendobj\n"); }
    var W = 595.28, H = 841.89;
    var n = pages.length;
    put("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
    obj(1, function(){ put("<< /Type /Catalog /Pages 2 0 R >>"); });
    var kids = [];
    for(var i = 0; i < n; i++){ kids.push((3 + i * 3) + " 0 R"); }
    obj(2, function(){ put("<< /Type /Pages /Count " + n + " /Kids [" + kids.join(" ") + "] >>"); });
    pages.forEach(function(p, i){
      var pageNo = 3 + i * 3, contentNo = pageNo + 1, imgNo = pageNo + 2;
      obj(pageNo, function(){
        put("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 " + W + " " + H + "] " +
            "/Resources << /XObject << /Im" + i + " " + imgNo + " 0 R >> >> /Contents " + contentNo + " 0 R >>");
      });
      var content = "q " + W + " 0 0 " + H + " 0 0 cm /Im" + i + " Do Q";
      obj(contentNo, function(){ put("<< /Length " + content.length + " >>\nstream\n" + content + "\nendstream"); });
      obj(imgNo, function(){
        put("<< /Type /XObject /Subtype /Image /Width " + p.w + " /Height " + p.h +
            " /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length " + p.bytes.length + " >>\nstream\n");
        put(p.bytes);
        put("\nendstream");
      });
    });
    var count = 3 + n * 3;
    var xref = size;
    put("xref\n0 " + count + "\n0000000000 65535 f \n");
    for(var k = 1; k < count; k++){ put(String(offsets[k]).padStart(10, "0") + " 00000 n \n"); }
    put("trailer\n<< /Size " + count + " /Root 1 0 R >>\nstartxref\n" + xref + "\n%%EOF\n");
    var out = new Uint8Array(size), at = 0;
    chunks.forEach(function(c){ out.set(c, at); at += c.length; });
    return out;
  }

  // Web version of 印刷・PDF: builds the PDF, then offers the iPhone share sheet
  // (which has "プリント" and "ファイルに保存"), saving, or viewing it.
  function runWebPdf(entries, pdfName){
    var wrap = document.createElement("div");
    wrap.className = "modal-backdrop";
    wrap.innerHTML = '<div class="modal"><h3>PDFを作っています</h3><p class="help" id="pdfProgress">準備しています…</p></div>';
    document.body.appendChild(wrap);
    var name = (pdfName || "航海日誌.pdf").replace(/\.pdf$/i, "") + ".pdf";
    return renderPdfPages(entries, function(done){
      var el = wrap.querySelector("#pdfProgress");
      if(el){ el.textContent = done + " ページ目まで作りました…"; }
    }).then(function(pages){
      var bytes = makePdf(pages);
      var file = new File([bytes], name, { type: "application/pdf" });
      var canShare = !!(navigator.canShare && navigator.canShare({ files: [file] }));
      wrap.innerHTML =
        '<div class="modal">' +
          '<h3>PDFができました</h3>' +
          '<p class="help">A4で ' + pages.length + ' ページです。' +
            (canShare ? '「共有・プリント」から、プリントや「"ファイル"に保存」ができます。' : '「保存」で端末に保存できます。') + '</p>' +
          '<div class="modal-actions quit-actions">' +
            '<button class="btn btn-ghost btn-small" id="pdfClose">閉じる</button>' +
            '<button class="btn btn-ghost btn-small" id="pdfView">見る</button>' +
            '<a class="btn btn-ghost btn-small" id="pdfSave">保存</a>' +
            (canShare ? '<button class="btn btn-primary btn-small" id="pdfShare">共有・プリント</button>' : '') +
          '</div>' +
        '</div>';
      var url = URL.createObjectURL(file);
      var save = wrap.querySelector("#pdfSave");
      save.href = url;
      save.download = name;
      function close(){ wrap.remove(); setTimeout(function(){ URL.revokeObjectURL(url); }, 60000); }
      wrap.querySelector("#pdfClose").addEventListener("click", close);
      wrap.querySelector("#pdfView").addEventListener("click", function(){
        api.openFile(name, "application/pdf", Promise.resolve(bytes)).catch(noop);
      });
      if(canShare){
        wrap.querySelector("#pdfShare").addEventListener("click", function(){
          navigator.share({ files: [file], title: name }).catch(noop);
        });
      }
    }).catch(function(err){
      wrap.remove();
      showToast(withDetail("PDFを作れませんでした", err), 8000);
    });
  }

  // Renders the entry into `host` as it will be printed: an A4 sheet scaled to fit.
  function renderPaper(host, entry){
    host.innerHTML = '<p class="paper-loading">紙面を組んでいます…</p>';
    host._imgByUrl = {};   // which attached image each picture on the sheet is (for ✎ 書き込み)
    return buildPrintSections([entry], function(img){
      return imageUrl(img).then(function(u){ host._imgByUrl[u] = img; return u; }, function(){ return null; });
    }).then(function(sections){
      if(!host.isConnected){ return; }
      host.innerHTML = '<style>' + scopedPrintCss("paper") + '</style>' +
        '<div class="paper-fit"><div class="paper-sheet"><div class="paper">' + sections.join("") + '</div></div></div>' +
        '<p class="paper-note" id="paperNote"></p>';
      var imgs = host.querySelectorAll(".paper img");
      return Promise.all(Array.prototype.map.call(imgs, function(im){
        return im.complete ? null : new Promise(function(res){ im.onload = im.onerror = res; });
      })).then(function(){
        if(!host.isConnected){ return; }
        // Zoomed first, then measured, as the editor's sheet is (v1.0.92): a line mixing text sizes
        // can be a pixel or two taller at another zoom, which moved the lines apart.
        fitPaper(host.querySelector(".paper-fit"));
        var pages = markPageBreaks(host.querySelector(".paper .entry"));
        host.querySelector("#paperNote").textContent = "A4で " + pages + " ページ（点線は印刷したときのページの区切りの目安）";
      });
    });
  }

  // entries: the records to print (already in print order).
  function runPrint(mode, entries, pdfName){
    if(api.isWeb){ return runWebPdf(entries, pdfName); }
    showToast("印刷の準備をしています…", 60000);
    return buildPrintHtml(entries).then(function(html){
      return mode === "pdf" ? api.savePdf({ html: html, defaultName: pdfName }) : api.printHtml(html);
    }).then(function(done){
      if(mode === "pdf"){ showToast(done ? "PDFを保存しました" : "PDFの保存を中止しました"); }
      else { showToast(done ? "印刷しました" : "印刷を中止しました"); }
    }).catch(function(err){
      showToast(errorMessage(err, withDetail(mode === "pdf" ? "PDFの保存に失敗しました" : "印刷に失敗しました", err)), 6000);
    });
  }

  function safeFileName(s){ return String(s || "").replace(/[\\/:*?"<>|]/g, "_").slice(0, 40); }

  function openPrintOneModal(entry){
    var wrap = document.createElement("div");
    wrap.className = "modal-backdrop";
    wrap.innerHTML =
      '<div class="modal">' +
        '<h3>印刷・PDF</h3>' +
        '<p class="help">「'+escapeHtml(entry.title || "（無題）")+'」をA4用紙1枚ずつの形で印刷します。PDFとして保存することもできます。</p>' +
        '<div class="modal-actions">' +
          '<button class="btn btn-ghost btn-small" id="prCancel">キャンセル</button>' +
          '<button class="btn btn-ghost btn-small" id="prPdf">PDFで保存</button>' +
          '<button class="btn btn-primary btn-small" id="prPrint">印刷する</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(wrap);
    var name = entry.date + "-" + safeFileName(entry.title || "entry") + ".pdf";
    wrap.querySelector("#prCancel").addEventListener("click", function(){ wrap.remove(); });
    wrap.querySelector("#prPdf").addEventListener("click", function(){ wrap.remove(); runPrint("pdf", [entry], name); });
    wrap.querySelector("#prPrint").addEventListener("click", function(){ wrap.remove(); runPrint("print", [entry], name); });
  }

  function openPrintManyModal(){
    var today = todayStr();
    var monthStart = today.slice(0, 8) + "01";
    var wrap = document.createElement("div");
    wrap.className = "modal-backdrop";
    var catOptions = '<option value="all">すべてのカテゴリ</option>' + (doc.categories || []).map(function(c){
      return '<option value="'+escapeHtml(c.id)+'"'+(currentCategory === c.id ? " selected" : "")+'>'+escapeHtml(c.name)+'</option>';
    }).join("");
    wrap.innerHTML =
      '<div class="modal">' +
        '<h3>まとめて印刷・PDF</h3>' +
        '<p class="help">選んだ期間の記録を、日付の古い順に1件ずつ新しいページから印刷します。</p>' +
        '<div class="field"><label>カテゴリ</label><select id="pmCat">'+catOptions+'</select></div>' +
        '<div class="field-row">' +
          '<div class="field"><label>いつから</label><input type="date" id="pmFrom" value="'+monthStart+'"></div>' +
          '<div class="field"><label>いつまで</label><input type="date" id="pmTo" value="'+today+'"></div>' +
        '</div>' +
        '<p class="help" id="pmCount" style="margin:0;"></p>' +
        '<div class="modal-actions">' +
          '<button class="btn btn-ghost btn-small" id="pmCancel">キャンセル</button>' +
          '<button class="btn btn-ghost btn-small" id="pmPdf">PDFで保存</button>' +
          '<button class="btn btn-primary btn-small" id="pmPrint">印刷する</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(wrap);
    var catSel = wrap.querySelector("#pmCat");
    var fromIn = wrap.querySelector("#pmFrom");
    var toIn = wrap.querySelector("#pmTo");
    var countEl = wrap.querySelector("#pmCount");
    var pdfBtn = wrap.querySelector("#pmPdf");
    var printBtn = wrap.querySelector("#pmPrint");

    function picked(){
      var cat = catSel.value, from = fromIn.value || "0000-00-00", to = toIn.value || "9999-99-99";
      return liveEntries.filter(function(e){
        return (cat === "all" || e.category === cat) && e.date >= from && e.date <= to;
      }).sort(function(a, b){
        if(a.date === b.date){ return (a.updatedAt || "").localeCompare(b.updatedAt || ""); }
        return a.date.localeCompare(b.date);
      });
    }
    function refresh(){
      var n = picked().length;
      countEl.textContent = n ? "対象：" + n + "件（" + n + "件分のページ以上になります）" : "この条件に当てはまる記録はありません。";
      pdfBtn.disabled = printBtn.disabled = !n;
    }
    [catSel, fromIn, toIn].forEach(function(el){ el.addEventListener("change", refresh); el.addEventListener("input", refresh); });
    refresh();

    function go(mode){
      var list = picked();
      if(!list.length) return;
      wrap.remove();
      runPrint(mode, list, "koukai-nisshi-" + (fromIn.value || "start") + "_" + (toIn.value || "end") + ".pdf");
    }
    wrap.querySelector("#pmCancel").addEventListener("click", function(){ wrap.remove(); });
    pdfBtn.addEventListener("click", function(){ go("pdf"); });
    printBtn.addEventListener("click", function(){ go("print"); });
  }

  /* ---------------- password visibility toggle ---------------- */
  var EYE_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>';
  var EYE_OFF_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.94 10.94 0 0 1 12 19c-7 0-11-7-11-7a20.3 20.3 0 0 1 5.06-5.94"/><path d="M9.9 4.24A10.9 10.9 0 0 1 12 4c7 0 11 7 11 7a20.4 20.4 0 0 1-2.16 3.19"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';

  function decoratePasswordInput(input){
    if(input.getAttribute("data-pw-toggle")) return;
    input.setAttribute("data-pw-toggle", "1");
    input.setAttribute("spellcheck", "false");
    input.setAttribute("autocapitalize", "off");
    var wrap = document.createElement("span");
    wrap.className = "pw-wrap";
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "pw-toggle";
    btn.tabIndex = -1;
    function sync(){
      var shown = input.type === "text";
      btn.innerHTML = shown ? EYE_OFF_SVG : EYE_SVG;
      btn.title = shown ? "合言葉を隠す" : "合言葉を表示";
      btn.setAttribute("aria-label", btn.title);
    }
    btn.addEventListener("mousedown", function(e){ e.preventDefault(); });   // keep the caret in the field
    btn.addEventListener("click", function(){
      input.type = input.type === "password" ? "text" : "password";
      sync();
      input.focus();
    });
    sync();
    wrap.appendChild(btn);
  }
  function decoratePasswordInputs(root){
    if(root.matches && root.matches('input[type="password"]')){ decoratePasswordInput(root); }
    if(root.querySelectorAll){ Array.prototype.forEach.call(root.querySelectorAll('input[type="password"]'), decoratePasswordInput); }
  }
  // Put every revealed password field back to hidden (used when locking / entering the app).
  function hideAllPasswords(){
    Array.prototype.forEach.call(document.querySelectorAll('input[data-pw-toggle]'), function(input){
      if(input.type !== "password"){
        input.type = "password";
        var btn = input.parentNode.querySelector(".pw-toggle");
        if(btn){ btn.innerHTML = EYE_SVG; btn.title = "合言葉を表示"; btn.setAttribute("aria-label", btn.title); }
      }
    });
  }
  decoratePasswordInputs(document);
  new MutationObserver(function(muts){
    muts.forEach(function(m){ Array.prototype.forEach.call(m.addedNodes, function(n){ if(n.nodeType === 1){ decoratePasswordInputs(n); } }); });
  }).observe(document.body, { childList:true, subtree:true });

  /* ---------------- import backup ---------------- */
  var fileInput = document.getElementById("fileInput");
  fileInput.addEventListener("change", function(){
    var file = fileInput.files[0];
    fileInput.value = "";
    if(!file) return;
    var reader = new FileReader();
    reader.onload = function(){
      var text = reader.result;
      var parsed;
      try{ parsed = JSON.parse(text); } catch(e){
        if(pendingRestoreFromGate){ showGateError("ファイルを読み取れませんでした"); }
        else { showToast("ファイルを読み取れませんでした"); }
        pendingRestoreFromGate = false;
        return;
      }
      if(pendingRestoreFromGate){
        pendingRestoreFromGate = false;
        restoreFromGateWithBackup(parsed);
      } else {
        importBackupIntoCurrent(parsed);
      }
    };
    reader.readAsText(file);
  });

  // Replaces the journal on Drive with the backup. An existing journal file
  // on Drive is renamed (not deleted) by the main process.
  function restoreFromGateWithBackup(backup){
    clearGateError();
    if(!backup || !backup.verifier || !backup.salt){
      showGateError("このファイルはバックアップとして認識できませんでした。");
      return;
    }
    var prevStage = gateStage;
    var uploaded = {};
    promptPasswordFor(backup, "このバックアップを作成したときの合言葉を入力してください").then(function(key){
      setGateStage("loading", "バックアップをGoogleドライブへ書き込んでいます…");
      var fresh = normalizeDoc({
        salt: backup.salt,
        verifier: backup.verifier,
        categories: backup.categories || defaultCategories(),
        entries: backup.entries || []
      });
      var imageData = backup.imageData || {};
      return runSeq(Object.keys(imageData), function(imgId){
        return api.uploadImage(b64ToBytes(imageData[imgId]), imgId).then(function(fileId){
          uploaded[imgId] = fileId;
        });
      }).then(function(){
        fresh.images = uploaded;
        return decryptEntriesWith(key, fresh.entries);
      }).then(function(list){
        return api.createJournal(JSON.stringify(fresh)).then(function(res){
          doc = fresh;
          docRev = res.revision;
          sessionKey = key;
          liveEntries = list;
          uploaded = null;
        });
      });
    }).then(function(){
      enterApp();
      showToast(liveEntries.length+"件の記録を復元しました");
    }).catch(function(err){
      if(uploaded && values(uploaded).length){ api.trashFiles(values(uploaded)).catch(noop); }
      setGateStage(prevStage);
      if(err && err.cancelled){ return; }
      if(err && err.code === "reauth"){ handleGateFailure(err); return; }
      showGateError(errorMessage(err, "復元に失敗しました。ファイルが壊れている可能性があります。"));
    });
  }

  function importBackupIntoCurrent(backup){
    if(!backup || !backup.verifier || !backup.salt || !backup.entries){
      showToast("このファイルはバックアップとして認識できませんでした。");
      return;
    }
    decryptJson(sessionKey, backup.verifier).then(function(){
      return sessionKey;
    }, function(){
      return promptPasswordFor(backup, "このバックアップは別の合言葉で保護されています。作成時の合言葉を入力してください");
    }).then(function(key){
      return decryptEntriesWith(key, backup.entries).then(function(list){
        return mergeImportedEntries(list, backup.categories, key, backup.imageData || {});
      });
    }).catch(function(err){
      if(err && err.cancelled){ return; }
      handleWriteError(err, "読み込みに失敗しました。ファイルが壊れている可能性があります。");
    });
  }

  function decryptEntriesWith(key, encEntries){
    var jobs = encEntries.map(function(enc){
      return decryptJson(key, enc).then(function(plain){
        plain.id = enc.id;
        if(!Array.isArray(plain.images)){ plain.images = []; }
        return plain;
      });
    });
    return Promise.all(jobs);
  }

  function mergeImportedEntries(decryptedList, importedCategories, backupKey, imageData){
    var idMap = {};
    var existingByName = {};
    var newCats = [];
    (doc.categories||[]).forEach(function(c){ existingByName[c.name] = c.id; });
    (importedCategories||[]).forEach(function(c){
      if(existingByName[c.name]){
        idMap[c.id] = existingByName[c.name];
      } else {
        var newId = genId();
        newCats.push({ id:newId, name:c.name, color:c.color||"dusk" });
        existingByName[c.name] = newId;
        idMap[c.id] = newId;
      }
    });

    var existingIds = liveEntries.map(function(e){ return e.id; });
    var toAdd = decryptedList.filter(function(e){ return existingIds.indexOf(e.id) === -1; });
    var fallbackCatId = (doc.categories[0] && doc.categories[0].id) || null;
    toAdd.forEach(function(e){
      if(idMap[e.category]){ e.category = idMap[e.category]; }
      else if(!catById(e.category)){ e.category = fallbackCatId; }
    });

    var uploaded = {};
    var committed = false;
    var salt = doc.salt;
    var sameKey = backupKey === sessionKey;
    if(toAdd.length){ showToast("読み込んでいます…", 60000); }

    function have(key){ return !!(doc.images[key] || uploaded[key]); }
    return runSeq(toAdd, function(e){
      var keys = [].concat.apply([], (e.images || []).map(imageFileKeys))
        .concat((e.files || []).map(function(f){ return f.id; }));
      return runSeq(keys, function(key){
        if(have(key)) return;
        var packed = imageData[key];
        if(!packed) return;
        var bytes = b64ToBytes(packed);
        var reencrypted = sameKey ? Promise.resolve(bytes) : decryptBytes(backupKey, bytes).then(function(plain){
          return encryptBytes(sessionKey, plain);
        });
        return reencrypted.then(function(enc){ return api.uploadImage(enc, key); }).then(function(fileId){
          uploaded[key] = fileId;
        });
      });
    }).then(function(){
      toAdd.forEach(function(e){
        // バックアップに画像データが含まれていない添付は外しておく（元画像だけが欠けている場合は書き込み情報を外す）
        e.files = (e.files || []).filter(function(f){ return have(f.id); });
        e.images = (e.images || []).filter(function(img){ return have(img.id); }).map(function(img){
          if(img.edit && !have(img.edit.originalId)){
            img = Object.assign({}, img);
            delete img.edit;
          }
          if(img.composite && !img.composite.sources.every(function(src){ return imageFileKeys(src).every(have); })){
            img = Object.assign({}, img);
            delete img.composite;
          }
          return img;
        });
      });
      return Promise.all(toAdd.map(function(e){
        return encryptJson(sessionKey, entryPayload(e)).then(function(enc){ return { id:e.id, enc:enc }; });
      }));
    }).then(function(blobs){
      return persist(function(d){
        newCats.forEach(function(c){
          if(!d.categories.some(function(x){ return x.id === c.id; })){ d.categories.push(c); }
        });
        blobs.forEach(function(b){
          if(!d.entries.some(function(x){ return x.id === b.id; })){ d.entries.push({ id:b.id, iv:b.enc.iv, data:b.enc.data }); }
        });
        Object.keys(uploaded).forEach(function(k){ d.images[k] = uploaded[k]; });
      }, salt);
    }).then(function(){
      committed = true;
      toAdd.forEach(upsertLive);
      renderCategories();
      renderMain();
      showToast(toAdd.length+"件の記録を読み込みました");
    }).catch(function(err){
      if(!committed && values(uploaded).length){ api.trashFiles(values(uploaded)).catch(noop); }
      throw err;
    });
  }

  // Resolves with the backup's key once the right password is entered;
  // rejects with {cancelled:true} when the dialog is closed.
  function promptPasswordFor(backup, message){
    return new Promise(function(resolve, reject){
      var wrap = document.createElement("div");
      wrap.className = "modal-backdrop";
      wrap.innerHTML =
        '<div class="modal">' +
          '<h3>合言葉を入力</h3>' +
          '<p class="help">'+escapeHtml(message)+'</p>' +
          '<div class="field"><input type="password" id="tmpPw"></div>' +
          '<p class="help" id="tmpErr" style="display:none;color:var(--danger);margin:0 0 8px;">合言葉が正しくないようです。</p>' +
          '<div class="modal-actions">' +
            '<button class="btn btn-ghost btn-small" id="tmpCancel">キャンセル</button>' +
            '<button class="btn btn-primary btn-small" id="tmpOk">OK</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(wrap);
      var input = wrap.querySelector("#tmpPw");
      var okBtn = wrap.querySelector("#tmpOk");
      input.focus();
      input.addEventListener("keydown", function(e){ if(e.key === "Enter" && !e.isComposing){ okBtn.click(); } });
      wrap.querySelector("#tmpCancel").addEventListener("click", function(){ wrap.remove(); reject({ cancelled:true }); });
      okBtn.addEventListener("click", function(){
        var pw = input.value;
        okBtn.disabled = true;
        var salt = new Uint8Array(b64ToBuf(backup.salt));
        deriveKeyFromPassword(pw, salt).then(function(key){
          return decryptJson(key, backup.verifier).then(function(){
            wrap.remove();
            resolve(key);
          });
        }).catch(function(){
          okBtn.disabled = false;
          wrap.querySelector("#tmpErr").style.display = "block";
          input.select();
        });
      });
    });
  }

  /* ---------------- change password ---------------- */
  // Images are re-encrypted into new Drive files first; the journal is then
  // replaced in one write, and only after that are the old image files
  // trashed. An interruption therefore never leaves a half-migrated journal.
  function openChangePasswordModal(){
    var wrap = document.createElement("div");
    wrap.className = "modal-backdrop";
    wrap.innerHTML =
      '<div class="modal">' +
        '<h3>合言葉を変更する</h3>' +
        '<div class="field"><label>現在の合言葉</label><input type="password" id="cpOld"></div>' +
        '<div class="field"><label>新しい合言葉</label><input type="password" id="cpNew1"></div>' +
        '<div class="field"><label>新しい合言葉（確認）</label><input type="password" id="cpNew2"></div>' +
        '<p class="help" id="cpError" style="display:none;color:var(--danger)"></p>' +
        '<div class="modal-actions">' +
          '<button class="btn btn-ghost btn-small" id="cpCancel">キャンセル</button>' +
          '<button class="btn btn-primary btn-small" id="cpOk">変更する</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(wrap);
    var okBtn = wrap.querySelector("#cpOk");
    var cancelBtn = wrap.querySelector("#cpCancel");
    cancelBtn.addEventListener("click", function(){ wrap.remove(); });
    okBtn.addEventListener("click", function(){
      var errEl = wrap.querySelector("#cpError");
      var oldPw = wrap.querySelector("#cpOld").value;
      var new1 = wrap.querySelector("#cpNew1").value;
      var new2 = wrap.querySelector("#cpNew2").value;
      if(new1.length < 4 || new1 !== new2){
        errEl.textContent = "新しい合言葉が4文字未満か、一致していません。";
        errEl.style.display = "block";
        return;
      }
      errEl.style.display = "none";
      okBtn.disabled = true;
      cancelBtn.disabled = true;
      okBtn.textContent = "変更中…";
      var oldSalt = new Uint8Array(b64ToBuf(doc.salt));
      var newImages = {};
      deriveKeyFromPassword(oldPw, oldSalt).then(function(oldKey){
        return decryptJson(oldKey, doc.verifier).then(function(){ return oldKey; }, function(){
          return Promise.reject({ code:"wrong_password" });
        });
      }).then(function(oldKey){
        var newSalt = randomBytes(16);
        return deriveKeyFromPassword(new1, newSalt).then(function(newKey){
          return queueWrite(function(){
            var oldImages = Object.assign({}, doc.images);
            return runSeq(Object.keys(oldImages), function(imgId){
              return api.downloadImage(oldImages[imgId]).then(function(packed){
                return decryptBytes(oldKey, packed);
              }).then(function(plain){
                return encryptBytes(newKey, plain);
              }).then(function(enc){
                return api.uploadImage(enc, imgId);
              }).then(function(fileId){
                newImages[imgId] = fileId;
              }, function(err){
                if(err && err.code === "not_found"){ return; }
                throw err;
              });
            }).then(function(){
              return encryptJson(newKey, { ok:true, rotatedAt:new Date().toISOString() });
            }).then(function(newVerifier){
              return Promise.all(liveEntries.map(function(e){
                return encryptJson(newKey, entryPayload(e)).then(function(enc){ return { id:e.id, iv:enc.iv, data:enc.data }; });
              })).then(function(newEntries){
                var next = {
                  version: 2,
                  salt: bufToB64(newSalt),
                  verifier: newVerifier,
                  categories: doc.categories,
                  entries: newEntries,
                  images: newImages
                };
                return api.saveJournal(JSON.stringify(next), docRev).then(function(res){
                  doc = next;
                  docRev = res.revision;
                  sessionKey = newKey;
                  newImages = null;
                  var oldFileIds = values(oldImages);
                  if(oldFileIds.length){ api.trashFiles(oldFileIds).catch(noop); }
                });
              });
            });
          });
        });
      }).then(function(){
        wrap.remove();
        showToast("合言葉を変更しました");
      }).catch(function(err){
        if(newImages && values(newImages).length){ api.trashFiles(values(newImages)).catch(noop); }
        okBtn.disabled = false;
        cancelBtn.disabled = false;
        okBtn.textContent = "変更する";
        errEl.textContent = (err && err.code === "wrong_password") ? "現在の合言葉が正しくありません。" : errorMessage(err, "変更中にエラーが発生しました。記録はそのまま残っています。");
        errEl.style.display = "block";
      });
    });
  }

  /* ---------------- disconnect Google account ---------------- */
  function confirmLogout(){
    guardLeave(function(){
      openConfirmModal(
        "Googleアカウントの接続を解除しますか？",
        "このパソコンに保存されているGoogleのログイン情報を削除します。ドライブ上の記録は消えません。次に開くときは、もう一度Googleでログインしてください。",
        function(){
          api.logout().catch(noop).then(function(){ lockApp(); });
        },
        "接続を解除する",
        false
      );
    });
  }

  /* ================================================================
     よく使うサイト (v1.0.62)
     Links to the owner's sites and to their own games on this PC, in three groups. In the Windows
     app a site opens in a tab inside the window: src/main/sites.js lays the page over #siteFrame and
     the tabs sit in the top bar. The web version opens the site in a new browser tab.
     The list is stored like an image: one encrypted file on Drive, listed in doc.images under
     SITES_KEY. Older versions of the app keep that entry untouched, and backups, restores and
     passphrase changes carry it along with the images.
  ================================================================ */
  var SITES_KEY = "sites";
  var SITE_GROUPS = [
    { id:"work", name:"仕事" },
    { id:"private", name:"プライベート" }
  ];
  var DESKTOP_TOKEN = "%DESKTOP%";
  var siteApi = api.sites || null;   // only in the Windows app
  var siteList = null;               // [{id, name, group, url | file, external}] once loaded
  var siteLoadError = false;
  var siteTabs = [];                 // open tabs: {id, linkId, name, title, url, isFile, canBack, canForward, loading, error}
  var activeSiteTab = null;          // the tab shown instead of the journal, or null
  var shownSiteTab = null;           // the tab the main process is drawing right now
  var siteNotice = null;             // {text, file} shown in the site bar (downloads)

  function defaultSites(){
    return [];
  }
  // v1.0.116: the owner dropped the links to 鳥の旅 and ロケットの旅 to make room for the calendar.
  // v1.0.117: the ゲーム group and 国旗当てゲーム went too.
  // Lists saved before then lose them once; a link added again later stays. Each name goes only from
  // lists older than the version that dropped it (鳥の旅 added again under 1.0.116 stays with 1.0.117).
  var SITES_VERSION = 3;
  var RETIRED_SITES = [
    { before: 2, names: ["鳥の旅", "ロケットの旅"] },
    { before: 3, names: ["国旗当てゲーム", "flag-quiz"] }
  ];
  function siteRetired(s, version){
    return RETIRED_SITES.some(function(r){
      return !(version >= r.before) && r.names.some(function(n){ return s.name === n || (s.file && s.file.indexOf("\\" + n + "\\") >= 0); });
    });
  }
  function siteGroupOk(g){ return SITE_GROUPS.some(function(x){ return x.id === g; }); }
  function cleanSite(s){
    if(!s || typeof s !== "object"){ return null; }
    var out = { id: String(s.id || genId()), name: String(s.name || "").slice(0, 60), group: siteGroupOk(s.group) ? s.group : "private", external: !!s.external };
    if(s.file){ out.file = String(s.file); }
    else if(/^https?:\/\//i.test(String(s.url || ""))){ out.url = String(s.url); }
    else { return null; }
    if(!out.name){ out.name = siteAddressLabel(out); }
    return out;
  }
  // What the owner reads and types: "デスクトップ\鳥の旅\index.html" for files on the desktop.
  function siteAddressText(s){
    if(s.file){ return s.file.indexOf(DESKTOP_TOKEN) === 0 ? "デスクトップ" + s.file.slice(DESKTOP_TOKEN.length) : s.file; }
    return s.url || "";
  }
  function siteAddressLabel(s){
    if(s.file){ return s.file.split(/[\\/]/).slice(-2, -1)[0] || "ページ"; }
    try{ return new URL(s.url).hostname.replace(/^www\./, ""); } catch(e){ return s.url; }
  }
  // The address typed in the editor → {url} or {file}, or null when it cannot be one.
  function parseSiteAddress(text){
    var t = String(text || "").trim().replace(/^["']|["']$/g, "");
    if(!t){ return null; }
    var m = /^デスクトップ([\\/].*)$/.exec(t);
    if(m){ t = DESKTOP_TOKEN + m[1].replace(/\//g, "\\"); }
    if(t.indexOf(DESKTOP_TOKEN) === 0 || /^[a-zA-Z]:[\\/]/.test(t) || /^\\\\/.test(t)){
      return /\.html?$/i.test(t) ? { file: t } : null;
    }
    if(!/^https?:\/\//i.test(t)){
      if(/\s/.test(t) || t.indexOf(".") < 0){ return null; }
      t = "https://" + t;
    }
    try{ new URL(t); } catch(e){ return null; }
    return { url: t };
  }

  function loadSites(){
    var key = sessionKey;
    siteList = null;
    siteLoadError = false;
    var fileId = doc.images[SITES_KEY];
    if(!fileId){
      siteList = defaultSites();
      renderSites();
      return Promise.resolve();
    }
    renderSites();
    return api.downloadImage(fileId).then(function(bytes){
      return decryptBytes(key, bytes);
    }).then(function(plain){
      if(key !== sessionKey){ return; }
      var o = JSON.parse(new TextDecoder().decode(plain));
      siteList = (Array.isArray(o.items) ? o.items : []).map(cleanSite).filter(Boolean);
      if(!(o.version >= SITES_VERSION)){
        var kept = siteList.filter(function(s){ return !siteRetired(s, o.version); });
        if(kept.length < siteList.length){
          siteList = kept;
          saveSites(kept).catch(noop);   // tried again at the next unlock if it fails
        }
      }
    }).catch(function(err){
      if(key !== sessionKey){ return; }
      // The file is gone from Drive (emptied trash, for example): start again from the defaults
      // rather than locking the list for good. Other failures (network) can be retried.
      if(err && err.code === "not_found"){ siteList = defaultSites(); } else { siteLoadError = true; }
    }).then(function(){
      if(key === sessionKey){ renderSites(); }
    });
  }

  // Uploads the new list as a new file, points the journal at it, then trashes the previous file.
  function saveSites(list){
    var bytes = new TextEncoder().encode(JSON.stringify({ version:SITES_VERSION, items:list }));
    var uploaded = null, old = null, committed = false, salt = doc.salt;
    return encryptBytes(sessionKey, bytes).then(function(enc){
      return api.uploadImage(enc, SITES_KEY);
    }).then(function(fileId){
      uploaded = fileId;
      return persist(function(d){
        old = d.images[SITES_KEY] || null;
        d.images[SITES_KEY] = fileId;
      }, salt);
    }).then(function(){
      committed = true;
      siteList = list;
      if(old && old !== uploaded){ api.trashFiles([old]).catch(noop); }
      siteTabs.forEach(function(t){
        var s = siteById(t.linkId);
        if(s){ t.name = s.name; } else if(t.linkId){ t.linkId = null; t.name = ""; }
      });
      renderSites();
      renderSiteTabs();
    }, function(err){
      if(uploaded && !committed){ api.trashFiles([uploaded]).catch(noop); }
      throw err;
    });
  }

  function siteById(id){
    return id && siteList ? siteList.filter(function(s){ return s.id === id; })[0] : null;
  }
  function siteTabById(id){
    return siteTabs.filter(function(t){ return t.id === id; })[0] || null;
  }
  function siteIcon(s){
    return s.group === "work" ? "💼" : "🏠";
  }

  // The sites' list in the sidebar is gone (v1.0.165, the owner's wish; the TO DO list took its place).
  // Nothing opens a site any more; the stored list (doc.images.sites) is kept on Drive as it is.
  function renderSites(){}

  function openSite(s){
    if(s.file && !siteApi){
      showToast("パソコンの中のページ（ゲームなど）は、パソコン版の航海日誌で開けます", 4000);
      return;
    }
    if(!siteApi){
      window.open(s.url, "_blank", "noopener");
      return;
    }
    var target = s.file ? { file: s.file } : { url: s.url };
    if(s.external){
      siteApi.external(target).catch(siteOpenError);
      return;
    }
    var tab = siteTabs.filter(function(t){ return t.linkId === s.id; })[0];
    if(tab){ showSiteTab(tab.id); return; }
    siteApi.open(target).then(function(id){
      shownSiteTab = id;   // the main process shows a new tab at once
      siteTabs.push({ id:id, linkId:s.id, name:s.name, title:"", url:s.url || "", isFile:!!s.file, canBack:false, canForward:false, loading:true, error:null });
      showSiteTab(id);
    }, siteOpenError);
  }
  function siteOpenError(err){
    if(err && err.code === "file_not_found"){
      showToast("このパソコンでは、ページが見つかりませんでした（" + err.message + "）。「編集」で場所を選び直せます。", 8000);
      return;
    }
    showToast(withDetail("開けませんでした", err), 6000);
  }

  /* ---------- tabs and the site area ---------- */
  // Shows a tab (id) or the journal (null).
  function showSiteTab(id){
    activeSiteTab = siteTabById(id) ? id : null;
    var on = activeSiteTab != null;
    document.body.classList.toggle("site-mode", on);
    document.getElementById("siteHost").hidden = !on;
    siteNotice = on ? siteNotice : null;
    // The tabs and the bar first: they decide where the page goes.
    renderSiteTabs();
    renderSiteBar();
    renderSites();
    if(on){
      hideCalTip();
      layoutSiteHost();
      requestAnimationFrame(layoutSiteHost);
    } else {
      refitPapers();   // the window may have changed size while the journal was hidden
    }
    syncSiteView();
  }

  function closeSiteTab(id){
    var i = siteTabs.findIndex(function(t){ return t.id === id; });
    if(i < 0){ return; }
    siteTabs.splice(i, 1);
    if(shownSiteTab === id){ shownSiteTab = null; }
    siteApi.close(id).catch(noop);
    if(activeSiteTab === id){
      var next = siteTabs[i] || siteTabs[i - 1];
      showSiteTab(next ? next.id : null);
    } else {
      renderSiteTabs();
      renderSites();
    }
  }

  /* ================================================================
     小さなメモ窓 (v1.0.122) と TO DO リスト (v1.0.136)
     Two small sheets that work the same way, shown together since v1.0.153: the TO DO list above,
     the memo under it (buildSheets). Windows app: one small always-on-top window (main.js allows the
     window name "memo"); web version (v1.0.124): one panel floating over the page.
     Each is stored like the sites list: one encrypted file on Drive, listed
     in doc.images under its key, so both PCs see the same sheet and older versions leave it alone.
     Saved a moment after a change stops. The windows go with the lock.
     The memo is one plain text. The TO DO list is items [{text, done}]: a ticked item stays, struck
     through, until 「済みを消す」 removes the ticked ones.
  ================================================================ */
  function makeSheet(o){
    return {
      key: o.key,            // the window name and the doc.images key
      word: o.word,          // in messages: 「メモ」「TO DO」
      icon: o.icon,
      empty: o.empty,        // a fresh value
      decode: o.decode,      // the stored file's object → value
      encode: o.encode,      // value → the fields the stored file keeps
      build: null,           // (d, close, isOpen) → { el, focus, recheck }: the sheet's own content
      value: o.empty(),      // as last loaded or changed here
      fileId: null,          // the Drive file value was loaded from (null: none yet)
      ready: false,          // loaded for this unlock
      timer: null,           // a save waiting for changes to stop
      saving: 0,             // saves on their way to Drive
      failed: false,         // the last save did not reach Drive
      checked: 0,            // when the other PC's sheet was last looked for
      chain: Promise.resolve(),
      keep: null             // the open sheet's keep(): see keepTyped
    };
  }
  // Where the two sheets are shown (one window or panel for both, v1.0.153).
  var sheetView = {
    win: null,               // Windows app: the open window
    panel: null,             // web version: the open panel
    shown: null,             // what buildSheets returned for it
    opening: false           // being prepared (a second Ctrl+M must not build it twice)
  };
  // The memo is its text and the strokes drawn over it (v1.0.146, see memo.build). Versions before that
  // read the text only, and saving there drops the strokes.
  var memo = makeSheet({ key:"memo", word:"メモ", icon:"📝",
    empty: function(){ return { text:"", draw:[] }; },
    decode: function(o){ return { text: String(o.text || ""), draw: decodeStrokes(o.draw) }; },
    encode: function(v){ return { text: v.text, draw: v.draw }; } });
  var todo = makeSheet({ key:"todo", word:"TO DO", icon:"✅",
    empty: function(){ return []; },
    decode: function(o){
      return (Array.isArray(o.items) ? o.items : []).map(function(it){
        return { text: String(it && it.text || ""), done: !!(it && it.done) };
      });
    },
    encode: function(v){ return { items: v }; } });
  // 予定 (v1.0.154): the calendar's plans, { "YYYY-MM-DD": [{ id, time: "HH:MM" or "", text }] }. Stored like the memo
  // (load, save, lock, quit and passphrase changes go through SHEETS) but not shown in the sheet window:
  // the calendar marks the days, and the day picked there shows and edits them (renderPlanBox).
  var plans = makeSheet({ key:"plans", word:"予定", icon:"📅",
    empty: function(){ return {}; },
    decode: function(o){
      var days = o.days && typeof o.days === "object" ? o.days : {}, v = {};
      Object.keys(days).forEach(function(d){
        if(!/^\d{4}-\d{2}-\d{2}$/.test(d) || !Array.isArray(days[d])){ return; }
        var list = days[d].map(function(p){
          return { id: p && typeof p.id === "string" && p.id ? p.id : genId(),
                   time: /^\d{2}:\d{2}$/.test(p && p.time) ? p.time : "", text: String(p && p.text || "") };
        }).filter(function(p){ return p.text; });
        if(list.length){ v[d] = list; }
      });
      return v;
    },
    encode: function(v){ return { days: v }; } });
  plans.onLoad = function(){
    renderCalendar();
    if(currentView !== "list"){ return; }
    // A time or a text being changed in its row would be lost (v1.0.155): drawn when the caret leaves the box.
    var box = document.getElementById("planBox"), at = document.activeElement;
    if(box && at && box.contains(at) && !at.closest(".plan-add")){ box.stale = true; } else { renderPlanBox(); }
  };
  // What is written in the day's add row and not added yet: { day, text, time, focus }, or null.
  function readPlanTyped(){
    var t = document.getElementById("planText"), tm = document.getElementById("planTime");
    if(!t){ return null; }
    return { day: t.getAttribute("data-day") || "", text: t.value, time: tm ? tm.value : "", focus: document.activeElement === t };
  }
  // The add row's text becomes a plan of its day (v1.0.155), as the TO DO box's does (keepTyped, v1.0.152): the box
  // is left, the day changed, the app locked or closed. With Japanese input the first Enter only fixes the conversion,
  // so a plan was easily never added, and it was lost.
  plans.keep = function(){
    var c = readPlanTyped(), text = c ? c.text.trim() : "";
    if(!c || !c.day || !text){ return; }
    var t = document.getElementById("planText"), tm = document.getElementById("planTime");
    t.value = "";
    if(tm){ tm.value = ""; }
    var time = /^\d{2}:\d{2}/.test(c.time) ? c.time.slice(0, 5) : "";
    setDayPlans(c.day, (plans.value[c.day] || []).concat([{ id: genId(), time: time, text: text }]));
  };
  var SHEETS = [memo, todo, plans];

  // The TO DO list in the sidebar, under the calendar (v1.0.165): the items as they are in the TO DO sheet,
  // ticked ones struck through. Drawn again on every change made in the sheet (sheetChanged) and whenever the
  // items are read from Drive (onLoad). It only shows them: a click opens the sheet with the caret in its box.
  var sideTodoFailed = false;   // the reading at unlock failed (opening the sheet tries again)
  todo.onLoad = function(){ sideTodoFailed = false; renderSideTodo(); };
  function renderSideTodo(){
    var box = document.getElementById("sideTodo");
    if(!box){ return; }
    if(!sessionKey){ box.innerHTML = ""; return; }
    var html = '<div class="side-todo-head"><p class="side-section-label">TO DOリスト</p>' +
      '<button type="button" class="tag-manage" id="sideTodoOpen" title="TO DO リストを開いて書く（Ctrl+T）">開く</button></div>';
    var items = todo.ready ? todo.value.filter(function(it){ return it.text.trim(); }) : [];
    if(!todo.ready){
      html += '<p class="side-todo-note">' + (sideTodoFailed ? "読み込めませんでした。「開く」でもう一度読みます。" : "読み込んでいます…") + '</p>';
    } else if(!items.length){
      html += '<p class="side-todo-note">項目はまだありません</p>';
    } else {
      html += '<ul class="side-todo-list" title="クリックで TO DO リストを開きます">' + items.map(function(it){
        return '<li class="side-todo-item' + (it.done ? ' done' : '') + '">' +
                 '<span class="side-todo-mark" aria-hidden="true">' + (it.done ? '☑' : '☐') + '</span>' +
                 '<span class="side-todo-text">' + escapeHtml(it.text) + '</span>' +
               '</li>';
      }).join("") + '</ul>';
    }
    // Drawn again on every key typed in the sheet: keep where the list was scrolled to (it went back to the top).
    var old = box.querySelector(".side-todo-list"), top = old ? old.scrollTop : 0;
    box.innerHTML = html;
    function open(){ openSheetsAt(todo); }
    box.querySelector("#sideTodoOpen").addEventListener("click", open);
    var list = box.querySelector(".side-todo-list");
    if(list){ list.scrollTop = top; list.addEventListener("click", open); }
  }
  // The other PC (or the iPhone) may have changed the list: look again when this window comes back, at most
  // every 10 seconds, as the plans do. refreshSheet leaves it alone while a change here is on its way.
  // While the sheet is open, its own recheck looks: its rows change the items they were drawn from, and it draws
  // them anew when it takes the other PC's list. Skipped until v1.0.166, so with the Windows sheet window open
  // the list here stayed old until that window was used.
  // After a failed reading at unlock it tries again here too.
  function recheckSideTodo(){
    if(!sessionKey || !(todo.ready || sideTodoFailed)){ return; }
    if(sheetView.shown){ sheetView.shown.recheck(); return; }
    if(Date.now() - todo.checked < 10000){ return; }
    refreshSheet(todo).catch(noop);
  }
  window.addEventListener("focus", recheckSideTodo);
  document.addEventListener("visibilitychange", function(){ if(document.visibilityState === "visible"){ recheckSideTodo(); } });

  // A press in progress (v1.0.155): what a change to the plans redraws waits until it is let go. A change made as
  // the press took the caret out of a row (change, focusout) redrew the calendar at once, the day under the pointer
  // was replaced before the release, and its click was lost.
  var pointerHeld = false, afterRelease = [];
  window.addEventListener("pointerdown", function(){ pointerHeld = true; }, true);
  function pointerReleased(){
    if(!pointerHeld){ return; }
    pointerHeld = false;
    var list = afterRelease;
    afterRelease = [];
    // After the click the release makes (it may draw the page again itself).
    if(list.length){ setTimeout(function(){ list.forEach(function(fn){ fn(); }); }, 0); }
  }
  window.addEventListener("pointerup", pointerReleased, true);
  window.addEventListener("pointercancel", pointerReleased, true);
  window.addEventListener("blur", function(e){ if(e.target === window){ pointerReleased(); } });
  function whenReleased(fn){ if(pointerHeld){ afterRelease.push(fn); } else { fn(); } }

  // Plans with a time first, in time order; the rest after them, in the order they were written.
  function sortPlans(list){
    return list.map(function(p, i){ return { p:p, i:i }; }).sort(function(a, b){
      if(a.p.time && b.p.time && a.p.time !== b.p.time){ return a.p.time < b.p.time ? -1 : 1; }
      if(!a.p.time !== !b.p.time){ return a.p.time ? -1 : 1; }
      return a.i - b.i;
    }).map(function(x){ return x.p; });
  }
  // keepBox: a time or a text was changed in its row. The box is drawn again (in the new order) only when
  // the caret leaves it, not under the pointer: a click on 追加 or ✕ right after typing would be lost.
  function setDayPlans(day, list, keepBox){
    list = sortPlans(list.filter(function(p){ return p.text; }));
    if(list.length){ plans.value[day] = list; } else { delete plans.value[day]; }
    sheetChanged(plans);
    whenReleased(renderCalendar);
    var box = document.getElementById("planBox");
    if(keepBox && box){ box.stale = true; } else { renderPlanBox(); }
  }
  // Not read yet (just unlocked) or the reading failed: read it now, then draw again.
  // plansFailed: the last reading failed; the box then offers 「もう一度」 instead of trying again by itself.
  var plansLoading = false, plansFailed = false;
  function ensurePlans(){
    if(plans.ready || plansLoading || !sessionKey){ return; }
    var key = sessionKey;
    plansLoading = true;
    plans.chain.then(function(){ return loadSheet(plans); }).catch(noop).then(function(){
      plansLoading = false;
      if(key !== sessionKey){ return; }
      plansFailed = !plans.ready;
      if(plansFailed){ renderPlanBox(); }
    });
  }
  // The other PC (or the iPhone) may have changed the plans: look again when this window comes back,
  // at most every 10 seconds. refreshSheet leaves them alone while a change here is on its way.
  function recheckPlans(){
    if(!sessionKey || !plans.ready || Date.now() - plans.checked < 10000){ return; }
    refreshSheet(plans).catch(noop);
  }
  window.addEventListener("focus", recheckPlans);
  document.addEventListener("visibilitychange", function(){ if(document.visibilityState === "visible"){ recheckPlans(); } });

  // The records the other PC (or the iPhone) saved since this one read the journal: look again when this window
  // comes back, at most every 10 seconds, as the sheets do. Until v1.0.168 the records were read only at unlock
  // (and when a save here met the other PC's), so with the app left open a record written on the other PC did not
  // show until a lock (the owner missed an evening's records, 2026-11-04).
  // It waits for the saves on their way (writeChain), so what they wrote is in what it reads.
  // The list is drawn again only when nothing is being typed in it (the search, a plan); else at the next look.
  var entriesChecked = 0, listStale = false;
  function recheckEntries(){
    if(!sessionKey || !doc || Date.now() - entriesChecked < 10000){ return; }
    entriesChecked = Date.now();
    var key = sessionKey;
    // Only the reading is in the chain of saves (v1.0.175): a failure in drawing the list must not stop the saves after it.
    var job = writeChain.then(function(){
      if(key !== sessionKey){ return; }
      return api.loadJournal().then(function(res){
        if(key !== sessionKey || !res.exists || res.revision === docRev){ return; }
        var fresh = normalizeDoc(JSON.parse(res.content));
        if(fresh.salt !== doc.salt){ return; }   // the passphrase was changed there: the next save locks and says so
        return decryptEntriesWith(key, fresh.entries).then(function(list){
          if(key !== sessionKey){ return; }
          var was = shownPayload();
          doc = fresh;
          docRev = res.revision;
          liveEntries = list;
          listStale = true;
          // The record on the reading screen was changed (in a record window, v1.0.216, or on the other PC).
          if(currentView === "view" && shownPayload() !== was){ viewStale = true; }
        });
      });
    }).catch(noop);
    writeChain = job;
    job.then(function(){
      if(key === sessionKey && listStale){ whenReleased(redrawForRemote); }
    });
  }
  function redrawForRemote(){
    if(!sessionKey){ return; }
    var typing = document.activeElement && viewRoot.contains(document.activeElement) &&
                 /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
    if(currentView === "list" && typing){ return; }
    listStale = false;
    renderCategories();   // counts, calendar and tags
    if(currentView === "list"){ renderList(); }
    // The reading screen is drawn again where it was scrolled to, unless a dialog is open over it (next look then).
    if(viewStale && currentView === "view" && !document.querySelector("body > .modal-backdrop")){
      viewStale = false;
      var y = window.scrollY;
      renderMain();
      window.scrollTo(0, y);
      setTimeout(function(){ if(currentView === "view"){ window.scrollTo(0, y); } }, 400);   // the A4 sheet is drawn a moment later
      if(RECORD_WIN){ showRecordTitle(); }
    }
  }
  var viewStale = false;
  function shownPayload(){
    var e = openEntryId ? liveEntries.filter(function(x){ return x.id === openEntryId; })[0] : null;
    return e ? JSON.stringify(entryPayload(e)) : "";
  }
  window.addEventListener("focus", recheckEntries);
  document.addEventListener("visibilitychange", function(){ if(document.visibilityState === "visible"){ recheckEntries(); } });

  // The day's plans, above its records (renderList): change a time or a text in place, ✕ removes one,
  // the row at the bottom adds one (Enter or 「追加」). Saved a second after the change, like the memo.
  // carry: what renderList read from the add row before it replaced the box (readPlanTyped).
  function renderPlanBox(carry){
    var box = document.getElementById("planBox");
    if(!box || !currentDate){ return; }
    var day = currentDate;
    // What is being typed in the add row stays when the box is drawn again.
    var c = carry || readPlanTyped();
    if(c && c.day !== day){ c = null; }
    var typed = c ? c.text : "", typedTime = c ? c.time : "";
    var hadFocus = !!(c && c.focus);
    var head = '<div class="plan-head">📅 予定</div>';
    if(!plans.ready){
      if(plansFailed && !plansLoading){
        box.innerHTML = head + '<p class="plan-empty">予定を読み込めませんでした。通信状況をご確認ください。 <button type="button" class="btn btn-ghost btn-small" id="planRetry">もう一度</button></p>';
        document.getElementById("planRetry").addEventListener("click", function(){ plansFailed = false; renderPlanBox(); });
        return;
      }
      box.innerHTML = head + '<p class="plan-empty">予定を読み込んでいます…</p>';
      ensurePlans();
      return;
    }
    var list = plans.value[day] || [];
    box.stale = false;
    if(READ_ONLY){   // v1.0.191: iPhone / iPad only show the day's plans
      box.innerHTML = head + (list.length ? '<ul class="plan-list">' + list.map(function(p){
        return '<li class="plan-item plan-ro"><span class="plan-ro-time">'+escapeHtml(p.time || "")+'</span><span class="plan-ro-text">'+escapeHtml(p.text)+'</span></li>';
      }).join("") + '</ul>' : '<p class="plan-empty">予定はありません。</p>');
      return;
    }
    box.innerHTML = head +
      (list.length ? '<ul class="plan-list">' + list.map(function(p){
        return '<li class="plan-item" data-id="'+escapeHtml(p.id)+'">' +
                 '<input type="time" class="plan-time'+(p.time ? '' : ' empty')+'" value="'+escapeHtml(p.time)+'" aria-label="時刻" title="時刻（なくてもかまいません）">' +
                 '<input type="text" class="plan-text" maxlength="200" value="'+escapeHtml(p.text)+'" aria-label="予定">' +
                 '<button type="button" class="plan-del" title="この予定を消す" aria-label="この予定を消す">✕</button>' +
               '</li>';
      }).join("") + '</ul>' : '<p class="plan-empty">予定はありません。</p>') +
      '<div class="plan-add">' +
        '<input type="time" id="planTime" aria-label="時刻" title="時刻（なくてもかまいません）">' +
        '<input type="text" id="planText" maxlength="200" placeholder="予定を書く…" aria-label="新しい予定">' +
        '<button type="button" class="btn btn-primary btn-small" id="planAddBtn">追加</button>' +
      '</div>';

    Array.prototype.forEach.call(box.querySelectorAll(".plan-item"), function(row){
      var id = row.getAttribute("data-id");
      var time = row.querySelector(".plan-time"), text = row.querySelector(".plan-text");
      // Each change takes the list as it is now (another change may have come in since this was drawn).
      // fn returns the changed plan, or null to remove it.
      function edit(fn, keepBox){
        var cur = (plans.value[day] || []).slice();
        var i = cur.findIndex(function(p){ return p.id === id; });
        if(i < 0){ return; }
        cur[i] = fn(Object.assign({}, cur[i]));
        setDayPlans(day, cur.filter(Boolean), keepBox && !!cur[i]);
      }
      time.addEventListener("change", function(){
        var t = /^\d{2}:\d{2}/.test(time.value) ? time.value.slice(0, 5) : "";
        time.classList.toggle("empty", !t);
        edit(function(p){ p.time = t; return p; }, true);
      });
      text.addEventListener("change", function(){
        var t = text.value.trim();
        // Emptied: the plan goes, as with ✕.
        edit(function(p){ if(!t){ return null; } p.text = t; return p; }, true);
      });
      // keyCode 229: Safari (iPhone, Mac) reports the Enter that fixes a Japanese conversion as not composing (v1.0.155).
      text.addEventListener("keydown", function(e){
        if(e.key === "Enter" && !e.isComposing && e.keyCode !== 229){ e.preventDefault(); text.blur(); }
      });
      row.querySelector(".plan-del").addEventListener("click", function(){
        edit(function(){ return null; });
      });
    });

    var addText = document.getElementById("planText"), addTime = document.getElementById("planTime");
    addText.value = typed;
    addTime.value = typedTime;
    if(hadFocus){ addText.focus(); }
    addText.setAttribute("data-day", day);
    function add(){
      if(!addText.value.trim()){ addText.focus(); return; }
      plans.keep();
      var again = document.getElementById("planText");
      if(again){ again.focus(); }
    }
    document.getElementById("planAddBtn").addEventListener("click", add);
    addText.addEventListener("keydown", function(e){
      if(e.key === "Enter" && !e.isComposing && e.keyCode !== 229){ e.preventDefault(); add(); }
    });
    if(!box.planBound){
      box.planBound = true;
      box.addEventListener("focusout", function(e){
        if(e.relatedTarget && box.contains(e.relatedTarget)){ return; }
        // Left for another place on the page (not another window, v1.0.155): what is written in the add row is added.
        // After the press is let go: a click on another day adds it first itself (renderList), to the day it was written on.
        var leaving = document.hasFocus();
        whenReleased(function(){
          var c = readPlanTyped();
          if(leaving && c && c.text.trim() && !(c.focus)){ keepTyped(plans); return; }   // setDayPlans draws the box again
          var b = document.getElementById("planBox");
          if(b && b.stale && !b.contains(document.activeElement)){ renderPlanBox(); }
        });
      });
    }
  }

  function sheetBusy(s){ return !!s.timer || s.saving > 0; }
  function sheetsBusy(){ return SHEETS.some(sheetBusy); }
  function sheetsFailed(){ return SHEETS.some(function(s){ return s.failed; }); }

  // The sheet's file as the journal on Drive has it now: the other PC may have saved since this one
  // last read the journal. Only doc.images[s.key] is read; the rest of doc is left as it is.
  function remoteSheetId(s){
    return api.loadJournal().then(function(res){
      if(!res.exists){ return doc.images[s.key] || null; }
      return normalizeDoc(JSON.parse(res.content)).images[s.key] || null;
    }, function(){ return doc.images[s.key] || null; });
  }

  // Resolves true when s.value was replaced by what fileId holds. s.onLoad (the plans) then redraws what shows it.
  function loadSheet(s, fileId){
    return loadSheetValue(s, fileId).then(function(took){
      if(took && s.onLoad){ s.onLoad(); }
      return took;
    });
  }
  function loadSheetValue(s, fileId){
    var key = sessionKey;
    if(fileId === undefined){ fileId = doc.images[s.key] || null; }
    if(!fileId){
      s.value = s.empty(); s.fileId = null; s.ready = true;
      return Promise.resolve(true);
    }
    return api.downloadImage(fileId).then(function(bytes){
      return decryptBytes(key, bytes);
    }).then(function(plain){
      // Changed while this was on its way: that is newer, keep it.
      if(key !== sessionKey || (s.ready && sheetBusy(s))){ return false; }
      var o = JSON.parse(new TextDecoder().decode(plain));
      s.value = s.decode(o || {});
      s.fileId = fileId;
      s.ready = true;
      return true;
    }).catch(function(err){
      if(key !== sessionKey || (s.ready && sheetBusy(s))){ return false; }
      if(err && err.code === "not_found"){ s.value = s.empty(); s.fileId = null; s.ready = true; return true; }
      return false;
    });
  }

  // Uploads json as a new file, points the journal at it, then trashes the previous file.
  // salt: the journal's salt that goes with key (persist refuses the write if the passphrase changed since).
  function saveSheet(s, json, key, salt){
    if(!key){ return Promise.resolve(); }
    var bytes = new TextEncoder().encode(json);
    var uploaded = null, old = null, committed = false;
    return encryptBytes(key, bytes).then(function(enc){
      return api.uploadImage(enc, s.key);
    }).then(function(fileId){
      uploaded = fileId;
      return persist(function(d){
        old = d.images[s.key] || null;
        d.images[s.key] = fileId;
      }, salt);
    }).then(function(){
      committed = true;
      if(key === sessionKey){ s.fileId = uploaded; }
      if(old && old !== uploaded){ api.trashFiles([old]).catch(noop); }
    }, function(err){
      if(uploaded && !committed){ api.trashFiles([uploaded]).catch(noop); }
      throw err;
    });
  }

  function flushSheet(s){
    if(s.timer){ clearTimeout(s.timer); s.timer = null; }
    var o = { version:1 }, f = s.encode(s.value);
    Object.keys(f).forEach(function(k){ o[k] = f[k]; });
    // Taken now: the lock clears them right after, and the TO DO items change in place.
    var json = JSON.stringify(o), key = sessionKey, salt = doc && doc.salt;
    var failMsg = s.word + "を保存できませんでした。通信状況をご確認ください。";
    s.saving++;
    s.chain = s.chain.then(function(){ return saveSheet(s, json, key, salt); }).then(function(){
      if(key === sessionKey){ s.failed = false; }
    }, function(err){
      // The passphrase was changed on this PC meanwhile (the sheet windows stay usable while it runs):
      // send the sheet again under the new key, or the change would be lost.
      if(err && err.code === "key_changed" && sessionKey && s.ready){
        if(!s.timer){ flushSheet(s); }
        return;
      }
      if(key !== sessionKey){   // sent by the lock: the change went with it, nothing to try again
        showToast(failMsg, 4000);
        return;
      }
      if(!s.failed){ showToast(failMsg, 4000); }
      s.failed = true;
      // Try again by itself (a lock or quit sends it at once), unless a newer change is already waiting.
      if(!s.timer){ s.timer = setTimeout(function(){ flushSheet(s); }, 15000); }
    }).then(function(){ s.saving--; showSync(); });
    return s.chain;
  }

  // A change made in the sheet: saved a second after changes stop.
  function sheetChanged(s){
    if(RECORD_WIN){ return; }   // a record window never reads the sheets, so it must never write them (v1.0.216)
    if(s.timer){ clearTimeout(s.timer); }
    s.timer = setTimeout(function(){ flushSheet(s); }, 1000);
    showSync();
    if(s === todo){ renderSideTodo(); }
  }

  // Takes what the open sheet still holds outside its value (the TO DO box's text), before it goes.
  function keepTyped(s){
    if(s.keep && sessionKey && s.ready){ s.keep(); }
  }

  // Closes the window or panel that shows both sheets.
  // The plans' keep is the calendar's add row (v1.0.155), not part of this window: it stays.
  function closeSheets(){
    SHEETS_SHOWN.forEach(function(s){ keepTyped(s); s.keep = null; });
    var v = sheetView;
    if(v.win && !v.win.closed){
      try{ v.win.close(); } catch(e){}
    }
    v.win = null;
    if(v.panel){ v.panel.remove(); v.panel = null; }
    v.shown = null;
    SHEETS.forEach(function(s){ if(s.timer){ flushSheet(s); } });
  }

  // On lock: send what is waiting, close, and forget the content.
  function resetSheet(s){
    keepTyped(s);
    if(s.timer){ flushSheet(s); }
    closeSheets();
    s.value = s.empty(); s.fileId = null; s.ready = false; s.failed = false;
  }

  // Takes the other PC's sheet when it saved one since. Never while this PC has a change on its way
  // to Drive: the remote file would be older than that. Resolves true when s.value was replaced.
  function refreshSheet(s){
    if(sheetBusy(s)){ return Promise.resolve(false); }
    var key = sessionKey;
    s.checked = Date.now();
    return remoteSheetId(s).then(function(id){
      if(key !== sessionKey || sheetBusy(s)){ return false; }
      if(s.ready && id === s.fileId){ return false; }
      return loadSheet(s, id);
    });
  }

  // Opens both sheets; part (memo or todo) gets the caret: Ctrl+T the TO DO box, Ctrl+M and the button the memo.
  function openSheets(part){
    var v = sheetView;
    if(!sessionKey || v.opening){ return; }
    if(v.win && !v.win.closed){
      // A minimized window comes back (the main process restores it; focus alone would not).
      var shown = v.shown;
      (api.showSheet ? api.showSheet("memo") : Promise.reject()).catch(function(){ v.win.focus(); }).then(function(){
        if(shown && v.shown === shown){ shown.focus(part); }
      });
      return;
    }
    // The button shows and hides the panel; a minimized one comes back instead.
    if(v.panel){ if(v.panel.classList.contains("min")){ v.panel.setMin(false); } else { closeSheets(); } return; }
    v.opening = true;
    // Not read yet for this unlock: first wait for what the lock sent (see enterApp, v1.0.138).
    Promise.all(SHEETS_SHOWN.map(function(s){
      return (s.ready ? Promise.resolve() : s.chain).then(function(){ return refreshSheet(s); });
    })).then(function(){
      v.opening = false;
      if(!sessionKey){ return; }
      var missing = SHEETS_SHOWN.filter(function(s){ return !s.ready; });
      if(missing.length){
        showToast(missing.map(function(s){ return s.word; }).join("と") + "を読み込めませんでした。通信状況をご確認ください。", 4000);
        return;
      }
      if(siteApi){ openSheetWindow(part); } else { openSheetPanel(part); }
    }, function(){ v.opening = false; });
  }
  // Ctrl+M / Ctrl+T and the sidebar's TO DO list: the caret goes to part. The web panel's button closes an open
  // panel and only brings back a minimized one; these bring it back and move the caret (v1.0.166: a minimized
  // panel came back with the caret nowhere, and Ctrl+M / Ctrl+T closed an open one).
  function openSheetsAt(part){
    var v = sheetView;
    if(v.panel && v.shown){
      if(v.panel.classList.contains("min")){ v.panel.setMin(false); }
      v.shown.focus(part);
      return;
    }
    openSheets(part);
  }

  // The look of both sheets, in their windows and in the web panels alike.
  var SHEET_CSS =
    ".sheet-memo{background:#FFF6C8}.sheet-todo{background:#EAF6E5}" +
    ".sheet-body{flex:1;min-height:0;display:flex;flex-direction:column}" +
    // Both in one (v1.0.153): the list as tall as its items, up to 45% (then it scrolls); the memo takes the rest.
    ".sheet-part{display:flex;flex-direction:column;min-height:0}" +
    ".sheet-part.sheet-todo{flex:0 1 auto;max-height:45%}" +
    ".sheet-part.sheet-todo>.sheet-body,.sheet-part .todo-list{flex:0 1 auto}" +
    ".sheet-part.sheet-memo{flex:1 1 0;min-height:120px;border-top:1px solid rgba(0,0,0,.16)}" +
    ".sheet-part-head{flex:none;padding:3px 10px 0;font-size:12px;font-weight:700;opacity:.7}" +
    // The text box grows with its text and memo-area scrolls, so the strokes over it scroll with the text.
    ".memo-area{flex:1;min-height:0;position:relative;overflow:auto;outline:0}" +
    ".memo-text{display:block;box-sizing:border-box;width:100%;min-height:100%;border:0;outline:0;resize:none;overflow:hidden;padding:8px 10px;background:transparent;color:inherit;font:inherit}" +
    ".memo-draw{position:absolute;left:0;top:0;width:100%;display:block;overflow:visible;pointer-events:none}" +
    ".pen-on .memo-draw{pointer-events:auto;cursor:crosshair;touch-action:none}" +
    ".pick-on .memo-draw{pointer-events:auto;cursor:default;touch-action:none}" +
    ".memo-menu{position:fixed;z-index:200;min-width:150px;padding:4px 0;background:#fff;border:1px solid rgba(0,0,0,.2);border-radius:6px;box-shadow:0 4px 14px rgba(0,0,0,.25);font-size:13px}" +
    ".memo-menu button{display:flex;width:100%;align-items:center;border:0;background:transparent;color:#2b2b2b;font:inherit;padding:5px 12px;text-align:left;cursor:pointer}" +
    ".memo-menu button:hover:not(:disabled){background:#FFF1B0}" +
    ".memo-menu button:disabled{color:#AAA;cursor:default}" +
    ".memo-menu-key{margin-left:auto;padding-left:18px;color:#8A8A8A;font-size:12px}" +
    ".todo-list{flex:1;min-height:0;overflow:auto;margin:0;padding:6px 4px 2px;list-style:none}" +
    ".todo-item{display:flex;align-items:center;gap:2px;padding:0 2px}" +
    ".todo-check{flex:none;width:17px;height:17px;margin:0 4px 0 2px;accent-color:#3E7F35;cursor:pointer}" +
    ".todo-text{flex:1;min-width:0;border:0;outline:0;background:transparent;color:inherit;font:inherit;padding:1px 3px;border-radius:3px}" +
    ".todo-text:focus{background:rgba(255,255,255,.75)}" +
    ".todo-item.done .todo-text{text-decoration:line-through;color:#8A9A86}" +
    ".todo-del{flex:none;border:0;background:transparent;color:#7A8A76;cursor:pointer;font-size:12px;padding:2px 5px;visibility:hidden}" +
    ".todo-item:hover .todo-del,.todo-item:focus-within .todo-del{visibility:visible}" +
    "@media (hover:none){.todo-del{visibility:visible}}" +
    ".todo-empty{color:#8A9A86;font-size:13px;padding:2px 6px}" +
    ".todo-add{flex:none;margin:4px 6px;box-sizing:border-box;border:1px solid #B9D8AE;border-radius:4px;background:#fff;color:inherit;font:inherit;padding:3px 7px;outline:0}" +
    ".todo-add:focus{border-color:#3E7F35}" +
    ".sheet-foot{flex:none;display:flex;align-items:center;justify-content:flex-end;gap:6px;padding:3px 6px;font-size:12px;line-height:1.4;border-top:1px solid rgba(0,0,0,.08)}" +
    ".sheet-ask{flex:1;min-width:0}" +
    ".sheet-btn{font:inherit;font-size:12px;border:1px solid rgba(0,0,0,.22);background:rgba(255,255,255,.65);color:inherit;border-radius:4px;padding:2px 9px;cursor:pointer}" +
    ".sheet-btn:disabled{opacity:.4;cursor:default}" +
    ".sheet-btn.push{margin-left:auto}" +
    ".sheet-btn.on{background:#5A4A12;border-color:#5A4A12;color:#fff}" +
    ".sheet-btn.danger{background:#C0392B;border-color:#C0392B;color:#fff}";

  // The row of buttons under a sheet. A button that removes things asks first, in the row itself
  // (a dialog would come up behind the always-on-top window).
  // actions: [{ label, title, ask(): the question, can(): whether there is anything to remove, run(),
  //   left: kept at the left end, on(): shown pressed }]
  function sheetFoot(d, actions){
    var foot = d.createElement("div");
    foot.className = "sheet-foot";
    function buttons(){
      foot.innerHTML = "";
      actions.forEach(function(a, i){
        var b = d.createElement("button");
        b.type = "button";
        b.className = "sheet-btn";
        b.textContent = a.label;
        b.title = a.title;
        b.disabled = !a.can();
        // The first button after the left ones goes to the right end, with the rest.
        if(!a.left && i > 0 && actions[i - 1].left){ b.classList.add("push"); }
        if(a.on && a.on()){ b.classList.add("on"); }
        // A button without a question (the memo's 「✎ ペン」) acts at once.
        b.addEventListener("click", function(){
          if(!a.can()){ return; }
          if(a.ask){ ask(a); } else { a.run(); buttons(); }
        });
        foot.appendChild(b);
      });
    }
    function ask(a){
      foot.innerHTML = "";
      var q = d.createElement("span");
      q.className = "sheet-ask";
      q.textContent = a.ask();
      var yes = d.createElement("button");
      yes.type = "button";
      yes.className = "sheet-btn danger";
      yes.textContent = "消す";
      var no = d.createElement("button");
      no.type = "button";
      no.className = "sheet-btn";
      no.textContent = "やめる";
      yes.addEventListener("click", function(){ a.run(); buttons(); });
      no.addEventListener("click", buttons);
      foot.appendChild(q);
      foot.appendChild(no);
      foot.appendChild(yes);
      no.focus();
    }
    // Enables or greys out the buttons after a change (a question that is up stays).
    foot.update = function(){
      if(!foot.querySelector(".sheet-ask")){ buttons(); }
    };
    buttons();
    return foot;
  }

  // Esc closes the sheet; Esc while choosing kanji only cancels the conversion.
  function closeOnEsc(el, close){
    el.addEventListener("keydown", function(e){
      if(e.key === "Escape" && !e.isComposing && e.keyCode !== 229){ close(); }
    });
  }

  // メモの手書き (v1.0.146): strokes drawn over the memo's text with 「✎ ペン」, one width and one colour.
  // Points are the memo's own CSS pixels from the top left of its text, so the strokes scroll with the
  // text (they stay where they are when a narrower window wraps the text anew).
  var MEMO_INK = "#2B2B2B", MEMO_PEN = 2, MEMO_PICK = "#2F6FD0";
  var memoClip = null;   // the strokes copied last, while the app runs: { json, n: pastes made with Ctrl+V }
  function decodeStrokes(v){
    return (Array.isArray(v) ? v : []).map(function(s){
      var pts = (s && Array.isArray(s.points) ? s.points : []).filter(function(p){
        return Array.isArray(p) && isFinite(p[0]) && isFinite(p[1]);
      }).map(function(p){ return [+p[0], +p[1]]; });
      return { points: pts };
    }).filter(function(s){ return s.points.length > 0; });
  }
  function strokesBox(list){
    var x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    list.forEach(function(s){
      s.points.forEach(function(p){
        x1 = Math.min(x1, p[0]); x2 = Math.max(x2, p[0]);
        y1 = Math.min(y1, p[1]); y2 = Math.max(y2, p[1]);
      });
    });
    return { x:x1, y:y1, w:x2 - x1, h:y2 - y1 };
  }
  function roundPt(v){ return Math.round(v * 10) / 10; }
  function moveStrokes(list, dx, dy){
    list.forEach(function(s){
      s.points = s.points.map(function(p){ return [roundPt(p[0] + dx), roundPt(p[1] + dy)]; });
    });
  }
  // Whether p is within tol of the stroke's line.
  function nearStroke(s, p, tol){
    var pts = s.points;
    for(var i = 0; i < pts.length; i++){
      var a = pts[i], b = pts[Math.min(i + 1, pts.length - 1)];
      var vx = b[0] - a[0], vy = b[1] - a[1], len = vx * vx + vy * vy;
      var t = len ? Math.max(0, Math.min(1, ((p.x - a[0]) * vx + (p.y - a[1]) * vy) / len)) : 0;
      var dx = a[0] + t * vx - p.x, dy = a[1] + t * vy - p.y;
      if(dx * dx + dy * dy <= tol * tol){ return true; }
    }
    return false;
  }
  function strokePath(pts){
    var out = "M" + pts[0][0] + " " + pts[0][1];
    if(pts.length === 1){ return out + "l0.01 0"; }   // a dot (the line's ends are round)
    for(var i = 1; i < pts.length; i++){ out += "L" + pts[i][0] + " " + pts[i][1]; }
    return out;
  }

  // The memo: the text box, the strokes drawn over it, and 「✎ ペン」「🗑 全部消す」 under them.
  // Pen off: the text works as before and the strokes only show. Pen on: the left button draws, and the pen
  // stays on for the next stroke (handwriting takes many). A right click on a stroke picks it and shows
  // コピー・貼り付け・削除 (貼り付け puts the copies where the click was). Ctrl+click picks more, Ctrl+drag picks the
  // ones inside a box, Ctrl+A all; picked ones move by dragging or with the arrow keys. Ctrl+C, Ctrl+V (beside
  // the copied ones), Delete, Ctrl+Z and Ctrl+Y act on the strokes. A press elsewhere lets go of picked ones.
  // 「⬚ 選択」 (v1.0.147, for the iPhone, which has no right click, Ctrl or Delete): a tap on a stroke picks it
  // and a drag from there moves it, a drag on an empty spot picks the strokes inside the box, a tap there
  // lets go; 「✕ 削除」 removes the picked ones.
  memo.build = function(d, close, isOpen){
    var SVG = "http://www.w3.org/2000/svg", win = d.defaultView;
    var box = d.createElement("div");
    box.className = "sheet-body";
    var area = d.createElement("div");
    area.className = "memo-area";
    area.tabIndex = -1;   // takes the keys while the pen is on
    var ta = d.createElement("textarea");
    ta.className = "memo-text";
    ta.value = memo.value.text;
    ta.spellcheck = false;
    ta.placeholder = "ここにメモ（自動で保存されます）";
    var svg = d.createElementNS(SVG, "svg");
    svg.setAttribute("class", "memo-draw");
    area.appendChild(ta);
    area.appendChild(svg);

    var mode = null;          // null: the text, "pen": draws, "pick": picks and moves
    var picked = [];          // the picked strokes (objects in memo.value.draw)
    var shownPick = false;    // whether 「✕ 削除」 was last shown enabled
    var current = null;       // the stroke being drawn
    var livePath = null;      // its path, changed as it grows
    var letGo = false;        // the press that started it let go of picked strokes: a click alone draws no dot
    var drag = null;          // moving the picked strokes: { start, orig: their points before, moved }
    var marquee = null;       // Ctrl+drag on an empty spot: { x1, y1, x2, y2 }
    var menu = null, menuArmed = false, menuAt = null;
    var undo = [], redo = [];

    var foot = sheetFoot(d, [{
      label: "✎ ペン", title: "手書きで描く（もう一度押すと文字に戻る）", left: true,
      can: function(){ return true; },
      on: function(){ return mode === "pen"; },
      run: function(){ setMode(mode === "pen" ? null : "pen"); }
    }, {
      label: "⬚ 選択", title: "手書きの線を押して選ぶ・囲んで選ぶ・動かす（もう一度押すと文字に戻る）", left: true,
      can: function(){ return true; },
      on: function(){ return mode === "pick"; },
      run: function(){ setMode(mode === "pick" ? null : "pick"); }
    }, {
      label: "✕ 削除", title: "選んだ線を消す（Delete）", left: true,
      can: function(){ return picked.length > 0; },
      run: function(){ remove(); area.focus({ preventScroll:true }); }
    }, {
      label: "🗑 全部消す", title: "メモの文字と手書きを全部消す",
      ask: function(){ return "メモを全部消しますか？"; },
      can: function(){ return ta.value !== "" || memo.value.draw.length > 0; },
      run: function(){
        if(memo.value.draw.length){ snapshot(); }
        ta.value = "";
        memo.value.text = "";
        memo.value.draw = [];
        picked = [];
        sheetChanged(memo);
        fitText();
        draw();
        (mode ? area : ta).focus({ preventScroll:true });
      }
    }]);

    // Between the pen and 選択 the picked strokes stay picked; back to the text lets go of them.
    function setMode(m){
      mode = m;
      box.classList.toggle("pen-on", mode === "pen");
      box.classList.toggle("pick-on", mode === "pick");
      if(!mode){ picked = []; }
      current = null; drag = null; marquee = null;
      svg.style.cursor = "";
      closeMenu();
      draw();
      (mode ? area : ta).focus({ preventScroll:true });
    }
    function changed(){
      sheetChanged(memo);
      foot.update();
    }
    function snapshot(){
      undo.push(JSON.stringify(memo.value.draw));
      if(undo.length > 100){ undo.shift(); }
      redo = [];
    }
    // Ctrl+Z: undoRedo(undo, redo); Ctrl+Y: undoRedo(redo, undo).
    function undoRedo(from, to){
      if(!from.length){ return; }
      to.push(JSON.stringify(memo.value.draw));
      memo.value.draw = decodeStrokes(JSON.parse(from.pop()));
      picked = [];
      draw();
      changed();
    }

    // The text box grows with its text (memo-area scrolls); the drawing is as tall as the text or the lowest stroke.
    // Not while hidden (the web panel minimized): everything measures 0 there, which left the box one memo
    // tall and the rest of the text cut off once it came back. The panel calls fit when it is shown again.
    function shown(){ return area.getClientRects().length > 0; }
    function fitText(){
      if(!shown()){ return; }
      var top = area.scrollTop;
      ta.style.height = "auto";
      // No taller than the memo while the text fits (a fraction of a pixel over would bring a scroll bar).
      ta.style.height = ta.scrollHeight > area.clientHeight ? ta.scrollHeight + "px" : "";
      area.scrollTop = top;
      fitDraw();
    }
    function fitDraw(){
      if(!shown()){ return; }
      var h = ta.offsetHeight;
      if(memo.value.draw.length){ var b = strokesBox(memo.value.draw); h = Math.max(h, b.y + b.h + 8); }
      svg.style.height = h + "px";
    }
    function add(name, attrs){
      var n = d.createElementNS(SVG, name);
      Object.keys(attrs).forEach(function(k){ n.setAttribute(k, attrs[k]); });
      svg.appendChild(n);
      return n;
    }
    function inkPath(s){
      return add("path", { d: strokePath(s.points), fill: "none", stroke: MEMO_INK, "stroke-width": MEMO_PEN,
        "stroke-linecap": "round", "stroke-linejoin": "round" });
    }
    function draw(){
      svg.textContent = "";
      memo.value.draw.forEach(inkPath);
      livePath = current ? inkPath(current) : null;
      picked.forEach(function(s){
        var f = frameOf(s);
        add("rect", { x: f.x, y: f.y, width: f.w, height: f.h, fill: "none", stroke: MEMO_PICK, "stroke-width": 1, "stroke-dasharray": "4 3" });
      });
      if(marquee){
        var m = norm(marquee);
        add("rect", { x: m.x, y: m.y, width: m.w, height: m.h, fill: "rgba(47,111,208,.08)", stroke: MEMO_PICK, "stroke-width": 1, "stroke-dasharray": "4 3" });
      }
      fitDraw();
      if((picked.length > 0) !== shownPick){ shownPick = picked.length > 0; foot.update(); }
    }
    function frameOf(s){
      var b = strokesBox([s]);
      return { x: b.x - 4, y: b.y - 4, w: b.w + 8, h: b.h + 8 };
    }
    function inFrame(s, p){
      var f = frameOf(s);
      return p.x >= f.x && p.x <= f.x + f.w && p.y >= f.y && p.y <= f.y + f.h;
    }
    function onPicked(p){ return picked.some(function(s){ return inFrame(s, p); }); }
    function norm(r){
      return { x: Math.min(r.x1, r.x2), y: Math.min(r.y1, r.y2), w: Math.abs(r.x2 - r.x1), h: Math.abs(r.y2 - r.y1) };
    }
    // The stroke under p (the one drawn last wins), or null.
    function hitAt(p, touch){
      var list = memo.value.draw, tol = touch ? 12 : 6;
      for(var i = list.length - 1; i >= 0; i--){
        if(nearStroke(list[i], p, tol)){ return list[i]; }
      }
      return null;
    }
    // The pointer on the drawing, kept off the left, top and right edges.
    function at(e){
      var r = svg.getBoundingClientRect();
      return { x: Math.max(0, Math.min(e.clientX - r.left, r.width)), y: Math.max(0, e.clientY - r.top) };
    }
    // Moves strokes back onto the memo when they went past its left, top or right edge.
    function keepIn(list){
      var b = strokesBox(list), w = svg.getBoundingClientRect().width;
      var dx = b.x < 0 ? -b.x : (b.x + b.w > w ? Math.max(w - b.x - b.w, -b.x) : 0);
      var dy = b.y < 0 ? -b.y : 0;
      if(dx || dy){ moveStrokes(list, dx, dy); }
    }

    function copy(){
      if(picked.length){ memoClip = { json: JSON.stringify(picked), n: 0 }; }
    }
    // Ctrl+V: beside the copied ones (a little further each time); from the menu: where the right click was.
    // The copies are picked, so they can be moved at once.
    function paste(p){
      if(!memoClip){ return; }
      var list = decodeStrokes(JSON.parse(memoClip.json));
      if(!list.length){ return; }
      if(p){
        var b = strokesBox(list);
        moveStrokes(list, p.x - b.x, p.y - b.y);
      } else {
        memoClip.n++;
        moveStrokes(list, 20 * memoClip.n, 20 * memoClip.n);
      }
      keepIn(list);
      snapshot();
      list.forEach(function(s){ memo.value.draw.push(s); });
      picked = list;
      draw();
      changed();
    }
    function remove(){
      if(!picked.length){ return; }
      snapshot();
      memo.value.draw = memo.value.draw.filter(function(s){ return picked.indexOf(s) < 0; });
      picked = [];
      draw();
      changed();
    }

    // The right-click menu at screen point (x, y).
    function openMenu(x, y){
      closeMenu();
      var p = menuAt;
      menu = d.createElement("div");
      menu.className = "memo-menu";
      [["copy", "コピー", "Ctrl+C", picked.length > 0],
       ["paste", "貼り付け", "Ctrl+V", !!memoClip],
       ["remove", "削除", "Delete", picked.length > 0]].forEach(function(m){
        var b = d.createElement("button");
        b.type = "button";
        b.setAttribute("data-act", m[0]);
        b.disabled = !m[3];
        b.innerHTML = m[1] + '<span class="memo-menu-key">' + m[2] + '</span>';
        menu.appendChild(b);
      });
      box.appendChild(menu);
      // Kept inside the window: opened up or to the left when it would run off the edge.
      var r = menu.getBoundingClientRect(), vw = d.documentElement.clientWidth, vh = d.documentElement.clientHeight;
      menu.style.left = Math.max(4, x + r.width > vw - 4 ? x - r.width : x) + "px";
      menu.style.top = Math.max(4, y + r.height > vh - 4 ? y - r.height : y) + "px";
      menu.addEventListener("click", function(e){
        var b = e.target.closest("button");
        if(!b || b.disabled){ return; }
        closeMenu();
        var act = b.getAttribute("data-act");
        if(act === "copy"){ copy(); } else if(act === "paste"){ paste(p); } else { remove(); }
        area.focus({ preventScroll:true });
      });
      d.addEventListener("pointerdown", menuAway, true);
      win.addEventListener("blur", closeMenu);
    }
    function closeMenu(){
      if(!menu){ return; }
      menu.remove();
      menu = null;
      d.removeEventListener("pointerdown", menuAway, true);
      win.removeEventListener("blur", closeMenu);
    }
    function menuAway(e){ if(menu && !menu.contains(e.target)){ closeMenu(); } }
    area.addEventListener("scroll", closeMenu);

    // Right press: picks the stroke under the pointer (picked ones stay picked, so the menu acts on all of
    // them; an empty spot lets go). The menu opens on the contextmenu event, after the button is let go.
    function rightPress(e){
      var p = at(e), s = hitAt(p, e.pointerType === "touch");
      if(s){ if(picked.indexOf(s) < 0){ picked = [s]; } }
      else if(!onPicked(p)){ picked = []; }
      menuAt = p;
      menuArmed = picked.length > 0 || !!memoClip;
      draw();
    }
    svg.addEventListener("contextmenu", function(e){
      e.preventDefault();
      if(menuArmed){ openMenu(e.clientX, e.clientY); }
      menuArmed = false;
    });
    svg.addEventListener("pointerdown", function(e){
      if(!mode){ return; }
      if(e.button === 2){ rightPress(e); return; }
      if(e.button !== 0){ return; }
      e.preventDefault();
      area.focus({ preventScroll:true });
      var p = at(e), s = hitAt(p, e.pointerType === "touch");
      if(e.ctrlKey || e.metaKey){
        if(s){
          var i = picked.indexOf(s);
          if(i >= 0){ picked.splice(i, 1); } else { picked.push(s); }
          draw();
        } else {
          marquee = { x1: p.x, y1: p.y, x2: p.x, y2: p.y };
          svg.setPointerCapture(e.pointerId);
        }
        return;
      }
      // 選択: a stroke that is not picked yet is picked alone, and the same press can move it.
      if(mode === "pick" && s && picked.indexOf(s) < 0){ picked = [s]; draw(); }
      if((mode === "pick" && s) || (picked.length && onPicked(p))){
        drag = { start: p, orig: picked.map(function(s){ return s.points; }), moved: false };
        svg.setPointerCapture(e.pointerId);
        return;
      }
      if(mode === "pick"){
        // An empty spot lets go; dragging from it picks the strokes inside the box.
        picked = [];
        marquee = { x1: p.x, y1: p.y, x2: p.x, y2: p.y };
        svg.setPointerCapture(e.pointerId);
        draw();
        return;
      }
      letGo = picked.length > 0;
      picked = [];
      current = { points: [[roundPt(p.x), roundPt(p.y)]] };
      svg.setPointerCapture(e.pointerId);
      draw();
    });
    svg.addEventListener("pointermove", function(e){
      if(!mode){ return; }
      var p = at(e);
      if(current){
        var last = current.points[current.points.length - 1], q = [roundPt(p.x), roundPt(p.y)];
        if(q[0] !== last[0] || q[1] !== last[1]){
          current.points.push(q);
          if(livePath){ livePath.setAttribute("d", strokePath(current.points)); }
        }
        return;
      }
      if(drag){
        var dx = p.x - drag.start.x, dy = p.y - drag.start.y;
        if(!drag.moved){
          if(!dx && !dy){ return; }
          snapshot();
          drag.moved = true;
        }
        picked.forEach(function(s, j){ s.points = drag.orig[j]; });
        moveStrokes(picked, dx, dy);
        keepIn(picked);
        draw();
        return;
      }
      if(marquee){
        marquee.x2 = p.x; marquee.y2 = p.y;
        draw();
        return;
      }
      // Over picked strokes: they move. Ctrl (or 選択) over a stroke: a click picks it.
      svg.style.cursor = picked.length && onPicked(p) ? "move" : (mode === "pick" || e.ctrlKey || e.metaKey) && hitAt(p) ? "pointer" : "";
    });
    function endPress(){
      if(current){
        var s = current;
        current = null;
        if(!(letGo && s.points.length === 1)){
          snapshot();
          memo.value.draw.push(s);
          changed();
        }
        letGo = false;
        draw();
      } else if(drag){
        var moved = drag.moved;
        drag = null;
        if(moved){ changed(); }
        draw();
      } else if(marquee){
        // Ctrl+drag adds the strokes wholly inside the box to the picked ones (選択 let go of them first).
        var m = norm(marquee);
        marquee = null;
        if(m.w > 2 || m.h > 2){
          memo.value.draw.forEach(function(s){
            var b = strokesBox([s]);
            if(b.x >= m.x && b.y >= m.y && b.x + b.w <= m.x + m.w && b.y + b.h <= m.y + m.h && picked.indexOf(s) < 0){ picked.push(s); }
          });
        }
        draw();
      }
    }
    svg.addEventListener("pointerup", endPress);
    svg.addEventListener("pointercancel", endPress);

    // The keys for the strokes, while the pen or 選択 is on (the text box has its own Ctrl+C and the rest).
    area.addEventListener("keydown", function(e){
      if(!mode || e.target === ta || e.isComposing){ return; }
      var k = String(e.key).toLowerCase(), ctrl = (e.ctrlKey || e.metaKey) && !e.altKey;
      if(ctrl && k === "c" && !e.shiftKey){ copy(); }
      else if(ctrl && k === "v" && !e.shiftKey){ paste(null); }
      else if(ctrl && k === "a" && !e.shiftKey){ picked = memo.value.draw.slice(); draw(); }
      else if(ctrl && (k === "y" || (k === "z" && e.shiftKey))){ undoRedo(redo, undo); }
      else if(ctrl && k === "z"){ undoRedo(undo, redo); }
      else if(!ctrl && (e.key === "Delete" || e.key === "Backspace")){ remove(); }
      else if(!ctrl && /^Arrow/.test(e.key) && picked.length){
        var n = e.shiftKey ? 10 : 1;
        snapshot();
        moveStrokes(picked, e.key === "ArrowLeft" ? -n : e.key === "ArrowRight" ? n : 0, e.key === "ArrowUp" ? -n : e.key === "ArrowDown" ? n : 0);
        keepIn(picked);
        draw();
        changed();
      }
      else if(e.key === "Escape" && (menu || picked.length)){ closeMenu(); picked = []; draw(); }
      else { return; }
      e.preventDefault();
      e.stopPropagation();   // Esc here only lets go; the next one closes the memo
    });

    // The browser shows the caret before the text box grows, inside the box itself; once it has grown,
    // memo-area has to be scrolled to it (measured on a hidden copy of the text up to the caret).
    function revealCaret(){
      if(d.activeElement !== ta){ return; }
      var cs = win.getComputedStyle(ta), m = d.createElement("div"), mark = d.createElement("span");
      ["boxSizing", "width", "paddingTop", "paddingLeft", "paddingRight", "fontFamily", "fontSize", "fontWeight",
       "lineHeight", "letterSpacing", "tabSize"].forEach(function(k){ m.style[k] = cs[k]; });
      m.style.position = "absolute"; m.style.left = "0"; m.style.top = "0"; m.style.visibility = "hidden";
      m.style.whiteSpace = "pre-wrap"; m.style.overflowWrap = "break-word";
      m.textContent = ta.value.slice(0, ta.selectionEnd);
      mark.textContent = "​";
      m.appendChild(mark);
      area.appendChild(m);
      var top = mark.offsetTop, bottom = top + mark.offsetHeight + parseFloat(cs.paddingBottom || 0);
      m.remove();
      if(top < area.scrollTop){ area.scrollTop = top; }
      else if(bottom > area.scrollTop + area.clientHeight){ area.scrollTop = bottom - area.clientHeight; }
    }
    ta.addEventListener("input", function(){
      memo.value.text = ta.value;
      fitText();
      revealCaret();
      changed();
    });
    // A narrower or wider window wraps the text anew.
    function onResize(){
      if(!isOpen()){ win.removeEventListener("resize", onResize); return; }
      fitText();
    }
    win.addEventListener("resize", onResize);
    // The TO DO list above it grows and shrinks with its items (v1.0.153), and the memo with it.
    if(win.ResizeObserver){
      var seen = new win.ResizeObserver(function(){
        if(!isOpen()){ seen.disconnect(); return; }
        fitText();
      });
      seen.observe(area);
    }
    closeOnEsc(box, close);
    box.appendChild(area);
    box.appendChild(foot);
    draw();
    // Measured once it is on the page (the web version on an iPhone does not call focus).
    win.requestAnimationFrame(fitText);
    return {
      el: box,
      fit: fitText,   // shown again after being minimized (web panel)
      focus: function(){
        fitText();
        ta.focus({ preventScroll:true });
        ta.setSelectionRange(ta.value.length, ta.value.length);
        area.scrollTop = Math.max(0, ta.offsetHeight - area.clientHeight);   // the end of the text, where the caret is
      },
      // Coming back to the memo: show what the other PC saved meanwhile (at most every 10 s).
      // refreshSheet takes it only while nothing here is waiting to be saved.
      recheck: function(){
        if(Date.now() - memo.checked < 10000){ return; }
        refreshSheet(memo).then(function(took){
          if(!took || !isOpen()){ return; }
          if(ta.value !== memo.value.text){ ta.value = memo.value.text; }
          picked = []; drag = null; marquee = null; undo = []; redo = [];
          closeMenu();
          fitText();
          draw();
          foot.update();
        }).catch(noop);
      }
    };
  };

  // The TO DO list: a tick, the text (can be changed in place) and ✕ on each item; a box under them
  // adds one with Enter; 「済みを消す」 removes the ticked ones.
  todo.build = function(d, close, isOpen){
    var box = d.createElement("div");
    box.className = "sheet-body";
    var list = d.createElement("ul");
    list.className = "todo-list";
    var add = d.createElement("input");
    add.type = "text";
    add.className = "todo-add";
    add.spellcheck = false;
    add.placeholder = "＋ 新しい項目（Enter で追加）";
    var foot = sheetFoot(d, [{
      label: "済みを消す", title: "印を付けた項目を消す",
      ask: function(){ return "済みの項目（" + doneCount() + "件）を消しますか？"; },
      can: function(){ return doneCount() > 0; },
      run: function(){
        todo.value = todo.value.filter(function(it){ return !it.done; });
        render();
        changed();
      }
    }]);
    function doneCount(){
      return todo.value.filter(function(it){ return it.done; }).length;
    }
    function changed(){
      sheetChanged(todo);
      foot.update();
    }
    // Draws the items from todo.value (each row changes its item in place).
    function render(){
      list.innerHTML = "";
      if(!todo.value.length){
        var none = d.createElement("li");
        none.className = "todo-empty";
        none.textContent = "項目はまだありません";
        list.appendChild(none);
      }
      todo.value.forEach(function(it){
        var li = d.createElement("li");
        li.className = "todo-item" + (it.done ? " done" : "");
        var cb = d.createElement("input");
        cb.type = "checkbox";
        cb.className = "todo-check";
        cb.checked = it.done;
        cb.title = "済みの印";
        cb.addEventListener("change", function(){
          it.done = cb.checked;
          li.classList.toggle("done", it.done);
          changed();
        });
        var tx = d.createElement("input");
        tx.type = "text";
        tx.className = "todo-text";
        tx.spellcheck = false;
        tx.value = it.text;
        tx.addEventListener("input", function(){
          it.text = tx.value;
          changed();
        });
        tx.addEventListener("keydown", function(e){
          if(e.key === "Enter" && !e.isComposing && e.keyCode !== 229){
            e.preventDefault();
            add.focus();
          }
        });
        var del = d.createElement("button");
        del.type = "button";
        del.className = "todo-del";
        del.textContent = "✕";
        del.title = "この項目を消す";
        del.addEventListener("click", function(){
          var i = todo.value.indexOf(it);
          if(i >= 0){ todo.value.splice(i, 1); }
          render();
          changed();
        });
        li.appendChild(cb);
        li.appendChild(tx);
        li.appendChild(del);
        list.appendChild(li);
      });
      foot.update();
    }
    // What is written in the box becomes an item.
    function addTyped(){
      var text = add.value.trim();
      if(!text){ return; }
      todo.value.push({ text: text, done: false });
      add.value = "";
      render();
      changed();
      list.scrollTop = list.scrollHeight;
    }
    add.addEventListener("keydown", function(e){
      if(e.key !== "Enter" || e.isComposing || e.keyCode === 229){ return; }
      e.preventDefault();
      addTyped();
    });
    closeOnEsc(box, close);
    box.appendChild(list);
    box.appendChild(add);
    box.appendChild(foot);
    render();
    return {
      el: box,
      focus: function(){ add.focus(); },
      // Closed with text still in the box (v1.0.152): with Japanese input the first Enter only fixes the
      // conversion, so the item was easily never added, and closing lost it.
      keep: addTyped,
      // Coming back to the list: show what the other PC saved meanwhile (at most every 10 s).
      // Drawn again whenever todo.value was replaced, so the rows change the items it now holds.
      recheck: function(){
        if(Date.now() - todo.checked < 10000){ return; }
        refreshSheet(todo).then(function(took){
          if(took && isOpen()){ render(); }
        }).catch(noop);
      }
    };
  };

  // Both sheets in one (v1.0.153): the TO DO list above, the memo under it, each with its own buttons.
  // Each part keeps its own colour, and Esc anywhere closes the whole.
  var SHEETS_SHOWN = [todo, memo];   // top to bottom
  function buildSheets(d, close, isOpen){
    var box = d.createElement("div");
    box.className = "sheet-body";
    var parts = {};
    SHEETS_SHOWN.forEach(function(s){
      var sec = d.createElement("section");
      sec.className = "sheet-part sheet-" + s.key;
      var head = d.createElement("div");
      head.className = "sheet-part-head";
      head.textContent = s.icon + " " + s.word;
      var shown = s.build(d, close, isOpen);
      sec.appendChild(head);
      sec.appendChild(shown.el);
      box.appendChild(sec);
      s.keep = shown.keep || null;
      parts[s.key] = shown;
    });
    return {
      el: box,
      focus: function(part){ parts[(part || memo).key].focus(); },
      fit: function(){ if(parts.memo.fit){ parts.memo.fit(); } },
      recheck: function(){ SHEETS_SHOWN.forEach(function(s){ parts[s.key].recheck(); }); }
    };
  }

  // Windows app: a small window of its own, always on top (main.js allows the name "memo").
  function openSheetWindow(part){
    var w = window.open("", "memo");
    if(!w){ return; }
    sheetView.win = w;
    var d = w.document;
    d.title = "メモ・TO DO — 航海日誌";
    d.documentElement.lang = "ja";
    d.body.className = "sheet-memo";
    var st = d.createElement("style");
    st.textContent = "html,body{height:100%;margin:0}body{display:flex;flex-direction:column;color:#2b2b2b;font:15px/1.6 'Yu Gothic UI',sans-serif}" + SHEET_CSS;
    d.head.appendChild(st);
    var shown = buildSheets(d, function(){ w.close(); }, function(){ return sheetView.win === w; });
    sheetView.shown = shown;
    d.body.appendChild(shown.el);
    w.addEventListener("focus", shown.recheck);
    w.addEventListener("pagehide", function(){
      if(sheetView.win === w){
        SHEETS_SHOWN.forEach(function(s){ keepTyped(s); s.keep = null; });
        sheetView.win = null; sheetView.shown = null;
      }
      SHEETS.forEach(function(s){ if(s.timer){ flushSheet(s); } });
    });
    shown.focus(part);
  }

  // Web version (iPhone, iPad): a browser cannot open a small window on top, so the sheet floats over
  // the page instead. It stays while moving between screens; drag its title bar to move it.
  var sheetCssAdded = false;
  function openSheetPanel(part){
    if(!sheetCssAdded){
      var st = document.createElement("style");
      st.textContent = SHEET_CSS;
      document.head.appendChild(st);
      sheetCssAdded = true;
    }
    var placeKey = "memo-panel-place";   // where it was dragged to, on this device only
    var p = document.createElement("div");
    p.className = "sheet-panel sheet-memo";
    p.innerHTML = '<div class="sheet-head"><span class="sheet-title"></span><span class="sheet-head-btns">' +
      '<button type="button" class="sheet-min"></button><button type="button" class="sheet-close" title="閉じる">✕</button></span></div>';
    p.querySelector(".sheet-title").textContent = "📝 メモ・✅ TO DO";
    var close = closeSheets;
    var sheet = buildSheets(document, close, function(){ return sheetView.panel === p; });
    p.appendChild(sheet.el);
    document.body.appendChild(p);
    sheetView.panel = p;
    sheetView.shown = sheet;
    p.querySelector(".sheet-close").addEventListener("click", close);
    // 最小化 (v1.0.148): only the title bar stays, where it was; 「□」 or the top-bar button brings the rest back.
    var minBtn = p.querySelector(".sheet-min");
    p.setMin = function(on){
      if(on && p.contains(document.activeElement)){ document.activeElement.blur(); }
      p.classList.toggle("min", on);
      minBtn.textContent = on ? "□" : "－";
      minBtn.title = on ? "元の大きさに戻す" : "最小化";
      if(p.style.left){ placeSheetPanel(p, parseFloat(p.style.left), parseFloat(p.style.top)); }
      if(!on && sheet.fit){ sheet.fit(); }   // what changed while hidden (a turned iPhone, the other device's memo)
    };
    p.setMin(false);
    minBtn.addEventListener("click", function(){ p.setMin(!p.classList.contains("min")); });
    p.addEventListener("focusin", sheet.recheck);
    p.recheck = sheet.recheck;
    try{
      var at = JSON.parse(localStorage.getItem(placeKey) || "null");
      if(at && isFinite(at.x) && isFinite(at.y)){ placeSheetPanel(p, at.x, at.y); }
    } catch(e){}

    var head = p.querySelector(".sheet-head"), drag = null;
    head.addEventListener("pointerdown", function(e){
      if(e.target.closest(".sheet-head-btns")){ return; }
      var r = p.getBoundingClientRect();
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top, id: e.pointerId };
      try{ head.setPointerCapture(e.pointerId); } catch(err){}
      e.preventDefault();
    });
    head.addEventListener("pointermove", function(e){
      if(!drag || e.pointerId !== drag.id){ return; }
      placeSheetPanel(p, e.clientX - drag.dx, e.clientY - drag.dy);
    });
    function endDrag(){
      if(!drag){ return; }
      drag = null;
      var r = p.getBoundingClientRect();
      try{ localStorage.setItem(placeKey, JSON.stringify({ x: r.left, y: r.top })); } catch(err){}
    }
    head.addEventListener("pointerup", endDrag);
    head.addEventListener("pointercancel", endDrag);
    // A tap on the iPhone keyboard's own fields would scroll the page; the sheet is focused on purpose only.
    if(!window.matchMedia || !window.matchMedia("(pointer: coarse)").matches){
      sheet.focus(part);
    }
  }
  // Keeps the panel inside the screen (also after turning the iPad).
  function placeSheetPanel(p, x, y){
    var w = p.offsetWidth, h = p.offsetHeight;
    x = Math.max(4, Math.min(x, window.innerWidth - w - 4));
    y = Math.max(4, Math.min(y, window.innerHeight - h - 4));
    p.style.left = x + "px";
    p.style.top = y + "px";
    p.style.right = "auto";
  }
  window.addEventListener("resize", function(){
    var p = sheetView.panel;
    if(p && p.style.left){ placeSheetPanel(p, parseFloat(p.style.left), parseFloat(p.style.top)); }
  });
  // Back on the page (iPhone: after another app): look for the other device's sheets.
  document.addEventListener("visibilitychange", function(){
    var p = sheetView.panel;
    if(document.visibilityState === "visible" && p && p.recheck){ p.recheck(); }
    SHEETS.forEach(function(s){
      if(document.visibilityState === "hidden" && s.timer){ flushSheet(s); }
    });
  });

  (function initSheets(){
    document.getElementById("memoBtn").addEventListener("click", function(){ openSheets(memo); });
    // Ctrl+M: the caret in the memo, Ctrl+T: in the TO DO box (the same window).
    var KEYS = { m: memo, t: todo };
    document.addEventListener("keydown", function(e){
      var s = KEYS[String(e.key).toLowerCase()];
      if(s && !RECORD_WIN && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && sessionKey && appEl.style.display !== "none"){
        e.preventDefault();
        openSheetsAt(s);
      }
    });
  })();

  // Called on lock: every page goes (a site may show private things too).
  function resetSites(){
    if(siteApi){ siteApi.closeAll().catch(noop); }   // also the pop-ups of tabs already closed
    siteTabs = [];
    activeSiteTab = null;
    shownSiteTab = null;
    siteNotice = null;
    siteList = null;
    siteLoadError = false;
    document.body.classList.remove("site-mode");
    document.getElementById("siteHost").hidden = true;
    renderSiteTabs();
    renderSites();
  }

  // The page is drawn above everything else in the window, so it steps aside while one of the
  // app's own dialogs is open (they are added to <body>) and comes back when it closes.
  function siteModalOpen(){ return !!document.querySelector("body > .modal-backdrop"); }
  function syncSiteView(){
    if(!siteApi){ return; }
    var want = activeSiteTab != null && !siteModalOpen() && appEl.style.display !== "none" ? activeSiteTab : null;
    if(want === shownSiteTab){ return; }
    shownSiteTab = want;
    if(want != null){ reportSiteBounds(); }
    siteApi.show(want).catch(noop);
  }
  if(siteApi){
    new MutationObserver(syncSiteView).observe(document.body, { childList:true });
  }

  // The site area starts below the top bar, beside the sidebar (above the page on a narrow window).
  function layoutSiteHost(){
    var top = document.querySelector("header.topbar").getBoundingClientRect().bottom;
    var side = document.querySelector("nav.sidebar").getBoundingClientRect();
    var stacked = side.width > window.innerWidth * 0.6;
    var root = document.documentElement.style;
    root.setProperty("--site-top", Math.round(stacked ? Math.max(top, side.bottom) : top) + "px");
    root.setProperty("--site-left", Math.round(stacked ? 0 : side.right) + "px");
    reportSiteBounds();
  }
  function reportSiteBounds(){
    if(!siteApi || activeSiteTab == null){ return; }
    var r = document.getElementById("siteFrame").getBoundingClientRect();
    siteApi.setBounds({ x:r.left, y:r.top, width:r.width, height:r.height }).catch(noop);
  }
  if(siteApi && window.ResizeObserver){
    var siteResize = new ResizeObserver(function(){ if(activeSiteTab != null){ layoutSiteHost(); } });
    siteResize.observe(document.getElementById("siteFrame"));
    siteResize.observe(document.querySelector("header.topbar"));
    siteResize.observe(document.querySelector("nav.sidebar"));
  }
  window.addEventListener("resize", function(){ if(activeSiteTab != null){ layoutSiteHost(); } });

  function siteTabLabel(t){
    return t.name || t.title || (t.url ? siteAddressLabel({ url:t.url }) : "ページ");
  }
  function renderSiteTabs(){
    var box = document.getElementById("siteTabs");
    box.classList.toggle("on", siteTabs.length > 0);
    if(!siteTabs.length){ box.innerHTML = ""; return; }
    box.innerHTML =
      '<button type="button" class="site-tab site-tab-journal' + (activeSiteTab == null ? ' active' : '') + '" data-tab="journal" role="tab" title="日誌に戻る">📖 日誌</button>' +
      siteTabs.map(function(t){
        var label = siteTabLabel(t);
        return '<span class="site-tab' + (t.id === activeSiteTab ? ' active' : '') + '" role="tab">' +
                 '<button type="button" class="site-tab-name" data-tab="' + t.id + '" title="' + escapeHtml(t.title || label) + '">' +
                   (t.loading ? '<span class="site-spin" aria-hidden="true"></span>' : '') + escapeHtml(label) +
                 '</button>' +
                 '<button type="button" class="site-tab-close" data-close="' + t.id + '" title="閉じる（Ctrl+W）" aria-label="閉じる">×</button>' +
               '</span>';
      }).join("");
    Array.prototype.forEach.call(box.querySelectorAll("[data-tab]"), function(b){
      b.addEventListener("click", function(){
        var v = b.getAttribute("data-tab");
        showSiteTab(v === "journal" ? null : Number(v));
      });
    });
    Array.prototype.forEach.call(box.querySelectorAll("[data-close]"), function(b){
      b.addEventListener("click", function(e){
        e.stopPropagation();
        closeSiteTab(Number(b.getAttribute("data-close")));
      });
    });
  }

  function renderSiteBar(){
    var t = siteTabById(activeSiteTab);
    if(!t){ return; }
    document.getElementById("siteBack").disabled = !t.canBack;
    document.getElementById("siteForward").disabled = !t.canForward;
    document.getElementById("siteAddress").textContent = t.isFile ? "このパソコンのページ" : t.url;
    document.getElementById("siteAddress").title = t.isFile ? "" : t.url;
    document.getElementById("siteSave").hidden = t.isFile || !!t.linkId || !/^https?:/i.test(t.url || "");
    var status = document.getElementById("siteStatus");
    status.innerHTML = "";
    if(siteNotice){
      status.textContent = siteNotice.text;
      if(siteNotice.file){
        var b = document.createElement("button");
        b.type = "button";
        b.className = "link-btn";
        b.textContent = "フォルダを開く";
        var file = siteNotice.file;
        b.addEventListener("click", function(){ siteApi.showDownload(file).catch(noop); });
        status.appendChild(b);
      }
    } else if(t.error){
      status.textContent = "読み込めませんでした（" + t.error + "）";
      status.classList.add("bad");
    } else if(t.loading){
      status.textContent = "読み込み中…";
    }
    status.classList.toggle("bad", !siteNotice && !!t.error);
    document.getElementById("siteFrameNote").textContent = t.error ? "ページを読み込めませんでした。インターネットの接続を確かめて「⟳」を押してください。" : "";
  }

  if(siteApi){
    siteApi.onEvent(function(ev){
      if(!sessionKey){ return; }
      if(ev.type === "tab"){
        var t = siteTabById(ev.id);
        if(!t){ return; }
        if(ev.loading && !t.loading){ t.error = null; }
        t.title = ev.title; t.url = ev.url; t.isFile = ev.isFile;
        t.canBack = ev.canBack; t.canForward = ev.canForward; t.loading = ev.loading;
        renderSiteTabs();
        if(ev.id === activeSiteTab){ renderSiteBar(); }
      } else if(ev.type === "opened"){
        // A link on a page asked for a new tab.
        if(ev.active){ shownSiteTab = ev.id; }
        siteTabs.push({ id:ev.id, linkId:null, name:"", title:"", url:ev.url, isFile:false, canBack:false, canForward:false, loading:true, error:null });
        if(ev.active){ showSiteTab(ev.id); } else { renderSiteTabs(); }
      } else if(ev.type === "error"){
        var et = siteTabById(ev.id);
        if(et){
          et.error = ev.code === "gone" ? "ページが止まりました" : ev.message || String(ev.code);
          if(ev.id === activeSiteTab){ renderSiteBar(); }
        }
      } else if(ev.type === "closeRequest"){
        closeSiteTab(ev.id);
      } else if(ev.type === "fullscreen"){
        if(!ev.on){ setTimeout(layoutSiteHost, 300); }
      } else if(ev.type === "download"){
        var text = ev.state === "started" ? "ダウンロードしています：" + ev.name
                 : ev.state === "completed" ? "保存しました：" + ev.name
                 : "ダウンロードを中止しました：" + ev.name;
        siteNotice = { text:text, file: ev.state === "completed" ? ev.path : null };
        if(activeSiteTab != null){ renderSiteBar(); } else { showToast(text, 4000); }
        if(ev.state !== "started"){
          var shown = siteNotice;
          setTimeout(function(){
            if(siteNotice === shown){ siteNotice = null; if(activeSiteTab != null){ renderSiteBar(); } }
          }, 12000);
        }
      }
    });

    document.getElementById("siteBack").addEventListener("click", function(){ siteApi.nav(activeSiteTab, "back").catch(noop); });
    document.getElementById("siteForward").addEventListener("click", function(){ siteApi.nav(activeSiteTab, "forward").catch(noop); });
    document.getElementById("siteReload").addEventListener("click", function(){ siteApi.nav(activeSiteTab, "reload").catch(noop); });
    document.getElementById("siteExternal").addEventListener("click", function(){
      siteApi.external({ tab: activeSiteTab }).catch(siteOpenError);
    });
    document.getElementById("siteSave").addEventListener("click", function(){
      var t = siteTabById(activeSiteTab);
      if(t){ openSiteManager({ name: (t.title || "").slice(0, 60), url: t.url, tabId: t.id }); }
    });
    // Anything else in the sidebar (a category, the calendar, 「＋ 新しい記録」…) belongs to the journal.
    document.querySelector("nav.sidebar").addEventListener("click", function(e){
      if(activeSiteTab != null && !e.target.closest("#sideSites")){ showSiteTab(null); }
    }, true);
  }

  /* ---------- the editor for the list ---------- */
  // prefill: null (just edit), {} (start with an empty row) or {name, url, tabId} (the page in a tab).
  function openSiteManager(prefill){
    if(!siteList){ return; }
    var rows = siteList.map(function(s){
      return { id:s.id, name:s.name, group:s.group, addr: siteAddressText(s), external: !!s.external };
    });
    var fresh = null;
    if(prefill){
      fresh = { id: genId(), name: prefill.name || "", group: "private", addr: prefill.url || "", external: false };
      rows.push(fresh);
    }
    var wrap = document.createElement("div");
    wrap.className = "modal-backdrop";
    document.body.appendChild(wrap);
    var busy = false;
    var message = "";

    function ordered(){
      // Shown by group; the order inside a group is the saved order.
      var out = [];
      SITE_GROUPS.forEach(function(g){ rows.forEach(function(r){ if(r.group === g.id){ out.push(r); } }); });
      return out;
    }
    function move(r, dir){
      var same = rows.filter(function(x){ return x.group === r.group; });
      var k = same.indexOf(r) + dir;
      if(k < 0 || k >= same.length){ return; }
      var a = rows.indexOf(r), b = rows.indexOf(same[k]);
      rows[a] = same[k];
      rows[b] = r;
    }

    function draw(focusId){
      var list = ordered();
      var groupOpts = function(sel){
        return SITE_GROUPS.map(function(g){ return '<option value="' + g.id + '"' + (g.id === sel ? ' selected' : '') + '>' + escapeHtml(g.name) + '</option>'; }).join("");
      };
      wrap.innerHTML =
        '<div class="modal site-manager">' +
          '<h3>よく使うサイトの編集</h3>' +
          '<p class="help">名前と、サイトのアドレス（https://…）を入れてください。' +
            (siteApi ? '「📁」を押すと、このパソコンの中のページ（ゲームの index.html など）を選べます。デスクトップの中のページは、もう1台のパソコンでも同じ場所で開きます。' +
                       'うまく動かないサイト（ログインできないなど）は「いつものブラウザで開く」にしてください。' : 'パソコンの中のページ（ゲームなど）は、パソコン版の航海日誌で開けます。') +
          '</p>' +
          '<div class="site-rows">' + (list.length ? list.map(function(r){
            var same = rows.filter(function(x){ return x.group === r.group; });
            var k = same.indexOf(r);
            return '<div class="site-row' + (r.bad ? ' bad' : '') + '" data-id="' + escapeHtml(r.id) + '">' +
                     '<div class="site-row-line">' +
                       '<select class="site-row-group" aria-label="分類">' + groupOpts(r.group) + '</select>' +
                       '<input type="text" class="site-row-name" maxlength="60" placeholder="名前（例：会社のメール）" value="' + escapeHtml(r.name) + '" aria-label="名前">' +
                       '<button type="button" class="btn btn-ghost btn-small site-row-up" title="上へ"' + (k === 0 ? ' disabled' : '') + '>↑</button>' +
                       '<button type="button" class="btn btn-ghost btn-small site-row-down" title="下へ"' + (k === same.length - 1 ? ' disabled' : '') + '>↓</button>' +
                       '<button type="button" class="btn btn-ghost btn-small site-row-delete">削除</button>' +
                     '</div>' +
                     '<div class="site-row-line">' +
                       '<input type="text" class="site-row-addr" placeholder="https://… またはパソコンのページ" value="' + escapeHtml(r.addr) + '" aria-label="アドレス" spellcheck="false">' +
                       (siteApi ? '<button type="button" class="btn btn-ghost btn-small site-row-pick" title="このパソコンの中のページを選ぶ">📁</button>' : '') +
                       (siteApi ? '<label class="site-row-ext"><input type="checkbox"' + (r.external ? ' checked' : '') + '> いつものブラウザで開く</label>' : '') +
                     '</div>' +
                   '</div>';
          }).join("") : '<p class="help">登録したサイトはありません。</p>') + '</div>' +
          '<button type="button" class="btn btn-ghost btn-small" id="siteRowAdd">＋ 行を追加</button>' +
          '<p class="site-manager-error" id="siteManagerError">' + escapeHtml(message) + '</p>' +
          '<div class="modal-actions">' +
            '<button class="btn btn-ghost btn-small" id="siteManagerCancel">キャンセル</button>' +
            '<button class="btn btn-primary btn-small" id="siteManagerSave">保存</button>' +
          '</div>' +
        '</div>';

      Array.prototype.forEach.call(wrap.querySelectorAll(".site-row"), function(el){
        var r = rows.filter(function(x){ return x.id === el.getAttribute("data-id"); })[0];
        el.querySelector(".site-row-name").addEventListener("input", function(e){ r.name = e.target.value; });
        el.querySelector(".site-row-addr").addEventListener("input", function(e){ r.addr = e.target.value; r.bad = false; el.classList.remove("bad"); });
        el.querySelector(".site-row-group").addEventListener("change", function(e){
          r.group = e.target.value;
          rows.splice(rows.indexOf(r), 1);
          rows.push(r);   // the end of its new group
          draw(r.id);
        });
        el.querySelector(".site-row-up").addEventListener("click", function(){ move(r, -1); draw(); });
        el.querySelector(".site-row-down").addEventListener("click", function(){ move(r, 1); draw(); });
        el.querySelector(".site-row-delete").addEventListener("click", function(){
          rows.splice(rows.indexOf(r), 1);
          draw();
        });
        var ext = el.querySelector(".site-row-ext input");
        if(ext){ ext.addEventListener("change", function(){ r.external = ext.checked; }); }
        var pick = el.querySelector(".site-row-pick");
        if(pick){
          pick.addEventListener("click", function(){
            siteApi.pickFile().then(function(res){
              if(!res){ return; }
              r.addr = siteAddressText({ file: res.file });
              if(!r.name.trim()){ r.name = res.name; }
              r.bad = false;
              draw(r.id);
            }, function(err){ showToast(withDetail("ファイルを選べませんでした", err), 5000); });
          });
        }
      });
      wrap.querySelector("#siteRowAdd").addEventListener("click", function(){
        var r = { id: genId(), name:"", group: SITE_GROUPS[0].id, addr:"", external:false };
        rows.push(r);
        draw(r.id);
      });
      wrap.querySelector("#siteManagerCancel").addEventListener("click", function(){ if(!busy){ wrap.remove(); } });
      wrap.querySelector("#siteManagerSave").addEventListener("click", save);
      if(focusId){
        var target = wrap.querySelector('.site-row[data-id="' + focusId + '"] .site-row-name');
        if(target){
          target.focus();
          target.scrollIntoView({ block:"nearest" });
        }
      }
    }

    function save(){
      if(busy){ return; }
      var out = [], badCount = 0;
      ordered().forEach(function(r){
        if(!r.name.trim() && !r.addr.trim()){ return; }   // empty rows are dropped
        var a = parseSiteAddress(r.addr);
        r.bad = !a;
        if(!a){ badCount++; return; }
        out.push(cleanSite({ id:r.id, name:r.name.trim(), group:r.group, url:a.url, file:a.file, external:r.external }));
      });
      if(badCount){
        message = "赤い枠のアドレスを確かめてください（https:// で始まるアドレスか、パソコンの .html ファイル）。";
        draw();
        return;
      }
      busy = true;
      Array.prototype.forEach.call(wrap.querySelectorAll("button, input, select"), function(el){ el.disabled = true; });
      saveSites(out).then(function(){
        // The page that was registered from its tab now belongs to that link.
        if(prefill && prefill.tabId != null && fresh && out.some(function(s){ return s.id === fresh.id; })){
          var t = siteTabById(prefill.tabId);
          if(t){ t.linkId = fresh.id; t.name = siteById(fresh.id).name; renderSiteTabs(); renderSiteBar(); renderSites(); }
        }
        wrap.remove();
        showToast("よく使うサイトを保存しました");
      }, function(err){
        busy = false;
        wrap.remove();
        handleWriteError(err, "よく使うサイトを保存できませんでした。通信状況をご確認ください。");
      });
    }

    draw(fresh ? fresh.id : null);
  }

  /* ---------------- wire up sidebar tool buttons ---------------- */
  // 上のバーの「＋ 新しい記録」：一覧・読む画面・編集画面・よく使うサイトの画面など、どこからでも押せる。
  function newEntryHere(){
    if(activeSiteTab != null){ showSiteTab(null); }
    openNewEntry();
  }
  // v1.0.229 (the owner): where the Windows app can open record windows, both 「＋ 新しい記録」 buttons are a
  // pull-down: this window, or a record window of its own. The web version has none, and the button acts at once.
  ["btnNewEntry", "topNewBtn"].forEach(function(bid){
    var btn = document.getElementById(bid);
    if(!CAN_OPEN_WINDOWS){ btn.addEventListener("click", newEntryHere); return; }
    btn.insertAdjacentHTML("beforeend", '<span class="dd-caret" aria-hidden="true"> ▾</span>');
    btn.setAttribute("aria-haspopup", "menu");
    btn.addEventListener("click", function(){
      if(menuClosedBy === btn && Date.now() - menuClosedAt < 400){ return; }   // a second press closes it
      var r = btn.getBoundingClientRect();
      openPopMenu('<button type="button" role="menuitem" data-pick="here">✎ この窓で書く</button>' +
                  '<button type="button" role="menuitem" data-pick="window">⧉ 別の窓で書く</button>',
        r.left, r.bottom + 2, function(pick){
          setSideOpen(false);   // the drawer (narrow window) stayed open for the menu
          if(pick === "window"){ openInWindow(null, "editor"); } else { newEntryHere(); }
        }, btn);
    });
  });
  document.getElementById("btnExportBackup").addEventListener("click", exportBackup);
  document.getElementById("btnExportMd").addEventListener("click", exportMarkdown);
  document.getElementById("btnPrintMany").addEventListener("click", openPrintManyModal);
  // The record windows hold the old key: they close first (v1.0.216).
  document.getElementById("btnChangePw").addEventListener("click", function(){ recordWindowsFirst("合言葉を変更", openChangePasswordModal); });
  document.getElementById("btnLogout").addEventListener("click", confirmLogout);
  document.getElementById("btnImportBackup").addEventListener("click", function(){
    pendingRestoreFromGate = false;
    fileInput.click();
  });

  // Dropping a file anywhere other than the editor must not navigate away.
  document.addEventListener("dragover", function(e){ e.preventDefault(); });
  document.addEventListener("drop", function(e){ e.preventDefault(); });

  // Closing the window while a save is running or the editor has unsaved
  // changes: the main process shows a confirmation dialog.
  window.addEventListener("beforeunload", function(e){
    SHEETS.forEach(function(s){ keepTyped(s); if(s.timer){ flushSheet(s); } });
    if(pendingWrites > 0 || sheetsBusy() || (currentView === "editor" && editorDirty) || window.ImageEditor.hasUnapplied()){
      e.preventDefault();
      e.returnValue = "";
    }
  });

  /* ---------------- 記録の窓 (v1.0.216) ---------------- */
  // The main window: this record in a window of its own (main.js openRecordWindow). The key goes along in memory;
  // a window that already shows the record comes to the front instead.
  // id null: a new record, written in its window (v1.0.229).
  function openInWindow(id, mode){
    if(!CAN_OPEN_WINDOWS || !sessionKey || (!id && mode !== "editor")) return;
    crypto.subtle.exportKey("raw", sessionKey).then(function(raw){
      return api.records.open(id, mode, new Uint8Array(raw), doc.salt);
    }).catch(function(err){
      showToast(withDetail("別の窓を開けませんでした", err), 6000);
    });
  }
  // 「⧉ 別の窓で開く／編集」 on the reading or edit screen: the record goes to its window, this one shows the list.
  function moveToWindow(id, mode){
    guardLeave(function(){
      currentView = "list";
      renderMain();
      openInWindow(id, mode);
    });
  }

  // The list's right-click menu.
  var cardMenu = null;
  function closeCardMenu(){
    if(cardMenu){ cardMenu.remove(); cardMenu = null; }
    if(menuOwner){ menuOwner.removeAttribute("aria-expanded"); menuOwner = null; }
  }
  // A small menu at (x, y); onPick gets the chosen button's data-pick. owner: the button that opened it (Escape
  // gives it the focus back, and pressing it again closes the menu instead of opening it anew).
  var menuOwner = null, menuClosedBy = null, menuClosedAt = 0;
  function openPopMenu(itemsHtml, x, y, onPick, owner){
    closeCardMenu();
    var m = cardMenu = document.createElement("div");
    m.className = "card-menu";
    m.setAttribute("role", "menu");
    m.innerHTML = itemsHtml;
    menuOwner = owner || null;
    if(menuOwner){ menuOwner.setAttribute("aria-expanded", "true"); }
    document.body.appendChild(m);
    m.style.left = Math.max(4, Math.min(x, window.innerWidth - m.offsetWidth - 4)) + "px";
    m.style.top = Math.max(4, Math.min(y, window.innerHeight - m.offsetHeight - 4)) + "px";
    m.addEventListener("click", function(ev){
      var b = ev.target.closest("button[data-pick]");
      if(!b) return;
      closeCardMenu();
      onPick(b.getAttribute("data-pick"));
    });
    m.addEventListener("keydown", function(ev){
      if(ev.key !== "ArrowDown" && ev.key !== "ArrowUp") return;
      ev.preventDefault();
      var bs = [].slice.call(m.querySelectorAll("button"));
      var i = bs.indexOf(document.activeElement);
      bs[(i + (ev.key === "ArrowDown" ? 1 : bs.length - 1)) % bs.length].focus();
    });
    m.querySelector("button").focus();
  }
  function openCardMenu(id, x, y){
    openPopMenu('<button type="button" role="menuitem" data-pick="view">⧉ 別の窓で開く</button>' +
                '<button type="button" role="menuitem" data-pick="editor">✎ 別の窓で編集する</button>',
      x, y, function(mode){ openInWindow(id, mode); });
  }
  document.addEventListener("pointerdown", function(ev){
    if(cardMenu && !cardMenu.contains(ev.target)){
      menuClosedBy = menuOwner && menuOwner.contains(ev.target) ? menuOwner : null;
      menuClosedAt = Date.now();
      closeCardMenu();
    }
  }, true);
  document.addEventListener("keydown", function(ev){
    if(cardMenu && ev.key === "Escape"){ var o = menuOwner; closeCardMenu(); if(o){ o.focus(); } }
  });
  window.addEventListener("blur", closeCardMenu);
  window.addEventListener("scroll", closeCardMenu, true);

  // The window's title in the taskbar: the record's date and title.
  function showRecordTitle(){
    var e = openEntryId ? liveEntries.filter(function(x){ return x.id === openEntryId; })[0] : null;
    var t = e ? fmtDate(e.date) + "　" + (e.title || "（無題）") : "新しい記録";
    document.title = (currentView === "editor" ? "✎ " : "") + t + " — 航海日誌";
  }

  // A record window starts here instead of at the gate: the key from the main window, then the journal as on Drive.
  function startRecordWindow(){
    clearGateError();
    setGateStage("loading", "記録を開いています…");
    document.getElementById("gateRetryBtn").style.display = "none";   // it would start the login of the main window
    var info = null;
    api.records.session().then(function(s){
      info = s;
      return crypto.subtle.importKey("raw", s.key, { name:"AES-GCM" }, false, ["encrypt","decrypt"]);
    }).then(function(key){
      return api.loadJournal().then(function(res){
        if(!res.exists){ return Promise.reject({ code:"journal_missing" }); }
        var d = normalizeDoc(JSON.parse(res.content));
        if(d.salt !== info.salt){ return Promise.reject({ code:"rekeyed", message:"合言葉が変わりました" }); }
        return decryptJson(key, d.verifier).then(function(){
          doc = d;
          docRev = res.revision;
          sessionKey = key;
          return decryptAllEntries();
        });
      });
    }).then(function(){
      gateEl.style.display = "none";
      appEl.style.display = "block";
      setSync("saved");
      renderCategories();
      openEntryId = info.entryId;
      currentView = info.mode === "editor" ? "editor" : "view";
      renderMain();
    }).catch(function(err){
      sessionKey = null;
      document.getElementById("gateFatalDetail").textContent = "この記録の窓を開けませんでした。窓を閉じて、本体の窓からもう一度開いてください。" +
        (err && err.message ? "（" + err.message + "）" : "");
      setGateStage("fatal");
    });
  }
  // Asked by main.js before the main window locks or quits: something here that is not saved yet.
  if(RECORD_WIN){
    window.__nisshiBusy = function(){
      return !!sessionKey && (pendingWrites > 0 || !!editorSaving || (currentView === "editor" && editorDirty) || window.ImageEditor.hasUnapplied());
    };
  }
  // Another window of this PC wrote the journal: read it now (the 10 seconds between looks do not apply).
  if(api && api.records && !READ_ONLY){
    api.records.onChanged(function(){ entriesChecked = 0; recheckEntries(); });
  }

  /* ---------------- boot ---------------- */
  if(RECORD_WIN){ startRecordWindow(); } else { initGate(); }

})();
