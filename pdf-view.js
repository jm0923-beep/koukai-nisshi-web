/* PDF の絵と表示 (v1.0.205): pdf.js (Apache 2.0, src/renderer/pdfjs, loaded only when needed).
 *   PdfView.firstPage(bytes, width) → Promise<{ blob, width, height, pages }>: page 1 as a JPEG, for a PDF placed
 *     in the body ([PDF1 中], app.js). Made once when it is placed and saved with the record like a video's picture.
 *   PdfView.view(host, bytes) → Promise<{ destroy() }>: every page in host, as wide as host (幅に合わせる), zoomed
 *     with two fingers (iPhone / iPad), a double tap, Ctrl+wheel or the ＋/－ buttons it adds. The browser's own
 *     PDF view in an iframe (until v1.0.204) showed the page at its own size on iPhone and could not be zoomed.
 * Pages are drawn when they come into sight and dropped again far away, so a long PDF does not fill the memory
 * (Safari on iPhone stops drawing canvases beyond a few hundred MB). */
(function(){
  "use strict";
  // pdfjs/ sits beside this file; the web version adds ?v=… to it, which the pdf.js files get too.
  var here = (function(){
    var s = document.currentScript, src = (s && s.src) || "";
    var q = src.indexOf("?");
    var path = q < 0 ? src : src.slice(0, q);
    return { dir: path.slice(0, path.lastIndexOf("/") + 1), v: q < 0 ? "" : src.slice(q) };
  })();
  var loading = null;
  function addScript(url){
    return new Promise(function(resolve, reject){
      var s = document.createElement("script");
      s.src = url;
      s.onload = resolve;
      s.onerror = function(){ reject({ code: "pdfjs_load" }); };
      document.head.appendChild(s);
    });
  }
  function load(){
    if(!loading){
      var workerUrl = here.dir + "pdfjs/pdf.worker.min.js" + here.v;
      loading = addScript(here.dir + "pdfjs/pdf.min.js" + here.v).then(function(){
        var lib = window.pdfjsLib;
        if(!lib){ throw { code: "pdfjs_load" }; }
        // A file:// page (the Windows app) cannot start a worker: pdf.js then works on this page
        // (it uses window.pdfjsWorker when that is there).
        if(location.protocol === "file:" || typeof Worker === "undefined"){
          return addScript(workerUrl).then(function(){ return lib; });
        }
        lib.GlobalWorkerOptions.workerSrc = workerUrl;
        return lib;
      });
      loading.catch(function(){ loading = null; });
    }
    return loading;
  }
  // pdf.js hands the bytes to its worker (they are gone afterwards): it gets a copy.
  function openDoc(bytes){
    return load().then(function(lib){
      var data = bytes instanceof Uint8Array ? bytes.slice() : new Uint8Array(bytes).slice();
      return lib.getDocument({
        data: data, isEvalSupported: false,
        cMapUrl: here.dir + "pdfjs/cmaps/", cMapPacked: true   // 日本語の PDF の文字の対応表
      }).promise;
    });
  }

  // Page 1 as a JPEG `width` pixels wide (white under transparent parts).
  function firstPage(bytes, width){
    return openDoc(bytes).then(function(doc){
      return doc.getPage(1).then(function(page){
        var one = page.getViewport({ scale: 1 });
        var vp = page.getViewport({ scale: (width || 1000) / one.width });
        var c = document.createElement("canvas");
        c.width = Math.max(1, Math.round(vp.width));
        c.height = Math.max(1, Math.round(vp.height));
        var ctx = c.getContext("2d");
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, c.width, c.height);
        return page.render({ canvasContext: ctx, viewport: vp }).promise.then(function(){
          return new Promise(function(resolve){ c.toBlob(resolve, "image/jpeg", 0.82); });
        }).then(function(blob){
          var out = { blob: blob, width: c.width, height: c.height, pages: doc.numPages };
          c.width = c.height = 0;
          return out;
        });
      }).then(function(out){ doc.destroy(); return out; }, function(err){ doc.destroy(); throw err; });
    });
  }

  var MIN_ZOOM = 1, MAX_ZOOM = 6, GAP = 8, MAX_PIXELS = 8e6;
  function view(host, bytes){
    host.innerHTML =
      '<div class="pdfv"><div class="pdfv-scroll"><div class="pdfv-pages"></div></div>' +
        '<div class="pdfv-zoom">' +
          '<button type="button" data-z="-1" title="縮小" aria-label="縮小">－</button>' +
          '<button type="button" data-z="0" class="pdfv-pct" title="画面の幅に合わせる">100%</button>' +
          '<button type="button" data-z="1" title="拡大" aria-label="拡大">＋</button>' +
        '</div><p class="pdfv-msg">読み込んでいます…</p></div>';
    var root = host.querySelector(".pdfv"), scroller = root.querySelector(".pdfv-scroll");
    var wrap = root.querySelector(".pdfv-pages"), pct = root.querySelector(".pdfv-pct");
    var doc = null, pages = [], zoom = 1, gone = false, observer = null;
    var cleanups = [];
    function on(el, type, fn, o){ el.addEventListener(type, fn, o); cleanups.push(function(){ el.removeEventListener(type, fn, o); }); }

    function fitWidth(){ return Math.max(100, scroller.clientWidth - GAP * 2); }
    // Every page as wide as the screen × zoom; the gaps grow with it, so the whole column scales as one.
    function layout(){
      var w = fitWidth() * zoom;
      wrap.style.width = w + "px";
      pages.forEach(function(p){
        p.el.style.width = w + "px";
        p.el.style.height = (w * p.ratio) + "px";
        p.el.style.marginBottom = (GAP * zoom) + "px";
      });
      pct.textContent = Math.round(zoom * 100) + "%";
    }
    // Draws the pages near the screen at the sharpness the zoom needs; drops those far away.
    var queue = Promise.resolve(), drawTimer = 0;
    function scheduleDraw(){
      clearTimeout(drawTimer);
      drawTimer = setTimeout(drawVisible, 60);
    }
    function drawVisible(){
      if(gone) return;
      var top = scroller.scrollTop, h = scroller.clientHeight;
      pages.forEach(function(p){
        var y = p.el.offsetTop - wrap.offsetTop, ph = p.el.offsetHeight;
        var near = y + ph > top - h && y < top + h * 2;
        if(near){ draw(p); }
        else if(p.canvas && (y + ph < top - h * 3 || y > top + h * 4)){
          if(p.task){ p.task.cancel(); }
          p.canvas.width = p.canvas.height = 0;
          p.canvas.remove();
          p.canvas = null;
          p.scale = 0;
        }
      });
    }
    function draw(p){
      var dpr = window.devicePixelRatio || 1;
      var cssW = fitWidth() * zoom;
      var scale = cssW * dpr / p.w1;
      // Never more pixels than the phone can hold: very large zooms are a little soft instead.
      var px = (p.w1 * scale) * (p.w1 * p.ratio * scale);
      if(px > MAX_PIXELS){ scale *= Math.sqrt(MAX_PIXELS / px); }
      if(p.scale && Math.abs(p.scale - scale) / scale < 0.02) return;
      p.scale = scale;
      queue = queue.then(function(){
        if(gone || p.scale !== scale) return;
        var vp = p.page.getViewport({ scale: scale });
        var c = document.createElement("canvas");
        c.width = Math.max(1, Math.round(vp.width));
        c.height = Math.max(1, Math.round(vp.height));
        var ctx = c.getContext("2d");
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, c.width, c.height);
        p.task = p.page.render({ canvasContext: ctx, viewport: vp });
        return p.task.promise.then(function(){
          p.task = null;
          if(gone || p.scale !== scale){ c.width = c.height = 0; return; }
          // The new picture replaces the old one only when it is ready, so the page never goes blank.
          if(p.canvas){ p.canvas.width = p.canvas.height = 0; p.canvas.remove(); }
          p.canvas = c;
          p.el.appendChild(c);
        }, function(){ p.task = null; c.width = c.height = 0; if(p.scale === scale){ p.scale = 0; } });
      });
    }

    // Zoom to z keeping the screen point (sx, sy) (relative to the scroller) on the same spot of the page.
    function zoomTo(z, sx, sy){
      z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
      if(sx == null){ sx = scroller.clientWidth / 2; sy = scroller.clientHeight / 2; }
      var r = z / zoom;
      var px = scroller.scrollLeft + sx - wrap.offsetLeft, py = scroller.scrollTop + sy - wrap.offsetTop;
      zoom = z;
      layout();
      scroller.scrollLeft = wrap.offsetLeft + px * r - sx;
      scroller.scrollTop = wrap.offsetTop + py * r - sy;
      scheduleDraw();
    }

    // Two fingers: the column follows them (a CSS transform while they move), and is laid out at the new size
    // when they let go. One finger scrolls as usual. Two quick taps: 250% there, or back to the screen's width.
    var pinch = null, lastTap = null;
    function pt(t){ var r = scroller.getBoundingClientRect(); return { x: t.clientX - r.left, y: t.clientY - r.top }; }
    function mid(ts){ var a = pt(ts[0]), b = pt(ts[1]); return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) || 1 }; }
    var touchAt = null;   // where and when the last one-finger touch began: a tap is short and does not move
    on(scroller, "touchstart", function(e){
      if(e.touches.length === 1){ var s = pt(e.touches[0]); touchAt = { x: s.x, y: s.y, at: Date.now() }; }
      if(e.touches.length === 2){
        var m = mid(e.touches);
        pinch = { m0: m, now: m, r: 1,
                  px: scroller.scrollLeft + m.x - wrap.offsetLeft, py: scroller.scrollTop + m.y - wrap.offsetTop };
        lastTap = null;
        e.preventDefault();
      }
    }, { passive: false });
    on(scroller, "touchmove", function(e){
      if(!pinch || e.touches.length < 2) return;
      e.preventDefault();
      var m = mid(e.touches);
      var r = Math.min(MAX_ZOOM / zoom, Math.max(MIN_ZOOM * 0.7 / zoom, m.d / pinch.m0.d));
      pinch.now = m;
      pinch.r = r;
      // The page point under the fingers at the start stays under them.
      var tx = (m.x - pinch.m0.x) + pinch.px * (1 - r), ty = (m.y - pinch.m0.y) + pinch.py * (1 - r);
      wrap.style.transformOrigin = "0 0";
      wrap.style.transform = "translate(" + tx + "px," + ty + "px) scale(" + r + ")";
    }, { passive: false });
    function endPinch(){
      if(!pinch) return;
      var p = pinch;
      pinch = null;
      wrap.style.transform = "";
      var z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom * p.r));
      var r = z / zoom;
      zoom = z;
      layout();
      scroller.scrollLeft = wrap.offsetLeft + p.px * r - p.now.x;
      scroller.scrollTop = wrap.offsetTop + p.py * r - p.now.y;
      scheduleDraw();
    }
    on(scroller, "touchend", function(e){
      if(pinch){ if(e.touches.length < 2){ endPinch(); } return; }
      if(e.touches.length || e.changedTouches.length !== 1) return;
      var t = pt(e.changedTouches[0]), now = Date.now();
      // The end of a scroll (a flick) is no tap.
      if(!touchAt || now - touchAt.at > 300 || Math.hypot(t.x - touchAt.x, t.y - touchAt.y) > 12){ lastTap = null; return; }
      if(lastTap && now - lastTap.at < 320 && Math.hypot(t.x - lastTap.x, t.y - lastTap.y) < 30){
        e.preventDefault();
        lastTap = null;
        zoomTo(zoom > 1.05 ? 1 : 2.5, t.x, t.y);
        return;
      }
      lastTap = { at: now, x: t.x, y: t.y };
    }, { passive: false });
    on(scroller, "touchcancel", endPinch);
    // Safari's own pinch of the whole page: not here (the page above stays as it is).
    on(root, "gesturestart", function(e){ e.preventDefault(); }, { passive: false });
    on(root, "gesturechange", function(e){ e.preventDefault(); }, { passive: false });
    // A mouse: Ctrl+wheel (also a trackpad's pinch), a double click.
    on(scroller, "wheel", function(e){
      if(!e.ctrlKey) return;
      e.preventDefault();
      var r = scroller.getBoundingClientRect();
      zoomTo(zoom * Math.exp(-e.deltaY / 300), e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });
    on(scroller, "dblclick", function(e){
      var r = scroller.getBoundingClientRect();
      zoomTo(zoom > 1.05 ? 1 : 2.5, e.clientX - r.left, e.clientY - r.top);
    });
    Array.prototype.forEach.call(root.querySelectorAll(".pdfv-zoom button"), function(b){
      on(b, "click", function(){
        var d = Number(b.getAttribute("data-z"));
        zoomTo(d === 0 ? 1 : d > 0 ? zoom * 1.25 : zoom / 1.25);
      });
    });
    on(scroller, "scroll", scheduleDraw);
    // Turning the phone: the pages take the new width (the zoom stays relative to it).
    var lastW = 0;
    function resized(){
      var w = scroller.clientWidth;
      if(!w || w === lastW) return;
      lastW = w;
      layout();
      scheduleDraw();
    }
    if(window.ResizeObserver){
      observer = new ResizeObserver(resized);
      observer.observe(scroller);
    } else {
      on(window, "resize", resized);
    }

    var ctl = {
      destroy: function(){
        if(gone) return;
        gone = true;
        clearTimeout(drawTimer);
        cleanups.forEach(function(f){ f(); });
        if(observer){ observer.disconnect(); }
        pages.forEach(function(p){
          if(p.task){ p.task.cancel(); }
          if(p.canvas){ p.canvas.width = p.canvas.height = 0; }
        });
        pages = [];
        if(doc){ doc.destroy(); doc = null; }
      }
    };

    return openDoc(bytes).then(function(d){
      if(gone){ d.destroy(); return; }
      doc = d;
      var list = [];
      for(var i = 1; i <= d.numPages; i++){ list.push(i); }
      // Every page's size first, so the column has its full length from the start.
      return list.reduce(function(p, n){
        return p.then(function(){
          return d.getPage(n).then(function(page){
            var one = page.getViewport({ scale: 1 });
            var el = document.createElement("div");
            el.className = "pdfv-page";
            wrap.appendChild(el);
            pages.push({ page: page, el: el, w1: one.width, ratio: one.height / one.width, canvas: null, scale: 0, task: null });
          });
        });
      }, Promise.resolve());
    }).then(function(){
      if(gone) return;
      root.querySelector(".pdfv-msg").remove();
      lastW = scroller.clientWidth;
      layout();
      drawVisible();
    }).then(function(){ return ctl; }, function(err){
      var msg = root.querySelector(".pdfv-msg");
      if(msg){ msg.textContent = "PDF を表示できませんでした。"; }
      ctl.destroy();
      throw err;
    });


  }

  window.PdfView = { load: load, firstPage: firstPage, view: view };
})();
