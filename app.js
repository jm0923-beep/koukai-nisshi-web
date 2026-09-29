(function(){
  "use strict";

  var api = window.nisshi;

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
        false,
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

  function setSync(state){
    var el = document.getElementById("syncStatus");
    el.classList.toggle("error", state === "error");
    el.textContent = state === "saving" ? "☁ 保存中…" : state === "saved" ? "☁ ドライブに保存済み" : state === "error" ? "☁ 保存できませんでした" : "";
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

  function persist(mutate){
    return queueWrite(function(){ return attemptWrite(mutate, false); });
  }
  function attemptWrite(mutate, retried){
    var next = JSON.parse(JSON.stringify(doc));
    mutate(next);
    return api.saveJournal(JSON.stringify(next), docRev).then(function(res){
      doc = next;
      docRev = res.revision;
      if(retried){ showToast("別のPCでの変更を取り込んでから保存しました"); }
    }, function(err){
      if(err && err.code === "conflict" && !retried){
        return refreshFromRemote().then(function(){ return attemptWrite(mutate, true); });
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
  var calMonth = "";         // "YYYY-MM" shown in the calendar
  var currentView = "list";  // "list" | "editor" | "view"
  var openEntryId = null;
  var pendingRestoreFromGate = false;
  var editorDirty = false;
  var editorSave = null;     // saves the open editor; set by renderEditor
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
    sessionKey = null;
    editorSave = null;
    closeRich();
    liveEntries = [];
    openEntryId = null;
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
    guardLeave(function(){ lockApp(); });
  });

  /* ---------------- quit ---------------- */
  // Saves (or, if the user chooses, discards) the open editor, waits for every
  // write to reach Drive, then closes: the Windows app quits; the web version
  // locks and says it is safe to close the page (a browser tab cannot close itself).
  document.getElementById("quitBtn").addEventListener("click", function(){
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
  });

  function finishQuit(){
    var busy = document.createElement("div");
    busy.className = "modal-backdrop";
    busy.innerHTML = '<div class="modal"><p class="quit-busy">Googleドライブへの保存を確かめています…</p></div>';
    document.body.appendChild(busy);
    writeChain.then(function(){
      busy.remove();
      if(pendingWrites > 0 || document.getElementById("syncStatus").classList.contains("error")){
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
                '<span class="cat-count">'+(counts[c.id]||0)+'</span></li>';
    });
    list.innerHTML = html;
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
  var calCollapsed = window.matchMedia && window.matchMedia("(max-width: 760px)").matches;

  function entriesByDate(){
    var by = {};
    liveEntries.forEach(function(e){ (by[e.date] = by[e.date] || []).push(e); });
    return by;
  }
  function pad2(n){ return String(n).padStart(2, "0"); }

  function renderCalendar(){
    var box = document.getElementById("miniCal");
    if(!box || !sessionKey) return;
    if(!calMonth){ calMonth = (currentDate || todayStr()).slice(0, 7); }
    var y = Number(calMonth.slice(0, 4)), m = Number(calMonth.slice(5, 7));
    var by = entriesByDate();
    var first = new Date(y, m - 1, 1).getDay();
    var days = new Date(y, m, 0).getDate();
    var today = todayStr();
    var html = '<div class="cal-head">' +
                 '<button type="button" class="cal-toggle" id="calToggle">📅 カレンダー <span>'+(calCollapsed ? "▸" : "▾")+'</span></button>' +
               '</div>';
    if(!calCollapsed){
      html += '<div class="cal-nav">' +
                '<button type="button" class="cal-move" data-move="-1" title="前の月">‹</button>' +
                '<span class="cal-month">'+y+'年'+m+'月</span>' +
                '<button type="button" class="cal-move" data-move="1" title="次の月">›</button>' +
              '</div><div class="cal-grid">';
      WEEKDAYS.forEach(function(w, i){ html += '<span class="cal-wd'+(i===0?" sun":i===6?" sat":"")+'">'+w+'</span>'; });
      for(var i = 0; i < first; i++){ html += '<span class="cal-blank"></span>'; }
      for(var d = 1; d <= days; d++){
        var key = y + "-" + pad2(m) + "-" + pad2(d);
        var cls = "cal-day" + (by[key] ? " has" : "") + (key === today ? " today" : "") + (key === currentDate ? " on" : "");
        var dow = (first + d - 1) % 7;
        if(dow === 0){ cls += " sun"; } else if(dow === 6){ cls += " sat"; }
        html += '<button type="button" class="'+cls+'" data-date="'+key+'">'+d+'</button>';
      }
      html += '</div>';
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
      b.addEventListener("mouseenter", function(){ showCalTip(b, by[key]); });
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
  function showCalTip(anchor, entries){
    hideCalTip();
    if(!entries || !entries.length) return;
    calTip = document.createElement("div");
    calTip.className = "cal-tip";
    var shown = entries.slice(0, 8);
    calTip.innerHTML = shown.map(function(e){
      return '<div class="cal-tip-row"><span class="cal-tip-dot" style="background:'+resolveColor(catColor(e.category))+'"></span>' +
             '<span class="cal-tip-title">' + escapeHtml(e.title || "（無題）") + '</span>' + attachBadges(e) + '</div>';
    }).join("") + (entries.length > shown.length ? '<div class="cal-tip-more">ほか '+(entries.length - shown.length)+' 件</div>' : '');
    document.body.appendChild(calTip);
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
  function storedFileMeta(f){ return { id:f.id, name:f.name, mime:f.mime, size:f.size }; }
  function fileIcon(f){ return /pdf/i.test(f.mime || "") || /\.pdf$/i.test(f.name || "") ? "📄" : "📎"; }
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
    if(layout){ layout.classList.remove("split"); }
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
  // opts: { name, image: url } or { name, pdf: Promise<bytes>, file }
  function openSide(opts){
    var layout = document.querySelector(".viewer-layout");
    var panel = document.getElementById("sidePanel");
    if(!layout || !panel) return false;
    if(sideUrl){ URL.revokeObjectURL(sideUrl); sideUrl = null; }
    layout.classList.add("split");
    document.querySelector(".content-inner").classList.add("wide");
    sideCurrent = opts.img ? { entryId: openEntryId, imgId: opts.img.id }
                : opts.file ? { entryId: openEntryId, fileId: opts.file.id } : null;
    // ✎ 書き込み: on the edit screen it changes the draft (kept with 保存する); when reading, the record is saved at once.
    var annotateFn = !opts.img ? null
      : currentView === "editor" && editorSideHooks ? function(){ editorSideHooks.annotate(opts.img.id); }
      : currentEntry() ? function(){ annotateSaved(currentEntry(), opts.img); } : null;
    var editable = !!annotateFn;
    panel.innerHTML =
      '<div class="side-head"><span class="side-name"></span>' +
        (editable ? '<button type="button" class="btn btn-ghost btn-small" id="sideAnnotate" title="この画像に書き込み・トリミングをして、日誌に反映します">✎ 書き込み</button>' : '') +
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
  // Images in the record: the side panel when there is room, the full-screen view otherwise.
  // el: the image clicked; it is outlined while it is the one shown in the panel.
  // img: the attached image, so the panel can offer ✎ 書き込み.
  function showImage(url, name, el, img){
    if(canSide() && openSide({ name: name || (img && img.name) || "", image: url, img: img })){
      markShown(el);
      return;
    }
    openLightbox(url, name);
  }
  function currentEntry(){
    return currentView === "view" ? liveEntries.filter(function(e){ return e.id === openEntryId; })[0] || null : null;
  }

  // ✎ 書き込み from the side panel: the same editor as in the edit screen, saved to the
  // record right away. The untouched original is kept, so 「元の画像に戻す」 still works.
  function annotateSaved(entry, img){
    var orig = img.edit ? {
      id: img.edit.originalId, mime: img.edit.originalMime, width: img.edit.originalWidth,
      height: img.edit.originalHeight, size: img.edit.originalSize
    } : { id: img.id, mime: img.mime, width: img.width, height: img.height, size: img.size };
    imageUrl({ id: orig.id, mime: orig.mime }).then(function(url){
      return window.ImageEditor.open({ url: url, crop: img.edit && img.edit.crop, shapes: img.edit && img.edit.shapes });
    }).then(function(r){
      if(!r) return;
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
          newImages.forEach(function(u){ imageUrlCache[u.id] = Promise.resolve(u.url); });
          showToast("画像の変更を日誌に反映しました");
          renderMain();
          return imageUrl(stored).then(function(u){
            var el = document.querySelector('.view-card .thumb[data-img="'+CSS.escape(stored.id)+'"] img');
            showImage(u, stored.name, el, stored);
          });
        });
      });
    }).catch(function(err){
      handleWriteError(err, "画像への書き込みを反映できませんでした。");
    });
  }
  function markShown(el){
    Array.prototype.forEach.call(document.querySelectorAll(".side-shown"), function(x){ x.classList.remove("side-shown"); });
    if(el){ el.classList.add("side-shown"); }
  }

  // Opens an attachment: the Windows app hands it to its usual program, the web version shows it.
  // On a wide Windows screen a PDF opens in the side panel instead (external: always the usual program).
  function openAttachment(f, external){
    var isPdf = /pdf/i.test(f.mime || "") || /\.pdf$/i.test(f.name || "");
    if(!external && isPdf && canSide()){
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
    var plain = String(text||"").replace(MARKER, " ").replace(/[#*_>-]/g," ").replace(/\s+/g," ").trim();
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
  function imagesAfterBody(e){
    var refs = inlineRefs(e.body, e.images);
    return (e.images||[]).filter(function(img){ return refs.indexOf(img.ref) < 0; });
  }
  // Gives every image a unique ref, keeping existing ones (the first holder of a duplicate keeps it).
  function ensureRefs(images){
    var used = [];
    images.forEach(function(img){
      if(img.ref && used.indexOf(img.ref) < 0){ used.push(img.ref); } else { img.ref = 0; }
    });
    var next = used.length ? Math.max.apply(null, used) + 1 : 1;
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
    return '<div class="inline-row'+(found.length > 1 ? ' multi' : '')+(cls ? ' '+cls : '')+
             (floating ? ' sz-'+(SIZE_CLASS[found[0].size] || "m") : '')+'">' + found.map(function(f){
      return '<figure class="inline-fig'+(floating ? '' : ' sz-'+(SIZE_CLASS[f.size] || "m"))+'">' + figure(f.img) + '</figure>';
    }).join("") + '</div>';
  }

  // figure(img) returns the markup for one placed image; without it markers stay as text.
  function mdToHtml(src, images, figure){
    var lines = escapeHtml(src||"").split("\n");
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
        html += "<li>"+inlineMd(l.replace(/^\s*-\s+/,""))+"</li>";
        return;
      } else if(inList){ html += "</ul>"; inList = false; }

      var h = l.match(/^(#{1,3})\s+(.*)$/);
      if(h){
        closeWrap();
        var level = h[1].length + 1;
        html += "<h"+level+">"+inlineMd(h[2])+"</h"+level+">";
        return;
      }
      if(l.trim()===""){ html += ""; return; }
      html += "<p>"+inlineMd(l)+"</p>";
    });
    closeWrap();
    return html || "<p style=\"color:var(--ink-faint)\">（本文なし）</p>";
  }
  function inlineMd(s){
    return s
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/\*(.+?)\*/g, "<em>$1</em>");
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

  // Ask before leaving the editor with unsaved changes.
  function guardLeave(proceed){
    if(currentView === "editor" && editorDirty){
      openConfirmModal("保存していない変更があります", "このまま移動すると、編集中の内容と追加した画像は失われます。", function(){
        editorDirty = false;
        proceed();
      }, "保存せずに移動する");
      return;
    }
    proceed();
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

  function openLightbox(url, caption){
    var wrap = document.createElement("div");
    wrap.className = "lightbox";
    // A close button of its own, so the window's ✕ (which quits the app) is never the obvious way back.
    wrap.innerHTML = '<button type="button" class="lightbox-close">✕ 閉じる</button><img alt=""><div class="lightbox-caption"></div>';
    wrap.querySelector("img").src = url;
    wrap.querySelector(".lightbox-caption").textContent = caption || "";
    function onKey(e){ if(e.key === "Escape"){ close(); } }
    function close(){ wrap.remove(); document.removeEventListener("keydown", onKey); }
    wrap.addEventListener("click", close);
    document.addEventListener("keydown", onKey);
    document.body.appendChild(wrap);
  }

  function loadThumbInto(container, img, urlPromise){
    var el = container.querySelector("img");
    urlPromise.then(function(url){
      if(!el.isConnected) return;
      el.src = url;
      el.addEventListener("click", function(){ showImage(url, img.name, el, img); });
      var loading = container.querySelector(".thumb-loading");
      if(loading){ loading.remove(); }
    }).catch(function(){
      if(!container.isConnected) return;
      var loading = container.querySelector(".thumb-loading");
      if(loading){ loading.remove(); }
      container.classList.add("thumb-error");
    });
  }

  /* ---------------- rendering: list / editor / view ---------------- */
  var viewRoot = document.getElementById("viewRoot");

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
               (e.body||"").toLowerCase().indexOf(q) >= 0 ||
               (e.tags||[]).some(function(t){ return t.toLowerCase().indexOf(q) >= 0; });
      });
    }
    list.sort(function(a,b){
      if(a.date === b.date){ return (b.updatedAt||"").localeCompare(a.updatedAt||""); }
      return b.date.localeCompare(a.date);
    });
    return list;
  }

  function renderMain(){
    var keep = sideCurrent;
    closeRich();
    closeSide();
    editorSideHooks = null;
    if(!sessionKey){ return; }
    if(currentView === "editor"){ renderEditor(openEntryId); restoreSide(keep); return; }
    if(currentView === "view"){ renderViewer(openEntryId); restoreSide(keep); return; }
    renderList();
  }

  function renderList(){
    var list = filteredEntries();
    var title = currentCategory === "all" ? "すべての記録" : catName(currentCategory);
    if(currentDate){
      var p = currentDate.split("-");
      title = Number(p[0]) + "年" + Number(p[1]) + "月" + Number(p[2]) + "日の記録";
    }
    var html = "";
    html += '<div class="list-head"><h2 class="serif">'+escapeHtml(title)+'</h2>' +
            (currentDate ? '<button class="btn btn-ghost btn-small" id="clearDateBtn">日付の絞り込みを解除</button>' : '') +
            '<button class="btn btn-primary btn-small" id="listNewBtn">＋ 新しい記録</button></div>';
    if(currentTags.length){
      html += '<div class="tag-filter"><span class="tag-filter-label">タグで絞り込み中：</span>' + tagChips(currentTags, "on") +
              '<button class="btn btn-ghost btn-small" id="clearTagsBtn">タグの絞り込みを解除</button></div>';
    }
    html += '<div class="search-row"><input type="text" id="searchInput" placeholder="タイトル・本文・タグを検索" value="'+escapeHtml(currentSearch)+'"></div>';

    if(list.length === 0){
      // the same pixel compass as in the top bar
      html += '<div class="empty-state"><span class="compass">' + document.querySelector(".brand .compass").innerHTML + '</span>' +
              '<p>まだここには何も記録されていません。</p>' +
              '<p>最初の一行から、航海日誌をはじめましょう。</p></div>';
    } else {
      list.forEach(function(e){
        var col = resolveColor(catColor(e.category));
        var clip = attachBadges(e);
        html += '<div class="entry-card" data-id="'+escapeHtml(e.id)+'" style="border-left-color:'+col+'">' +
                  '<div class="entry-meta">' +
                    '<span class="entry-date mono">'+fmtDate(e.date)+'</span>' +
                    '<span class="entry-time">'+escapeHtml(writtenLabel(e))+'</span>' +
                    '<span class="entry-badge" style="background:'+col+'22;color:'+col+'">'+escapeHtml(catName(e.category))+'</span>' +
                    clip +
                  '</div>' +
                  '<div class="entry-title">'+escapeHtml(e.title || "（無題）")+'</div>' +
                  '<div class="entry-snippet">'+escapeHtml(snippet(e.body))+'</div>' +
                  ((e.tags && e.tags.length) ? '<div class="entry-tags">'+tagChips(e.tags)+'</div>' : '') +
                '</div>';
      });
    }
    viewRoot.innerHTML = html;

    document.getElementById("listNewBtn").addEventListener("click", openNewEntry);
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
    search.addEventListener("input", function(){
      currentSearch = search.value;
      renderList();
      var s2 = document.getElementById("searchInput");
      s2.focus();
      s2.selectionStart = s2.selectionEnd = s2.value.length;
    });
    Array.prototype.forEach.call(viewRoot.querySelectorAll(".entry-card"), function(card){
      card.addEventListener("click", function(){
        openEntryId = card.getAttribute("data-id");
        currentView = "view";
        renderMain();
        window.scrollTo(0,0);
      });
    });
  }

  // What is attached, told apart: 📷 images, 📄 PDFs, 📎 other files (list and calendar popup).
  function attachCounts(e){
    var pdf = (e.files || []).filter(function(f){ return fileIcon(f) === "📄"; }).length;
    return { img: (e.images || []).length, pdf: pdf, other: (e.files || []).length - pdf };
  }
  function attachBadges(e){
    var c = attachCounts(e);
    return (c.img ? '<span class="entry-clip" title="画像 '+c.img+'枚">📷 '+c.img+'</span>' : '') +
           (c.pdf ? '<span class="entry-clip" title="PDF '+c.pdf+'件">📄 '+c.pdf+'</span>' : '') +
           (c.other ? '<span class="entry-clip" title="ファイル '+c.other+'件">📎 '+c.other+'</span>' : '');
  }

  function openNewEntry(){
    guardLeave(function(){
      openEntryId = null;
      currentView = "editor";
      renderMain();
    });
  }

  function renderViewer(id){
    var entry = liveEntries.filter(function(e){ return e.id===id; })[0];
    if(!entry){ currentView="list"; renderList(); return; }
    var vcol = resolveColor(catColor(entry.category));
    var images = entry.images || [];
    var paper = viewMode() === "paper";
    var html = "";
    html += '<div class="editor-top">' +
              '<button class="back-link" id="backToList">← 一覧へ戻る</button>' +
              '<div class="editor-actions">' +
                '<span class="view-switch">' +
                  '<button type="button" id="modePaper" class="'+(paper?"on":"")+'">紙面（A4）</button>' +
                  '<button type="button" id="modeRead" class="'+(paper?"":"on")+'">読みやすく</button>' +
                '</span>' +
                '<button class="btn btn-ghost btn-small" id="btnEditEntry">編集する</button>' +
                '<button class="btn btn-ghost btn-small" id="btnPrintOne">印刷・PDF</button>' +
                '<button class="btn btn-ghost btn-small" id="btnExportOne">この記録をMarkdownで書き出す</button>' +
                '<button class="btn btn-danger btn-small" id="btnDeleteEntry">削除</button>' +
              '</div>' +
            '</div>';
    if(paper){
      viewRoot.innerHTML = '<div class="viewer-layout"><div class="viewer-main">' + html +
        '<div class="paper-view" id="paperHost"></div></div><aside class="side-panel" id="sidePanel"></aside></div>';
      var host = document.getElementById("paperHost");
      renderPaper(host, entry).then(function(){
        bindFileCards(host, entry.files);
        Array.prototype.forEach.call(host.querySelectorAll(".paper img"), function(im){
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
                '<span class="entry-date mono">'+fmtDate(entry.date)+'</span>' +
                '<span class="entry-time">'+escapeHtml(writtenLabel(entry))+'</span>' +
                (updatedLabel(entry) ? '<span class="entry-time">・'+escapeHtml(updatedLabel(entry))+'</span>' : '') +
                '<span class="entry-badge" style="background:'+vcol+'22;color:'+vcol+'">'+escapeHtml(catName(entry.category))+'</span>' +
                tagChips(entry.tags) +
              '</div>' +
              '<h2 class="view-title serif">'+escapeHtml(entry.title || "（無題）")+'</h2>' +
              '<div class="view-body">'+mdToHtml(entry.body, images, function(img){
                return '<div class="thumb inline-thumb" data-img="'+escapeHtml(img.id)+'"><img alt="'+escapeHtml(img.name)+'"><span class="thumb-loading">読み込み中…</span></div>';
              })+'</div>';
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
    html += fileCardsHtml(entry.files);
    html += '</div>';
    viewRoot.innerHTML = '<div class="viewer-layout"><div class="viewer-main">' + html +
      '</div><aside class="side-panel" id="sidePanel"></aside></div>';
    bindFileCards(viewRoot, entry.files);

    images.forEach(function(img){
      // The same image may be placed more than once in the text.
      Array.prototype.forEach.call(viewRoot.querySelectorAll('.thumb[data-img="'+CSS.escape(img.id)+'"]'), function(box){
        loadThumbInto(box, img, imageUrl(img));
      });
    });
    bindViewerButtons(entry);
  }

  // "paper" = the printed A4 look (default), "read" = the screen-sized reading view.
  function viewMode(){
    try { return localStorage.getItem("nisshi.viewMode") === "read" ? "read" : "paper"; } catch(e){ return "paper"; }
  }
  function setViewMode(mode){
    try { localStorage.setItem("nisshi.viewMode", mode); } catch(e){}
  }

  function bindViewerButtons(entry){
    // A tag on the record: the list of records with that tag.
    Array.prototype.forEach.call(viewRoot.querySelectorAll(".view-meta .tag-chip"), function(b){
      b.addEventListener("click", function(){ toggleTag(b.getAttribute("data-tag"), true); });
    });
    document.getElementById("modePaper").addEventListener("click", function(){ setViewMode("paper"); renderMain(); });
    document.getElementById("modeRead").addEventListener("click", function(){ setViewMode("read"); renderMain(); });
    document.getElementById("backToList").addEventListener("click", function(){ currentView="list"; renderMain(); });
    document.getElementById("btnEditEntry").addEventListener("click", function(){ currentView="editor"; renderMain(); });
    document.getElementById("btnPrintOne").addEventListener("click", function(){ openPrintOneModal(entry); });
    document.getElementById("btnExportOne").addEventListener("click", function(){ exportSingleEntryMd(entry); });
    document.getElementById("btnDeleteEntry").addEventListener("click", function(){ confirmDeleteEntry(entry.id); });
  }

  function renderEditor(id){
    var entry = id ? liveEntries.filter(function(e){ return e.id===id; })[0] : null;
    var isNew = !entry;
    var draft = entry ? Object.assign({}, entry) : {
      id: null, title:"", category: currentCategory!=="all" ? currentCategory : (doc.categories[0] && doc.categories[0].id),
      date: todayStr(), body:""
    };
    var originalImageIds = [].concat.apply([], (entry && entry.images || []).map(imageFileKeys))
      .concat((entry && entry.files || []).map(function(f){ return f.id; }));
    var draftImages = (entry && entry.images || []).map(function(img){ return Object.assign({}, img, { isNew:false }); });
    var draftFiles = (entry && entry.files || []).map(function(f){ return Object.assign({}, f, { isNew:false }); });
    // A new record written while tags are picked in the sidebar starts with those tags.
    var draftTags = entry ? (entry.tags || []).slice() : currentTags.slice();
    ensureRefs(draftImages);
    var draftLayout = entry && entry.layout ? JSON.parse(JSON.stringify(entry.layout)) : null;
    var compressing = 0;
    editorDirty = false;

    var catOptions = (doc.categories||[]).map(function(c){
      return '<option value="'+escapeHtml(c.id)+'" '+(draft.category===c.id?"selected":"")+'>'+escapeHtml(c.name)+'</option>';
    }).join("");

    var html = '<div class="editor-wrap">';
    html += '<div class="editor-top">' +
              '<button class="back-link" id="backFromEditor">← '+(isNew?"一覧へ戻る":"記録へ戻る")+'</button>' +
              '<div class="editor-actions">' +
                '<button class="btn btn-primary btn-small" id="saveEntryBtn">保存する</button>' +
              '</div>' +
            '</div>';
    html += '<input class="title-input serif" id="editTitle" type="text" placeholder="タイトル" value="'+escapeHtml(draft.title)+'">';
    html += '<div class="field-row">' +
              '<div class="field"><label>日付 <span class="entry-time">'+(isNew ? "（保存した時刻が記入時刻になります）" : escapeHtml(writtenLabel(entry)))+'</span></label><input type="date" id="editDate" value="'+escapeHtml(draft.date)+'"></div>' +
              '<div class="field"><label>カテゴリ</label><select id="editCategory">'+catOptions+'</select></div>' +
            '</div>';
    html += '<div class="field tag-field"><label for="tagInput">タグ <span class="entry-time">（言葉を入れてEnter。いくつでも付けられます）</span></label>' +
              '<div class="tag-editor" id="tagEditor"><span id="tagChipsEd"></span>' +
                '<input type="text" id="tagInput" list="tagSuggest" autocomplete="off" placeholder="例：相場メモ、家族、旅行">' +
              '</div>' +
              '<datalist id="tagSuggest">' + allTags().map(function(t){ return '<option value="'+escapeHtml(t)+'">'; }).join("") + '</datalist>' +
            '</div>';
    html += '<div id="editBody" data-placeholder="今日あったこと、考えたこと、相場で気づいたこと…"></div>';
    html += '<div class="attach-area">' +
              '<div class="attach-head">' +
                '<span class="attach-label">画像</span>' +
                '<button class="btn btn-ghost btn-small" id="attachBtn">＋ 画像を添付</button>' +
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
    var thumbGrid = document.getElementById("thumbGrid");
    var saveBtn = document.getElementById("saveEntryBtn");
    function markDirty(){ editorDirty = true; }

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
      escapeHtml: escapeHtml,
      inlineMd: inlineMd,
      markers: { isLine: function(l){ return MARKER_LINE.test(l); }, parse: markersIn, text: markerText },
      hasRef: function(ref){ return !!imageByRef(draftImages, ref); },
      imageUrl: function(ref){
        var img = imageByRef(draftImages, ref);
        return img ? draftUrl(img) : Promise.resolve(null);
      },
      onChange: function(){ markDirty(); refreshInlineState(); },
      onShow: function(ref){ var img = imageByRef(draftImages, ref); if(img){ showDraftSide(img); } }
    });

    // An attached image shown large: on the right beside the editor when there is room, full screen otherwise.
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
      var h = draftImages.map(function(img){
        return '<div class="thumb" draggable="true" data-img="'+escapeHtml(img.id)+'"><img alt="'+escapeHtml(img.name)+'" draggable="false"><span class="thumb-loading">読み込み中…</span>' +
               '<button class="thumb-edit" title="書き込み・トリミング">✎</button>' +
               '<button class="thumb-remove" title="添付を外す">×</button>' +
               (img.composite ? '<button class="thumb-split" title="合成を解除して元の画像に戻す">合成を解除</button>' : '') +
               '<button class="thumb-inline" title="本文のカーソルの位置に入れる">本文へ</button>' +
               '<span class="thumb-size mono"><b>画像'+img.ref+'</b> '+fmtSize(img.size)+(img.edit ? " ✎" : "")+(img.composite ? " ⧉" : "")+'</span></div>';
      }).join("");
      for(var i=0;i<compressing;i++){ h += '<div class="thumb thumb-pending">処理中…</div>'; }
      thumbGrid.innerHTML = h;
      draftImages.forEach(function(img, i){
        var box = thumbGrid.children[i];
        loadThumbInto(box, img, img.isNew ? Promise.resolve(img.url) : imageUrl(img));
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
          draftImages = draftImages.filter(function(x){ return x !== img; });
          removeMarkers(img.ref);
          markDirty();
          renderThumbs();
        });
      });
      refreshInlineState();
      saveBtn.disabled = compressing > 0;
    }

    function afterBodyImages(){
      var refs = rich.refs();
      return draftImages.filter(function(img){ return refs.indexOf(img.ref) < 0; });
    }
    // Marks the thumbnails placed in the text, and limits the board to the rest.
    function refreshInlineState(){
      var refs = rich.refs().filter(function(r, i, all){ return all.indexOf(r) === i; });
      draftImages.forEach(function(img, i){
        var box = thumbGrid.children[i];
        if(box){ box.classList.toggle("placed", refs.indexOf(img.ref) >= 0); }
      });
      var rest = draftImages.length - refs.length;
      document.getElementById("layoutBtn").disabled = rest < 1 || compressing > 0;
      document.getElementById("layoutNote").textContent =
        refs.length ? "本文中に" + refs.length + "枚" + (rest ? "・本文のあとに" + rest + "枚" + (draftLayout ? "（自由配置）" : "") : "") :
        (draftLayout && draftImages.length ? "自由配置で表示します" : "");
    }

    // 「本文へ」: the image goes in at the caret (beside the chosen image, if one is chosen).
    function insertMarker(img){
      rich.insertImage(img.ref);
    }
    // Removing an attachment also takes it out of the text.
    function removeMarkers(ref){
      rich.removeRef(ref);
    }

    // Swaps one draft image for another (after annotating or reverting).
    function replaceDraft(oldImg, newImg){
      var i = draftImages.indexOf(oldImg);
      if(i < 0) return;
      newImg.ref = oldImg.ref;
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
            ensureRefs(draftImages);
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
      ensureRefs(draftImages);
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
        createdAt: entry && (entry.createdAt || entry.updatedAt) || new Date().toISOString(),
        updatedAt: entry && entry.updatedAt
      };
    }

    // Opens the annotation editor on the untouched original of `img` (with its
    // previous crop/shapes, if any) and replaces the draft with the result.
    function annotate(img){
      var orig = img.edit ? {
        id: img.edit.originalId, mime: img.edit.originalMime, width: img.edit.originalWidth,
        height: img.edit.originalHeight, size: img.edit.originalSize,
        bytes: img.edit.originalBytes || null, url: img.edit.originalUrl || null
      } : {
        id: img.id, mime: img.mime, width: img.width, height: img.height, size: img.size,
        bytes: img.isNew ? img.bytes : null, url: img.isNew ? img.url : null
      };
      var urlReady = orig.url ? Promise.resolve(orig.url) : imageUrl({ id: orig.id, mime: orig.mime });
      urlReady.then(function(url){
        return window.ImageEditor.open({ url: url, crop: img.edit && img.edit.crop, shapes: img.edit && img.edit.shapes });
      }).then(function(r){
        if(!r) return;
        if(r.empty){
          replaceDraft(img, {
            id: orig.id, mime: orig.mime, name: img.name, width: orig.width, height: orig.height, size: orig.size,
            isNew: !!orig.bytes, bytes: orig.bytes, url: orig.url, composite: img.composite
          });
          return;
        }
        compressing++;
        renderThumbs();
        return compressImage(new File([r.blob], "edited.png", { type:"image/png" })).then(function(res){
          return res.blob.arrayBuffer().then(function(ab){
            replaceDraft(img, {
              id: genId(), mime: res.mime, name: img.name, width: res.width, height: res.height, size: res.blob.size,
              isNew: true, bytes: new Uint8Array(ab), url: URL.createObjectURL(res.blob),
              edit: {
                originalId: orig.id, originalMime: orig.mime, originalWidth: orig.width,
                originalHeight: orig.height, originalSize: orig.size,
                originalBytes: orig.bytes, originalUrl: orig.url,
                crop: r.crop, shapes: r.shapes
              },
              composite: img.composite
            });
          });
        }).then(function(){
          compressing--;
          if(thumbGrid.isConnected){ renderThumbs(); }
        }, function(err){
          compressing--;
          if(thumbGrid.isConnected){ renderThumbs(); }
          throw err;
        });
      }).catch(function(err){
        showToast(withDetail("画像への書き込みを反映できませんでした", err), 6000);
      });
    }

    var fileList = document.getElementById("fileList");
    function renderFiles(){
      fileList.innerHTML = draftFiles.map(function(f, i){
        return '<div class="file-row">' +
                 '<button type="button" class="file-open" data-i="'+i+'" title="開く">'+fileIcon(f)+' '+escapeHtml(f.name)+'</button>' +
                 '<span class="file-size">'+fmtSize(f.size)+'</span>' +
                 '<button type="button" class="file-remove" data-i="'+i+'" title="添付を外す">×</button>' +
               '</div>';
      }).join("");
      Array.prototype.forEach.call(fileList.querySelectorAll(".file-open"), function(b){
        b.addEventListener("click", function(){ openAttachment(draftFiles[Number(b.getAttribute("data-i"))]); });
      });
      Array.prototype.forEach.call(fileList.querySelectorAll(".file-remove"), function(b){
        b.addEventListener("click", function(){
          draftFiles.splice(Number(b.getAttribute("data-i")), 1);
          markDirty();
          renderFiles();
        });
      });
    }
    function addAttachment(file){
      if(file.size > MAX_FILE_BYTES){
        showToast("「"+(file.name||"")+"」は大きすぎます（1つ20MBまで）", 5000);
        return;
      }
      compressing++;
      renderThumbs();
      file.arrayBuffer().then(function(ab){
        draftFiles.push({ id: genId(), name: file.name || "file", mime: file.type || "application/octet-stream",
                          size: file.size, isNew: true, bytes: new Uint8Array(ab) });
        markDirty();
      }).catch(function(){
        showToast("ファイルを読み込めませんでした（"+(file.name||"")+"）");
      }).then(function(){
        compressing--;
        if(fileList.isConnected){ renderThumbs(); renderFiles(); }
      });
    }

    // Images go to the images (shrunk, can be placed in the text); anything else is attached as a file.
    // inline: also put each image into the text at the caret (pasting into the body).
    function addFiles(files, inline){
      Array.prototype.forEach.call(files, function(file){
        if(IMAGE_TYPES.indexOf(file.type) < 0){
          addAttachment(file);
          return;
        }
        compressing++;
        renderThumbs();
        compressImage(file).then(function(res){
          return res.blob.arrayBuffer().then(function(ab){
            var added = {
              id: genId(), mime: res.mime, name: file.name || "image",
              width: res.width, height: res.height, size: res.blob.size,
              isNew: true, bytes: new Uint8Array(ab), url: URL.createObjectURL(res.blob)
            };
            draftImages.push(added);
            ensureRefs(draftImages);
            markDirty();
            if(inline && thumbGrid.isConnected){ rich.insertImage(added.ref); }
          });
        }).catch(function(err){
          showToast(err && err.code === "too_large" ? "この画像は500KB以下に縮小できませんでした" : "画像を読み込めませんでした（"+(file.name||"")+"）");
        }).then(function(){
          compressing--;
          if(thumbGrid.isConnected){ renderThumbs(); }
        });
      });
    }

    renderThumbs();
    renderFiles();

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
    saveBtn.addEventListener("click", function(){ doSave().catch(noop); });
    editorSave = function(){ return compressing > 0 ? Promise.reject({ code:"busy" }) : doSave(); };

    // Resolves once the entry is on Drive; rejects (after showing why) when it could not be saved.
    function doSave(){
      var nowIso = new Date().toISOString();
      var newEntry = {
        id: draft.id || genId(),
        title: document.getElementById("editTitle").value.trim(),
        date: document.getElementById("editDate").value || todayStr(),
        category: document.getElementById("editCategory").value,
        body: rich.getBody(),
        tags: (flushTagEdit(), addTypedTags(), draftTags.slice()),
        images: draftImages.map(storedImageMeta),
        files: draftFiles.map(storedFileMeta),
        // 記入時刻 = first save; entries saved before this existed fall back to their last save.
        createdAt: (entry && (entry.createdAt || entry.updatedAt)) || nowIso,
        updatedAt: nowIso
      };
      var keptKeys = [].concat.apply([], draftImages.map(imageFileKeys))
        .concat(draftFiles.map(function(f){ return f.id; }));
      var removedIds = originalImageIds.filter(function(key){ return keptKeys.indexOf(key) < 0; });
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
      if(draftImages.length && draftLayout){
        newEntry.layout = BoardLayout.normalize(draftImages, draftLayout);
      }
      saveBtn.disabled = true;
      saveBtn.textContent = "保存中…";
      return saveEntry(newEntry, newImages, removedIds).then(function(){
        newImages.forEach(function(img){ if(img.url){ imageUrlCache[img.id] = Promise.resolve(img.url); } });
        editorDirty = false;
        // A new record gets its id only now: keep the image shown on the right.
        if(sideCurrent && sideCurrent.entryId === openEntryId){ sideCurrent.entryId = newEntry.id; }
        openEntryId = newEntry.id;
        currentView = "view";
        renderCategories();
        renderMain();
        showToast("保存しました");
      }).catch(function(err){
        if(saveBtn.isConnected){
          saveBtn.disabled = false;
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
      createdAt: e.createdAt, updatedAt: e.updatedAt
    };
  }

  function upsertLive(entry){
    var idx = liveEntries.findIndex(function(e){ return e.id === entry.id; });
    if(idx >= 0){ liveEntries[idx] = entry; } else { liveEntries.push(entry); }
  }

  // 1) upload newly attached images, 2) write the journal, 3) move detached
  //    images to the Drive trash. Uploaded images are trashed again if the
  //    journal write fails so no orphans are left behind.
  function saveEntry(entry, newImages, removedIds){
    var uploaded = {};
    var committed = false;
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
      }).then(function(){
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
        var entry = liveEntries.filter(function(e){ return e.id === id; })[0];
        var imgIds = [].concat.apply([], (entry && entry.images || []).map(imageFileKeys))
          .concat((entry && entry.files || []).map(function(f){ return f.id; }));
        var toTrash = [];
        persist(function(d){
          toTrash = [];
          d.entries = d.entries.filter(function(e){ return e.id !== id; });
          imgIds.forEach(function(k){
            if(d.images[k]){ toTrash.push(d.images[k]); delete d.images[k]; }
          });
        }).then(function(){
          liveEntries = liveEntries.filter(function(e){ return e.id !== id; });
          imgIds.forEach(dropCachedImage);
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
      (e.images||[]).forEach(function(img){ all.push({ item: img, name: img.id + "." + extForMime(img.mime) }); });
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
    "h1{ font-size:16pt; line-height:1.4; margin:0 0 12px; }" +
    ".body p{ margin:0 0 .8em; }" +
    ".body h2,.body h3,.body h4{ margin:1.1em 0 .4em; line-height:1.4; }" +
    ".body ul{ padding-left:1.4em; margin:0 0 .8em; }" +
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
    ".inline-row.multi .inline-fig{ flex:1 1 0; width:auto; min-width:0; }" +
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
    // Every image row starts below the images before it (a wrapped one included).
    ".inline-row{ clear:both; }" +
    ".wrap-group{ display:flow-root; }" +
    ".body::after{ content:''; display:block; clear:both; }";

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
    }) + '</section>';
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
  function printSectionHead(e, figure){
    return '<div class="meta"><span>'+escapeHtml(fmtDate(e.date))+'</span>' +
             '<span>'+escapeHtml(writtenLabel(e))+(updatedLabel(e) ? '・'+escapeHtml(updatedLabel(e)) : '')+'</span>' +
             '<span>'+escapeHtml(catName(e.category))+'</span>' +
             ((e.tags && e.tags.length) ? '<span>'+e.tags.map(function(t){ return "#" + escapeHtml(t); }).join(" ")+'</span>' : '') +
           '</div>' +
           '<h1>'+escapeHtml(e.title || "（無題）")+'</h1>' +
           '<div class="body">'+mdToHtml(e.body, e.images, figure)+'</div>';
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
        }) + imgs + fileCardsHtml(e.files) + '</section>');
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

  function fitPaper(fit){
    var sheet = fit.firstChild;
    var avail = fit.parentNode.clientWidth;
    var s = Math.min(1, avail / PAPER_W_PX);
    sheet.style.transform = "scale(" + s + ")";
    fit.style.width = (PAPER_W_PX * s) + "px";
    fit.style.height = (sheet.offsetHeight * s) + "px";
  }
  window.addEventListener("resize", function(){
    Array.prototype.forEach.call(document.querySelectorAll(".paper-fit"), fitPaper);
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
    var blocks = section.querySelectorAll(".meta, h1, .body p, .body h2, .body h3, .body h4, .body li, .body .inline-row, .board, .images figure, .files");
    var shift = 0, next = pageH;
    var ys = [];
    function line(y){
      ys.push(y);
      next += pageH;
    }
    Array.prototype.forEach.call(blocks, function(b){
      var r = b.getBoundingClientRect();
      var top = r.top - top0, h = r.height;
      while(top + shift >= next){ line(Math.min(top, next - shift)); }
      var keep = !/^(P|H[1-4]|LI)$/.test(b.tagName) && h <= pageH;
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
    var total = section.getBoundingClientRect().height + shift;
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
              scale: PDF_SCALE, backgroundColor: "#ffffff", logging: false,
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
        var pages = markPageBreaks(host.querySelector(".paper .entry"));
        host.querySelector("#paperNote").textContent = "A4で " + pages + " ページ（点線は印刷したときのページの区切りの目安）";
        fitPaper(host.querySelector(".paper-fit"));
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
      });
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

  /* ---------------- wire up sidebar tool buttons ---------------- */
  document.getElementById("btnNewEntry").addEventListener("click", openNewEntry);
  document.getElementById("btnExportBackup").addEventListener("click", exportBackup);
  document.getElementById("btnExportMd").addEventListener("click", exportMarkdown);
  document.getElementById("btnPrintMany").addEventListener("click", openPrintManyModal);
  document.getElementById("btnChangePw").addEventListener("click", openChangePasswordModal);
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
    if(pendingWrites > 0 || (currentView === "editor" && editorDirty)){
      e.preventDefault();
      e.returnValue = "";
    }
  });

  /* ---------------- boot ---------------- */
  initGate();

})();
