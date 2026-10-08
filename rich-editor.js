// The body editor: the text is written straight into a page that looks like
// the finished record, and placed images are shown as they will appear.
// It still reads and writes the same plain body text as before
// (paragraph lines, "# 見出し", "- 箇条書き", **太字**, text size and colour as
// <span style="color:#E53935; font-size:14pt">…</span> (v1.0.49), and image lines such as
// "[画像1 小 左回り込み]"), so older records open unchanged and the viewer,
// print and export code keep working on that text.
//
//   var ed = RichEditor.create(element, {
//     body, escapeHtml, inlineMd,
//     markers: { isLine(line), parse(line) → [{ref,size,align}], text(ref,size,align) },
//     hasRef(ref), imageUrl(ref) → Promise<url|null>, onChange()
//   });
//   ed.getBody(), ed.insertImage(ref), ed.removeRef(ref), ed.refs(), ed.refreshImages()
(function(){
  "use strict";

  var SIZES = ["小", "中", "大"];
  var ALIGNS = ["中央", "左寄せ", "右寄せ", "左回り込み", "右回り込み"];
  // What the buttons say (the owner's wording): where the text goes. The saved words stay the same.
  var ALIGN_LABEL = { "左回り込み": "右文章", "右回り込み": "左文章" };
  var ALIGN_TITLE = {
    "左回り込み": "画像を左に置き、あとの文章を右側に流します",
    "右回り込み": "画像を右に置き、あとの文章を左側に流します"
  };
  var SIZE_CLASS = { "大":"l", "中":"m", "小":"s" };
  var ALIGN_CLASS = { "左寄せ":"al-l", "右寄せ":"al-r", "左回り込み":"float fl-l", "右回り込み":"float fl-r" };
  var DRAG_ROW = "application/x-nisshi-row";
  var DRAG_REF = "application/x-nisshi-ref";

  function create(root, opts){
    var M = opts.markers;
    root.classList.add("rich-editor", "view-body");
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
    function loadImage(fig){
      var img = fig.querySelector("img");
      opts.imageUrl(Number(fig.getAttribute("data-ref"))).then(function(url){
        if(url){ img.src = url; } else { fig.classList.add("missing"); }
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
      String(text || "").split("\n").forEach(function(line){
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
        root.appendChild(para(line.trim() ? opts.inlineMd(opts.escapeHtml(line)) : ""));
      });
      ensureEnds();
      updateEmpty();
    }
    // Keeps an editable line before the first and after the last image, so the caret can go there.
    function ensureEnds(){
      if(!root.firstChild){ root.appendChild(para()); }
      if(isRow(root.lastChild)){ root.appendChild(para()); }
      if(isRow(root.firstChild)){ root.insertBefore(para(), root.firstChild); }
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
    function changed(){
      updateEmpty();
      if(opts.onChange){ opts.onChange(); }
    }
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
    function refreshImages(){
      Array.prototype.forEach.call(root.querySelectorAll("figure[data-ref]"), loadImage);
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
        '<span class="ed-group">' + SIZES.map(function(s){
          return '<button type="button" data-size="' + s + '" class="' + (item.size === s ? "on" : "") + '">' + s + '</button>';
        }).join("") + '</span>' +
        '<span class="ed-group">' + ALIGNS.map(function(a){
          return '<button type="button" data-align="' + a + '" class="' + (align === a ? "on" : "") + '"' +
                 (ALIGN_TITLE[a] ? ' title="' + ALIGN_TITLE[a] + '"' : '') + '>' + (ALIGN_LABEL[a] || a) + '</button>';
        }).join("") + '</span>' +
        (opts.onShow ? '<span class="ed-group"><button type="button" data-show="1" title="この画像を大きく表示（広い画面では右側）">🔍 大きく表示</button></span>' : '') +
        '<span class="ed-group">' +
          '<button type="button" data-move="-1" title="上へ移動">↑</button>' +
          '<button type="button" data-move="1" title="下へ移動">↓</button>' +
          '<button type="button" data-remove="1" title="本文から外す（添付は残ります）">本文から外す</button>' +
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
      if(b.hasAttribute("data-size")){
        items[idx].size = b.getAttribute("data-size");
        // A wrapped row is one width: its size is the row's.
        if(/float/.test(row.className)){ items.forEach(function(it){ it.size = items[idx].size; }); }
      } else if(b.hasAttribute("data-align")){
        var a = b.getAttribute("data-align");
        items.forEach(function(it){ it.align = a === "中央" ? "" : a; });
      } else if(b.hasAttribute("data-move")){
        var up = b.getAttribute("data-move") === "-1";
        var sib = up ? row.previousSibling : row.nextSibling;
        if(!sib) return;
        if(up){ root.insertBefore(row, sib); } else { root.insertBefore(row, sib.nextSibling); }
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
      select(nr, nr.querySelectorAll("figure[data-ref]")[idx]);
      changed();
    }

    root.addEventListener("mousedown", function(e){
      var row = e.target.closest && e.target.closest(".ed-row");
      if(row && root.contains(row)){
        select(row, e.target.closest("figure"));
      } else {
        deselect();
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
      if(e.key === "Escape"){ deselect(); }
    });

    /* ---------- typing, pasting, dragging ---------- */
    root.addEventListener("input", function(){
      if(!root.firstChild){ root.appendChild(para()); }
      changed();
    });
    root.addEventListener("paste", function(e){
      var cd = e.clipboardData;
      if(!cd || (cd.files && cd.files.length)) return;   // pictures: the page attaches them
      var text = cd.getData("text/plain");
      e.preventDefault();
      if(text){ document.execCommand("insertText", false, text); }
    });
    // Bold / italic from the keyboard are kept; anything else is plain text.
    root.addEventListener("keydown", function(e){
      if((e.ctrlKey || e.metaKey) && /^[uU]$/.test(e.key)){ e.preventDefault(); }
    });

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
    root.addEventListener("dragend", function(){ dragRow = null; });
    root.addEventListener("dragover", function(e){
      var types = Array.prototype.slice.call(e.dataTransfer.types || []);
      if(types.indexOf(DRAG_ROW) >= 0 || types.indexOf(DRAG_REF) >= 0){
        e.preventDefault();
        e.dataTransfer.dropEffect = types.indexOf(DRAG_ROW) >= 0 ? "move" : "copy";
      }
    });
    root.addEventListener("drop", function(e){
      var types = Array.prototype.slice.call(e.dataTransfer.types || []);
      var range = rangeAtPoint(e.clientX, e.clientY);
      if(types.indexOf(DRAG_ROW) >= 0 && dragRow){
        e.preventDefault();
        var row = dragRow;
        dragRow = null;
        if(range && row.contains(range.startContainer)) return;
        row.remove();
        insertRowAt(range, row);
        changed();
        return;
      }
      if(types.indexOf(DRAG_REF) >= 0){
        e.preventDefault();
        var ref = Number(e.dataTransfer.getData(DRAG_REF));
        if(ref){
          deselect();
          insertRowAt(range, buildRow([{ ref: ref, size: "中", align: "" }]));
          changed();
        }
      }
    });

    setBody(opts.body);

    return {
      getBody: getBody,
      insertImage: insertImage,
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
