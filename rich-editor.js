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
//   ed.undo(), ed.redo(), ed.canUndo(), ed.canRedo()   (v1.0.78; onHistory() tells when these change)
(function(){
  "use strict";

  var SIZES = ["小", "中", "大"];
  var ALIGNS = ["中央", "左寄せ", "右寄せ", "左回り込み", "右回り込み"];
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
      var img = fig.querySelector("img");
      opts.imageUrl(Number(fig.getAttribute("data-ref"))).then(function(url){
        if(url){ img.src = url; fig.classList.remove("missing"); } else { fig.classList.add("missing"); }
      }, function(){ fig.classList.add("missing"); });
    }
    function rowText(row){
      return itemsOf(row).map(function(it){ return M.text(it.ref, it.size, it.align); }).join("");
    }
    function isRow(node){ return node && node.nodeType === 1 && node.classList.contains("ed-row"); }

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
    // Keeps an editable line before the first and after the last image, so the caret can go there.
    function ensureEnds(){
      if(!root.firstChild){ root.appendChild(para()); }
      if(isRow(root.lastChild)){ root.appendChild(para()); }
      if(isRow(root.firstChild)){ root.insertBefore(para(), root.firstChild); }
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
        if(isAuto(node) || isGap(node)){ return; }   // empty lines the editor added (ensureWrapLines, openLine)
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
    root.addEventListener("compositionstart", function(){ composing = true; });
    root.addEventListener("compositionend", function(){ composing = false; changed(true); });
    // typing: from typing (a run of keys within a second is one step to undo); otherwise (images, Delete
    // of a line, a drop…) each change is a step of its own.
    function changed(typing){
      if(!composing){
        ensureWrapLines(false);
        markWraps();
        record(typing === true);
      }
      updateEmpty();
      if(opts.onChange){ opts.onChange(); }
    }

    /* ---------- 戻す・やり直す (v1.0.78) ---------- */
    // The body text (getBody) before each change is kept, so 戻す can go back step by step through typing,
    // placing, moving and removing images, even after a layout went wrong. Up to 200 steps, while the editor is open.
    var undoStack = [], redoStack = [], lastBody = null, lastTyped = 0, wasTyping = false;
    function record(typing){
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
      // Split the line: what follows the caret moves to a new line after the image.
      var tail = document.createRange();
      tail.setStart(range.startContainer, range.startOffset);
      tail.setEnd(block, block.childNodes.length);
      var frag = tail.extractContents();
      var rest = document.createElement(block.tagName === "P" || block.tagName === "DIV" ? "p" : block.tagName.toLowerCase());
      rest.appendChild(frag);
      if(!rest.textContent.trim() && !rest.querySelector("img")){ rest.innerHTML = "<br>"; }
      var emptyBefore = !block.textContent.trim();
      if(emptyBefore){ block.innerHTML = "<br>"; }
      root.insertBefore(row, block.nextSibling);
      root.insertBefore(rest, row.nextSibling);
      // An empty line left above the image by the split is not kept (unless it was there already on its own).
      if(emptyBefore && range.startOffset === 0 && block.previousSibling && !isRow(block.previousSibling)){ block.remove(); }
      ensureEnds();
      placeCaret(rest, false);
    }

    // 「本文へ」: at the caret, or beside the chosen image when one is chosen.
    function insertImage(ref){
      if(selected && selected.isConnected){
        var items = itemsOf(selected).concat([{ ref: ref, size: "中", align: "" }]);
        var row = buildRow(items);
        selected.replaceWith(row);
        select(row);
      } else {
        insertRowAt(lastRange, buildRow([{ ref: ref, size: "中", align: "" }]));
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
      if(to){ placeCaret(to, !back); }
      changed();
    });

    /* ---------- typing, pasting, dragging ---------- */
    root.addEventListener("input", function(e){
      if(!root.firstChild){ root.appendChild(para()); }
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
      e.dataTransfer.setData(DRAG_ROW, "1");
      e.dataTransfer.effectAllowed = "move";
      deselect();
    });
    // Dropped on another placed image (v1.0.104): a placed image swaps places with it (the text beside
    // each stays where it is); an attached image from the list takes its place.
    var dropMark = null;
    function markDrop(row){
      if(dropMark === row) return;
      if(dropMark){ dropMark.classList.remove("drop-swap"); }
      dropMark = row;
      if(dropMark){ dropMark.classList.add("drop-swap"); }
    }
    function rowUnder(e){
      var r = e.target.closest && e.target.closest(".ed-row");
      return r && root.contains(r) ? r : null;
    }
    root.addEventListener("dragend", function(){ dragRow = null; markDrop(null); });
    document.addEventListener("dragend", function(){ markDrop(null); });   // a drag from the image list, given up
    root.addEventListener("dragleave", function(e){ if(!root.contains(e.relatedTarget)){ markDrop(null); } });
    root.addEventListener("dragover", function(e){
      var types = Array.prototype.slice.call(e.dataTransfer.types || []);
      if(types.indexOf(DRAG_ROW) >= 0 || types.indexOf(DRAG_REF) >= 0){
        e.preventDefault();
        e.dataTransfer.dropEffect = types.indexOf(DRAG_ROW) >= 0 ? "move" : "copy";
        var over = rowUnder(e);
        markDrop(over && over !== dragRow ? over : null);
      }
    });
    root.addEventListener("drop", function(e){
      var types = Array.prototype.slice.call(e.dataTransfer.types || []);
      var range = rangeAtPoint(e.clientX, e.clientY);
      var overRow = rowUnder(e);
      markDrop(null);
      if(types.indexOf(DRAG_ROW) >= 0 && dragRow){
        e.preventDefault();
        var row = dragRow;
        dragRow = null;
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
        row.remove();
        insertRowAt(range, row);
        changed();
        return;
      }
      if(types.indexOf(DRAG_REF) >= 0){
        e.preventDefault();
        var ref = Number(e.dataTransfer.getData(DRAG_REF));
        if(ref && overRow){
          var dropFig = e.target.closest("figure[data-ref]") || overRow.querySelector("figure[data-ref]");
          if(!dropFig || Number(dropFig.getAttribute("data-ref")) === ref) return;   // onto itself: nothing to do
          place(ref, function(r){ replaceFigure(dropFig, r); });
          return;
        }
        if(ref){
          deselect();
          place(ref, function(r){
            insertRowAt(range, buildRow([{ ref: r, size: "中", align: "" }]));
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
        var blank = isBlank(n) && !n.hasAttribute("data-auto") && !n.hasAttribute("data-gap") && i > first && i < last;
        if(n.hasAttribute("data-blank") !== blank){ n.toggleAttribute("data-blank", blank); }
      });
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
    }
    if(window.ResizeObserver){ new ResizeObserver(scheduleWraps).observe(root); }
    root.addEventListener("load", scheduleWraps, true);   // an image finished loading

    setBody(opts.body);
    lastBody = getBody();

    return {
      getBody: getBody,
      undo: undo,
      redo: redo,
      canUndo: function(){ return undoStack.length > 0; },
      canRedo: function(){ return redoStack.length > 0; },
      insertImage: insertImage,
      splitDuplicates: splitDuplicates,
      removeRef: removeRef,
      refs: refs,
      refreshImages: refreshImages,
      destroy: function(){
        deselect();
        window.removeEventListener("scroll", placeToolbar, true);
        window.removeEventListener("resize", placeToolbar);
      }
    };
  }

  window.RichEditor = { create: create, DRAG_REF: DRAG_REF };
})();
