// Free layout ("image board") for an entry's attached images.
//
// A layout is stored on the entry as
//   { h, items: { <imageId>: { x, y, w } }, order: [imageId, ...] }
// where every number is a fraction of the board width (so it scales to any
// screen or to the printed page). An item's height follows the image's
// aspect ratio; `order` is the stacking order (last = front).
//
// window.BoardLayout  — pure helpers shared by the viewer and print code
// window.BoardEditor.open({ images:[{id,url,width,height,name}], layout, guide })
//   resolves null (cancelled), { action:"layout", layout }
//   or { action:"composite", layout, blob } (a flattened JPEG of the board).
(function(){
  "use strict";

  var GAP = 0.02;
  var MIN_W = 0.06;

  function ratio(im){ return im.width && im.height ? im.height / im.width : 0.75; }

  function bottomOf(images, layout){
    var b = 0;
    images.forEach(function(im){
      var it = layout.items[im.id];
      if(it){ b = Math.max(b, it.y + it.w * ratio(im)); }
    });
    return b;
  }

  function autoLayout(images){
    var n = images.length;
    var cols = n <= 1 ? 1 : n <= 4 ? 2 : 3;
    var w = (1 - GAP * (cols + 1)) / cols;
    var items = {}, order = [];
    var y = GAP, rowH = 0, col = 0;
    images.forEach(function(im){
      items[im.id] = { x: GAP + col * (w + GAP), y: y, w: w };
      order.push(im.id);
      rowH = Math.max(rowH, w * ratio(im));
      col++;
      if(col === cols){ col = 0; y += rowH + GAP; rowH = 0; }
    });
    var layout = { h: 0, items: items, order: order };
    layout.h = bottomOf(images, layout) + GAP;
    return layout;
  }

  // Makes a stored layout consistent with the current images: drops removed
  // ones and places newly attached ones in a row below everything else.
  function normalize(images, layout){
    if(!layout || !layout.items){ return autoLayout(images); }
    var items = {}, order = [];
    var ids = images.map(function(im){ return im.id; });
    (layout.order || Object.keys(layout.items)).forEach(function(id){
      if(ids.indexOf(id) >= 0 && layout.items[id] && order.indexOf(id) < 0){
        items[id] = Object.assign({}, layout.items[id]);
        order.push(id);
      }
    });
    var out = { h: layout.h || 0, items: items, order: order };
    var missing = images.filter(function(im){ return !items[im.id]; });
    if(missing.length){
      var y = bottomOf(images, out) + GAP, x = GAP, rowH = 0, w = 0.3;
      missing.forEach(function(im){
        if(x + w > 1 - GAP + 1e-9){ x = GAP; y += rowH + GAP; rowH = 0; }
        items[im.id] = { x: x, y: y, w: w };
        order.push(im.id);
        x += w + GAP;
        rowH = Math.max(rowH, w * ratio(im));
      });
    }
    out.h = Math.max(out.h, bottomOf(images, out) + GAP);
    return out;
  }

  window.BoardLayout = { normalize: normalize, auto: autoLayout, ratio: ratio, bottom: bottomOf };

  function loadImage(url){
    return new Promise(function(resolve, reject){
      var im = new Image();
      im.onload = function(){ resolve(im); };
      im.onerror = function(){ reject(new Error("画像を読み込めませんでした")); };
      im.src = url;
    });
  }
  function esc(s){
    return String(s).replace(/[&<>"']/g, function(c){ return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]; });
  }
  function clamp(v, lo, hi){ return Math.min(Math.max(v, lo), hi); }

  function open(opts){
    return new Promise(function(resolve){ run(opts, resolve); });
  }

  function run(opts, resolve){
    var images = opts.images;
    var byId = {};
    images.forEach(function(im){ byId[im.id] = im; });
    var layout = normalize(images, opts.layout && JSON.parse(JSON.stringify(opts.layout)));
    var guide = opts.guide;          // fraction of board width where the A4 page ends, or null
    var selected = null;

    var root = document.createElement("div");
    root.className = "bded";
    root.innerHTML =
      '<div class="imged-bar">' +
        '<div class="imged-group">' +
          '<button type="button" class="imged-btn" data-act="auto">▦ 自動で並べる</button>' +
          '<button type="button" class="imged-btn" data-act="fit">⤓ A4に収める</button>' +
          '<button type="button" class="imged-btn" data-act="front">▲ 前面へ</button>' +
        '</div>' +
        '<div class="imged-group">' +
          '<button type="button" class="imged-btn" data-act="composite">⧉ 合成して1枚の画像にする</button>' +
        '</div>' +
        '<button type="button" class="imged-close" data-act="close">✕ 閉じる</button>' +
      '</div>' +
      '<div class="bded-stage"><div class="bded-board"><div class="bded-guide"><span>A4ページの下端の目安</span></div><div class="bded-resize-board" title="ボードの高さを変える"></div></div></div>' +
      '<div class="imged-foot">' +
        '<span class="imged-hint">画像をドラッグで移動、右下の角でサイズ変更。ボードの下端をドラッグすると高さを変えられます。</span>' +
        '<button type="button" class="btn btn-ghost btn-small" data-act="cancel">キャンセル</button>' +
        '<button type="button" class="btn btn-primary btn-small" data-act="save">配置を反映</button>' +
      '</div>';
    document.body.appendChild(root);

    var stage = root.querySelector(".bded-stage");
    var board = root.querySelector(".bded-board");
    var guideEl = root.querySelector(".bded-guide");
    var W = 800;

    var els = {};
    layout.order.forEach(function(id){
      var im = byId[id];
      var el = document.createElement("div");
      el.className = "bded-item";
      el.innerHTML = '<img alt="'+esc(im.name || "")+'" draggable="false" src="'+im.url+'"><span class="bded-handle" title="サイズを変える"></span>';
      board.appendChild(el);
      els[id] = el;
      bindItem(id, el);
    });

    function place(){
      W = Math.min(stage.clientWidth - 48, 900);
      board.style.width = W + "px";
      board.style.height = Math.round(layout.h * W) + "px";
      layout.order.forEach(function(id, z){
        var it = layout.items[id], el = els[id];
        el.style.left = (it.x * W) + "px";
        el.style.top = (it.y * W) + "px";
        el.style.width = (it.w * W) + "px";
        el.style.height = (it.w * ratio(byId[id]) * W) + "px";
        el.style.zIndex = String(z + 1);
        el.classList.toggle("on", id === selected);
      });
      if(guide){
        guideEl.style.display = "block";
        guideEl.style.top = (guide * W) + "px";
      } else {
        guideEl.style.display = "none";
      }
      root.querySelector('[data-act="fit"]').disabled = !guide;
      root.querySelector('[data-act="front"]').disabled = !selected;
    }

    function grow(){
      layout.h = Math.max(layout.h, bottomOf(images, layout) + 0.01);
    }

    function bindItem(id, el){
      el.addEventListener("pointerdown", function(e){
        if(e.button !== 0) return;
        e.preventDefault();
        selected = id;
        var it = layout.items[id];
        var rect = board.getBoundingClientRect();
        var resizing = e.target.classList.contains("bded-handle");
        var startX = (e.clientX - rect.left) / W, startY = (e.clientY - rect.top) / W;
        var orig = { x: it.x, y: it.y, w: it.w };
        el.setPointerCapture(e.pointerId);
        function move(ev){
          var px = (ev.clientX - rect.left) / W, py = (ev.clientY - rect.top) / W;
          if(resizing){
            // At the right edge the image grows leftwards instead of stopping.
            it.w = clamp(orig.w + (px - startX), MIN_W, 1);
            it.x = Math.min(orig.x, 1 - it.w);
          } else {
            it.x = clamp(orig.x + (px - startX), 0, 1 - it.w);
            it.y = Math.max(0, orig.y + (py - startY));
          }
          grow();
          place();
        }
        function up(){
          el.removeEventListener("pointermove", move);
          el.removeEventListener("pointerup", up);
          el.removeEventListener("pointercancel", up);
        }
        el.addEventListener("pointermove", move);
        el.addEventListener("pointerup", up);
        el.addEventListener("pointercancel", up);
        place();
      });
    }

    // Dragging the board's bottom edge changes its height (never above the lowest image).
    var boardHandle = root.querySelector(".bded-resize-board");
    boardHandle.addEventListener("pointerdown", function(e){
      e.preventDefault();
      var rect = board.getBoundingClientRect();
      boardHandle.setPointerCapture(e.pointerId);
      function move(ev){
        layout.h = Math.max((ev.clientY - rect.top) / W, bottomOf(images, layout) + 0.01, 0.1);
        place();
      }
      function up(){
        boardHandle.removeEventListener("pointermove", move);
        boardHandle.removeEventListener("pointerup", up);
      }
      boardHandle.addEventListener("pointermove", move);
      boardHandle.addEventListener("pointerup", up);
    });
    board.addEventListener("pointerdown", function(e){
      if(e.target === board){ selected = null; place(); }
    });

    function fitToGuide(){
      var bottom = bottomOf(images, layout);
      var target = guide - 0.01;
      if(bottom > target){
        var s = target / bottom;
        layout.order.forEach(function(id){
          var it = layout.items[id];
          it.x *= s; it.y *= s; it.w *= s;
        });
      }
      layout.h = Math.min(Math.max(bottomOf(images, layout) + 0.01, layout.h), guide);
    }

    function composite(){
      var OUT_W = 2000;
      var canvas = document.createElement("canvas");
      canvas.width = OUT_W;
      canvas.height = Math.max(1, Math.round(layout.h * OUT_W));
      var ctx = canvas.getContext("2d");
      ctx.fillStyle = "#FFFFFF";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.imageSmoothingQuality = "high";
      return layout.order.reduce(function(p, id){
        return p.then(function(){
          return loadImage(byId[id].url).then(function(img){
            var it = layout.items[id];
            ctx.drawImage(img, it.x * OUT_W, it.y * OUT_W, it.w * OUT_W, it.w * ratio(byId[id]) * OUT_W);
          });
        });
      }, Promise.resolve()).then(function(){
        return new Promise(function(res){ canvas.toBlob(res, "image/jpeg", 0.92); });
      });
    }

    function close(result){
      window.removeEventListener("resize", place);
      document.removeEventListener("keydown", onKey, true);
      root.remove();
      resolve(result);
    }
    function onKey(e){ if(e.key === "Escape"){ e.preventDefault(); close(null); } }

    root.addEventListener("click", function(e){
      var b = e.target.closest("button[data-act]");
      if(!b || b.disabled) return;
      var act = b.getAttribute("data-act");
      if(act === "auto"){ layout = autoLayout(images); selected = null; place(); }
      if(act === "fit"){ fitToGuide(); place(); }
      if(act === "front" && selected){
        layout.order.splice(layout.order.indexOf(selected), 1);
        layout.order.push(selected);
        place();
      }
      if(act === "cancel" || act === "close"){ close(null); }
      if(act === "save"){ grow(); close({ action:"layout", layout: layout }); }
      if(act === "composite"){
        b.disabled = true;
        b.textContent = "合成しています…";
        grow();
        composite().then(function(blob){
          close({ action:"composite", layout: layout, blob: blob });
        }, function(){
          b.disabled = false;
          b.textContent = "⧉ 合成して1枚の画像にする";
        });
      }
    });

    document.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", place);
    place();
  }

  window.BoardEditor = { open: open };
})();
