// Image annotation editor: crop, text, line, arrow, rectangle, ellipse,
// freehand pen and click-by-click polyline, with colour / thickness / font-size
// choices and undo. Shift constrains rect/ellipse to squares/circles and
// lines to 45-degree steps.
//
// Annotations are kept as data, not burned into the original:
//   crop   { x, y, w, h }                  in original-image pixels
//   shapes [{ type, color, size, ... }]    in original-image pixels
//     text: fontSize (units of longest side/1000); older data has only size
//     poly: points [[x,y]...], closed
// so an edit can be reopened later on top of the untouched original.
//
// window.ImageEditor.open({ url, crop, shapes }) resolves with
//   null                                  when cancelled / nothing changed
//   { empty:true }                        when everything was cleared (back to the original)
//   { empty:false, crop, shapes, blob }   with the rendered PNG otherwise
(function(){
  "use strict";

  var COLORS = [
    { v:"#E53935", n:"赤" }, { v:"#FDD835", n:"黄" }, { v:"#1E88E5", n:"青" },
    { v:"#43A047", n:"緑" }, { v:"#FFFFFF", n:"白" }, { v:"#111111", n:"黒" }
  ];
  var TOOLS = [
    ["pen","✎","ペン"], ["poly","⋀","折れ線"], ["line","／","直線"], ["arrow","→","矢印"], ["rect","□","四角"],
    ["ellipse","○","丸"], ["text","A","文字"], ["crop","⌗","トリミング"]
  ];
  var SIZES = [["s","細"], ["m","中"], ["l","太"]];
  var LINE = { s:3, m:6, l:10 };
  var FONT = { s:28, m:44, l:64 };   // fallback for text saved before fontSize existed
  var FONT_SIZES = [[16,"極小"], [22,"小"], [28,"やや小"], [44,"中"], [56,"やや大"], [64,"大"], [88,"特大"], [120,"超特大"]];
  var FONT_FAMILY = '"BIZ UDPGothic","Yu Gothic UI","Yu Gothic","Meiryo",sans-serif';

  function esc(s){
    return String(s).replace(/[&<>"']/g, function(c){ return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]; });
  }
  function loadImage(url){
    return new Promise(function(resolve, reject){
      var im = new Image();
      im.onload = function(){ resolve(im); };
      im.onerror = function(){ reject(new Error("画像を読み込めませんでした")); };
      im.src = url;
    });
  }
  // Stroke widths and font sizes scale with the image so they look the same on any resolution.
  function unitFor(w, h){ return Math.max(w, h) / 1000; }
  function contrastFor(hex){
    var n = parseInt(hex.slice(1), 16);
    var lum = (0.299*((n>>16)&255) + 0.587*((n>>8)&255) + 0.114*(n&255)) / 255;
    return lum > 0.6 ? "rgba(0,0,0,0.85)" : "rgba(255,255,255,0.9)";
  }
  // Moves the end point of a drag shape to p. With Shift, rect/ellipse become
  // square/circle and line/arrow snap to 45-degree steps.
  function setEnd(s, p, shift){
    s.x2 = p.x; s.y2 = p.y;
    if(!shift) return;
    var dx = p.x - s.x1, dy = p.y - s.y1;
    if(s.type === "rect" || s.type === "ellipse"){
      var m = Math.max(Math.abs(dx), Math.abs(dy));
      s.x2 = s.x1 + (dx < 0 ? -m : m);
      s.y2 = s.y1 + (dy < 0 ? -m : m);
    } else {
      var q = snap45(s.x1, s.y1, p);
      s.x2 = q.x; s.y2 = q.y;
    }
  }
  function snap45(x0, y0, p){
    var dx = p.x - x0, dy = p.y - y0;
    var len = Math.sqrt(dx*dx + dy*dy);
    var a = Math.round(Math.atan2(dy, dx) / (Math.PI/4)) * (Math.PI/4);
    return { x: x0 + len * Math.cos(a), y: y0 + len * Math.sin(a) };
  }
  function norm(s){
    return { x:Math.min(s.x1, s.x2), y:Math.min(s.y1, s.y2), w:Math.abs(s.x2 - s.x1), h:Math.abs(s.y2 - s.y1) };
  }

  function drawShape(ctx, s, u){
    ctx.save();
    ctx.strokeStyle = ctx.fillStyle = s.color;
    ctx.lineWidth = LINE[s.size] * u;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    var r;
    switch(s.type){
      case "pen":
      case "poly":
        ctx.beginPath();
        ctx.moveTo(s.points[0][0], s.points[0][1]);
        if(s.points.length === 1){ ctx.lineTo(s.points[0][0] + 0.1, s.points[0][1]); }
        for(var i=1;i<s.points.length;i++){ ctx.lineTo(s.points[i][0], s.points[i][1]); }
        if(s.closed){ ctx.closePath(); }
        ctx.stroke();
        break;
      case "line":
      case "arrow":
        ctx.beginPath();
        ctx.moveTo(s.x1, s.y1);
        ctx.lineTo(s.x2, s.y2);
        ctx.stroke();
        if(s.type === "arrow"){
          var a = Math.atan2(s.y2 - s.y1, s.x2 - s.x1);
          var len = Math.max(ctx.lineWidth * 4, 14 * u);
          ctx.beginPath();
          ctx.moveTo(s.x2, s.y2);
          ctx.lineTo(s.x2 - len*Math.cos(a - 0.45), s.y2 - len*Math.sin(a - 0.45));
          ctx.lineTo(s.x2 - len*Math.cos(a + 0.45), s.y2 - len*Math.sin(a + 0.45));
          ctx.closePath();
          ctx.fill();
        }
        break;
      case "rect":
        r = norm(s);
        ctx.strokeRect(r.x, r.y, r.w, r.h);
        break;
      case "ellipse":
        r = norm(s);
        ctx.beginPath();
        ctx.ellipse(r.x + r.w/2, r.y + r.h/2, Math.max(r.w/2, 0.5), Math.max(r.h/2, 0.5), 0, 0, Math.PI*2);
        ctx.stroke();
        break;
      case "text":
        var fs = (s.fontSize || FONT[s.size]) * u;
        ctx.font = "bold " + fs + "px " + FONT_FAMILY;
        ctx.textBaseline = "top";
        ctx.lineWidth = Math.max(fs / 7, 1);
        ctx.strokeStyle = contrastFor(s.color);
        String(s.text).split("\n").forEach(function(line, idx){
          var y = s.y + idx * fs * 1.25;
          ctx.strokeText(line, s.x, y);
          ctx.fillText(line, s.x, y);
        });
        break;
    }
    ctx.restore();
  }

  // Draws the image with the crop applied (or the full image when crop is null) plus shapes.
  function paint(ctx, img, crop, shapes, extra){
    var u = unitFor(img.naturalWidth, img.naturalHeight);
    ctx.save();
    if(crop){ ctx.translate(-crop.x, -crop.y); }
    ctx.drawImage(img, 0, 0);
    shapes.forEach(function(s){ drawShape(ctx, s, u); });
    if(extra){ drawShape(ctx, extra, u); }
    ctx.restore();
  }

  function open(opts){
    return loadImage(opts.url).then(function(img){
      return new Promise(function(resolve){ runEditor(img, opts, resolve); });
    });
  }

  function runEditor(img, opts, resolve){
    var W = img.naturalWidth, H = img.naturalHeight;
    var full = { x:0, y:0, w:W, h:H };
    var state = {
      crop: opts.crop ? Object.assign({}, opts.crop) : Object.assign({}, full),
      shapes: (opts.shapes || []).map(function(s){ return JSON.parse(JSON.stringify(s)); })
    };
    var initial = JSON.stringify(state);
    var history = [];
    var tool = "pen", color = COLORS[0].v, size = "m", fontSize = 44;
    var current = null;      // shape being drawn
    var cropDraft = null;    // {x1,y1,x2,y2} while dragging in crop mode
    var textBox = null;
    var poly = null;         // polyline being built click by click
    var polyHover = null;    // where the next segment would go
    var lastClick = null;    // {t, x, y} in screen pixels, to detect a double-click
    var lastRaw = null;      // last pointer position, to re-apply Shift on key press

    var root = document.createElement("div");
    root.className = "imged";
    root.innerHTML =
      '<div class="imged-bar">' +
        '<div class="imged-group">' + TOOLS.map(function(t){
          return '<button type="button" class="imged-tool" data-tool="'+t[0]+'" title="'+t[2]+'"><span>'+esc(t[1])+'</span>'+t[2]+'</button>';
        }).join("") + '</div>' +
        '<div class="imged-group">' + COLORS.map(function(c){
          return '<button type="button" class="imged-color" data-color="'+c.v+'" title="'+c.n+'" style="background:'+c.v+'"></button>';
        }).join("") + '</div>' +
        '<div class="imged-group imged-sizes"><span class="imged-label">太さ</span>' + SIZES.map(function(s){
          return '<button type="button" class="imged-size" data-size="'+s[0]+'">'+s[1]+'</button>';
        }).join("") + '</div>' +
        '<div class="imged-group imged-fonts"><span class="imged-label">文字の大きさ</span>' +
          '<select class="imged-font">' + FONT_SIZES.map(function(f){
            return '<option value="'+f[0]+'"'+(f[0] === 44 ? ' selected' : '')+'>'+f[1]+'</option>';
          }).join("") + '</select>' +
        '</div>' +
        '<div class="imged-group">' +
          '<button type="button" class="imged-btn" data-act="undo" title="1つ戻す（Ctrl+Z）">↶ 1つ戻す</button>' +
          '<button type="button" class="imged-btn" data-act="clear">書き込みを全部消す</button>' +
          '<button type="button" class="imged-btn" data-act="uncrop">トリミング解除</button>' +
        '</div>' +
        // Its own way out at the top right, so the window's ✕ (which quits the app) is not the obvious one.
        '<button type="button" class="imged-close" data-act="close">✕ 閉じる</button>' +
      '</div>' +
      '<div class="imged-stage"><canvas></canvas></div>' +
      '<div class="imged-foot">' +
        '<span class="imged-hint"></span>' +
        '<button type="button" class="btn btn-ghost btn-small" data-act="reset">元の画像に戻す</button>' +
        '<button type="button" class="btn btn-ghost btn-small" data-act="cancel">キャンセル</button>' +
        '<button type="button" class="btn btn-primary btn-small" data-act="save">書き込みを反映</button>' +
      '</div>';
    document.body.appendChild(root);

    var stage = root.querySelector(".imged-stage");
    var canvas = root.querySelector("canvas");
    var ctx = canvas.getContext("2d");
    var hint = root.querySelector(".imged-hint");
    var fontSel = root.querySelector(".imged-font");

    function snapshot(){ history.push(JSON.stringify(state)); if(history.length > 100){ history.shift(); } }
    function restore(json){ var s = JSON.parse(json); state.crop = s.crop; state.shapes = s.shapes; }

    function fit(){
      var sw = stage.clientWidth - 24, sh = stage.clientHeight - 24;
      var scale = Math.min(sw / canvas.width, sh / canvas.height, 2);
      canvas.style.width = Math.max(1, Math.floor(canvas.width * scale)) + "px";
      canvas.style.height = Math.max(1, Math.floor(canvas.height * scale)) + "px";
    }

    function draw(){
      var cropMode = tool === "crop";
      var view = cropMode ? full : state.crop;
      if(canvas.width !== view.w || canvas.height !== view.h){
        canvas.width = view.w;
        canvas.height = view.h;
        fit();
      }
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      var extra = current;
      if(poly){
        extra = Object.assign({}, poly, { points: polyHover ? poly.points.concat([[polyHover.x, polyHover.y]]) : poly.points });
      }
      paint(ctx, img, cropMode ? null : state.crop, state.shapes, extra);
      if(cropMode){
        var r = cropDraft ? norm(cropDraft) : state.crop;
        ctx.save();
        ctx.fillStyle = "rgba(0,0,0,0.55)";
        ctx.beginPath();
        ctx.rect(0, 0, W, H);
        ctx.rect(r.x, r.y, r.w, r.h);
        ctx.fill("evenodd");
        ctx.strokeStyle = "#FFFFFF";
        ctx.lineWidth = Math.max(2, 2 * unitFor(W, H));
        ctx.setLineDash([10 * unitFor(W, H), 6 * unitFor(W, H)]);
        ctx.strokeRect(r.x, r.y, r.w, r.h);
        ctx.restore();
      }
    }

    function syncBar(){
      Array.prototype.forEach.call(root.querySelectorAll(".imged-tool"), function(b){ b.classList.toggle("on", b.getAttribute("data-tool") === tool); });
      Array.prototype.forEach.call(root.querySelectorAll(".imged-color"), function(b){ b.classList.toggle("on", b.getAttribute("data-color") === color); });
      Array.prototype.forEach.call(root.querySelectorAll(".imged-size"), function(b){ b.classList.toggle("on", b.getAttribute("data-size") === size); });
      root.querySelector('[data-act="undo"]').disabled = !history.length;
      root.querySelector(".imged-sizes").hidden = tool === "text" || tool === "crop";
      root.querySelector(".imged-fonts").hidden = tool !== "text";
      fontSel.value = String(fontSize);
      hint.textContent = {
        pen:"ドラッグして自由に描きます",
        poly: poly
          ? "クリックで点を追加します。ダブルクリックかEnterで終了、始点をクリックすると閉じた図形になります（Ctrl+Zで1点戻す、Escで取り消し）"
          : "クリックするたびに点を打ち、線をつないでいきます（Shiftを押しながらだと水平・垂直・45°）",
        line:"始点から終点までドラッグします（Shiftを押しながらだと水平・垂直・45°）",
        arrow:"矢印の根元から先端までドラッグします（Shiftを押しながらだと水平・垂直・45°）",
        rect:"対角線の方向にドラッグします（Shiftを押しながらだと正方形）",
        ellipse:"囲みたい範囲をドラッグします（Shiftを押しながらだと真円）",
        text:"文字を置きたい場所をクリックして入力し、Enterで確定します（改行はShift+Enter）。大きさは上の欄で選びます",
        crop:"残したい範囲をドラッグで囲みます。ほかの道具に切り替えるとトリミング後の表示に戻ります"
      }[tool];
    }

    function toImage(e){
      var rect = canvas.getBoundingClientRect();
      var view = tool === "crop" ? full : state.crop;
      var x = (e.clientX - rect.left) * canvas.width / rect.width + view.x;
      var y = (e.clientY - rect.top) * canvas.height / rect.height + view.y;
      return { x: Math.min(Math.max(x, 0), W), y: Math.min(Math.max(y, 0), H) };
    }

    function commitText(){
      if(!textBox) return;
      var box = textBox;
      textBox = null;
      var text = box.el.value.replace(/\s+$/, "");
      box.el.remove();
      if(text){
        snapshot();
        state.shapes.push({ type:"text", x:box.x, y:box.y, text:text, color:color, size:size, fontSize:fontSize });
        draw();
        syncBar();
      }
    }
    function openTextBox(e, p){
      commitText();
      var el = document.createElement("textarea");
      el.className = "imged-text";
      var rect = canvas.getBoundingClientRect();
      var srect = stage.getBoundingClientRect();
      var scale = rect.width / canvas.width;
      var fs = fontSize * unitFor(W, H) * scale;
      el.style.left = (e.clientX - srect.left) + "px";
      el.style.top = (e.clientY - srect.top) + "px";
      el.style.fontSize = Math.max(fs, 12) + "px";
      el.style.color = color;
      el.rows = 1;
      stage.appendChild(el);
      textBox = { el:el, x:p.x, y:p.y };
      el.addEventListener("keydown", function(ev){
        ev.stopPropagation();
        if(ev.key === "Enter" && !ev.shiftKey && !ev.isComposing){ ev.preventDefault(); commitText(); }
        if(ev.key === "Escape"){ ev.preventDefault(); textBox = null; el.remove(); }
      });
      el.addEventListener("input", function(){ el.rows = Math.max(1, el.value.split("\n").length); });
      el.addEventListener("blur", function(ev){
        // Choosing a font size while typing keeps the box open and resizes it.
        if(ev.relatedTarget === fontSel) return;
        setTimeout(commitText, 0);
      });
      setTimeout(function(){ el.focus(); }, 0);
    }

    function finishPoly(closed){
      if(!poly) return;
      var s = poly;
      poly = null; polyHover = null; lastClick = null;
      if(s.points.length >= 2){
        if(closed){ s.closed = true; }
        snapshot();
        state.shapes.push(s);
      }
      draw();
      syncBar();
    }
    // Anything that leaves the current tool finishes what is in progress.
    function commitPending(){ commitText(); finishPoly(false); }

    function polyPoint(e){
      var p = toImage(e);
      if(e.shiftKey && poly && poly.points.length){
        var last = poly.points[poly.points.length - 1];
        p = snap45(last[0], last[1], p);
      }
      return p;
    }
    function onPolyDown(e){
      e.preventDefault();
      var now = Date.now();
      if(!poly){
        commitText();
        var p0 = toImage(e);
        poly = { type:"poly", color:color, size:size, points:[[p0.x, p0.y]] };
        lastClick = { t:now, x:e.clientX, y:e.clientY };
        draw(); syncBar();
        return;
      }
      if(lastClick && now - lastClick.t < 400 && Math.abs(e.clientX - lastClick.x) < 6 && Math.abs(e.clientY - lastClick.y) < 6){
        finishPoly(false);
        return;
      }
      var p = polyPoint(e);
      var first = poly.points[0];
      var tol = 12 * canvas.width / canvas.getBoundingClientRect().width;
      if(poly.points.length >= 3 && Math.abs(p.x - first[0]) < tol && Math.abs(p.y - first[1]) < tol){
        finishPoly(true);
        return;
      }
      poly.points.push([p.x, p.y]);
      lastClick = { t:now, x:e.clientX, y:e.clientY };
      draw();
    }

    canvas.addEventListener("pointerdown", function(e){
      if(e.button !== 0) return;
      var p = toImage(e);
      if(tool === "text"){ e.preventDefault(); openTextBox(e, p); return; }
      if(tool === "poly"){ onPolyDown(e); return; }
      commitText();
      canvas.setPointerCapture(e.pointerId);
      if(tool === "crop"){ cropDraft = { x1:p.x, y1:p.y, x2:p.x, y2:p.y }; return; }
      current = tool === "pen"
        ? { type:"pen", color:color, size:size, points:[[p.x, p.y]] }
        : { type:tool, color:color, size:size, x1:p.x, y1:p.y, x2:p.x, y2:p.y };
      draw();
    });
    canvas.addEventListener("pointermove", function(e){
      if(poly){ polyHover = polyPoint(e); lastRaw = { e:{ clientX:e.clientX, clientY:e.clientY } }; draw(); return; }
      if(!current && !cropDraft) return;
      var p = toImage(e);
      lastRaw = { p:p };
      if(cropDraft){ cropDraft.x2 = p.x; cropDraft.y2 = p.y; }
      else if(current.type === "pen"){ current.points.push([p.x, p.y]); }
      else { setEnd(current, p, e.shiftKey); }
      draw();
    });
    canvas.addEventListener("pointerleave", function(){
      if(poly && polyHover){ polyHover = null; draw(); }
    });
    // Pressing or releasing Shift mid-drag updates the shape without moving the mouse.
    function onShift(e){
      if(e.key !== "Shift" || !lastRaw) return;
      if(current && lastRaw.p && current.type !== "pen"){ setEnd(current, lastRaw.p, e.shiftKey); draw(); }
      else if(poly && lastRaw.e){ polyHover = polyPoint({ clientX:lastRaw.e.clientX, clientY:lastRaw.e.clientY, shiftKey:e.shiftKey }); draw(); }
    }
    document.addEventListener("keydown", onShift);
    document.addEventListener("keyup", onShift);
    function endStroke(){
      var minSize = 4 * unitFor(W, H);
      if(cropDraft){
        var r = norm(cropDraft);
        cropDraft = null;
        if(r.w > minSize * 4 && r.h > minSize * 4){
          snapshot();
          state.crop = { x:Math.round(r.x), y:Math.round(r.y), w:Math.round(r.w), h:Math.round(r.h) };
        }
      } else if(current){
        var s = current;
        current = null;
        var big = s.type === "pen" || Math.abs(s.x2 - s.x1) > minSize || Math.abs(s.y2 - s.y1) > minSize;
        if(big){ snapshot(); state.shapes.push(s); }
      }
      draw();
      syncBar();
    }
    canvas.addEventListener("pointerup", endStroke);
    canvas.addEventListener("pointercancel", endStroke);

    root.querySelector(".imged-bar").addEventListener("click", function(e){
      var b = e.target.closest("button");
      if(!b) return;
      // Colour and thickness apply to a polyline in progress instead of ending it.
      if(poly && (b.hasAttribute("data-color") || b.hasAttribute("data-size"))){
        if(b.hasAttribute("data-color")){ color = poly.color = b.getAttribute("data-color"); }
        if(b.hasAttribute("data-size")){ size = poly.size = b.getAttribute("data-size"); }
        draw(); syncBar();
        return;
      }
      commitPending();
      if(b.hasAttribute("data-tool")){ tool = b.getAttribute("data-tool"); draw(); }
      if(b.hasAttribute("data-color")){ color = b.getAttribute("data-color"); }
      if(b.hasAttribute("data-size")){ size = b.getAttribute("data-size"); }
      var act = b.getAttribute("data-act");
      if(act === "undo" && history.length){ restore(history.pop()); draw(); }
      if(act === "clear" && state.shapes.length){ snapshot(); state.shapes = []; draw(); }
      if(act === "uncrop"){ snapshot(); state.crop = Object.assign({}, full); draw(); }
      syncBar();
    });

    fontSel.addEventListener("change", function(){
      fontSize = Number(fontSel.value);
      if(textBox){
        var scale = canvas.getBoundingClientRect().width / canvas.width;
        textBox.el.style.fontSize = Math.max(fontSize * unitFor(W, H) * scale, 12) + "px";
        textBox.el.focus();
      }
    });

    function close(result){
      window.removeEventListener("resize", fit);
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("keydown", onShift);
      document.removeEventListener("keyup", onShift);
      root.remove();
      resolve(result);
    }
    // ✕ 閉じる: the same as キャンセル, after asking if something was drawn.
    root.querySelector(".imged-close").addEventListener("click", function(){
      commitPending();
      if(JSON.stringify(state) !== initial && !window.confirm("書き込みを反映せずに閉じますか？")) return;
      close(null);
    });
    function isEmpty(){
      return !state.shapes.length && state.crop.x === 0 && state.crop.y === 0 && state.crop.w === W && state.crop.h === H;
    }
    root.querySelector(".imged-foot").addEventListener("click", function(e){
      var b = e.target.closest("button");
      if(!b) return;
      var act = b.getAttribute("data-act");
      if(act === "cancel"){ close(null); return; }
      if(act === "reset"){ commitPending(); snapshot(); state.shapes = []; state.crop = Object.assign({}, full); draw(); syncBar(); return; }
      if(act === "save"){
        commitPending();
        if(JSON.stringify(state) === initial){ close(null); return; }
        if(isEmpty()){ close({ empty:true }); return; }
        var out = document.createElement("canvas");
        out.width = state.crop.w;
        out.height = state.crop.h;
        paint(out.getContext("2d"), img, state.crop, state.shapes, null);
        out.toBlob(function(blob){
          close({ empty:false, crop:state.crop, shapes:state.shapes, blob:blob });
        }, "image/png");
      }
    });

    function onKey(e){
      if(textBox) return;
      if(poly){
        if(e.key === "Enter"){ e.preventDefault(); finishPoly(false); return; }
        if(e.key === "Escape"){ e.preventDefault(); poly = null; polyHover = null; lastClick = null; draw(); syncBar(); return; }
        if(((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") || e.key === "Backspace"){
          e.preventDefault();
          poly.points.pop();
          lastClick = null;
          if(!poly.points.length){ poly = null; polyHover = null; }
          draw(); syncBar();
          return;
        }
      }
      if((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z"){
        e.preventDefault();
        if(history.length){ restore(history.pop()); draw(); syncBar(); }
      } else if(e.key === "Escape"){
        e.preventDefault();
        close(null);
      }
    }
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", fit);

    syncBar();
    draw();
    fit();
  }

  window.ImageEditor = { open: open };
})();
