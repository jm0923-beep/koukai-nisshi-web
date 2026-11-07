// The body editor: the text is written straight into a page that looks like
// the finished record, and placed images are shown as they will appear.
// It still reads and writes the same plain body text as before
// (paragraph lines, "# 見出し", "- 箇条書き", **太字**, <u>下線</u> (v1.0.110), text size and colour as
// <span style="color:#E53935; font-size:14pt">…</span> (v1.0.49), and image lines such as
// "[画像1 小 左回り込み]"), so older records open unchanged and the viewer,
// print and export code keep working on that text.
//
//   var ed = RichEditor.create(element, {
//     body, escapeHtml, inlineMd,
//     markers: { isLine(line), parse(line) → [{ref,size,align}], text(ref,size,align) },
//     hasRef(ref), imageUrl(ref) → Promise<url|null>, onChange(), onHistory()
//   });
//   ed.getBody(), ed.insertImage(ref), ed.removeRef(ref), ed.refs(), ed.refreshImages()
//   ed.insertVideo({id,start})   (v1.0.171, with opts.video: a YouTube video on a line of its own)
//   ed.undo(), ed.redo(), ed.canUndo(), ed.canRedo()   (v1.0.78; onHistory() tells when these change)
//   ed.forEachPiece(fn(i, n)), ed.pieceCount()   (v1.0.179: Ctrl + drag chooses several pieces of text;
//     opts.onFormatKey("b"|"u") gets Ctrl+B / Ctrl+U while there are several, opts.keepMulti is a selector
//     of the format tools whose presses keep them)
(function(){
  "use strict";

  var SIZES = ["小", "中", "大"];
  // The size an image or video gets when it is first put in the text (v1.0.181; 中 before).
  // A marker without a size still reads as 中, so older records look the same.
  var NEW_SIZE = "小";
  var ALIGNS = ["左寄せ", "中央", "右寄せ", "右回り込み", "左回り込み"];
  // What the buttons say (the owner's wording): where the text goes. The saved words stay the same.
  var ALIGN_LABEL = { "左回り込み": "右文章", "右回り込み": "左文章" };
  var ALIGN_TITLE = {
    "左回り込み": "画像を左に置き、あとの文章を右側に流します（点線の枠が画像の横に入る範囲）",
    "右回り込み": "画像を右に置き、あとの文章を左側に流します（点線の枠が画像の横に入る範囲）"
  };
  var SIZE_CLASS = { "大":"l", "中":"m", "小":"s" };
  var ALIGN_CLASS = { "左寄せ":"al-l", "右寄せ":"al-r", "左回り込み":"float fl-l", "右回り込み":"float fl-r" };
  var DRAG_ROW = "application/x-nisshi-row";
  var DRAG_REF = "application/x-nisshi-ref";

  function create(root, opts){
    var M = opts.markers;
    // opts.paper (v1.0.90): the editor is the body of an A4 sheet (app.js renderEditor) and takes the
    // printed look (class "body" under .paper, PRINT_CSS) instead of the screen-sized 「読みやすく」 one.
    if(opts.paper){ root.classList.add("rich-editor", "body", "on-paper"); }
    else { root.classList.add("rich-editor", "view-body"); }
    root.setAttribute("contenteditable", "true");
    root.setAttribute("spellcheck", "false");
    try{ document.execCommand("defaultParagraphSeparator", false, "p"); } catch(e){}

    var lastRange = null;      // where the caret was when the editor last had it
    var selected = null;       // the image row chosen for the toolbar
    var dragRow = null;
    var dragFig = null;        // the image grabbed in dragRow (v1.0.184); none when a video or the row's gap was grabbed
    var toolbar = null;

    /* ---------- image rows ---------- */
    function itemsOf(row){
      return Array.prototype.map.call(row.querySelectorAll("figure[data-ref]"), function(f){
        return { ref: Number(f.getAttribute("data-ref")), size: f.getAttribute("data-size") || "中", align: f.getAttribute("data-align") || "" };
      });
    }
    // The same classes the viewer and print use, so the editor shows the real result.
    function buildRow(items){
      var align = (items.filter(function(it){ return it.align; })[0] || {}).align || "";
      var cls = ALIGN_CLASS[align] || "";
      var floating = /float/.test(cls);
      var row = document.createElement("div");
      row.className = "inline-row ed-row" + (items.length > 1 ? " multi" : "") + (cls ? " " + cls : "") +
                      (floating ? " sz-" + (SIZE_CLASS[items[0].size] || "m") : "");
      row.setAttribute("contenteditable", "false");
      row.setAttribute("draggable", "true");
      items.forEach(function(it){
        var fig = document.createElement("figure");
        fig.className = "inline-fig" + (floating ? "" : " sz-" + (SIZE_CLASS[it.size] || "m"));
        fig.setAttribute("data-ref", String(it.ref));
        fig.setAttribute("data-size", it.size || "中");
        fig.setAttribute("data-align", it.align === "中央" ? "" : (it.align || ""));
        // Each image drags on its own (v1.0.184), so one of several side by side can be moved or swapped.
        fig.setAttribute("draggable", "true");
        var img = document.createElement("img");
        img.alt = "画像" + it.ref;
        img.draggable = false;
        fig.appendChild(img);
        row.appendChild(fig);
        loadImage(fig);
      });
      return row;
    }
    // A blank (白紙, v1.0.133) keeps its own width whatever its size, as in the viewer (app.js paperPct).
    function paperWidth(fig){
      var pct = opts.paperPct ? opts.paperPct(Number(fig.getAttribute("data-ref"))) : 0;
      var row = fig.parentNode;
      if(row && row.classList.contains("float")){
        if(row.querySelector("figure[data-ref]") !== fig) return;
        row.style.width = pct ? pct + "%" : "";
        row.classList.toggle("paper", !!pct);
        if(pct){ row.style.setProperty("--paper-rest", opts.paperRest(pct) + "%"); } else { row.style.removeProperty("--paper-rest"); }
      } else {
        fig.style.flex = pct ? "0 1 " + pct + "%" : "";
        fig.style.width = pct ? pct + "%" : "";
      }
    }
    function loadImage(fig){
      paperWidth(fig);
      var img = fig.querySelector("img"), ref = Number(fig.getAttribute("data-ref"));
      // Its room is kept from the start (v1.0.176): the stored width and height give the box its shape before the
      // picture is decrypted and drawn. Without them a row was one line high until then and grew as each image came,
      // so in a long record the line under an image moved down just as it was clicked and the image took the click.
      var size = opts.imageSize ? opts.imageSize(ref) : null;
      function noRoom(){ img.removeAttribute("width"); img.removeAttribute("height"); }
      if(size && size.width > 0 && size.height > 0){ img.width = size.width; img.height = size.height; } else { noRoom(); }
      opts.imageUrl(ref).then(function(url){
        if(url){ img.src = url; fig.classList.remove("missing"); } else { noRoom(); fig.classList.add("missing"); }
      }, function(){ noRoom(); fig.classList.add("missing"); });
    }
    function rowText(row){
      if(isVideo(row)){ return V.text(videoOf(row)); }
      return itemsOf(row).map(function(it){ return M.text(it.ref, it.size, it.align); }).join("");
    }
    function isRow(node){ return node && node.nodeType === 1 && node.classList.contains("ed-row"); }

    /* ---------- YouTube の動画 (v1.0.171) ---------- */
    // opts.video: { parse(line) → {id,start,size,align}|null, text(v) → line, inner(v) → the picture's HTML,
    // fromUrl(address) → {id,start}|null, open(v), load(figure) (fills in a saved picture), onInsert(v) }. A video row is an image row without figure[data-ref]:
    // it moves, is chosen and is deleted like one, and is written back as its own line ("[動画 中 https://…]").
    var V = opts.video || null;
    // Since v1.0.173 a video takes every position an image does, 右文章・左文章 included (text beside it).
    var VIDEO_ALIGN_TITLE = {
      "左回り込み": "動画を左に置き、あとの文章を右側に流します（点線の枠が動画の横に入る範囲）",
      "右回り込み": "動画を右に置き、あとの文章を左側に流します（点線の枠が動画の横に入る範囲）"
    };
    function isVideo(node){ return !!V && isRow(node) && node.classList.contains("video-row"); }
    function videoOf(row){
      var f = row.querySelector("figure.video-fig");
      return { id: f.getAttribute("data-yt"), start: Number(f.getAttribute("data-start")) || 0,
               size: f.getAttribute("data-size") || "中", align: f.getAttribute("data-align") || "" };
    }
    function buildVideoRow(v){
      var cls = ALIGN_CLASS[v.align] || "";
      var sz = " sz-" + (SIZE_CLASS[v.size] || "m");
      var floating = /float/.test(cls);
      var row = document.createElement("div");
      // A wrapped one is sized on its row, as a wrapped image (buildRow) and the viewer (app.js videoRowHtml).
      row.className = "inline-row ed-row video-row" + (cls ? " " + cls : "") + (floating ? sz : "");
      row.setAttribute("contenteditable", "false");
      row.setAttribute("draggable", "true");
      var fig = document.createElement("figure");
      fig.className = "inline-fig video-fig" + (floating ? "" : sz);
      fig.setAttribute("data-yt", v.id);
      fig.setAttribute("data-start", String(v.start || 0));
      fig.setAttribute("data-size", v.size || "中");
      fig.setAttribute("data-align", v.align === "中央" ? "" : (v.align || ""));
      fig.innerHTML = V.inner(v);
      var box = fig.querySelector(".yt-box");
      if(box){ box.title = "動画は、記録の画面で押すと再生できます"; }
      row.appendChild(fig);
      if(V.load){ V.load(fig); }   // the picture saved with the record (v1.0.172)
      return row;
    }
    // At range (or where the caret last was), as 「本文へ」 puts an image.
    function insertVideo(v, range){
      deselect();
      insertRowAt(range || lastRange, buildVideoRow({ id: v.id, start: v.start || 0, size: NEW_SIZE, align: "" }));
      changed();
      if(V.onInsert){ V.onInsert(v); }   // fetches its picture to save (v1.0.172)
    }

    /* ---------- body text → page ---------- */
    function para(html){
      var p = document.createElement("p");
      p.innerHTML = html || "<br>";
      return p;
    }
    function setBody(text){
      root.innerHTML = "";
      var list = null;
      // Empty lines at the very start or end are dropped, as getBody and the viewer do (v1.0.61).
      var lines = String(text || "").split("\n");
      while(lines.length && !lines[0].trim()){ lines.shift(); }
      while(lines.length && !lines[lines.length - 1].trim()){ lines.pop(); }
      lines.forEach(function(line){
        var vid = V && V.parse(line);
        if(vid){ list = null; root.appendChild(buildVideoRow(vid)); return; }
        if(M.isLine(line)){
          var items = M.parse(line).filter(function(it){ return opts.hasRef(it.ref); });
          if(items.length){ list = null; root.appendChild(buildRow(items)); return; }
        }
        var li = line.match(/^\s*-\s+(.*)$/);
        if(li){
          if(!list){ list = document.createElement("ul"); root.appendChild(list); }
          var item = document.createElement("li");
          item.innerHTML = opts.inlineMd(opts.escapeHtml(li[1])) || "<br>";
          list.appendChild(item);
          return;
        }
        list = null;
        var h = line.match(/^(#{1,3})\s+(.*)$/);
        if(h){
          var head = document.createElement("h" + (h[1].length + 1));
          head.innerHTML = opts.inlineMd(opts.escapeHtml(h[2])) || "<br>";
          root.appendChild(head);
          return;
        }
        // Half-width spaces at the start of a line are kept as no-break spaces (v1.0.94), or the
        // browser drops them; getBody saves them as plain spaces again.
        var lead = line.replace(/^ +/, function(m){ return new Array(m.length + 1).join(" "); });
        root.appendChild(para(line.trim() ? opts.inlineMd(opts.escapeHtml(lead)) : ""));
      });
      ensureEnds();
      updateEmpty();
      markWraps();
    }
    // Keeps an editable line after the last image, so the caret can go there.
    function ensureEnds(){
      if(!root.firstChild){ root.appendChild(para()); }
      // Nor below an image at the very end (v1.0.185): it showed as one more line after the last image and
      // came back each time it was taken away. A click below the image opens one there (padTo), as does
      // ＋下に行 / Enter / ↓ on the chosen image (openLine).
      // No empty line is added above an image at the very top any more (v1.0.181): it showed as a blank
      // line above every image put at the first line. ＋上に行 / Shift+Enter / ↑ open one there (openLine).
      ensureWrapLines(true);
    }

    /* ---------- 右文章・左文章 (v1.0.59) ---------- */
    // The viewer puts a wrapped image and the text after it, up to the next image line or heading,
    // in one block (div.wrap-group in app.js), and what follows starts below both. The editor keeps
    // its lines flat, so it marks the last line of each such group (data-group-end, see style.css)
    // to end it in the same place. A wrapped image followed straight by another image line or a
    // heading gets an empty line beside it (data-auto) so the group has a line to end on and there
    // is a place to write beside it. That line is not saved while it stays empty (getBody), and
    // moving an image steps over it.
    function isHeading(n){ return !!n && n.nodeType === 1 && /^H[1-6]$/.test(n.tagName); }
    function isFloat(n){ return isRow(n) && n.classList.contains("float"); }
    function isAuto(n){
      return !!n && n.nodeType === 1 && n.tagName === "P" && n.hasAttribute("data-auto") &&
             !n.textContent.trim() && !n.querySelector("img");
    }
    function isGap(n){
      return !!n && n.nodeType === 1 && n.tagName === "P" && n.hasAttribute("data-gap") &&
             !n.textContent.trim() && !n.querySelector("img");
    }
    // Lines opened by a click below the text (padTo, v1.0.178): not saved until something is written.
    function isPad(n){
      return !!n && n.nodeType === 1 && n.tagName === "P" && n.hasAttribute("data-pad") &&
             !n.textContent.trim() && !n.querySelector("img");
    }
    function autoNeeded(p){
      var next = p.nextSibling;
      return isFloat(p.previousSibling) && (!next || isRow(next) || isHeading(next));
    }
    // tidy: after an image was placed, moved or changed, an empty line no longer needed is removed.
    // While typing it stays and becomes a line of its own (Enter on it adds a blank line).
    function ensureWrapLines(tidy){
      var sel = window.getSelection();
      var caret = sel && sel.rangeCount ? sel.getRangeAt(0).startContainer : null;
      // A line opened between images (openLine) is not saved while it stays empty and alone there; left
      // empty, it goes when the images are tidied. Written in, or with a line beside it (Enter in it),
      // it is a line of its own.
      function textLine(n){ return !!n && n.nodeType === 1 && !isRow(n); }
      Array.prototype.forEach.call(root.querySelectorAll("p[data-gap]"), function(p){
        if(!isGap(p)){ p.removeAttribute("data-gap"); return; }
        if(caret && p.contains(caret)) return;
        if(textLine(p.previousSibling) || textLine(p.nextSibling)){ p.removeAttribute("data-gap"); }
        else if(tidy){ p.remove(); }
      });
      Array.prototype.forEach.call(root.querySelectorAll("p[data-auto]"), function(p){
        if(!isAuto(p)){ p.removeAttribute("data-auto"); return; }        // written in: a line of its own
        if(autoNeeded(p)) return;
        if(tidy && !(caret && p.contains(caret))){ p.remove(); } else { p.removeAttribute("data-auto"); }
      });
      Array.prototype.forEach.call(root.querySelectorAll(".ed-row.float"), function(row){
        var next = row.nextSibling;
        if(!next || isRow(next) || isHeading(next)){
          var p = para();
          p.setAttribute("data-auto", "");
          root.insertBefore(p, next);
        }
      });
    }

    /* ---------- page → body text ---------- */
    // Marks each line of inner that has text (a mark never runs across a line break).
    function wrapLines(inner, open, close){
      return inner.split("\n").map(function(l){ return l.trim() ? open + l + close : l; }).join("\n");
    }
    function hexColor(css){
      var m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(css || "");
      if(!m) return null;
      return "#" + [m[1], m[2], m[3]].map(function(n){ return ("0" + Number(n).toString(16)).slice(-2); }).join("").toUpperCase();
    }
    // The size and colour a span or font element sets, as the body text's span style
    // ("color:#E53935; font-size:14pt", see textStyleCss in app.js), or "" when it changes nothing
    // from the text around it (or only sets the standard colour).
    function textStyle(el){
      var parts = [], parent = el.parentNode;
      if(!root.isConnected){
        // Off the page nothing is computed: keep what the element itself says.
        var c = hexColor(el.style.color) || (/^#[0-9a-f]{6}$/i.test(el.getAttribute("color") || "") ? el.getAttribute("color").toUpperCase() : null);
        var o = /\*\s*(\d+(?:\.\d+)?)\s*\)\s*$/.exec(el.style.fontSize);
        if(c){ parts.push("color:" + c); }
        if(o && Number(o[1]) !== 10.5){ parts.push("font-size:" + Number(o[1]) + "pt"); }
        return parts.join("; ");
      }
      var cs = window.getComputedStyle(el), ps = parent && parent.nodeType === 1 ? window.getComputedStyle(parent) : null;
      if(el.style.color || el.getAttribute("color")){
        var hex = hexColor(cs.color);
        var same = ps && hexColor(ps.color) === hex;
        if(hex && !same && hex !== hexColor(window.getComputedStyle(root).color)){ parts.push("color:" + hex); }
      }
      if(el.style.fontSize || el.getAttribute("size")){
        var own = /\*\s*(\d+(?:\.\d+)?)\s*\)\s*$/.exec(el.style.fontSize);   // calc(var(--body-pt) * 14)
        var px = parseFloat(cs.fontSize), ppx = ps ? parseFloat(ps.fontSize) : NaN;
        var pt = own ? Number(own[1]) : Math.round(px / parseFloat(window.getComputedStyle(root).fontSize) * 10.5 * 2) / 2;
        // Kept inside what the reader accepts (4–200, textStyleCss in app.js): outside it the whole
        // span would show as plain "<span style=…>" text.
        if(isFinite(pt)){ pt = Math.min(Math.max(pt, 4), 200); }
        if(isFinite(pt) && !(Math.abs(px - ppx) < 0.1)){ parts.push("font-size:" + pt + "pt"); }
      }
      return parts.join("; ");
    }
    function inlineText(node){
      if(node.nodeType === 3){ return node.nodeValue.replace(/ /g, " ").replace(/\n/g, " "); }
      if(node.nodeType !== 1){ return ""; }
      if(isRow(node)){ return "\n" + rowText(node) + "\n"; }
      var tag = node.tagName;
      if(tag === "BR"){ return "\n"; }
      var inner = Array.prototype.map.call(node.childNodes, inlineText).join("");
      if(tag === "DIV" || tag === "P" || tag === "LI" || /^H[1-6]$/.test(tag)){ return "\n" + styled(node, inner) + "\n"; }
      if(tag === "STRONG" || tag === "B" || /^(bold|bolder|[6-9]00)$/.test(node.style.fontWeight)){ inner = wrapLines(inner, "**", "**"); }
      if((tag === "EM" || tag === "I") && inner.trim()){ inner = "*" + inner + "*"; }
      // 下線 (v1.0.110): <u>…</u> in the body text, which Markdown readers show too
      if(tag === "U" || /underline/.test(node.style.textDecorationLine || node.style.textDecoration || "")){ inner = wrapLines(inner, "<u>", "</u>"); }
      // 取り消し線: <s>…</s>（削除の意味）
      if(tag === "S" || tag === "STRIKE" || tag === "DEL" || /line-through/.test(node.style.textDecorationLine || node.style.textDecoration || "")){ inner = wrapLines(inner, "<s>", "</s>"); }
      return styled(node, inner);
    }
    // text with the size and colour that element sets, if any. Not only spans: when the chosen
    // text is exactly a bold word (or a whole paragraph), Chrome puts the colour or size on that
    // element itself (<b style="color: …">), and before v1.0.52 it was lost on saving.
    function styled(el, text){
      var st = textStyle(el);
      return st ? wrapLines(text, '<span style="' + st + '">', "</span>") : text;
    }
    // A block's own lines ("<p>a<br>b</p>" is two lines; the <br> that browsers keep
    // at the end of a block does not add one).
    function linesOf(node){
      var s = Array.prototype.map.call(node.childNodes, inlineText).join("");
      s = s.replace(/\n$/, "");
      return s.split("\n");
    }
    function getBody(){
      var out = [];
      Array.prototype.forEach.call(root.childNodes, function(node){
        if(node.nodeType === 3){ if(node.nodeValue.trim()){ out.push(node.nodeValue.replace(/ /g, " ")); } return; }
        if(node.nodeType !== 1){ return; }
        if(isRow(node)){ out.push(rowText(node)); return; }
        if(isAuto(node) || isGap(node) || isPad(node)){ return; }   // empty lines the editor added (ensureWrapLines, openLine, padTo)
        var tag = node.tagName;
        if(tag === "UL" || tag === "OL"){
          Array.prototype.forEach.call(node.children, function(li){
            out.push("- " + styled(li, linesOf(li).join(" ").trim()));
          });
          return;
        }
        var h = /^H([2-4])$/.exec(tag);
        if(h){ out.push(new Array(Number(h[1])).join("#") + " " + styled(node, linesOf(node).join(" ").trim())); return; }
        if(/^H[15-6]$/.test(tag)){ out.push("# " + styled(node, linesOf(node).join(" ").trim())); return; }
        if(tag === "BR"){ out.push(""); return; }
        linesOf(node).forEach(function(l){ out.push(styled(node, l)); });
      });
      while(out.length && !out[0].trim()){ out.shift(); }
      while(out.length && !out[out.length - 1].trim()){ out.pop(); }
      return out.join("\n");
    }

    function refs(){
      return Array.prototype.map.call(root.querySelectorAll("figure[data-ref]"), function(f){ return Number(f.getAttribute("data-ref")); });
    }
    // While a Japanese word is being converted (IME), the lines are left alone; they are marked
    // again once it is confirmed (compositionend).
    var composing = false;
    root.addEventListener("compositionstart", function(){ composing = true; hideEnds(); });
    root.addEventListener("compositionend", function(){ composing = false; changed(true); });
    // typing: from typing (a run of keys within a second is one step to undo); otherwise (images, Delete
    // of a line, a drop…) each change is a step of its own.
    function changed(typing){
      if(!composing){
        ensureWrapLines(false);
        markWraps();
        record(typing === true);
      }
      if(multi.length){ showMulti(); }
      updateEmpty();
      if(opts.onChange){ opts.onChange(); }
    }

    /* ---------- 戻す・やり直す (v1.0.78) ---------- */
    // The body text (getBody) before each change is kept, so 戻す can go back step by step through typing,
    // placing, moving and removing images, even after a layout went wrong. Up to 200 steps, while the editor is open.
    var undoStack = [], redoStack = [], lastBody = null, lastTyped = 0, wasTyping = false;
    function record(typing){
      if(batching) return;   // forEachPiece records once at the end
      var b = getBody();
      if(lastBody === null){ lastBody = b; return; }   // before the editor has finished starting
      if(b === lastBody) return;
      var now = Date.now();
      // A run of typing is one step; anything else, or typing after a pause or after something else, starts a new one.
      if(!(typing && wasTyping && now - lastTyped < 1000)){
        undoStack.push(lastBody);
        if(undoStack.length > 200){ undoStack.shift(); }
      }
      wasTyping = typing;
      lastTyped = now;
      lastBody = b;
      redoStack = [];
      if(opts.onHistory){ opts.onHistory(); }
    }
    function restoreBody(b){
      deselect();
      clearMulti();
      setBody(b);
      lastBody = getBody();
      wasTyping = false;
      // The caret goes to the end, so typing can go on.
      var last = root.lastChild;
      while(last && isRow(last)){ last = last.previousSibling; }
      if(last){ root.focus(); placeCaret(last, true); }
      if(opts.onChange){ opts.onChange(); }
      if(opts.onHistory){ opts.onHistory(); }
    }
    function undo(){
      if(!undoStack.length) return;
      redoStack.push(getBody());
      restoreBody(undoStack.pop());
    }
    function redo(){
      if(!redoStack.length) return;
      undoStack.push(getBody());
      restoreBody(redoStack.pop());
    }
    // Ctrl+Z / Ctrl+Y (Ctrl+Shift+Z) use these steps too: the browser's own undo does not know about the image rows.
    root.addEventListener("keydown", function(e){
      if(!(e.ctrlKey || e.metaKey) || e.altKey || e.isComposing) return;
      var k = e.key.toLowerCase();
      if(k === "z" && !e.shiftKey){ e.preventDefault(); undo(); }
      else if(k === "y" || (k === "z" && e.shiftKey)){ e.preventDefault(); redo(); }
    });
    function updateEmpty(){
      root.classList.toggle("is-empty", !root.querySelector(".ed-row") && !root.textContent.trim());
    }

    /* ---------- several pieces of text chosen at once (v1.0.179) ---------- */
    // Ctrl + drag (as in Word) keeps what was chosen and starts another piece, so 太字・下線・大きさ・色 can be
    // put on all of them with one press. Chromium keeps only one selection range, so the earlier pieces are
    // kept here as letter positions in the body (counted over its text nodes, which the format commands do
    // not change) and drawn with the CSS Custom Highlight API (::highlight(ed-multi) in style.css), which adds
    // nothing to the body. A plain click, a key, typing, 戻す or a click outside the editor and its format
    // tools ends it. Without the Highlight API (older browsers) Ctrl + drag is the normal drag.
    var multi = [], batching = false;
    var HL = !!(window.CSS && CSS.highlights && window.Highlight);
    function textPos(node, off){
      var r = document.createRange();
      r.setStart(root, 0);
      r.setEnd(node, off);
      return r.toString().length;
    }
    function posPoint(n, isEnd){
      var w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT), at = 0, last = null;
      while(w.nextNode()){
        var t = w.currentNode, len = t.length;
        if(isEnd ? n <= at + len : n < at + len){ return { node: t, offset: n - at }; }
        at += len;
        last = t;
      }
      return last ? { node: last, offset: last.length } : { node: root, offset: root.childNodes.length };
    }
    function piecePos(r){ return { s: textPos(r.startContainer, r.startOffset), e: textPos(r.endContainer, r.endOffset) }; }
    function pieceRange(p){
      var a = posPoint(p.s, false), b = posPoint(p.e, true), r = document.createRange();
      r.setStart(a.node, a.offset);
      r.setEnd(b.node, b.offset);
      return r;
    }
    function bodySelection(){
      var sel = window.getSelection();
      return sel && sel.rangeCount && root.contains(sel.getRangeAt(0).commonAncestorContainer) ? sel.getRangeAt(0) : null;
    }
    function showMulti(){
      if(!HL) return;
      if(!multi.length || !root.isConnected){ CSS.highlights.delete("ed-multi"); return; }
      var h = new Highlight();
      multi.forEach(function(p){ h.add(pieceRange(p)); });
      CSS.highlights.set("ed-multi", h);
    }
    function clearMulti(){
      if(!multi.length) return;
      multi = [];
      showMulti();
    }
    root.addEventListener("mousedown", function(e){
      if(!multi.length && !(HL && (e.ctrlKey || e.metaKey))) return;
      if(!(HL && (e.ctrlKey || e.metaKey)) || e.button !== 0 || (e.target.closest && e.target.closest(".ed-row"))){
        if(e.button === 0 && !e.shiftKey){ clearMulti(); }   // Shift + click widens the current piece
        return;
      }
      if(e.detail > 1) return;   // the second press of a double-click (a word): the first one kept the piece
      var r = bodySelection();
      if(r && !r.collapsed){
        multi.push(piecePos(r));
        showMulti();
        // Without a selection under the press, the browser starts a new one there instead of dragging the old one.
        window.getSelection().removeAllRanges();
      }
    }, true);
    root.addEventListener("keydown", function(e){
      if(!multi.length || /^(Control|Shift|Alt|Meta)$/.test(e.key)) return;
      // Ctrl+B / Ctrl+U go to all pieces (app.js, opts.onFormatKey)
      if((e.ctrlKey || e.metaKey) && !e.altKey && /^[bu]$/i.test(e.key) && opts.onFormatKey){
        e.preventDefault();
        opts.onFormatKey(e.key.toLowerCase());
        return;
      }
      clearMulti();
    }, true);
    document.addEventListener("mousedown", function onDoc(e){
      if(!root.isConnected){ document.removeEventListener("mousedown", onDoc, true); if(HL){ CSS.highlights.delete("ed-multi"); } return; }
      if(!multi.length || root.contains(e.target)) return;
      if(opts.keepMulti && e.target.closest && e.target.closest(opts.keepMulti)) return;   // the format buttons and their lists
      clearMulti();
    }, true);
    // Runs fn once for each piece, with the selection set to that piece (the current selection last), as one
    // step of 戻す. With only one piece it just runs fn on the current selection, as before. Afterwards the
    // pieces stay chosen, so another format can go on them too.
    function forEachPiece(fn){
      if(!multi.length){ fn(0, 1); return; }
      var pieces = multi.slice(), cur = bodySelection() || lastRange;
      if(cur && !cur.collapsed){ pieces.push(piecePos(cur)); }
      var sel = window.getSelection();
      root.focus();
      batching = true;
      try{
        pieces.forEach(function(p, i){
          sel.removeAllRanges();
          sel.addRange(pieceRange(p));
          fn(i, pieces.length);
        });
      } finally {
        batching = false;
      }
      record(false);
      multi = pieces.slice(0, -1);
      sel.removeAllRanges();
      sel.addRange(pieceRange(pieces[pieces.length - 1]));
      showMulti();
    }

    /* ---------- caret ---------- */
    function saveRange(){
      var sel = window.getSelection();
      if(sel && sel.rangeCount && root.contains(sel.getRangeAt(0).startContainer)){
        lastRange = sel.getRangeAt(0).cloneRange();
      }
    }
    ["keyup", "mouseup", "input", "focus"].forEach(function(ev){ root.addEventListener(ev, saveRange); });
    document.addEventListener("selectionchange", function(){ if(document.activeElement === root){ saveRange(); } });

    function topBlock(node){
      while(node && node.parentNode !== root){ node = node.parentNode; }
      return node;
    }
    function placeCaret(node, atEnd){
      var r = document.createRange();
      r.selectNodeContents(node);
      r.collapse(!atEnd);
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
      lastRange = r.cloneRange();
    }

    // Puts a row at the range: between blocks, splitting the line the caret is in.
    function insertRowAt(range, row){
      if(!range || !root.contains(range.startContainer)){
        ensureEnds();
        var last = root.lastChild;
        if(last && !last.textContent.trim() && !isRow(last)){ root.insertBefore(row, last); } else { root.appendChild(row); }
        ensureEnds();
        return;
      }
      var block = range.startContainer === root ? root.childNodes[range.startOffset] || null : topBlock(range.startContainer);
      if(!block){ root.appendChild(row); ensureEnds(); return; }
      if(isRow(block) || block.tagName === "UL" || block.tagName === "OL"){
        root.insertBefore(row, block.nextSibling);
        ensureEnds();
        return;
      }
      // Empty lines opened by a click below the text (padTo) are kept down to this one: the image goes there.
      if(block.hasAttribute && block.hasAttribute("data-pad")){
        var below = false;
        Array.prototype.slice.call(root.children).forEach(function(n){
          if(n === block){ below = true; }
          if(!n.hasAttribute("data-pad")) return;
          if(below && n !== block && isPad(n)){ n.remove(); } else { n.removeAttribute("data-pad"); }
        });
      }
      // The image goes in at the top of the line the caret is on (v1.0.180): that line moves below the image
      // (beside it, once it is made 右文章・左文章). Before, the line was split at the caret and the image went
      // after it, so a click on a line (the caret at its end) always put the image one line lower.
      // A long line that wraps is split where the caret's screen line starts.
      var caretAt = textOffset(block, range.startContainer, range.startOffset);
      var start = lineStart(block, caretAt);
      if(start <= 0){
        root.insertBefore(row, block);
        ensureEnds();
        placeAt(block, caretAt);
        return;
      }
      var cut = document.createRange();
      var p = pointAt(block, start);
      cut.setStart(p.node, p.offset);
      cut.setEnd(block, block.childNodes.length);
      var rest = document.createElement(block.tagName === "P" || block.tagName === "DIV" ? "p" : block.tagName.toLowerCase());
      rest.appendChild(cut.extractContents());
      root.insertBefore(row, block.nextSibling);
      root.insertBefore(rest, row.nextSibling);
      ensureEnds();
      placeAt(rest, caretAt - start);
    }
    // Letters from the start of block to (node, offset).
    function textOffset(block, node, offset){
      var r = document.createRange();
      r.selectNodeContents(block);
      try{ r.setEnd(node, offset); } catch(e){ return 0; }
      return r.toString().length;
    }
    // The text node and offset of letter n in block (its end when n is past the last letter).
    function pointAt(block, n){
      var w = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, null), t, last = null;
      while((t = w.nextNode())){
        if(n <= t.data.length){ return { node: t, offset: n }; }
        n -= t.data.length;
        last = t;
      }
      return last ? { node: last, offset: last.data.length } : { node: block, offset: 0 };
    }
    function letterRect(block, n){
      var a = pointAt(block, n), b = pointAt(block, n + 1);
      if(a.node.nodeType !== 3) return null;
      if(a.offset >= a.node.data.length){
        if(b.node === a.node) return null;
        a = { node: b.node, offset: 0 };
      }
      var r = document.createRange();
      r.setStart(a.node, a.offset);
      r.setEnd(a.node, a.offset + 1);
      var q = r.getClientRects();
      return q.length ? q[q.length - 1] : null;
    }
    // Where the screen line holding letter `at` starts, when block wraps into several lines.
    function lineStart(block, at){
      var len = block.textContent.length;
      if(!len) return 0;
      var ref = letterRect(block, Math.min(at, len - 1));
      if(!ref || !ref.height) return 0;
      var n = Math.min(at, len - 1);
      while(n > 0){
        var q = letterRect(block, n - 1);
        if(q && q.height && q.bottom <= ref.top + 1) break;   // that letter is on the line above
        n--;
      }
      return n;
    }
    function placeAt(block, n){
      var p = pointAt(block, n);
      var r = document.createRange();
      r.setStart(p.node, p.offset);
      r.collapse(true);
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
      lastRange = r.cloneRange();
    }

    // 「本文へ」: at the caret, or beside the chosen image when one is chosen.
    function insertImage(ref){
      if(isVideo(selected) && selected.isConnected){
        // Beside a chosen video there is no room in its row: the image goes below it (a wrapped one: below
        // the text beside it too, v1.0.173, or it would cut that text off the video).
        var unit = [selected].concat(isFloat(selected) ? besideNodes(selected) : []);
        var below = unit[unit.length - 1];
        deselect();
        root.insertBefore(buildRow([{ ref: ref, size: NEW_SIZE, align: "" }]), below.nextSibling);
        ensureEnds();
      } else if(selected && selected.isConnected){
        var items = itemsOf(selected).concat([{ ref: ref, size: NEW_SIZE, align: "" }]);
        var row = buildRow(items);
        selected.replaceWith(row);
        select(row);
      } else {
        insertRowAt(lastRange, buildRow([{ ref: ref, size: NEW_SIZE, align: "" }]));
      }
      changed();
    }
    // Taking an image out of the text (the attachment stays).
    function removeRef(ref){
      Array.prototype.forEach.call(root.querySelectorAll('figure[data-ref="' + ref + '"]'), function(f){
        var row = f.parentNode;
        var items = itemsOf(row).filter(function(it){ return it.ref !== ref; });
        if(!items.length){
          if(row === selected){ deselect(); }
          row.remove();
        } else {
          var nr = buildRow(items);
          if(row === selected){ selected = null; row.replaceWith(nr); select(nr); } else { row.replaceWith(nr); }
        }
      });
      ensureEnds();
      changed();
    }
    // Putting attached image ref into the text with use(ref): the page may hand back a copy of it
    // instead, when it is already in the text (v1.0.129, opts.placeRef).
    function place(ref, use){
      if(opts.placeRef){ opts.placeRef(ref, use); } else { use(ref); }
    }
    // One image in the text twice (saved before v1.0.129): every later place gets its own copy, one at a time
    // (a row is rebuilt by each change).
    function splitDuplicates(){
      var seen = [], dup = null;
      Array.prototype.some.call(root.querySelectorAll("figure[data-ref]"), function(f){
        var r = Number(f.getAttribute("data-ref"));
        if(seen.indexOf(r) >= 0){ dup = f; return true; }
        seen.push(r);
        return false;
      });
      if(!dup) return;
      place(Number(dup.getAttribute("data-ref")), function(r){
        replaceFigure(dup, r);
        splitDuplicates();
      });
    }
    function refreshImages(){
      Array.prototype.forEach.call(root.querySelectorAll("figure[data-ref]"), loadImage);
    }
    // Puts another attached image in the place of the one in fig, keeping its row (size, 右文章・左文章,
    // the text beside it). The old image stays attached, just no longer placed in the text.
    function replaceFigure(fig, newRef){
      if(!fig || !fig.isConnected || !newRef) return;
      var row = fig.parentNode;
      var idx = Array.prototype.indexOf.call(row.querySelectorAll("figure[data-ref]"), fig);
      var items = itemsOf(row);
      if(idx < 0 || items[idx].ref === newRef) return;
      items[idx].ref = newRef;
      var nr = buildRow(items);
      var wasSelected = row === selected;
      row.replaceWith(nr);
      if(wasSelected){ selected = null; select(nr, nr.querySelectorAll("figure[data-ref]")[idx]); }
      ensureEnds();
      changed();
    }
    // The text beside a wrapped image: the lines after it that start within its height (the dashed frame,
    // markWraps), always the first one. Nothing for any other image.
    function besideNodes(row){
      var list = [];
      if(!isFloat(row)) return list;
      var bottom = row.getBoundingClientRect().bottom;
      for(var n = row.nextSibling; n && !isRow(n) && !isHeading(n); n = n.nextSibling){
        if(n.nodeType !== 1){ continue; }
        if(list.length && n.getBoundingClientRect().top >= bottom - 1){ break; }
        list.push(n);
      }
      return list;
    }
    // n with what moves along with it: a wrapped image or a line beside one gives the image and its
    // text, anything else just itself.
    function unitContaining(n){
      if(isFloat(n)){ return [n].concat(besideNodes(n)); }
      for(var p = n.previousSibling; p; p = p.previousSibling){
        if(isRow(p) || isHeading(p)){
          if(isFloat(p)){ var u = [p].concat(besideNodes(p)); if(u.indexOf(n) >= 0){ return u; } }
          break;
        }
      }
      return [n];
    }

    /* ---------- the toolbar of a chosen image ---------- */
    function select(row, fig){
      deselect();
      selected = row;
      row.classList.add("selected");
      if(isVideo(row)){ videoToolbar(row); return; }
      var figs = row.querySelectorAll("figure[data-ref]");
      var target = fig || figs[0];
      if(figs.length > 1){ target.classList.add("target"); }
      var item = itemsOf(row)[Array.prototype.indexOf.call(figs, target)];
      var align = itemsOf(row).filter(function(it){ return it.align; }).map(function(it){ return it.align; })[0] || "中央";
      toolbar = document.createElement("div");
      toolbar.className = "ed-toolbar";
      toolbar.innerHTML =
        (opts.paperPct && opts.paperPct(item.ref)
          ? '<span class="ed-group ed-note" title="白紙は、作ったときに選んだ幅のまま出ます（文字が本文と同じ大きさになるように）">白紙：作った幅のまま</span>'
          : '<span class="ed-group">' + SIZES.map(function(s){
              return '<button type="button" data-size="' + s + '" class="' + (item.size === s ? "on" : "") + '">' + s + '</button>';
            }).join("") + '</span>') +
        '<span class="ed-group">' + ALIGNS.map(function(a){
          return '<button type="button" data-align="' + a + '" class="' + (align === a ? "on" : "") + '"' +
                 (ALIGN_TITLE[a] ? ' title="' + ALIGN_TITLE[a] + '"' : '') + '>' + (ALIGN_LABEL[a] || a) + '</button>';
        }).join("") + '</span>' +
        (opts.onShow ? '<span class="ed-group"><button type="button" data-show="1" title="この画像を大きく表示（広い画面では右側）">🔍 大きく表示</button></span>' : '') +
        (opts.onSwap ? '<span class="ed-group"><button type="button" data-swap="1" title="この画像を、別の添付画像に入れ替えます（位置・大きさ・横の文章はそのまま）">⇄ 入れ替え</button></span>' : '') +
        '<span class="ed-group">' +
          '<button type="button" data-move="-1" title="上へ移動（右文章・左文章の画像は、横の文章も一緒に動きます）">↑</button>' +
          '<button type="button" data-move="1" title="下へ移動（右文章・左文章の画像は、横の文章も一緒に動きます）">↓</button>' +
          '<button type="button" data-remove="1" title="本文から外す（添付は残ります）">本文から外す</button>' +
        '</span>' +
        '<span class="ed-group">' +
          '<button type="button" data-line="-1" title="この画像の上に文字を書く行を足します（Shift+Enter）">＋上に行</button>' +
          '<button type="button" data-line="1" title="この画像の下に文字を書く行を足します（Enter）">＋下に行</button>' +
        '</span>';
      document.body.appendChild(toolbar);
      placeToolbar();
      toolbar.addEventListener("mousedown", function(e){ e.preventDefault(); });
      Array.prototype.forEach.call(toolbar.querySelectorAll("button"), function(b){
        b.addEventListener("click", function(){ toolbarAction(b, target); });
      });
    }
    // A chosen video: its size, where it sits, YouTube, moving, taking it out, and the lines around it.
    function videoToolbar(row){
      var v = videoOf(row);
      toolbar = document.createElement("div");
      toolbar.className = "ed-toolbar";
      toolbar.innerHTML =
        '<span class="ed-group">' + SIZES.map(function(s){
          return '<button type="button" data-size="' + s + '" class="' + (v.size === s ? "on" : "") + '">' + s + '</button>';
        }).join("") + '</span>' +
        '<span class="ed-group">' + ALIGNS.map(function(a){
          return '<button type="button" data-align="' + a + '" class="' + ((v.align || "中央") === a ? "on" : "") + '"' +
                 (VIDEO_ALIGN_TITLE[a] ? ' title="' + VIDEO_ALIGN_TITLE[a] + '"' : '') + '>' + (ALIGN_LABEL[a] || a) + '</button>';
        }).join("") + '</span>' +
        '<span class="ed-group"><button type="button" data-open="1" title="この動画を YouTube で開きます">▶ YouTube で開く</button></span>' +
        '<span class="ed-group">' +
          '<button type="button" data-move="-1" title="上へ移動（右文章・左文章の動画は、横の文章も一緒に動きます）">↑</button>' +
          '<button type="button" data-move="1" title="下へ移動（右文章・左文章の動画は、横の文章も一緒に動きます）">↓</button>' +
          '<button type="button" data-remove="1" title="この動画を本文から外します">本文から外す</button>' +
        '</span>' +
        '<span class="ed-group">' +
          '<button type="button" data-line="-1" title="この動画の上に文字を書く行を足します（Shift+Enter）">＋上に行</button>' +
          '<button type="button" data-line="1" title="この動画の下に文字を書く行を足します（Enter）">＋下に行</button>' +
        '</span>';
      document.body.appendChild(toolbar);
      placeToolbar();
      toolbar.addEventListener("mousedown", function(e){ e.preventDefault(); });
      Array.prototype.forEach.call(toolbar.querySelectorAll("button"), function(b){
        b.addEventListener("click", function(){ toolbarAction(b, null); });
      });
    }
    function deselect(){
      if(selected){
        selected.classList.remove("selected");
        Array.prototype.forEach.call(selected.querySelectorAll(".target"), function(f){ f.classList.remove("target"); });
      }
      selected = null;
      if(toolbar){ toolbar.remove(); toolbar = null; }
    }
    function placeToolbar(){
      if(!toolbar || !selected) return;
      var r = selected.getBoundingClientRect();
      var w = toolbar.offsetWidth, h = toolbar.offsetHeight;
      var left = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), window.innerWidth - w - 8);
      var top = r.top - h - 8;
      if(top < 8){ top = Math.min(r.bottom + 8, window.innerHeight - h - 8); }
      toolbar.style.left = left + "px";
      toolbar.style.top = top + "px";
    }
    window.addEventListener("scroll", placeToolbar, true);
    window.addEventListener("resize", placeToolbar);

    function toolbarAction(b, target){
      var row = selected;
      if(!row) return;
      if(isVideo(row)){
        if(b.hasAttribute("data-open")){ if(V.open){ V.open(videoOf(row)); } return; }
        if(b.hasAttribute("data-size") || b.hasAttribute("data-align")){
          var v = videoOf(row);
          if(b.hasAttribute("data-size")){ v.size = b.getAttribute("data-size"); }
          else { v.align = b.getAttribute("data-align") === "中央" ? "" : b.getAttribute("data-align"); }
          var nv = buildVideoRow(v);
          row.replaceWith(nv);
          ensureEnds();
          select(nv);
          changed();
          return;
        }
        // ↑ ↓, 本文から外す and the lines around it: as for an image (below).
      }
      var figs = Array.prototype.slice.call(row.querySelectorAll("figure[data-ref]"));
      var idx = Math.max(0, figs.indexOf(target));
      var items = itemsOf(row);
      if(b.hasAttribute("data-show")){
        opts.onShow(items[idx].ref);
        return;
      }
      if(b.hasAttribute("data-line")){
        openLine(row, b.getAttribute("data-line") === "1", true);
        return;
      }
      if(b.hasAttribute("data-swap")){
        var swapFig = figs[idx];
        opts.onSwap(items[idx].ref, function(newRef){ place(newRef, function(r){ replaceFigure(swapFig, r); }); });
        return;
      }
      if(b.hasAttribute("data-size")){
        items[idx].size = b.getAttribute("data-size");
        // A wrapped row is one width: its size is the row's.
        if(/float/.test(row.className)){ items.forEach(function(it){ it.size = items[idx].size; }); }
      } else if(b.hasAttribute("data-align")){
        var a = b.getAttribute("data-align");
        items.forEach(function(it){ it.align = a === "中央" ? "" : a; });
      } else if(b.hasAttribute("data-move")){
        var up = b.getAttribute("data-move") === "-1";
        // A wrapped image moves together with the text beside it (v1.0.104): moved alone, it only hopped
        // past that text, which then looked as if the text had moved and the image stayed.
        var unit = [row].concat(besideNodes(row));
        var edge = up ? unit[0] : unit[unit.length - 1];
        var sib = up ? edge.previousSibling : edge.nextSibling;
        if(isAuto(sib)){ sib = up ? sib.previousSibling : sib.nextSibling; }   // it belongs to the image above
        if(!sib) return;
        // Past the empty line kept at the very start or end there is nowhere to go: moving would
        // only add another empty line there each time (ensureEnds), and saved, a blank line.
        if(sib === (up ? root.firstChild : root.lastChild) && !isRow(sib) && !sib.textContent.trim() && !sib.querySelector("img")) return;
        // It hops over one block: a plain line, or another wrapped image with the text beside it.
        var block = unitContaining(sib);
        var hopTo = up ? block[0] : block[block.length - 1].nextSibling;
        unit.forEach(function(n){ root.insertBefore(n, hopTo); });
        ensureEnds();
        placeToolbar();
        row.scrollIntoView({ block: "nearest" });
        changed();
        return;
      } else if(b.hasAttribute("data-remove")){
        var rest = items.filter(function(it, i){ return i !== idx; });
        deselect();
        if(rest.length){ row.replaceWith(buildRow(rest)); } else { row.remove(); }
        ensureEnds();
        changed();
        return;
      }
      var nr = buildRow(items);
      row.replaceWith(nr);
      ensureEnds();   // 右文章・左文章 on or off: the empty line beside it (ensureWrapLines)
      select(nr, nr.querySelectorAll("figure[data-ref]")[idx]);
      changed();
    }

    // Images placed one after another have no line between them, and an image row cannot take the
    // caret, so there was nowhere to write between them. openLine puts the caret on the line above or
    // below the row, opening an empty one (data-gap, see ensureWrapLines) when there is none, or
    // always with fresh (Enter).
    function openLine(row, below, fresh){
      var sib = below ? row.nextSibling : row.previousSibling;
      var line = !fresh && sib && sib.nodeType === 1 && !isRow(sib) ? sib : null;
      if(!line){
        line = para();
        line.setAttribute("data-gap", "");
        root.insertBefore(line, below ? row.nextSibling : row);
      }
      deselect();
      root.focus({ preventScroll: true });
      placeCaret(line, !below);
      markWraps();
      updateEmpty();
      line.scrollIntoView({ block: "nearest" });
    }
    // A click in the space between two images opens a line there.
    function gapAt(y){
      var kids = root.children;
      for(var i = 0; i + 1 < kids.length; i++){
        if(!isRow(kids[i]) || !isRow(kids[i + 1])) continue;
        if(y >= kids[i].getBoundingClientRect().bottom - 1 && y <= kids[i + 1].getBoundingClientRect().top + 1){ return kids[i]; }
      }
      return null;
    }

    root.addEventListener("mousedown", function(e){
      var row = e.target.closest && e.target.closest(".ed-row");
      if(row && root.contains(row)){
        select(row, e.target.closest("figure"));
      } else {
        deselect();
        var above = e.target === root && e.button === 0 ? gapAt(e.clientY) : null;
        if(above){ e.preventDefault(); openLine(above, true); }
        else if(e.button === 0 && !e.shiftKey && padTo(e.clientY)){ e.preventDefault(); }   // below the text (v1.0.178)
      }
    });
    // Double-clicking an image in the text shows it large.
    root.addEventListener("dblclick", function(e){
      var fig = opts.onShow && e.target.closest && e.target.closest("figure[data-ref]");
      if(fig && root.contains(fig)){ opts.onShow(Number(fig.getAttribute("data-ref"))); }
    });
    document.addEventListener("mousedown", function(e){
      if(!selected) return;
      if(root.contains(e.target) || (toolbar && toolbar.contains(e.target))) return;
      if(e.target.closest && e.target.closest(".thumb-inline")) return;   // 「本文へ」 adds beside the chosen image
      deselect();
    });
    root.addEventListener("keydown", function(e){
      if(!selected) return;
      if(e.key === "Delete" || e.key === "Backspace"){
        e.preventDefault();
        var row = selected;
        deselect();
        row.remove();
        ensureEnds();
        changed();
        return;
      }
      if(e.key === "Escape"){ deselect(); return; }
      // Enter opens a new line below the chosen image (Shift+Enter above); the arrow keys go to the
      // line above or below it, opening one between two images.
      if(e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return;
      if(e.key === "Enter"){ e.preventDefault(); openLine(selected, !e.shiftKey, true); return; }
      if(/^Arrow(Up|Down|Left|Right)$/.test(e.key)){
        e.preventDefault();
        openLine(selected, e.key === "ArrowDown" || e.key === "ArrowRight", false);
      }
    });

    // Backspace at the start of a line right after an image (or Delete at the end of a line right
    // before one) made the browser delete the image (v1.0.60). An empty line there is removed
    // instead; with text in it nothing happens. An image is deleted by choosing it first.
    root.addEventListener("keydown", function(e){
      if(selected || e.isComposing || (e.key !== "Backspace" && e.key !== "Delete")) return;
      if(e.ctrlKey || e.metaKey || e.altKey) return;
      var sel = window.getSelection();
      if(!sel.rangeCount || !sel.isCollapsed) return;
      var range = sel.getRangeAt(0);
      if(!root.contains(range.startContainer)) return;
      var block = topBlock(range.startContainer);
      if(!block || block.nodeType !== 1 || !/^(P|H[1-6]|UL|OL)$/.test(block.tagName)) return;
      var back = e.key === "Backspace";
      function hasLetters(n){ return !!n.textContent.replace(/​/g, "").length; }
      // The empty last line right below an image goes with Backspace or Delete (v1.0.185). The caret is
      // let go (another Backspace must not reach the image); a click below the image opens a line again.
      // Only a line with nothing in it (v1.0.186): spaces typed there are letters, and Backspace takes one of them.
      if(!block.nextSibling && isRow(block.previousSibling) && block.tagName === "P" &&
         !hasLetters(block) && !block.querySelector("img")){
        e.preventDefault();
        block.remove();
        ensureEnds();
        sel.removeAllRanges();
        lastRange = null;
        root.blur();
        changed();
        return;
      }
      // An empty first line right above an image goes with Backspace too (v1.0.181): before, the blank line
      // above an image at the top could not be taken away.
      if(back && !block.previousSibling && isRow(block.nextSibling) && block.tagName === "P" &&
         !hasLetters(block) && !block.querySelector("img")){
        e.preventDefault();
        var first = block.nextSibling;
        block.remove();
        ensureEnds();
        var after = first.nextSibling;
        while(after && isRow(after)){ after = after.nextSibling; }
        if(after){ placeCaret(after, false); }
        changed();
        return;
      }
      if(!isRow(back ? block.previousSibling : block.nextSibling)) return;
      // In a list: its first item for Backspace, its last for Delete (v1.0.61).
      var line = block;
      if(/^(UL|OL)$/.test(block.tagName)){
        var n0 = range.startContainer;
        line = (n0.nodeType === 1 ? n0 : n0.parentNode).closest("li");
        if(!line || line.parentNode !== block || line !== (back ? block.firstElementChild : block.lastElementChild)) return;
      }
      var edge = document.createRange();
      edge.selectNodeContents(line);
      if(back){ edge.setEnd(range.startContainer, range.startOffset); } else { edge.setStart(range.startContainer, range.startOffset); }
      if(edge.toString() !== "" || edge.cloneContents().querySelector("img")) return;   // not at that edge
      e.preventDefault();
      if(line.textContent.trim() || line.querySelector("img")) return;
      if(line !== block){
        // An empty list item: only that item goes.
        line.remove();
        if(block.children.length){
          placeCaret(back ? block.firstElementChild : block.lastElementChild, !back);
          changed();
          return;
        }
      }
      var next = block.nextSibling, prev = block.previousSibling;
      block.remove();
      ensureEnds();
      function textLine(n){ return n && n.nodeType === 1 && n.isConnected && !isRow(n) ? n : null; }
      // The caret goes to the neighbouring line on the far side from the image, or to the line
      // ensureEnds put back in its place (the one kept after the last image).
      var to = textLine(back ? next : prev) || textLine(prev && prev.isConnected ? prev.nextSibling : root.firstChild);
      // Delete on the empty first line above an image: to the line below the image(s).
      if(!to && !back){ var n2 = next; while(n2 && isRow(n2)){ n2 = n2.nextSibling; } to = textLine(n2); }
      if(to){ placeCaret(to, !back); }
      changed();
    });

    /* ---------- typing, pasting, dragging ---------- */
    root.addEventListener("input", function(e){
      if(!root.firstChild){ root.appendChild(para()); }
      keepPads();   // written in the lines a click opened: they are lines of their own now
      if(!batching){ clearMulti(); }   // typed or pasted: only the current piece changed
      // Bold, size and colour come through here too (execCommand); they are steps of their own.
      changed(!/^format/.test(e.inputType || ""));
    });
    // A space typed at the start of a line that wrapped (v1.0.93): browsers never break a line before a
    // space, so it went to the end of the line above, unseen (only with line-break:anywhere would it
    // move down, and then 。 and 、 could start lines too). So the line is broken there as with Enter
    // and the space starts the new one; since v1.0.92 a line broken with Enter is spaced like a wrapped
    // one, so it still looks like the same paragraph. Paragraphs only: a list item's leading spaces
    // are not kept (getBody).
    function charRect(node, i){
      var r = document.createRange();
      r.setStart(node, i);
      r.setEnd(node, i + 1);
      return r.getBoundingClientRect();
    }
    // The block's letters before and after the caret, wherever its text is split into nodes: a colour,
    // size or bold change, or two lines joined with Backspace (v1.0.95; before, a caret at the edge of
    // a text node was never taken as a wrap, so the space went to the end of the line above).
    // Letters drawn nowhere (collapsed spaces) are skipped.
    function lettersAround(range, block){
      var before = null, after = null, w = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
      while(w.nextNode()){
        var t = w.currentNode;
        for(var i = 0; i < t.length; i++){
          var q = charRect(t, i);
          if(!(q.height > 0)) continue;
          if(range.comparePoint(t, i + 1) <= 0){ before = q; }
          else if(range.comparePoint(t, i) >= 0){ return { before: before, after: q }; }
        }
      }
      return { before: before, after: after };
    }
    function atWrapStart(range){
      var block = topBlock(range.startContainer);
      if(!block || block.tagName !== "P") return false;
      var a = lettersAround(range, block);
      return !!(a.before && a.after) && a.after.top > a.before.bottom - 2;
    }
    function breakWithSpace(data){
      document.execCommand("insertParagraph");
      document.execCommand("insertText", false, data);
    }
    root.addEventListener("beforeinput", function(e){
      if(e.inputType !== "insertText" || !/^[ 　]+$/.test(e.data || "")) return;
      var sel = window.getSelection();
      if(!sel.rangeCount || !sel.isCollapsed || !atWrapStart(sel.getRangeAt(0))) return;
      e.preventDefault();
      breakWithSpace(e.data);
    });
    // A space can also come through the Japanese input (IME) as a composition, which cannot be
    // stopped beforehand (v1.0.95): where the caret was at a wrap when it began, the space it put
    // there is taken out again and typed as above.
    var spaceWrap = null;
    root.addEventListener("compositionstart", function(){
      var sel = window.getSelection();
      spaceWrap = sel.rangeCount && sel.isCollapsed && atWrapStart(sel.getRangeAt(0)) ? true : null;
    });
    root.addEventListener("compositionend", function(e){
      var data = e.data || "", was = spaceWrap;
      spaceWrap = null;
      if(!was || !/^[ 　]+$/.test(data)) return;
      setTimeout(function(){
        var sel = window.getSelection();
        if(!sel.rangeCount || !sel.isCollapsed) return;
        var r = sel.getRangeAt(0), node = r.startContainer, off = r.startOffset;
        if(node.nodeType !== 3 || off < data.length) return;
        var typed = node.nodeValue.slice(off - data.length, off).replace(/ /g, " ");
        if(typed !== data.replace(/ /g, " ")) return;
        var del = document.createRange();
        del.setStart(node, off - data.length);
        del.setEnd(node, off);
        sel.removeAllRanges();
        sel.addRange(del);
        document.execCommand("delete");
        breakWithSpace(data);
      }, 0);
    });
    root.addEventListener("paste", function(e){
      var cd = e.clipboardData;
      if(!cd || (cd.files && cd.files.length)) return;   // pictures: the page attaches them
      var text = cd.getData("text/plain");
      e.preventDefault();
      // A YouTube address pasted on its own becomes the video (v1.0.171), at the caret.
      var vid = V && text && /^\s*\S+\s*$/.test(text) ? V.fromUrl(text.trim()) : null;
      if(vid){
        var sel = window.getSelection();
        if(sel.rangeCount && !sel.isCollapsed){ document.execCommand("delete"); }
        insertVideo(vid, sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null);
        return;
      }
      if(text){ document.execCommand("insertText", false, text); }
    });
    // Bold / italic and (v1.0.110) underline from the keyboard are kept (Ctrl+U makes <u>, saved as <u>…</u>).

    function rangeAtPoint(x, y){
      if(document.caretRangeFromPoint){ return document.caretRangeFromPoint(x, y); }
      if(document.caretPositionFromPoint){
        var p = document.caretPositionFromPoint(x, y);
        if(!p) return null;
        var r = document.createRange();
        r.setStart(p.offsetNode, p.offset);
        r.collapse(true);
        return r;
      }
      return null;
    }
    root.addEventListener("dragstart", function(e){
      var row = e.target.closest && e.target.closest(".ed-row");
      if(!row) return;
      dragRow = row;
      dragFig = e.target.closest("figure[data-ref]");
      e.dataTransfer.setData(DRAG_ROW, "1");
      e.dataTransfer.effectAllowed = "move";
      deselect();
    });
    // Dropped on another placed image (v1.0.104): a placed image swaps places with it (the text beside
    // each stays where it is); an attached image from the list takes its place.
    // Since v1.0.184 an image dropped on another image (side by side in one row, or in another row) swaps
    // only the pictures: each place keeps its size and 左寄せ…右文章, so the rows keep their shape. A video, or a
    // row grabbed by its gap, still swaps whole rows.
    var dropMark = null;
    function markDrop(el){
      if(dropMark === el) return;
      if(dropMark){ dropMark.classList.remove("drop-swap"); }
      dropMark = el;
      if(dropMark){ dropMark.classList.add("drop-swap"); }
    }
    function rowUnder(e){
      var r = e.target.closest && e.target.closest(".ed-row");
      return r && root.contains(r) ? r : null;
    }
    function figUnder(e){
      var f = e.target.closest && e.target.closest("figure[data-ref]");
      return f && root.contains(f) ? f : null;
    }
    function swapFigures(a, b){
      var rowA = a.parentNode, rowB = b.parentNode;
      var figsA = rowA.querySelectorAll("figure[data-ref]"), figsB = rowB.querySelectorAll("figure[data-ref]");
      var ia = Array.prototype.indexOf.call(figsA, a), ib = Array.prototype.indexOf.call(figsB, b);
      var itemsA = itemsOf(rowA), itemsB = rowB === rowA ? itemsA : itemsOf(rowB);
      var refA = itemsA[ia].ref;
      itemsA[ia].ref = itemsB[ib].ref;
      itemsB[ib].ref = refA;
      rowA.replaceWith(buildRow(itemsA));
      if(rowB !== rowA){ rowB.replaceWith(buildRow(itemsB)); }
    }
    // One image of several side by side, taken out of its row (the others stay together).
    function takeFigure(fig){
      var row = fig.parentNode;
      var idx = Array.prototype.indexOf.call(row.querySelectorAll("figure[data-ref]"), fig);
      var items = itemsOf(row);
      var item = items.splice(idx, 1)[0];
      row.replaceWith(buildRow(items));
      return item;
    }
    root.addEventListener("dragend", function(){ dragRow = null; dragFig = null; markDrop(null); });
    document.addEventListener("dragend", function(){ markDrop(null); });   // a drag from the image list, given up
    root.addEventListener("dragleave", function(e){ if(!root.contains(e.relatedTarget)){ markDrop(null); } });
    root.addEventListener("dragover", function(e){
      var types = Array.prototype.slice.call(e.dataTransfer.types || []);
      if(types.indexOf(DRAG_ROW) >= 0 || types.indexOf(DRAG_REF) >= 0){
        e.preventDefault();
        e.dataTransfer.dropEffect = types.indexOf(DRAG_ROW) >= 0 ? "move" : "copy";
        var over = rowUnder(e), overFig = figUnder(e);
        if(types.indexOf(DRAG_ROW) >= 0 && dragFig){
          markDrop(overFig ? (overFig !== dragFig ? overFig : null) : (over && over !== dragRow ? over : null));
        } else if(types.indexOf(DRAG_REF) >= 0 && overFig){
          markDrop(overFig);
        } else {
          markDrop(over && over !== dragRow ? over : null);
        }
      }
    });
    root.addEventListener("drop", function(e){
      var types = Array.prototype.slice.call(e.dataTransfer.types || []);
      var range = rangeAtPoint(e.clientX, e.clientY);
      var overRow = rowUnder(e);
      markDrop(null);
      if(types.indexOf(DRAG_ROW) >= 0 && dragRow){
        e.preventDefault();
        var row = dragRow, fig = dragFig;
        dragRow = null;
        dragFig = null;
        var overFig = figUnder(e);
        if(fig && overFig){
          if(overFig === fig) return;
          swapFigures(fig, overFig);
          ensureEnds();
          changed();
          return;
        }
        if(fig && overRow === row) return;   // the gap beside itself
        if(overRow && overRow !== row){
          var mark = document.createElement("span");
          row.replaceWith(mark);
          overRow.replaceWith(row);
          mark.replaceWith(overRow);
          ensureEnds();
          changed();
          return;
        }
        if(range && row.contains(range.startContainer)) return;
        if(fig && row.querySelectorAll("figure[data-ref]").length > 1){
          insertRowAt(range, buildRow([takeFigure(fig)]));
          ensureEnds();
          changed();
          return;
        }
        row.remove();
        insertRowAt(range, row);
        changed();
        return;
      }
      if(types.indexOf(DRAG_REF) >= 0){
        e.preventDefault();
        var ref = Number(e.dataTransfer.getData(DRAG_REF));
        if(ref && overRow && !isVideo(overRow)){
          var dropFig = e.target.closest("figure[data-ref]") || overRow.querySelector("figure[data-ref]");
          if(!dropFig || Number(dropFig.getAttribute("data-ref")) === ref) return;   // onto itself: nothing to do
          place(ref, function(r){ replaceFigure(dropFig, r); });
          return;
        }
        if(ref){
          deselect();
          place(ref, function(r){
            insertRowAt(range, buildRow([{ ref: r, size: NEW_SIZE, align: "" }]));
            changed();
          });
        }
      }
    });

    /* ---------- 右文章・左文章: how far the text beside an image reaches (v1.0.59) ---------- */
    // style.css draws a frame beside each wrapped image (.ed-row.float::after) as tall as the image.
    // A line that starts in its last few pixels still goes beside the image while its letters end
    // lower, so the frame is stretched to the end of the last such line (--wrap-extra on the row).
    // A timer, not requestAnimationFrame: that one does not run while the window is hidden or covered.
    var wrapTimer = 0;
    function scheduleWraps(){
      if(!wrapTimer){ wrapTimer = setTimeout(function(){ wrapTimer = 0; if(!composing){ markWraps(); } }, 0); }
    }
    // Empty lines that will be saved (v1.0.60): the viewer and print keep them as empty lines, which
    // can leave a gap under a wrapped image's text, so style.css marks them faintly (data-blank, "↵").
    // Not the empty lines at the very start or end (getBody drops them) nor the data-auto ones.
    function markBlanks(){
      var kids = Array.prototype.filter.call(root.childNodes, function(n){ return n.nodeType === 1; });
      function isBlank(n){ return n.tagName === "P" && !n.textContent.trim() && !n.querySelector("img"); }
      var first = -1, last = -1;
      kids.forEach(function(n, i){ if(!isBlank(n)){ if(first < 0){ first = i; } last = i; } });
      kids.forEach(function(n, i){
        // Since v1.0.178 every empty line has it (also those at the start and end, and those not saved
        // while empty): the owner looks for the ↵ to see where a line is (markEnds adds it after the text).
        var blank = isBlank(n);
        if(n.hasAttribute("data-blank") !== blank){ n.toggleAttribute("data-blank", blank); }
      });
    }
    // ↵ at the end of each line of text (v1.0.178), like the empty lines' one (style.css p[data-blank]).
    // Drawn in a layer beside the editor (.ed-ends), not in it: the last line of a wrapped image's group
    // already uses its ::after to clear the image, and nothing in the layer is part of the text or takes clicks.
    var endsLayer = null;
    function hideEnds(){ if(endsLayer){ endsLayer.style.visibility = "hidden"; } }
    function markEnds(){
      if(!root.parentNode) return;
      if(!endsLayer || endsLayer.parentNode !== root.parentNode || endsLayer.nextSibling !== root){
        if(endsLayer){ endsLayer.remove(); }
        endsLayer = document.createElement("div");
        endsLayer.className = "ed-ends";
        endsLayer.setAttribute("aria-hidden", "true");
        root.parentNode.insertBefore(endsLayer, root);
      }
      endsLayer.style.visibility = "";
      var k = (root.offsetWidth && root.getBoundingClientRect().width / root.offsetWidth) || 1;
      var o = endsLayer.getBoundingClientRect();
      var html = "";
      Array.prototype.forEach.call(root.children, function(n){
        if(isRow(n)) return;
        var boxes = n.tagName === "UL" || n.tagName === "OL" ? n.children : [n];
        Array.prototype.forEach.call(boxes, function(box){
          var q = lastLetterRect(box);
          if(!q) return;
          var fs = parseFloat(getComputedStyle(box).fontSize) || 14;
          html += '<span style="left:' + ((q.right - o.left) / k + fs * 0.12).toFixed(1) + 'px;top:' +
                  (((q.top + q.bottom) / 2 - o.top) / k).toFixed(1) + 'px;font-size:' + (fs * 0.9).toFixed(1) + 'px">↵</span>';
        });
      });
      if(endsLayer.innerHTML !== html){ endsLayer.innerHTML = html; }
    }
    // The box of the last letter of a line (or null when it has none).
    function lastLetterRect(box){
      if(!box.textContent.trim()) return null;
      var texts = [], w = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
      while(w.nextNode()){ if(w.currentNode.nodeValue.length){ texts.push(w.currentNode); } }
      var range = document.createRange();
      for(var t = texts.length - 1; t >= 0; t--){
        var s = texts[t].nodeValue;
        for(var i = s.length - 1; i >= 0 && i >= s.length - 4; i--){
          range.setStart(texts[t], i);
          range.setEnd(texts[t], i + 1);
          var rs = range.getClientRects(), q = rs[rs.length - 1];
          if(q && q.height){ return q; }
        }
      }
      return null;
    }
    // A paragraph or list item whose text is all smaller than the body (v1.0.92) is spaced for its
    // largest letters at the body's ratio, as the viewer and print do (smallTextLineHeight in app.js).
    // Only the style attribute changes: getBody reads colours and sizes, not the line height.
    function fitLineHeights(){
      var base = parseFloat(getComputedStyle(root).fontSize);
      Array.prototype.forEach.call(root.querySelectorAll(":scope > p, :scope > ul > li"), function(b){
        var max = 0;
        var w = document.createTreeWalker(b, NodeFilter.SHOW_TEXT);
        while(w.nextNode()){
          if(!w.currentNode.nodeValue.trim()) continue;
          max = Math.max(max, parseFloat(getComputedStyle(w.currentNode.parentNode).fontSize));
        }
        var pt = max && max < base - 0.01 ? Math.round(max / base * 10.5 * 100) / 100 : 0;
        var key = pt ? String(pt) : null;
        if(b.getAttribute("data-lh") === key && (key !== null) === !!b.style.lineHeight) return;
        if(key){
          b.setAttribute("data-lh", key);
          b.style.lineHeight = "calc(var(--body-pt, 0.0952em) * " + pt + " * var(--lh-ratio, 1.6))";
        } else {
          b.removeAttribute("data-lh");
          b.style.removeProperty("line-height");
          if(!b.getAttribute("style")){ b.removeAttribute("style"); }
        }
      });
    }
    function markWraps(){
      fitLineHeights();
      markBlanks();
      var rows = root.querySelectorAll(".ed-row.float");
      // Where each group starts and ends (see ensureWrapLines): its first line, and the last line
      // before the next image line or heading.
      var starts = [], ends = [];
      Array.prototype.forEach.call(rows, function(row){
        var first = null, last = null;
        for(var n = row.nextSibling; n && !isRow(n) && !isHeading(n); n = n.nextSibling){
          if(n.nodeType === 1){ first = first || n; last = n; }
        }
        if(first){ starts.push(first); ends.push(last); }
      });
      function mark(attr, list){
        Array.prototype.forEach.call(root.querySelectorAll("[" + attr + "]"), function(n){
          if(list.indexOf(n) < 0){ n.removeAttribute(attr); }
        });
        list.forEach(function(n){ if(!n.hasAttribute(attr)){ n.setAttribute(attr, ""); } });
      }
      mark("data-group-start", starts);
      mark("data-group-end", ends);

      // The sheet may be zoomed (CSS zoom, v1.0.90): boxes on screen are zoomed, computed lengths are not.
      var k = (root.offsetWidth && root.getBoundingClientRect().width / root.offsetWidth) || 1;
      Array.prototype.forEach.call(rows, function(row){
        var r = row.getBoundingClientRect();
        // The text goes beside the image itself, not beside the margin below it (shape-outside, v1.0.91).
        var floatBottom = r.bottom;
        var extra = 0;
        // The text beside it runs to the end of its group.
        for(var n = row.nextSibling; n && !isRow(n) && !isHeading(n); n = n.nextSibling){
          if(n.nodeType === 1 && n.getBoundingClientRect().top >= floatBottom) break;
          if(n.nodeType !== 1) continue;
          // Each paragraph (or list item) stacks its lines one line-height apart from its top, and
          // a line goes beside the image when its line box starts above the image's bottom margin.
          var boxes = n.tagName === "UL" || n.tagName === "OL" ? n.children : [n];
          Array.prototype.forEach.call(boxes, function(box){
            var cs = getComputedStyle(box), lh = parseFloat(cs.lineHeight) * k;
            if(!(lh > 0)) return;
            var top0 = box.getBoundingClientRect().top + (parseFloat(cs.borderTopWidth) + parseFloat(cs.paddingTop)) * k;
            // Only the letters: a range over an element also returns the boxes of the elements in it.
            var walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
            while(walker.nextNode()){
              var range = document.createRange();
              range.selectNodeContents(walker.currentNode);
              Array.prototype.forEach.call(range.getClientRects(), function(q){
                if(!q.width) return;
                var lead = Math.max(0, (lh - q.height) / 2);
                var lineTop = top0 + Math.max(0, Math.round((q.top - lead - top0) / lh)) * lh;
                // A line taller than the others (bigger letters) is measured by its letters instead.
                var lineBottom = Math.max(lineTop + lh, q.bottom);
                if(lineTop < floatBottom - 0.01){ extra = Math.max(extra, lineBottom - floatBottom); }
              });
            }
          });
        }
        var v = Math.max(0, Math.ceil(extra / k)) + "px";
        if(row.style.getPropertyValue("--wrap-extra") !== v){ row.style.setProperty("--wrap-extra", v); }
      });
      markEnds();   // after the frames: the lines are where they stay
    }
    if(window.ResizeObserver){ new ResizeObserver(scheduleWraps).observe(root); }
    root.addEventListener("load", scheduleWraps, true);   // an image finished loading
    if(document.fonts && document.fonts.ready){ document.fonts.ready.then(scheduleWraps); }   // the ↵ follow the letters

    /* ---------- 押した所から書く (v1.0.178) ---------- */
    // A click below the text (in the frame beside a wrapped image under its text, or below the last line)
    // opens empty lines down to that place and puts the caret there, as pressing Enter that many times
    // would. Before, the caret went to the end of the text and the owner pressed Enter again and again.
    // The lines (data-pad) are not saved while nothing is written in them, and go when the caret leaves.
    function padTo(y){
      var k = (root.offsetWidth && root.getBoundingClientRect().width / root.offsetWidth) || 1;
      var b = null;
      Array.prototype.forEach.call(root.children, function(n){ if(n.getBoundingClientRect().top <= y){ b = n; } });
      if(!b) return false;
      // Below the last image (v1.0.185, no empty line is kept after it any more): lines open under it.
      if(isRow(b) && (b.nextSibling || isFloat(b))) return false;
      function lineH(el){ return (parseFloat(getComputedStyle(el).lineHeight) || 20) * k; }
      var bottom;
      if(isRow(b)){ bottom = b.getBoundingClientRect().bottom; }
      else {
        // Where its letters end: the last line of a wrapped image's group reaches down to the image's
        // bottom (it clears it, style.css data-group-end), but only its lines count.
        bottom = b.getBoundingClientRect().top + lineH(b);
        var rg = document.createRange();
        rg.selectNodeContents(b);
        Array.prototype.forEach.call(rg.getClientRects(), function(q){ if(q.height){ bottom = Math.max(bottom, q.bottom); } });
      }
      if(y < bottom + 2) return false;   // on its last line: the browser puts the caret there
      // While lines are added, the line that ended the group must not clear the image (markWraps marks the new end).
      b.removeAttribute("data-group-end");
      var ref = b.nextSibling, line = null;
      for(var i = 0; i < 400; i++){
        line = para();
        line.setAttribute("data-pad", "");
        root.insertBefore(line, ref);
        if(line.getBoundingClientRect().top + lineH(line) >= y) break;
      }
      deselect();
      markWraps();
      updateEmpty();
      root.focus({ preventScroll: true });
      placeCaret(line, false);
      return true;
    }
    // Written in: the lines down to the one written in stay; those below it (a click on an upper one of them) go.
    function keepPads(){
      if(!root.querySelector("p[data-pad]")) return;
      var sel = window.getSelection();
      var at = sel && sel.rangeCount ? topBlock(sel.getRangeAt(0).startContainer) : null;
      var below = false;
      Array.prototype.slice.call(root.children).forEach(function(n){
        if(n === at){ below = true; }
        if(!n.hasAttribute("data-pad")) return;
        if(below && n !== at && isPad(n)){ n.remove(); } else { n.removeAttribute("data-pad"); }
      });
    }
    function dropPads(){
      var pads = root.querySelectorAll("p[data-pad]");
      if(!pads.length) return;
      Array.prototype.forEach.call(pads, function(p){ if(isPad(p)){ p.remove(); } else { p.removeAttribute("data-pad"); } });
      markWraps();
      updateEmpty();
    }
    // Left without writing: the caret went to another line (a click, the arrow keys).
    document.addEventListener("selectionchange", function(){
      if(!root.isConnected || document.activeElement !== root || !root.querySelector("p[data-pad]")) return;
      var sel = window.getSelection();
      var at = sel && sel.rangeCount ? topBlock(sel.getRangeAt(0).startContainer) : null;
      if(!(at && at.nodeType === 1 && at.hasAttribute("data-pad"))){ dropPads(); }
    });

    setBody(opts.body);
    lastBody = getBody();

    return {
      getBody: getBody,
      undo: undo,
      redo: redo,
      canUndo: function(){ return undoStack.length > 0; },
      canRedo: function(){ return redoStack.length > 0; },
      insertImage: insertImage,
      insertVideo: function(v){ insertVideo(v); },
      splitDuplicates: splitDuplicates,
      removeRef: removeRef,
      refs: refs,
      refreshImages: refreshImages,
      padTo: padTo,
      forEachPiece: forEachPiece,
      pieceCount: function(){ return multi.length; },
      destroy: function(){
        deselect();
        multi = [];
        if(HL){ CSS.highlights.delete("ed-multi"); }
        window.removeEventListener("scroll", placeToolbar, true);
        window.removeEventListener("resize", placeToolbar);
      }
    };
  }

  window.RichEditor = { create: create, DRAG_REF: DRAG_REF };
})();
