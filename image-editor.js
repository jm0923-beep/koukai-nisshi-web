// Image annotation editor: crop, text, line, arrow, rectangle, ellipse,
// freehand pen and click-by-click polyline, with colour / thickness / font-size
// choices and undo. Shift constrains rect/ellipse to squares/circles and
// lines to 45-degree steps. An ellipse is dragged out from its centre (v1.0.39).
// The 選択・移動 tool picks a drawn shape to drag, nudge with the arrow keys,
// recolour, change the line or text size of, delete, or copy and paste (v1.0.41).
// Dotted guide lines follow the pointer across the whole picture (v1.0.42), to read off
// where it is against a chart's time and price axes; 補助線 turns them off.
// A picked shape has handles to resize it (v1.0.45); see resizeShape.
// v1.0.47: a click on a drawn shape picks it with any tool (a drag still draws over it; v1.0.48
// also with 文字 and 折れ線, and a shape under the pointer gets a faint frame and a hand), and
// text can wrap: Enter starts a new line, and text given a width (drag a box with 文字, or
// the left/right handles of picked text) wraps inside it ("wrap", in picture pixels).
// v1.0.49: Ctrl+click picks several shapes, to move, recolour, delete or copy them together.
// v1.0.51: double-clicking drawn text opens it for rewriting, keeping its colour, size and place.
// v1.0.56: 点 places filled dots (size from a list of numbers, like font sizes), and 塗りつぶし fills □ ○.
// v1.0.65: with 点 a click places a dot on top of other shapes too; it picks only a dot right under it (pickAt).
// A press on a picked shape moves it even where another shape's edge is near, e.g. a pasted copy (pressAt).
// v1.0.72: every drawing tool draws on top of other shapes (a 丸 no longer gets picked when a 折れ線 starts on it).
// Only 選択・移動 picks any shape with a click; 点 still picks a dot and 文字 a text right under it (pickAt).
// Double-clicking drawn text still rewrites it with any tool. 黄 became オレンジ (#FB8C00).
// v1.0.73: only white text has an outline (outlined); a line thickness 最細 (xxs) below 極細.
// v1.0.74: the thickness is a slider (0.4〜16) instead of named steps, and sets the thickness of text too.
// v1.0.75: the dot size is a slider too (2〜100, whole numbers) instead of a list.
// v1.0.76: a size set on picked dots carries on to the next dots. v1.0.77: a dot just placed is picked at once (isAutoPick).
// v1.0.79: so are shapes and text just drawn; Enter or a click lets go of it (the click no longer places the next dot).
// v1.0.80: pen strokes too; a picked line has a frame; every tool picks a shape by a click on it; a box dragged
//          with 選択・移動 picks the shapes inside; Ctrl+A picks all.
// v1.0.81: drawing tools draw on top of shapes again (a dot on a line); a right-click picks with any tool.
// v1.0.82: a click with a drawing tool always draws (it lets go of the picked shapes at the same time).
// v1.0.88: letters chosen in the text box take a colour of their own (runs); with none chosen, the whole text changes.
// v1.0.89: 文字の縁 turns an edge round text on or off, with its colour (the same six) and how strong it is (edge).
// v1.0.95: ✖ (cross) draws the two diagonals of a dragged box, like 四角 without its sides.
// v1.0.96: what is set on the thing just drawn carries on to the next ones again (isAutoPick).
// v1.0.110: ⇔ 両矢印 puts a head at the start of an arrow too (both), and 下線 underlines text (underline).
// v1.0.120: 重なり順 (最前面へ・前面へ・背面へ・最背面へ) in the bar and in a right-click menu reorders the picked
//           shapes. The order of shapes is the order they are painted in, so it is kept with the drawing.
// v1.0.137: ⛓ 一体化 (Ctrl+G) makes the picked shapes one (group): a click on any of them picks them all, so they
//           move, recolour, copy and delete together; 一体化を解除 (Ctrl+Shift+G) parts them again. ペンの矢印
//           (なし・片側・両側) puts a head at the end of a pen stroke, or at both ends (head).
// v1.0.139: 矢印 ← 始点 / 終点 → puts a head on or off at each end of a pen stroke or an arrow, whichever way it was
//           drawn (headsOf / setHeads). It replaces ⇔ 両矢印 and ペンの矢印 (なし・片側・両側).
// v1.0.140: the same for 折れ線 (head, as for pen strokes), except a closed one, which has no ends.
//
// Annotations are kept as data, not burned into the original:
//   crop   { x, y, w, h }                  in original-image pixels
//   shapes [{ type, color, size, ... }]    in original-image pixels
//     size: line width in units of longest side/1000 (v1.0.74); before, a name (xxs〜l, see LINE)
//     text: fontSize (units of longest side/1000); older data has only size;
//           wrap (optional, v1.0.47): width to wrap at, in original-image pixels
//           thick (optional, v1.0.74): thickness from the slider (textThick); no size
//           runs (optional, v1.0.88): [[start, end, colour], ...] letters in another colour than color
//           edge (optional, v1.0.89): false, or { color, alpha } for an edge round the letters; without it, white letters get a dark edge
//           bold (optional, v1.0.86 only): true bold / false regular; without it, as thick says (the 太字 button was removed in v1.0.87)
//           underline (optional, v1.0.110): true for a line under the letters (the 下線 button)
//     arrow: a head at the end (x2, y2); both (optional, v1.0.110): true for a head at the start (x1, y1) too;
//            head (optional, v1.0.139): "start" for a head at the start only, "none" for no head (older versions draw the end's)
//     pen: points [[x,y]...]; head (optional, v1.0.137): "end" for a head where the stroke was let go, "both" for one at the start too,
//          "start" (v1.0.139) for one at the start only (older versions draw it at the end)
//     poly: points [[x,y]...], closed; head (optional, v1.0.140): as for pen, never on a closed one (older versions draw no head)
//     cross (v1.0.95): x1, y1, x2, y2 like rect, no fill
//     rect / ellipse: fill (optional, v1.0.56): the inside is painted in the line's colour
//     dot (v1.0.56): x, y (centre), dotSize (diameter, same unit as fontSize); no size (thickness)
//     any shape: group (optional, v1.0.137): a number shared by the shapes made one with 一体化
// so an edit can be reopened later on top of the untouched original.
//
// window.ImageEditor.open({ url, crop, shapes, separateWindow, onApply }) resolves with
//   null                                  when cancelled / nothing changed
//   { empty:true }                        when everything was cleared (back to the original)
//   { empty:false, crop, shapes, blob }   with the rendered PNG otherwise
//
// separateWindow (Windows app, v1.0.36): the editor opens in its own window, which can be
// moved to another display while the record is edited in the main window. Only one such
// window at a time; opening another just brings it to the front (and resolves null).
// The main process places it (last position, if still on a screen) and remembers where it was.
//
// onApply (with separateWindow, v1.0.37): 「書き込みを反映」 hands the same result object to
// onApply (which returns a promise) and the window stays open for more work; only ✕ 閉じる
// closes it, and open() then resolves null. Each later 反映 again sends the whole drawing.
(function(){
  "use strict";

  var COLORS = [
    { v:"#E53935", n:"赤" }, { v:"#FB8C00", n:"オレンジ" }, { v:"#1E88E5", n:"青" },
    { v:"#43A047", n:"緑" }, { v:"#FFFFFF", n:"白" }, { v:"#111111", n:"黒" }
  ];
  var TOOLS = [
    ["move","✥","選択・移動"], ["pen","✎","ペン"], ["poly","⋀","折れ線"], ["line","／","直線"], ["arrow","→","矢印"], ["rect","□","四角"],
    ["ellipse","○","丸"], ["cross","✖","バツ"], ["dot","●","点"], ["text","A","文字"], ["crop","⌗","トリミング"]
  ];
  // Drawn one at a time unless started with Shift: the tool then goes back to 選択・移動 (v1.0.83 for the shapes,
  // v1.0.84 also ペン and 点; 折れ線 and 文字 do the same in finishPoly and commitText).
  var SHAPE_TOOLS = ["pen", "line", "arrow", "rect", "ellipse", "cross", "dot"];
  // 重なり順 (v1.0.120): [how, mark, name, title]. The shortcuts are the ones common drawing programs use.
  var ORDERS = [
    ["front", "⇈", "最前面へ", "選んだ書き込みをいちばん上に重ねる（Ctrl+Shift+]）"],
    ["forward", "↑", "前面へ", "選んだ書き込みを、上に重なっている書き込みの1つ上へ（Ctrl+]）"],
    ["backward", "↓", "背面へ", "選んだ書き込みを、下に重なっている書き込みの1つ下へ（Ctrl+[）"],
    ["back", "⇊", "最背面へ", "選んだ書き込みをいちばん下に置く（Ctrl+Shift+[）"]
  ];
  // 矢印 (v1.0.139): [end (0 start, 1 end), button, title]. Each end is switched on and off by itself.
  var HEAD_ENDS = [
    [0, "← 始点", "ペンの線・折れ線・矢印の描き始めの端に矢印を付ける・外す（選んだものにも使えます。閉じた折れ線には付きません）"],
    [1, "終点 →", "ペンの線・折れ線・矢印の描き終わりの端に矢印を付ける・外す（選んだものにも使えます。閉じた折れ線には付きません）"]
  ];
  // The heads of a pen stroke, a polyline or an arrow as [at the start, at the end], and setting them (see the data notes above).
  function headsOf(s){
    if(s.type === "arrow"){ return s.both ? [true, true] : s.head === "start" ? [true, false] : s.head === "none" ? [false, false] : [false, true]; }
    return [s.head === "start" || s.head === "both", s.head === "end" || s.head === "both"];
  }
  function setHeads(s, h){
    delete s.head; delete s.both;
    if(s.type === "arrow"){
      if(h[0] && h[1]){ s.both = true; } else if(h[0]){ s.head = "start"; } else if(!h[1]){ s.head = "none"; }
    } else {
      var v = h[0] && h[1] ? "both" : h[0] ? "start" : h[1] ? "end" : "";
      if(v){ s.head = v; }
    }
  }
  function hasHeads(s){ return s.type === "pen" || s.type === "arrow" || (s.type === "poly" && !s.closed); }
  // Line thickness (v1.0.74): a number, the line width in units of longest side/1000, chosen with a slider.
  // Shapes saved before have a name instead (最細 xxs, v1.0.73, 〜 太 l), read through LINE.
  var LINE = { xxs:0.75, xs:1.5, s:3, m:6, l:10 };
  var WIDTH_MIN = 0.4, WIDTH_MAX = 16, WIDTH_DEFAULT = 1.5, WIDTH_KEY = "imged-line-width";
  function lineW(v){ return typeof v === "number" ? v : (LINE[v] || LINE.m); }   // v: a shape's size
  // The slider (0〜100) moves in even ratios, so the thin end has as much room as the thick end.
  function widthToPos(w){ return Math.round(100 * Math.log(w / WIDTH_MIN) / Math.log(WIDTH_MAX / WIDTH_MIN)); }
  function posToWidth(p){ return Math.round(WIDTH_MIN * Math.pow(WIDTH_MAX / WIDTH_MIN, p / 100) * 100) / 100; }
  function widthLabel(w){ return w < 10 ? w.toFixed(1) : String(Math.round(w)); }
  function savedWidth(){
    try {
      var v = Number(window.localStorage.getItem(WIDTH_KEY));
      return v >= WIDTH_MIN && v <= WIDTH_MAX ? v : WIDTH_DEFAULT;
    } catch(e){ return WIDTH_DEFAULT; }
  }
  function rememberWidth(v){ try { window.localStorage.setItem(WIDTH_KEY, String(v)); } catch(e){} }
  // Text thickness (v1.0.74) follows the same slider ("thick"; text without it looks as at 1.5, the default):
  // at 1.5 the bold font as before, below 1.2 the regular font, and thicker than 1.5 the bold font with a line
  // of its own colour around the letters, growing with the font size.
  function textThick(s){ return typeof s.thick === "number" ? s.thick : WIDTH_DEFAULT; }
  function textWeightFor(thick){ return thick < 1.2 ? "normal" : "bold"; }
  // Text saved by v1.0.86 may have "bold" (its 太字 button, removed in v1.0.87): that decides its weight.
  // Other text follows its thickness, which the 太さ slider sets.
  function textWeight(s){ return typeof s.bold === "boolean" ? (s.bold ? "bold" : "normal") : textWeightFor(textThick(s)); }
  function textExtra(s, fs){ var k = textThick(s) / WIDTH_DEFAULT; return k > 1 ? fs * 0.02 * (k - 1) : 0; }
  var FONT = { s:28, m:44, l:64 };   // fallback for text saved before fontSize existed
  // Font sizes as numbers (v1.0.40), in the same unit as before: longest side / 1000, so on a
  // picture shown about 1000 pixels wide the number is roughly the letter height in pixels.
  // Includes every value the old named list (極小〜超特大) could save.
  // Since v1.0.132 the list shows points of the printed record instead (the body is 10.5pt), for the
  // picture placed 「大」 (the full A4 text width, 180mm, at most 240mm tall), whatever its pixel size:
  // runEditor's fontPt / fontUnit convert. Saved text still keeps fontSize in the unit above.
  // A blank (白紙, v1.0.133, opts.mmPerPx) is shown at its own printed size wherever it is placed, so its
  // points are the real ones.
  var FONT_PTS = [6, 7, 8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 22, 24, 28, 32, 36, 40, 48, 56, 64, 72];
  var FONT_PT_DEFAULT = 10.5;
  var PAPER_W_MM = 180, PAPER_H_MM = 240, PT_MM = 25.4 / 72;
  var BODY_FAMILY = '"Yu Gothic UI","Yu Gothic",Meiryo,sans-serif';   // the record's body text (style.css, PRINT_CSS)
  // The last size chosen (in points), used as the next default.
  var FONT_KEY = "imged-font-pt";
  function savedFontPt(){
    try {
      var v = Number(window.localStorage.getItem(FONT_KEY));
      return FONT_PTS.indexOf(v) >= 0 ? v : FONT_PT_DEFAULT;
    } catch(e){ return FONT_PT_DEFAULT; }
  }
  function rememberFontPt(v){ try { window.localStorage.setItem(FONT_KEY, String(v)); } catch(e){} }
  // Dots (v1.0.56): filled circles. Their size is the diameter in the same unit as font sizes, a whole
  // number; the last one chosen is the next default. Chosen with a slider since v1.0.75 (before, a list
  // of 4〜64), moving in even ratios like the 太さ slider.
  var DOT_MIN = 2, DOT_MAX = 100, DOT_DEFAULT = 12, DOT_KEY = "imged-dot-size";
  function dotToPos(v){ return Math.round(100 * Math.log(Math.min(Math.max(v, DOT_MIN), DOT_MAX) / DOT_MIN) / Math.log(DOT_MAX / DOT_MIN)); }
  function posToDot(p){ return Math.round(DOT_MIN * Math.pow(DOT_MAX / DOT_MIN, p / 100)); }
  function savedDotSize(){
    try {
      var v = Number(window.localStorage.getItem(DOT_KEY));
      return v >= DOT_MIN && v <= DOT_MAX && v === Math.round(v) ? v : DOT_DEFAULT;
    } catch(e){ return DOT_DEFAULT; }
  }
  function rememberDotSize(v){ try { window.localStorage.setItem(DOT_KEY, String(v)); } catch(e){} }
  // Shapes whose size is a number (font size or dot size) and that have no line thickness.
  var noLine = function(s){ return s.type === "text" || s.type === "dot"; };
  var dotR = function(s, u){ return (s.dotSize || DOT_DEFAULT) * u / 2; };
  var GUIDE_KEY = "imged-guides";   // "off" when the pointer guide lines are turned off
  function guidesOn(){ try { return window.localStorage.getItem(GUIDE_KEY) !== "off"; } catch(e){ return true; } }
  function rememberGuides(on){ try { window.localStorage.setItem(GUIDE_KEY, on ? "on" : "off"); } catch(e){} }
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
  // Only white text gets an outline (dark), to stand out on light pictures; other colours are drawn
  // in their own colour alone (v1.0.73; before, each colour had a white or dark outline).
  // c: a colour (v1.0.88, since letters of one text can have different colours).
  function outlined(c){ return String(c).toUpperCase() === "#FFFFFF"; }
  // The edge around text (v1.0.89): s.edge is false (none) or { color, alpha } (one of COLORS, 0.1〜1).
  // Text saved before has no edge and keeps the old rule: white letters get a dark edge.
  var EDGE_KEY = "imged-text-edge", EDGE_ALPHA_MIN = 0.1;
  var EDGE_DEFAULT = { on:false, color:"#111111", alpha:0.85 };
  function savedEdge(){
    try {
      var v = JSON.parse(window.localStorage.getItem(EDGE_KEY));
      if(v && typeof v.on === "boolean" && /^#[0-9A-F]{6}$/i.test(v.color) && v.alpha >= EDGE_ALPHA_MIN && v.alpha <= 1) return v;
    } catch(e){}
    return Object.assign({}, EDGE_DEFAULT);
  }
  function rememberEdge(v){ try { window.localStorage.setItem(EDGE_KEY, JSON.stringify(v)); } catch(e){} }
  // The edge setting { on, color, alpha } a text's edge stands for (old text: as its old rule draws it).
  function edgeSetting(edge, base){
    if(edge === undefined) return outlined(base) ? { on:true, color:"#111111", alpha:0.85 } : { on:false, color:null, alpha:null };
    return edge ? { on:true, color:edge.color, alpha:edge.alpha } : { on:false, color:null, alpha:null };
  }
  // The colour of the edge around letters of colour c, or null for none.
  function edgeColor(edge, c){
    if(edge === undefined) return outlined(c) ? "rgba(0,0,0,0.85)" : null;
    if(!edge) return null;
    var n = parseInt(edge.color.slice(1), 16);
    return "rgba(" + (n >> 16) + "," + ((n >> 8) & 255) + "," + (n & 255) + "," + edge.alpha + ")";
  }
  function edgeValue(x){ return x.on ? { color:x.color, alpha:x.alpha } : false; }
  function edgeWidth(s, fs){ return Math.max(fs / 7, 1) + textExtra(s, fs); }
  // Letters of a text in another colour (v1.0.88): s.runs [[start, end, colour], ...], indices into s.text
  // as in JavaScript strings; the other letters are in s.color. cols: a colour (or null) for each index.
  function runsToCols(runs, len){
    var cols = [];
    for(var k = 0; k < len; k++){ cols.push(null); }
    (runs || []).forEach(function(r){ for(var k = r[0]; k < Math.min(r[1], len); k++){ cols[k] = r[2]; } });
    return cols;
  }
  function colsToRuns(cols, len, base){
    var runs = [], i = 0, j, c;
    while(i < len){
      c = cols[i];
      if(!c || c === base){ i++; continue; }
      for(j = i + 1; j < len && cols[j] === c; j++){}
      runs.push([i, j, c]);
      i = j;
    }
    return runs;
  }
  // The colour of each letter (as Array.from splits the text), or null when the text has one colour.
  function charColors(s){
    if(!s.runs || !s.runs.length) return null;
    var cols = runsToCols(s.runs, String(s.text).length), out = [], at = 0;
    Array.from(String(s.text)).forEach(function(ch){ out.push(cols[at] || s.color); at += ch.length; });
    return out;
  }
  // Moves the end point of a drag shape to p. With Shift, rect/ellipse/cross become
  // square/circle (a cross in a square) and line/arrow snap to 45-degree steps.
  function setEnd(s, p, shift){
    if(s.type === "ellipse"){
      // Dragged from the centre (cx, cy): the pointer sets the radii.
      var rx = Math.abs(p.x - s.cx), ry = Math.abs(p.y - s.cy);
      if(shift){ rx = ry = Math.max(rx, ry); }
      s.x1 = s.cx - rx; s.x2 = s.cx + rx;
      s.y1 = s.cy - ry; s.y2 = s.cy + ry;
      return;
    }
    s.x2 = p.x; s.y2 = p.y;
    if(!shift) return;
    var dx = p.x - s.x1, dy = p.y - s.y1;
    if(s.type === "rect" || s.type === "cross"){
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

  // Selecting and moving (v1.0.39). All in original-image pixels.
  function distSeg(p, a, b){
    var dx = b[0] - a[0], dy = b[1] - a[1];
    var t = dx || dy ? ((p.x - a[0]) * dx + (p.y - a[1]) * dy) / (dx*dx + dy*dy) : 0;
    t = Math.max(0, Math.min(1, t));
    var x = a[0] + t * dx - p.x, y = a[1] + t * dy - p.y;
    return Math.sqrt(x*x + y*y);
  }
  function textFont(s, u){ return (s.fontSize || FONT[s.size]) * u; }
  // The lines text is drawn in: its own line breaks, and with s.wrap, also wherever a line
  // would get wider than that (character by character, which suits Japanese).
  // ctx.font must already be the text's font. starts (optional) gets where each line begins,
  // counted in letters as Array.from splits the text (for charColors).
  function textLines(ctx, s, starts){
    var paras = String(s.text).split("\n"), out = [], at = 0;
    paras.forEach(function(para){
      var chars = Array.from(para);
      if(!s.wrap){ out.push(para); if(starts){ starts.push(at); } }
      else {
        var line = "", from = at;
        chars.forEach(function(ch, k){
          if(line && ctx.measureText(line + ch).width > s.wrap){ out.push(line); if(starts){ starts.push(from); } line = ch; from = at + k; }
          else { line += ch; }
        });
        out.push(line);
        if(starts){ starts.push(from); }
      }
      at += chars.length + 1;
    });
    return out;
  }
  // A drawn line cut where its colour changes: [{ t, x, c }], x from the line's left end.
  function lineParts(ctx, line, cols, from, base){
    if(!cols) return [{ t:line, x:0, c:base }];
    var chars = Array.from(line), parts = [], i = 0, j;
    while(i < chars.length){
      for(j = i + 1; j < chars.length && cols[from + j] === cols[from + i]; j++){}
      parts.push({ t:chars.slice(i, j).join(""), x:i ? ctx.measureText(chars.slice(0, i).join("")).width : 0, c:cols[from + i] });
      i = j;
    }
    return parts;
  }
  // The box a shape covers, for hit-testing text and drawing the selection frame.
  function shapeBox(ctx, s, u){
    if(s.type === "text"){
      var fs = textFont(s, u), lines, w = 0;
      ctx.save();
      ctx.font = textWeight(s) + " " + fs + "px " + FONT_FAMILY;
      lines = textLines(ctx, s);
      lines.forEach(function(l){ w = Math.max(w, ctx.measureText(l).width); });
      ctx.restore();
      if(s.wrap){ w = s.wrap; }
      return { x:s.x, y:s.y, w:w, h:fs * (1.25 * (lines.length - 1) + 1.1) };
    }
    if(s.type === "dot"){ var dr = dotR(s, u); return { x:s.x - dr, y:s.y - dr, w:dr * 2, h:dr * 2 }; }
    if(s.points){
      var xs = s.points.map(function(q){ return q[0]; }), ys = s.points.map(function(q){ return q[1]; });
      var x0 = Math.min.apply(null, xs), y0 = Math.min.apply(null, ys);
      return { x:x0, y:y0, w:Math.max.apply(null, xs) - x0, h:Math.max.apply(null, ys) - y0 };
    }
    return norm(s);
  }
  // How far p is from the drawn line of a shape (0 inside text).
  function outlineDist(ctx, s, p, u){
    var i, d = Infinity, r;
    switch(s.type){
      case "pen":
      case "poly":
        if(s.points.length === 1) return Math.sqrt(Math.pow(p.x - s.points[0][0], 2) + Math.pow(p.y - s.points[0][1], 2));
        for(i=1;i<s.points.length;i++){ d = Math.min(d, distSeg(p, s.points[i-1], s.points[i])); }
        if(s.closed){ d = Math.min(d, distSeg(p, s.points[s.points.length-1], s.points[0])); }
        return d;
      case "line":
      case "arrow":
        return distSeg(p, [s.x1, s.y1], [s.x2, s.y2]);
      case "rect":
        r = norm(s);
        var c = [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]];
        for(i=0;i<4;i++){ d = Math.min(d, distSeg(p, c[i], c[(i+1)%4])); }
        return d;
      case "cross":
        r = norm(s);
        return Math.min(distSeg(p, [r.x, r.y], [r.x + r.w, r.y + r.h]), distSeg(p, [r.x + r.w, r.y], [r.x, r.y + r.h]));
      case "ellipse":
        r = norm(s);
        var rx = Math.max(r.w/2, 0.5), ry = Math.max(r.h/2, 0.5);
        var ex = (p.x - r.x - rx) / rx, ey = (p.y - r.y - ry) / ry;
        return Math.abs(Math.sqrt(ex*ex + ey*ey) - 1) * Math.min(rx, ry);
      case "text":
        r = shapeBox(ctx, s, u);
        var ox = Math.max(r.x - p.x, 0, p.x - r.x - r.w), oy = Math.max(r.y - p.y, 0, p.y - r.y - r.h);
        return Math.sqrt(ox*ox + oy*oy);
      case "dot":                          // 0 anywhere on the dot
        return Math.max(0, Math.sqrt(Math.pow(p.x - s.x, 2) + Math.pow(p.y - s.y, 2)) - dotR(s, u));
    }
    return Infinity;
  }
  // The topmost shape under p: first by its line (within tol), then the inside of a box or circle.
  function hitShape(ctx, shapes, p, u, tol){
    var i, s;
    for(i=shapes.length-1;i>=0;i--){
      s = shapes[i];
      var w = noLine(s) ? 0 : lineW(s.size) * u / 2;
      if(outlineDist(ctx, s, p, u) <= tol + w) return i;
    }
    for(i=shapes.length-1;i>=0;i--){
      s = shapes[i];
      if(s.type !== "rect" && s.type !== "ellipse") continue;
      var r = norm(s);
      if(p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h) return i;
    }
    return -1;
  }
  function moveShape(s, dx, dy){
    if(s.points){ s.points = s.points.map(function(q){ return [q[0] + dx, q[1] + dy]; }); }
    if(s.type === "text" || s.type === "dot"){ s.x += dx; s.y += dy; }
    if(s.x1 !== undefined){ s.x1 += dx; s.y1 += dy; s.x2 += dx; s.y2 += dy; }
  }
  // Resize handles (v1.0.45): the two ends of a line or arrow, the four corners and the left and
  // right middles of text, and the corners and edge middles of the frame around anything else.
  // [x, y] along the frame.
  var HANDLES = { nw:[0,0], n:[0.5,0], ne:[1,0], e:[1,0.5], se:[1,1], s:[0.5,1], sw:[0,1], w:[0,0.5] };
  var HANDLE_CURSOR = { nw:"nwse-resize", se:"nwse-resize", ne:"nesw-resize", sw:"nesw-resize",
    n:"ns-resize", s:"ns-resize", e:"ew-resize", w:"ew-resize", p1:"crosshair", p2:"crosshair" };
  function handlesFor(ctx, s, u, pad){
    if(s.type === "line" || s.type === "arrow") return [{ id:"p1", x:s.x1, y:s.y1 }, { id:"p2", x:s.x2, y:s.y2 }];
    var b = shapeBox(ctx, s, u);
    // Text: corners and left/right. Dots: corners only (a dot stays round).
    return Object.keys(HANDLES).filter(function(id){ return s.type === "dot" ? id.length === 2 : s.type !== "text" || id.length === 2 || id === "e" || id === "w"; }).map(function(id){
      var f = HANDLES[id];
      return { id:id, x: b.x - pad + f[0] * (b.w + pad*2), y: b.y - pad + f[1] * (b.h + pad*2) };
    });
  }
  // The shape orig resized by dragging handle id by (dx, dy), as a new object.
  //   line / arrow: that end moves (Shift: 45-degree steps).
  //   ellipse: about its centre, so the centre stays where it was put; corners keep the proportions.
  //   rect, cross, pen, polyline: the opposite side stays; corners with Shift keep the proportions.
  //   text: corners change the font size (whole numbers) and the opposite corner stays;
  //         the left and right handles set the width it wraps at (v1.0.47).
  // Line thickness is not scaled.
  function resizeShape(ctx, orig, id, dx, dy, u, shift, minSize){
    var s = JSON.parse(JSON.stringify(orig));
    if(id === "p1" || id === "p2"){
      var k = id === "p1" ? ["x1","y1","x2","y2"] : ["x2","y2","x1","y1"];
      var p = { x: orig[k[0]] + dx, y: orig[k[1]] + dy };
      if(shift){ p = snap45(orig[k[2]], orig[k[3]], p); }
      s[k[0]] = p.x; s[k[1]] = p.y;
      return s;
    }
    var b = shapeBox(ctx, orig, u), f = HANDLES[id];
    if(orig.type === "dot"){
      // A dot grows from its centre: the size (a whole number) follows the corner being dragged.
      var g0 = orig.dotSize || DOT_DEFAULT;
      var grow = ((f[0] === 1 ? dx : -dx) + (f[1] === 1 ? dy : -dy)) / 2;
      s.dotSize = Math.max(1, Math.round(g0 + grow * 2 / u));
      return s;
    }
    if(orig.type === "text" && f[1] === 0.5){
      var ww = Math.max(b.w + (f[0] === 1 ? dx : -dx), textFont(orig, u), minSize);   // at least one letter wide
      s.wrap = ww;
      if(f[0] === 0){ s.x = b.x + b.w - ww; }
      return s;
    }
    var centre = orig.type === "ellipse", twice = centre ? 2 : 1;
    var corner = f[0] !== 0.5 && f[1] !== 0.5;
    var nw = b.w + (f[0] === 0.5 ? 0 : (f[0] === 1 ? dx : -dx) * twice);
    var nh = b.h + (f[1] === 0.5 ? 0 : (f[1] === 1 ? dy : -dy) * twice);
    var sx = b.w > 0 ? Math.max(nw, minSize) / b.w : 1, sy = b.h > 0 ? Math.max(nh, minSize) / b.h : 1;
    if(orig.type === "text"){
      // Text is short and wide: follow both directions together, so a small drag makes a small change.
      sx = sy = Math.max(nw + nh, minSize) / Math.max(b.w + b.h, 1e-6);
    } else if(corner && (shift || centre)){
      var m = Math.abs(sx - 1) > Math.abs(sy - 1) ? sx : sy;
      sx = sy = m;
    }
    var fs1;
    if(orig.type === "text"){
      var fs0 = orig.fontSize || FONT[orig.size];
      fs1 = Math.max(1, Math.round(fs0 * sx));
      sx = sy = fs1 / fs0;
    }
    var ax = centre ? b.x + b.w/2 : (f[0] === 0 ? b.x + b.w : b.x);
    var ay = centre ? b.y + b.h/2 : (f[1] === 0 ? b.y + b.h : b.y);
    function map(x, y){ return [ax + (x - ax) * sx, ay + (y - ay) * sy]; }
    if(s.points){ s.points = s.points.map(function(q){ return map(q[0], q[1]); }); }
    if(s.x1 !== undefined){
      var a1 = map(s.x1, s.y1), a2 = map(s.x2, s.y2);
      s.x1 = a1[0]; s.y1 = a1[1]; s.x2 = a2[0]; s.y2 = a2[1];
    }
    if(s.type === "text"){
      var t = map(s.x, s.y);
      s.x = t[0]; s.y = t[1]; s.fontSize = fs1;
      if(s.wrap){ s.wrap *= sx; }
    }
    return s;
  }
  // Scales positions by k (about the origin). Thickness and font size are relative to the
  // picture already, so a shape pasted into a picture of another size keeps its look.
  function scaleShape(s, k){
    if(s.points){ s.points = s.points.map(function(q){ return [q[0] * k, q[1] * k]; }); }
    if(s.type === "text"){ s.x *= k; s.y *= k; if(s.wrap){ s.wrap *= k; } }
    if(s.type === "dot"){ s.x *= k; s.y *= k; }
    if(s.x1 !== undefined){ s.x1 *= k; s.y1 *= k; s.x2 *= k; s.y2 *= k; }
  }
  // Multiplies what is in units of the picture (thickness, font size, dot size) by f (v1.0.135).
  function scaleSizes(s, f){
    if(s.type === "text"){
      s.fontSize = (s.fontSize || FONT[s.size]) * f;
      s.thick = textThick(s) * f;
    } else if(s.type === "dot"){
      s.dotSize = Math.max(1, Math.round((s.dotSize || DOT_DEFAULT) * f));
    } else {
      s.size = lineW(s.size) * f;
    }
  }

  // Arrow heads: their length for a line of width lw, and a filled head with its tip at (x, y) pointing in direction d.
  function arrowLen(lw, u){ return Math.max(lw * 4, 14 * u); }
  function arrowHead(ctx, x, y, d, len){
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x - len*Math.cos(d - 0.45), y - len*Math.sin(d - 0.45));
    ctx.lineTo(x - len*Math.cos(d + 0.45), y - len*Math.sin(d + 0.45));
    ctx.closePath();
    ctx.fill();
  }
  // The stroke pts cut back by back from its last point: { base, rest } (rest ends at base), or null when it is shorter.
  function cutEnd(pts, back){
    var left = back;
    for(var i = pts.length - 1; i > 0; i--){
      var a = pts[i], b = pts[i-1], seg = Math.sqrt(Math.pow(a[0] - b[0], 2) + Math.pow(a[1] - b[1], 2));
      if(seg > 0 && seg >= left){
        var t = left / seg, base = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
        return { base: base, rest: pts.slice(0, i).concat([base]) };
      }
      left -= seg;
    }
    return null;
  }
  // ペンの矢印 (v1.0.137): the heads of a pen stroke at the ends h says ([at the start, at the end], v1.0.139), as [x, y, direction],
  // and the stroke (pts, or null for none) cut back to their bases, as an arrow's shaft is (back: the head's length along it).
  // Each head points from its base to its tip, so it follows the last stretch of the stroke, not one shaky step of the hand.
  function penHeads(pts, h, back){
    var out = { pts: pts, heads: [] };
    if(!(h[0] || h[1]) || pts.length < 2) return out;
    var tip = pts[pts.length - 1], start = pts[0], rest = pts;
    var along = Math.atan2(tip[1] - start[1], tip[0] - start[0]);
    // Shorter than its heads: the heads alone, along the line from the start to the end.
    function headsOnly(){
      if(tip[0] === start[0] && tip[1] === start[1]) return { pts: pts, heads: [] };
      out.pts = null; out.heads = [];
      if(h[1]){ out.heads.push([tip[0], tip[1], along]); }
      if(h[0]){ out.heads.push([start[0], start[1], along + Math.PI]); }
      return out;
    }
    if(h[1]){
      var c = cutEnd(rest, back);
      if(!c) return headsOnly();
      out.heads.push([tip[0], tip[1], Math.atan2(tip[1] - c.base[1], tip[0] - c.base[0])]);
      rest = c.rest;
    }
    if(h[0]){
      var c2 = cutEnd(rest.slice().reverse(), back);
      if(!c2) return headsOnly();
      out.heads.push([start[0], start[1], Math.atan2(start[1] - c2.base[1], start[0] - c2.base[0])]);
      rest = c2.rest.reverse();
    }
    out.pts = rest;
    return out;
  }

  function drawShape(ctx, s, u){
    ctx.save();
    ctx.strokeStyle = ctx.fillStyle = s.color;
    ctx.lineWidth = lineW(s.size) * u;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    var r;
    switch(s.type){
      case "pen":
      case "poly":
        // ペンの矢印 (v1.0.137): heads at the end (or both ends) of a pen stroke, sized as those of 矢印; a polyline's too (v1.0.140)
        var hlen = arrowLen(ctx.lineWidth, u);
        var ph = hasHeads(s) ? penHeads(s.points, headsOf(s), hlen * Math.cos(0.45)) : { pts: s.points, heads: [] }, pts = ph.pts;
        if(pts){
          ctx.beginPath();
          ctx.moveTo(pts[0][0], pts[0][1]);
          if(pts.length === 1){ ctx.lineTo(pts[0][0] + 0.1, pts[0][1]); }
          for(var i=1;i<pts.length;i++){ ctx.lineTo(pts[i][0], pts[i][1]); }
          if(s.closed){ ctx.closePath(); }
          ctx.stroke();
        }
        ph.heads.forEach(function(h){ arrowHead(ctx, h[0], h[1], h[2], hlen); });
        break;
      case "line":
        ctx.beginPath();
        ctx.moveTo(s.x1, s.y1);
        ctx.lineTo(s.x2, s.y2);
        ctx.stroke();
        break;
      case "arrow":
        var a = Math.atan2(s.y2 - s.y1, s.x2 - s.x1);
        var len = arrowLen(ctx.lineWidth, u);
        // The shaft stops at the base of the head (v1.0.44): drawn to the tip, its round end
        // and its width stuck out past the point and the sides of the triangle on thick arrows.
        // both (v1.0.110): a head at the start too, and the shaft stops at its base as well.
        // Since v1.0.139 each end has a head or not (headsOf); with none it is a plain line.
        var ah = headsOf(s), back = len * Math.cos(0.45), back1 = ah[0] ? back : 0, back2 = ah[1] ? back : 0;
        var total = Math.sqrt(Math.pow(s.x2 - s.x1, 2) + Math.pow(s.y2 - s.y1, 2));
        if(total > back1 + back2 || (!ah[0] && !ah[1])){
          ctx.beginPath();
          ctx.moveTo(s.x1 + back1 * Math.cos(a), s.y1 + back1 * Math.sin(a));
          ctx.lineTo(s.x2 - back2 * Math.cos(a), s.y2 - back2 * Math.sin(a));
          ctx.stroke();
        }
        if(ah[1]){ arrowHead(ctx, s.x2, s.y2, a, len); }
        if(ah[0]){ arrowHead(ctx, s.x1, s.y1, a + Math.PI, len); }
        break;
      // fill (v1.0.56): the inside is painted in the same colour as the line
      case "rect":
        r = norm(s);
        if(s.fill){ ctx.fillRect(r.x, r.y, r.w, r.h); }
        ctx.strokeRect(r.x, r.y, r.w, r.h);
        break;
      case "ellipse":
        r = norm(s);
        ctx.beginPath();
        ctx.ellipse(r.x + r.w/2, r.y + r.h/2, Math.max(r.w/2, 0.5), Math.max(r.h/2, 0.5), 0, 0, Math.PI*2);
        if(s.fill){ ctx.fill(); }
        ctx.stroke();
        break;
      // ✖ (v1.0.95): the two diagonals of the box it was dragged over
      case "cross":
        r = norm(s);
        ctx.beginPath();
        ctx.moveTo(r.x, r.y);
        ctx.lineTo(r.x + r.w, r.y + r.h);
        ctx.moveTo(r.x + r.w, r.y);
        ctx.lineTo(r.x, r.y + r.h);
        ctx.stroke();
        break;
      case "dot":
        ctx.beginPath();
        ctx.arc(s.x, s.y, Math.max(dotR(s, u), 0.5), 0, Math.PI*2);
        ctx.fill();
        break;
      case "text":
        var fs = (s.fontSize || FONT[s.size]) * u;
        ctx.font = textWeight(s) + " " + fs + "px " + FONT_FAMILY;
        ctx.textBaseline = "top";
        var extra = textExtra(s, fs), cols = charColors(s), starts = [];
        textLines(ctx, s, starts).forEach(function(line, idx){
          var y = s.y + idx * fs * 1.25, parts = lineParts(ctx, line, cols, starts[idx], s.color);
          // The dark outline of white text goes outside the thickening line of its own colour.
          // Each layer for the whole line first, so an outline never covers the letters beside it.
          // A chosen edge (v1.0.89) goes round the whole line at once, so a pale one does not get darker where parts meet.
          (s.edge === undefined ? parts : [{ t:line, x:0, c:s.color }]).forEach(function(g){
            var ec = edgeColor(s.edge, g.c);
            if(ec){ ctx.lineWidth = edgeWidth(s, fs); ctx.strokeStyle = ec; ctx.strokeText(g.t, s.x + g.x, y); }
          });
          // 下線 (v1.0.110): under each run in its colour, with the text's edge round it too
          var ul = s.underline && line ? { y:y + fs * 1.0, h:Math.max(fs / 16, u) + extra } : null;
          if(ul){
            var uec = edgeColor(s.edge, s.color);
            if(uec){ ctx.lineWidth = edgeWidth(s, fs); ctx.strokeStyle = uec; ctx.strokeRect(s.x, ul.y, ctx.measureText(line).width, ul.h); }
          }
          if(extra){ parts.forEach(function(g){ ctx.lineWidth = extra; ctx.strokeStyle = g.c; ctx.strokeText(g.t, s.x + g.x, y); }); }
          parts.forEach(function(g){
            ctx.fillStyle = g.c;
            ctx.fillText(g.t, s.x + g.x, y);
            if(ul){ ctx.fillRect(s.x + g.x, ul.y, ctx.measureText(g.t).width, ul.h); }
          });
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

  // 重なり順 (v1.0.120): shapes in their new order after moving the picked ones (how: an ORDERS name).
  // 前面へ / 背面へ take each picked shape past the next shape it overlaps (overlap(a, b)) that way, as
  // common drawing programs do, so every press shows; with none it overlaps, one step. They are moved one
  // at a time, the nearest to the way they go first, and never past another picked shape, so the picked
  // ones keep their order among themselves.
  function reorderShapes(shapes, picked, how, overlap){
    var isP = function(s){ return picked.indexOf(s) >= 0; };
    var mine = shapes.filter(isP), rest = shapes.filter(function(s){ return !isP(s); });
    if(how === "front") return rest.concat(mine);
    if(how === "back") return mine.concat(rest);
    var up = how === "forward", list = shapes.slice();
    (up ? mine.slice().reverse() : mine).forEach(function(s){
      var i = list.indexOf(s), step = up ? 1 : -1, first = -1, to = -1;
      for(var j = i + step; j >= 0 && j < list.length; j += step){
        if(isP(list[j])) break;
        if(first < 0){ first = j; }
        if(overlap(s, list[j])){ to = j; break; }
      }
      if(to < 0){ to = first; }
      if(to < 0) return;
      list.splice(i, 1);
      list.splice(to, 0, s);
    });
    return list;
  }

  // The separate editor window while it is open: { w, cancel }.
  var winState = null;
  // The shape copied with コピー / Ctrl+C. Kept while the app runs, so it can be pasted
  // into another picture too. Each paste lands a little further down and to the right.
  var clip = null, clipPastes = 0;   // clip: { shape (JSON), u (unitFor of its picture) }
  function isOpen(){ return !!(winState && !winState.w.closed); }
  // Something drawn in the separate window since it opened or since the last 反映.
  function hasUnapplied(){ return isOpen() && winState.changed(); }
  // Closes the separate window without applying anything (the open() promise resolves null).
  function closeWindow(){ if(winState){ winState.cancel(); } }

  // 書き込みの画面が開いている間に別の画像の「書き込み」を押したとき (v1.0.104): before, nothing happened.
  // Drawing not yet applied is asked about (保存して次へ / 保存しないで次へ / 戻る), then the same window
  // shows the next picture.
  // opts.key names the picture (its untouched original): the one already open is only brought to the front,
  // since reopening it would start from what the caller had before the drawing now on screen.
  function switchImage(opts){
    var st = winState;
    try { st.w.focus(); } catch(e){}
    if(opts.key && opts.key === st.key) return Promise.resolve(null);
    var answer = st.changed() ? st.ask() : Promise.resolve("discard");
    return answer.then(function(ans){
      if(ans === "stay" || winState !== st) return null;
      return (ans === "apply" ? st.apply() : Promise.resolve()).then(function(){
        if(winState !== st) return null;
        return loadImage(opts.url).then(function(img){
          if(winState !== st) return null;
          var w = st.w;
          st.release();
          return new Promise(function(resolve){
            runEditor(img, opts, resolve, { doc: w.document, win: w, popup: w });
          });
        });
      }, function(){ return null; });   // it could not be applied: stay on this picture
    });
  }

  function open(opts){
    if(opts.separateWindow && isOpen()){ return switchImage(opts); }
    return loadImage(opts.url).then(function(img){
      return new Promise(function(resolve){
        var host = (opts.separateWindow && openHostWindow()) || { doc: document, win: window, popup: null };
        runEditor(img, opts, resolve, host);
      });
    });
  }

  // An empty same-origin window (the main process allows only this name) that the editor
  // is built into from here, with the app's own style sheets.
  function openHostWindow(){
    var w = window.open("", "imged");
    if(!w) return null;
    var d = w.document;
    d.title = "画像への書き込み — 航海日誌";
    d.documentElement.lang = "ja";
    Array.prototype.forEach.call(document.querySelectorAll('link[rel="stylesheet"]'), function(l){
      var c = d.createElement("link");
      c.rel = "stylesheet";
      c.href = l.href;
      d.head.appendChild(c);
    });
    d.body.style.margin = "0";
    d.body.style.background = "#0B101A";
    return { doc: d, win: w, popup: w };
  }

  function runEditor(img, opts, resolve, host){
    var doc = host.doc, hwin = host.win;
    var W = img.naturalWidth, H = img.naturalHeight;
    var full = { x:0, y:0, w:W, h:H };
    var state = {
      crop: opts.crop ? Object.assign({}, opts.crop) : Object.assign({}, full),
      shapes: (opts.shapes || []).map(function(s){ return JSON.parse(JSON.stringify(s)); })
    };
    var initial = JSON.stringify(state);
    var history = [];
    var tool = "pen", color = COLORS[0].v, size = savedWidth(), newPt = savedFontPt();   // size: line width (and text thickness) for new things; newPt: their text size in points
    var dotSize = savedDotSize(), fillMode = false;   // the next dot's size; whether the next □ ○ is filled (v1.0.56)
    var underMode = false;                            // whether the next text has an underline (v1.0.110)
    var nextHeads = { pen: [false, false], poly: [false, false], arrow: [false, true] };   // the heads of the next pen stroke / polyline / arrow, [at the start, at the end] (v1.0.139, poly v1.0.140)
    var current = null;      // shape being drawn
    var keepTool = false;    // Shift was down when the thing being drawn was started: the tool stays for the next one (v1.0.83, all tools v1.0.84)
    var cropDraft = null;    // {x1,y1,x2,y2} while dragging in crop mode
    var textBox = null;
    var poly = null;         // polyline being built click by click
    var polyHover = null;    // where the next segment would go
    var lastClick = null;    // {t, x, y} in screen pixels, to detect a double-click
    var lastRaw = null;      // last pointer position, to re-apply Shift on key press
    var selection = [];      // indexes in state.shapes of the picked shapes (Ctrl+click picks more than one, v1.0.49)
    var dragMove = null;     // { start, idx, orig, moved, handle, clickOn } while dragging the picked shapes (handle: resizing one)
    var lastNudge = 0;       // arrow-key moves within a moment of each other undo together
    var hover = -1;          // the shape under the pointer (gets a faint frame), or -1
    var clickDots = [];      // [{ s, t }]: the last two dots (or pen dabs, v1.0.72) placed by a click and when, so the clicks of a double-click on text can take them back (v1.0.65)
    var widthEdit = false;   // the 太さ slider is being moved over picked shapes (one undo step for the whole move)
    var dotEdit = false;     // the same for the 点の大きさ slider over picked dots
    var edgeEdit = false;    // the same for the 縁の濃さ slider over picked texts
    var nextEdge = savedEdge();   // the edge of the next text { on, color, alpha } (v1.0.89)
    var autoIdx = -1;        // index of the thing just drawn and picked at once (see isAutoPick)
    var polySaved = 0;       // when a polyline was last finished and kept, so its closing double-click does not rewrite text under it
    var textDraft = null;    // { x1, y1, x2, y2, cx, cy } while pressing / dragging with 文字
    var marquee = null;      // { x1, y1, x2, y2 } while dragging a box with 選択・移動 to pick the shapes inside (v1.0.80)
    var menu = null;         // the right-click menu (重なり順, v1.0.120) while it is shown
    var menuArmed = false;   // the right-button press picked a shape: the contextmenu event after it shows the menu
    // Points on the printed record (picture placed 「大」, as cropped now) ⇄ the fontSize unit (v1.0.132).
    function mmPerPx(){
      if(opts.mmPerPx > 0) return opts.mmPerPx;
      var c = state.crop;
      return Math.min(PAPER_W_MM, PAPER_H_MM * c.w / c.h) / c.w;
    }
    // FONT_FAMILY draws its letters larger than the record's body font at the same size (BIZ UDPGothic
    // about 7% taller than Yu Gothic UI), so the size is scaled until a 本 is as tall as in the body.
    var glyphK = (function(){
      try {
        var m = doc.createElement("canvas").getContext("2d");
        function tall(f){ m.font = "100px " + f; var r = m.measureText("本"); return r.actualBoundingBoxAscent + r.actualBoundingBoxDescent; }
        var k = tall(BODY_FAMILY) / tall(FONT_FAMILY);
        return k > 0.8 && k < 1.25 ? k : 1;
      } catch(e){ return 1; }
    })();
    function fontPt(fs){ return Math.round(fs * unitFor(W, H) * mmPerPx() / PT_MM / glyphK * 10) / 10; }
    function fontUnit(pt){ return pt * glyphK * PT_MM / mmPerPx() / unitFor(W, H); }
    function newFont(){ return fontUnit(newPt); }
    var fontTip = opts.mmPerPx > 0 ? "日誌での大きさ（ポイント）。本文は10.5です（白紙はどこに置いてもこの大きさ）"
                                   : "日誌に「大」で置いたときの大きさ（ポイント）。本文は10.5です";

    var root = doc.createElement("div");
    root.className = "imged";
    root.innerHTML =
      '<div class="imged-bar">' +
        '<div class="imged-group">' + TOOLS.map(function(t){
          return '<button type="button" class="imged-tool" data-tool="'+t[0]+'" title="'+t[2]+'"><span>'+esc(t[1])+'</span>'+t[2]+'</button>';
        }).join("") + '</div>' +
        '<div class="imged-group">' + COLORS.map(function(c){
          return '<button type="button" class="imged-color" data-color="'+c.v+'" title="'+c.n+'" style="background:'+c.v+'"></button>';
        }).join("") + '</div>' +
        '<div class="imged-group imged-sizes"><span class="imged-label">太さ</span>' +
          '<input type="range" class="imged-width" min="0" max="100" step="1" title="線と文字の太さ（選んだ書き込みにも使えます）">' +
          '<span class="imged-width-val"></span>' +
          '<button type="button" class="imged-size imged-fill" data-act="fill" title="四角と丸の中を塗りつぶす（選んだ四角・丸にも使えます）">■ 塗りつぶし</button>' +
        '</div>' +
        // 矢印 (v1.0.139): a head at each end of a pen stroke or an arrow, on or off
        '<div class="imged-group imged-heads"><span class="imged-label">矢印</span>' + HEAD_ENDS.map(function(h){
          return '<button type="button" class="imged-size" data-head="'+h[0]+'" title="'+h[2]+'">'+h[1]+'</button>';
        }).join("") + '</div>' +
        '<div class="imged-group imged-fonts"><span class="imged-label" title="' + fontTip + '">文字の大きさ</span>' +
          '<select class="imged-font" title="' + fontTip + '">' + FONT_PTS.map(function(f){
            return '<option value="'+f+'">'+f+'</option>';
          }).join("") + '</select>' +
          '<button type="button" class="imged-size" data-act="underline" title="文字に下線を付ける・外す（選んだ文字にも使えます）"><u>U</u> 下線</button>' +
        '</div>' +
        // 文字の縁 (v1.0.89): on / off, its colour and how strong it is
        '<div class="imged-group imged-edges"><span class="imged-label">文字の縁</span>' +
          '<button type="button" class="imged-size" data-act="edge" title="文字に縁をつける・外す（選んだ文字にも使えます）">縁あり</button>' +
          COLORS.map(function(c){
            return '<button type="button" class="imged-edge-color" data-edge="'+c.v+'" title="縁の色：'+c.n+'" style="background:'+c.v+'"></button>';
          }).join("") +
          '<span class="imged-label">濃さ</span>' +
          '<input type="range" class="imged-width imged-edge-alpha" min="10" max="100" step="5" title="縁の濃さ（選んだ文字にも使えます）">' +
          '<span class="imged-width-val imged-edge-val"></span>' +
        '</div>' +
        '<div class="imged-group imged-dots"><span class="imged-label">点の大きさ</span>' +
          '<input type="range" class="imged-width imged-dot" min="0" max="100" step="1" title="点の大きさ（選んだ点にも使えます）">' +
          '<span class="imged-width-val imged-dot-val"></span>' +
        '</div>' +
        // 重なり順 (v1.0.120): the picked shapes, as in the right-click menu
        '<div class="imged-group imged-orders"><span class="imged-label">重なり順</span>' + ORDERS.map(function(o){
          return '<button type="button" class="imged-size" data-order="'+o[0]+'" title="'+o[3]+'">'+o[1]+' '+o[2]+'</button>';
        }).join("") + '</div>' +
        // 一体化 (v1.0.137): the picked shapes, as in the right-click menu
        '<div class="imged-group imged-groups">' +
          '<button type="button" class="imged-size" data-act="group" title="選んだ2つ以上の書き込みを1つにまとめる。どれかをクリックすると全部が選ばれ、まとめて動きます（Ctrl+G）">⛓ 一体化</button>' +
          '<button type="button" class="imged-size" data-act="ungroup" title="一体化した書き込みを、元のばらばらに戻す（Ctrl+Shift+G）">✂ 一体化を解除</button>' +
        '</div>' +
        '<div class="imged-group">' +
          '<button type="button" class="imged-btn" data-act="undo" title="1つ戻す（Ctrl+Z）">↶ 1つ戻す</button>' +
          '<button type="button" class="imged-btn" data-act="clear">書き込みを全部消す</button>' +
          '<button type="button" class="imged-btn" data-act="uncrop">トリミング解除</button>' +
          '<button type="button" class="imged-btn" data-act="copy" title="選んだ書き込みをコピー（Ctrl+C）">コピー</button>' +
          '<button type="button" class="imged-btn" data-act="paste" title="コピーした書き込みを貼り付け（Ctrl+V）">貼り付け</button>' +
          '<button type="button" class="imged-btn imged-guide-btn" data-act="guides" title="カーソルの位置に縦横の点線を出す">┼ 補助線</button>' +
        '</div>' +
        // Its own way out at the top right, so the window's ✕ (which quits the app) is not the obvious one.
        '<button type="button" class="imged-close" data-act="close">✕ 閉じる</button>' +
      '</div>' +
      '<div class="imged-stage"><canvas></canvas></div>' +
      '<div class="imged-foot">' +
        '<span class="imged-hint"></span>' +
        '<span class="imged-status"></span>' +
        '<button type="button" class="btn btn-ghost btn-small" data-act="reset">元の画像に戻す</button>' +
        '<button type="button" class="btn btn-ghost btn-small" data-act="cancel">キャンセル</button>' +
        '<button type="button" class="btn btn-primary btn-small" data-act="save">書き込みを反映</button>' +
      '</div>';
    doc.body.appendChild(root);
    // 反映 keeps the window open: the footer's キャンセル becomes 閉じる (nothing to cancel once applied).
    var keepOpen = !!(host.popup && opts.onApply);
    var statusEl = root.querySelector(".imged-status");
    var saveBtn = root.querySelector('[data-act="save"]');
    var applying = false;
    if(keepOpen){ root.querySelector('[data-act="cancel"]').textContent = "閉じる"; }

    var stage = root.querySelector(".imged-stage");
    var canvas = root.querySelector("canvas");
    var ctx = canvas.getContext("2d");
    var hint = root.querySelector(".imged-hint");
    var fontSel = root.querySelector(".imged-font");
    var widthSel = root.querySelector(".imged-width"), widthVal = root.querySelector(".imged-width-val");
    var dotSel = root.querySelector(".imged-dot"), dotVal = root.querySelector(".imged-dot-val"), fillBtn = root.querySelector('[data-act="fill"]');
    var underBtn = root.querySelector('[data-act="underline"]');
    var edgeBtn = root.querySelector('[data-act="edge"]'), edgeSel = root.querySelector(".imged-edge-alpha"), edgeVal = root.querySelector(".imged-edge-val");
    var orderBtns = root.querySelectorAll("[data-order]");
    var headBtns = root.querySelectorAll("[data-head]");
    var groupBtn = root.querySelector('[data-act="group"]'), ungroupBtn = root.querySelector('[data-act="ungroup"]');

    // Guide lines: two thin elements over the stage, so following the pointer never repaints the picture.
    var showGuides = guidesOn();
    var guideH = doc.createElement("div"), guideV = doc.createElement("div");
    guideH.className = "imged-guide imged-guide-h";
    guideV.className = "imged-guide imged-guide-v";
    stage.appendChild(guideH);
    stage.appendChild(guideV);
    function hideGuides(){ guideH.style.display = guideV.style.display = "none"; }
    function moveGuides(e){
      var c = canvas.getBoundingClientRect(), st = stage.getBoundingClientRect();
      if(!showGuides || e.clientX < c.left || e.clientX > c.right || e.clientY < c.top || e.clientY > c.bottom){ hideGuides(); return; }
      var x = Math.round(e.clientX - st.left), y = Math.round(e.clientY - st.top);
      guideH.style.left = (c.left - st.left) + "px";
      guideH.style.width = c.width + "px";
      guideH.style.top = y + "px";
      guideV.style.top = (c.top - st.top) + "px";
      guideV.style.height = c.height + "px";
      guideV.style.left = x + "px";
      guideH.style.display = guideV.style.display = "block";
    }
    canvas.addEventListener("pointermove", moveGuides);
    canvas.addEventListener("pointerleave", hideGuides);

    function snapshot(){
      history.push(JSON.stringify(state));
      if(history.length > 100){ history.shift(); }
      statusEl.textContent = "";   // 「反映しました」 no longer describes what is on screen
    }
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
      // Text being rewritten is left out: its box shows it.
      var shown = textBox && textBox.orig ? state.shapes.filter(function(s){ return s !== textBox.orig; }) : state.shapes;
      paint(ctx, img, cropMode ? null : state.crop, shown, extra);
      var px = canvas.width / Math.max(canvas.getBoundingClientRect().width, 1);   // image pixels per screen pixel
      if(textDraft && textDraft.x2 !== textDraft.x1){
        // The box being dragged with 文字: the text will wrap at its width.
        var tb = norm(textDraft);
        ctx.save();
        ctx.translate(-view.x, -view.y);
        ctx.lineWidth = 1.5 * px;
        ctx.setLineDash([6 * px, 4 * px]);
        ctx.strokeStyle = "#CBA35F";
        ctx.strokeRect(tb.x, tb.y, tb.w, Math.max(tb.h, newFont() * unitFor(W, H) * 1.25));
        ctx.restore();
      }
      if(marquee){
        // The box being dragged with 選択・移動: the shapes wholly inside it get picked.
        var mb = norm(marquee);
        ctx.save();
        ctx.translate(-view.x, -view.y);
        ctx.fillStyle = "rgba(203,163,95,0.12)";
        ctx.fillRect(mb.x, mb.y, mb.w, mb.h);
        ctx.lineWidth = 1.5 * px;
        ctx.setLineDash([6 * px, 4 * px]);
        ctx.strokeStyle = "#CBA35F";
        ctx.strokeRect(mb.x, mb.y, mb.w, mb.h);
        ctx.restore();
      }
      var hv = !dragMove && !isPicked(hover) && tool !== "crop" ? state.shapes[hover] : null;
      if(hv){
        // A faint frame around the shape a click would pick (round the whole of a 一体化 group).
        var hb = framesFor(hv.group ? state.shapes.filter(function(s){ return s.group === hv.group; }) : [hv], px)[0];
        ctx.save();
        ctx.translate(-view.x, -view.y);
        ctx.lineWidth = 1.5 * px;
        ctx.setLineDash([4 * px, 4 * px]);
        ctx.strokeStyle = "rgba(203,163,95,0.9)";
        ctx.strokeRect(hb.x, hb.y, hb.w, hb.h);
        ctx.restore();
      }
      var picks = pickedShapes(), sel = selectedShape();
      if(picks.length || (current && current.type === "ellipse")){
        ctx.save();
        ctx.translate(-view.x, -view.y);
        ctx.lineWidth = 1.5 * px;
        if(picks.length){
          // A dotted frame around each picked shape. Handles only when one is picked (resizing
          // works on one shape); a picked line alone has them at its two ends. (Before v1.0.80 such a line
          // had no frame, and showing only its two small ends it did not look picked.)
          // A 一体化 group has one frame round the whole of it (v1.0.137), so it shows as one thing.
          framesFor(picks, px).forEach(function(b){
            ctx.lineDashOffset = 0;
            ctx.setLineDash([6 * px, 4 * px]);
            ctx.strokeStyle = "#FFFFFF";
            ctx.strokeRect(b.x, b.y, b.w, b.h);
            ctx.lineDashOffset = 5 * px;
            ctx.strokeStyle = "#111111";
            ctx.strokeRect(b.x, b.y, b.w, b.h);
          });
          ctx.setLineDash([]);
          if(sel){
            // Handles: white squares (circles at the ends of a line) with a dark edge.
            var ends = sel.type === "line" || sel.type === "arrow";
            var hs = 4.5 * px;
            ctx.fillStyle = "#FFFFFF";
            ctx.strokeStyle = "#111111";
            ctx.lineWidth = 1.5 * px;
            handlesFor(ctx, sel, unitFor(W, H), framePad(sel, px)).forEach(function(h){
              ctx.beginPath();
              if(ends){ ctx.arc(h.x, h.y, hs, 0, Math.PI*2); } else { ctx.rect(h.x - hs, h.y - hs, hs*2, hs*2); }
              ctx.fill();
              ctx.stroke();
            });
          }
        } else {
          // The centre of the circle being drawn.
          var m = 7 * px;
          [["#111111", 3 * px], [current.color, 1.5 * px]].forEach(function(st){
            ctx.strokeStyle = st[0]; ctx.lineWidth = st[1];
            ctx.beginPath();
            ctx.moveTo(current.cx - m, current.cy); ctx.lineTo(current.cx + m, current.cy);
            ctx.moveTo(current.cx, current.cy - m); ctx.lineTo(current.cx, current.cy + m);
            ctx.stroke();
          });
        }
        ctx.restore();
      }
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
      // With shapes picked, the bar shows their colour / thickness / font size (when they all
      // share it); the settings for drawing new things (color, size, newPt) stay as they were.
      var picks = pickedShapes(), move = tool === "move";
      var texts = picks.filter(function(s){ return s.type === "text"; });
      var thicks = picks.filter(function(s){ return s.type !== "dot"; });   // lines and text: they have a thickness
      var dots = picks.filter(function(s){ return s.type === "dot"; });
      var boxes = picks.filter(function(s){ return s.type === "rect" || s.type === "ellipse"; });
      function common(list, f){ var v = list.length ? f(list[0]) : null; return list.every(function(s){ return f(s) === v; }) ? v : null; }
      var showColor = picks.length ? common(picks, function(s){ return s.color; }) : color;
      var thickOf = function(s){ return s.type === "text" ? textThick(s) : lineW(s.size); };
      var showSize = thicks.length ? common(thicks, thickOf) : size;
      // Picked texts of different sizes show "–": a number already shown could not be chosen again
      // (no change event), so they could not all be set to it.
      // Shown in points (v1.0.132).
      var showFont = texts.length ? common(texts, function(s){ return fontPt(s.fontSize || FONT[s.size]); }) : newPt;
      // Drawn text open for rewriting (double-click): the bar shows that text's colour and size.
      var rewriting = !!(textBox && textBox.orig);
      if(textBox){ showColor = textBox.color; }
      if(rewriting){ showFont = fontPt(textBox.fontSize); }
      if(textBox){ showSize = textBox.thick; }
      Array.prototype.forEach.call(root.querySelectorAll(".imged-tool"), function(b){ b.classList.toggle("on", b.getAttribute("data-tool") === tool); });
      Array.prototype.forEach.call(root.querySelectorAll(".imged-color"), function(b){ b.classList.toggle("on", b.getAttribute("data-color") === showColor); });
      // 太さ (v1.0.74): the picked lines' and texts' thickness ("–" when they differ; the slider then stays at the
      // first one's), the text being typed, or the next thing's. Not moved while it is being dragged.
      widthSel.disabled = rewriting ? false : picks.length ? !thicks.length : move || tool === "dot";
      if(!widthEdit){ widthSel.value = String(widthToPos(showSize !== null ? showSize : thickOf(thicks[0]))); }
      widthVal.textContent = showSize === null ? "–" : widthLabel(showSize);
      // 塗りつぶし (v1.0.56): with □ ○ picked it shows / switches theirs, with the □ ○ tools the next shape's
      fillBtn.classList.toggle("on", boxes.length ? boxes.every(function(s){ return s.fill; }) : (!picks.length && fillMode && (tool === "rect" || tool === "ellipse")));
      fillBtn.disabled = picks.length ? !boxes.length : !(tool === "rect" || tool === "ellipse");
      // 下線 (v1.0.110): like 塗りつぶし, the picked texts' (or the text being typed), or the next one's
      underBtn.classList.toggle("on", textBox ? !!textBox.underline : texts.length ? texts.every(function(s){ return s.underline; }) : (!picks.length && underMode && tool === "text"));
      underBtn.disabled = textBox ? false : picks.length ? !texts.length : tool !== "text";
      fontSel.disabled = rewriting ? false : picks.length ? !texts.length : move;
      // 文字の縁 (v1.0.89): the text being typed, the picked texts' (colour and 濃さ when they share them), or the next text's.
      var edges = textBox ? [edgeSetting(textBox.edge, textBox.color)]
        : texts.length ? texts.map(function(s){ return edgeSetting(s.edge, s.color); }) : [nextEdge];
      var edgeAll = edges.every(function(x){ return x.on; });
      var edgeColorShown = edgeAll ? common(edges, function(x){ return x.color; }) : null;
      var edgeAlpha = edgeAll ? common(edges, function(x){ return x.alpha; }) : null;
      var edgeOff = textBox ? false : picks.length ? !texts.length : move;
      edgeBtn.classList.toggle("on", edgeAll);
      edgeBtn.textContent = edgeAll ? "縁あり" : "縁なし";
      edgeBtn.disabled = edgeOff;
      Array.prototype.forEach.call(root.querySelectorAll(".imged-edge-color"), function(b){
        b.classList.toggle("on", b.getAttribute("data-edge") === edgeColorShown);
        b.disabled = edgeOff;
      });
      if(!edgeEdit){ edgeSel.value = String(Math.round((edgeAlpha !== null ? edgeAlpha : nextEdge.alpha) * 100)); }
      edgeVal.textContent = edgeAll && edgeAlpha === null ? "–" : edgeSel.value + "%";
      edgeSel.disabled = edgeOff;
      // 点の大きさ (slider since v1.0.75): the picked dots' size ("–" when they differ; the slider then stays
      // at the first one's), or the next dot's. A size beyond the slider (a dragged corner) shows its own number.
      var dotOf = function(s){ return s.dotSize || DOT_DEFAULT; };
      var showDot = dots.length ? common(dots, dotOf) : dotSize;
      if(!dotEdit){ dotSel.value = String(dotToPos(showDot !== null ? showDot : dotOf(dots[0]))); }
      dotVal.textContent = showDot === null ? "–" : String(showDot);
      dotSel.disabled = picks.length ? !dots.length : tool !== "dot";
      root.querySelector(".imged-dots").hidden = tool === "crop";
      // 重なり順 (v1.0.120): greyed out when nothing is picked, or the picked ones are already at that end.
      var canOrder = orderable(picks);
      Array.prototype.forEach.call(orderBtns, function(b){ b.disabled = !canOrder[b.getAttribute("data-order")]; });
      root.querySelector(".imged-orders").hidden = tool === "crop";
      // 一体化 (v1.0.137): greyed out when it would change nothing
      var canGroup = groupable(picks);
      groupBtn.disabled = !canGroup.group;
      ungroupBtn.disabled = !canGroup.ungroup;
      root.querySelector(".imged-groups").hidden = tool === "crop";
      // 矢印 ← 始点 / 終点 → (v1.0.139): like 塗りつぶし, lit when every picked pen stroke, open polyline and arrow
      // has a head at that end, or the next one's
      var headed = picks.filter(hasHeads), nextH = nextHeads[tool];
      Array.prototype.forEach.call(headBtns, function(b){
        var k = +b.getAttribute("data-head");
        b.classList.toggle("on", headed.length ? headed.every(function(s){ return headsOf(s)[k]; }) : (!picks.length && !!nextH && nextH[k]));
        b.disabled = picks.length ? !headed.length : !nextH;
      });
      root.querySelector(".imged-heads").hidden = tool === "crop";
      root.querySelector('[data-act="undo"]').disabled = !history.length;
      root.querySelector('[data-act="copy"]').disabled = !picks.length;
      root.querySelector('[data-act="paste"]').disabled = !clip || tool === "crop";
      root.querySelector('[data-act="guides"]').classList.toggle("on", showGuides);
      // Both groups stay on screen (greyed out when they do not apply), so picking a shape
      // never changes the bar's height and moves the picture under the pointer.
      root.querySelector(".imged-sizes").hidden = tool === "crop";
      root.querySelector(".imged-fonts").hidden = tool === "crop";
      canvas.style.cursor = dragMove ? "move" : (move ? "default" : "");
      var blank = fontSel.querySelector('option[value=""]');
      if(showFont === null && !blank){
        blank = doc.createElement("option");
        blank.value = "";
        blank.textContent = "–";
        fontSel.insertBefore(blank, fontSel.firstChild);
      } else if(showFont !== null && blank){
        blank.remove();
      }
      // Text saved with a size that is not in the list still shows its own number.
      if(showFont !== null && !fontSel.querySelector('option[value="'+showFont+'"]')){
        var o = doc.createElement("option");
        o.value = o.textContent = String(showFont);
        var next = Array.prototype.filter.call(fontSel.options, function(x){ return Number(x.value) > showFont; })[0];
        fontSel.insertBefore(o, next || null);
      }
      fontSel.value = showFont === null ? "" : String(showFont);
      var oneGroup = picks.length > 1 && !!picks[0].group && picks.every(function(s){ return s.group === picks[0].group; });
      var picked = oneGroup
        ? "一体化した書き込み（" + picks.length + "個）を選んでいます：ドラッグか矢印キー（Shiftで大きく）でまとめて移動。色・太さ・文字の大きさはまとめて変わります。文字はダブルクリックで書き換え。「✂ 一体化を解除」（Ctrl+Shift+G）でばらばらに戻せます。Ctrl+C／Ctrl+Vでコピー・貼り付け、Deleteで削除、Escで選択を外す"
        : picks.length > 1
        ? picks.length + "個を選んでいます：「⛓ 一体化」（Ctrl+G）で1つにまとめられます。ドラッグか矢印キー（Shiftで大きく）でまとめて移動。色・太さ・文字の大きさは選んだものがまとめて変わります。重なり順は上の「重なり順」か右クリックで変えられます。Ctrl+クリックで追加・外す、Ctrl+C／Ctrl+Vでコピー・貼り付け、Deleteで削除、Escで選択を外す"
        : "選んだ書き込み：ドラッグか矢印キー（Shiftで大きく）で移動、□や○で大きさ（Shiftで比を保つ。文字の左右の□は折り返しの幅）。色・太さ・大きさ・塗りつぶしはこの書き込みだけ変わります。文字はダブルクリックで書き換え。重なり順（最前面へ・前面へ・背面へ・最背面へ）は上の「重なり順」か右クリックで。Ctrl+クリックでほかの書き込みも選べます。Ctrl+C／Ctrl+Vでコピー・貼り付け、Deleteで削除、Escで選択を外す";
      var auto = "描いた書き込みを選んでいます：色・太さ・大きさ・塗りつぶしを変えると、次に描くものにも引き継ぎます。ドラッグで移動、□や○で大きさ。Enterで確定（選択を外す）、続けて描けば自動で外れます。Deleteで削除";
      hint.textContent = rewriting
        ? "文字を書き換えています（大きさと色はそのまま）：Enterで改行、一部の文字をなぞって選んで色を押すと、その文字だけ色が変わります。Ctrl+Enterかほかの場所をクリックで確定、Escで元のまま。全部消して確定すると、その文字を削除します"
        : isAutoPick() ? auto
        : picks.length ? picked : {
        move:"動かしたい線・丸・文字などをクリックして選びます（Ctrl+クリックで複数、何もない所からドラッグで囲んで複数、Ctrl+Aで全部）。文字はダブルクリックで書き換えられます",
        pen:"ドラッグして自由に描きます。「矢印」の「← 始点」「終点 →」で、描き始め・描き終わりの端に矢印を付けられます（描いたあとでも、それぞれ付け外しできます）。1つ描くと「選択・移動」に戻ります。Shiftを押しながら描き始めると、続けて描けます。描いたものの上にもそのまま描けます（選ぶには右クリック）",
        poly: poly
          ? "クリックで点を追加します。ダブルクリックかEnterで終了、始点をクリックすると閉じた図形になります（Ctrl+Zで1点戻す、Escで取り消し）"
          : "クリックするたびに点を打ち、線をつないでいきます（Shiftで水平・垂直・45°）。「矢印」の「← 始点」「終点 →」で、描き始め・描き終わりの端に矢印を付けられます（描いている途中・描いたあとでも。閉じた図形には付きません）。1つ描くと「選択・移動」に戻ります。Shiftを押しながら描き始めると、続けて描けます。描いたものの上にもそのまま描けます（選ぶには右クリック）",
        line:"始点から終点までドラッグします（Shiftで水平・垂直・45°）。1つ描くと「選択・移動」に戻ります。Shiftを押しながら描き始めると、続けて同じ図形を描けます。描いたものの上にもそのまま描けます（選ぶには右クリック）",
        arrow:"矢印の根元から先端までドラッグします（Shiftで水平・垂直・45°）。「矢印」の「← 始点」「終点 →」で、根元・先端のどちらに△を付けるかを選べます（描いたあとでも、それぞれ付け外しできます）。1つ描くと「選択・移動」に戻ります。Shiftを押しながら描き始めると、続けて同じ図形を描けます。描いたものの上にもそのまま描けます（選ぶには右クリック）",
        rect:"対角線の方向にドラッグします（Shiftで正方形）。「■ 塗りつぶし」で中を塗れます。1つ描くと「選択・移動」に戻ります。Shiftを押しながら描き始めると、続けて同じ図形を描けます。描いたものの上にもそのまま描けます（選ぶには右クリック）",
        cross:"✖の対角線の方向にドラッグします（Shiftで縦横が同じ✖）。1つ描くと「選択・移動」に戻ります。Shiftを押しながら描き始めると、続けて同じ図形を描けます。描いたものの上にもそのまま描けます（選ぶには右クリック）",
        ellipse:"円の中心にしたい場所から外へドラッグします（Shiftで真円）。「■ 塗りつぶし」で中を塗れます。1つ描くと「選択・移動」に戻ります。Shiftを押しながら描き始めると、続けて同じ図形を描けます。描いたものの上にもそのまま描けます（選ぶには右クリック）",
        dot:"クリックした所に塗りつぶした点を置きます（押したまま動かすと、離した所に置きます）。置いた点は選んだ状態になり、「点の大きさ」と色をそのまま変えられます（次の点にも引き継ぎます）。1つ置くと「選択・移動」に戻ります。Shiftを押しながらクリックすると、続けて次の点を置けます。描いたものの上にもそのまま置けます（選ぶには右クリック）",
        text:"クリックした所に入力します。横にドラッグして枠を作ると、その幅で折り返します。Enterで改行、Ctrl+Enterかほかの場所をクリックで確定（Escで取り消し）。打った文字の一部をなぞって選び、色を押すと、その文字だけ色が変わります。「文字の縁」で縁をつけ、縁の色と濃さを選べます。「下線」で下線を付けられます。1つ書くと「選択・移動」に戻ります。Shiftを押しながらクリックして書き始めると、続けて書けます。図形の上にも書けます。書いた文字はクリックで選び、ダブルクリックで書き換え（ほかの書き込みを選ぶには右クリック）",
        crop:"残したい範囲をドラッグで囲みます。ほかの道具に切り替えるとトリミング後の表示に戻ります"
      }[tool];
    }

    function toImage(e, noClamp){
      var rect = canvas.getBoundingClientRect();
      var view = tool === "crop" ? full : state.crop;
      var x = (e.clientX - rect.left) * canvas.width / rect.width + view.x;
      var y = (e.clientY - rect.top) * canvas.height / rect.height + view.y;
      if(noClamp) return { x:x, y:y };
      return { x: Math.min(Math.max(x, 0), W), y: Math.min(Math.max(y, 0), H) };
    }
    // Moves the shapes back together so the middle of the box around them stays on the visible
    // picture (they cannot get lost off the edge, and keep their places against each other).
    function keepInView(list){
      var u = unitFor(W, H), v = state.crop;
      var boxes = list.map(function(s){ return shapeBox(ctx, s, u); });
      var x0 = Math.min.apply(null, boxes.map(function(b){ return b.x; })), y0 = Math.min.apply(null, boxes.map(function(b){ return b.y; }));
      var x1 = Math.max.apply(null, boxes.map(function(b){ return b.x + b.w; })), y1 = Math.max.apply(null, boxes.map(function(b){ return b.y + b.h; }));
      var cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
      var dx = Math.min(Math.max(cx, v.x), v.x + v.w) - cx, dy = Math.min(Math.max(cy, v.y), v.y + v.h) - cy;
      if(dx || dy){ list.forEach(function(s){ moveShape(s, dx, dy); }); }
    }
    function framePad(s, px){ return noLine(s) ? 4 * px : 6 * px + lineW(s.size) * unitFor(W, H) / 2; }
    // The dotted frames round shapes, padding included: one for each shape, and one round the whole of each 一体化 group.
    function framesFor(list, px){
      var u = unitFor(W, H), out = [], byGroup = {};
      list.forEach(function(s){
        var b = shapeBox(ctx, s, u), pad = framePad(s, px);
        var r = { x0:b.x - pad, y0:b.y - pad, x1:b.x + b.w + pad, y1:b.y + b.h + pad }, g = s.group ? byGroup[s.group] : null;
        if(g){ g.x0 = Math.min(g.x0, r.x0); g.y0 = Math.min(g.y0, r.y0); g.x1 = Math.max(g.x1, r.x1); g.y1 = Math.max(g.y1, r.y1); }
        else { out.push(r); if(s.group){ byGroup[s.group] = r; } }
      });
      return out.map(function(r){ return { x:r.x0, y:r.y0, w:r.x1 - r.x0, h:r.y1 - r.y0 }; });
    }
    // The handle of the picked shape under p (image pixels), or null.
    function handleAt(p){
      var sel = selectedShape();
      if(!sel) return null;
      // On a dot it is always a move: a dot that looks smaller than about 8 screen pixels has its
      // corner handles over its middle, and dragging it resized it instead (found in the v1.0.56 recheck).
      // "On" means within the dotted frame's padding (4 screen pixels), as a tiny dot is hard to hit exactly;
      // the corner handles sit diagonally outside that, so they can still be grabbed to resize it.
      var px = canvas.width / Math.max(canvas.getBoundingClientRect().width, 1), r = 8 * px, found = null;
      if(sel.type === "dot" && outlineDist(ctx, sel, p, unitFor(W, H)) <= 4 * px) return null;
      handlesFor(ctx, sel, unitFor(W, H), framePad(sel, px)).forEach(function(h){
        if(!found && Math.abs(p.x - h.x) <= r && Math.abs(p.y - h.y) <= r){ found = h.id; }
      });
      return found;
    }
    // Picking works with every tool but トリミング and a polyline being built.
    function pickedShapes(){
      if(tool === "crop" || poly) return [];
      return selection.map(function(i){ return state.shapes[i]; }).filter(Boolean);
    }
    // The picked shape when exactly one is picked (it gets the resize handles), else null.
    function selectedShape(){ var l = pickedShapes(); return l.length === 1 ? l[0] : null; }
    function isPicked(i){ return i >= 0 && selection.indexOf(i) >= 0; }
    // A dot just placed is picked at once (v1.0.77), and since v1.0.79 so is a line, arrow, box, circle, polyline
    // or text just drawn (v1.0.80: a pen stroke too), so its colour, thickness and size can be changed straight away; they
    // carry on to the next ones. Enter or a click lets go of it (the click does not draw the next one).
    // Also once the tool has gone back to 選択・移動 after it was drawn (v1.0.96; since v1.0.83 that happens
    // at once, so a thickness, colour or size set on it no longer carried on). Any other pick resets autoIdx.
    function isAutoPick(){
      return autoIdx >= 0 && selection.length === 1 && selection[0] === autoIdx && !!state.shapes[autoIdx];
    }
    function autoPick(){ var i = state.shapes.length - 1; select(i); autoIdx = i; }
    // Starts dragging the picked shapes: a body moves them all, a handle resizes the one picked.
    // clickOn: the shape pressed; a click on it without a drag leaves only it picked.
    function startDrag(e, q, handle, clickOn){
      hover = -1;
      canvas.setPointerCapture(e.pointerId);
      dragMove = { start: q, idx: selection.slice(), orig: selection.map(function(i){ return JSON.stringify(state.shapes[i]); }),
                   moved: false, handle: handle || null, clickOn: clickOn === undefined ? -1 : clickOn, auto: isAutoPick() };
    }
    function hitAt(p){
      var tol = 8 * canvas.width / Math.max(canvas.getBoundingClientRect().width, 1);
      return hitShape(ctx, state.shapes, p, unitFor(W, H), tol);
    }
    // The shape a plain press at p picks. 選択・移動 picks any shape near the pointer. A drawing tool draws on
    // top of other shapes, so a dot can go on a line (v1.0.81; v1.0.80 picked the shape under a click instead);
    // only 文字 picks a text right under the pointer, to move or rewrite it. With any tool a right-click picks
    // (see contextPick), and picked shapes still move by their body (see pressAt).
    function pickAt(p, touch){
      if(tool === "move") return hitAt(p);
      if(tool !== "text") return -1;
      for(var i=state.shapes.length-1;i>=0;i--){
        var s = state.shapes[i];
        if(s.type === "text" && rightOn(s, p, touch)) return i;
      }
      return -1;
    }
    // Whether p is right on shape s: on its line, text or dot (2 screen pixels; 8 for a finger), or inside it when filled.
    function rightOn(s, p, touch){
      var u = unitFor(W, H), px = canvas.width / Math.max(canvas.getBoundingClientRect().width, 1);
      var w = (noLine(s) ? 0 : lineW(s.size) * u / 2) + (touch ? 8 : 2) * px;
      if(outlineDist(ctx, s, p, u) <= w) return true;
      if(!s.fill) return false;
      var r = norm(s);
      if(s.type === "ellipse"){
        var rx = Math.max(r.w / 2, 0.5), ry = Math.max(r.h / 2, 0.5), ex = (p.x - r.x - rx) / rx, ey = (p.y - r.y - ry) / ry;
        return ex*ex + ey*ey <= 1;
      }
      return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
    }
    // The shape a press at p acts on while shapes are picked (v1.0.65). A picked one under it wins over a
    // shape the pointer is only near, such as the original under a pasted copy (its edge took the press).
    // A shape the pointer is right on still gets picked (text inside a picked frame, say), unless it lies
    // below a picked shape that the pointer is right on too (hidden under a filled box).
    function pressAt(p, touch){
      var on = pickAt(p, touch);
      if(isPicked(on) || !selection.length) return on;
      // The thing just drawn moves only by a press right on it, so the next stroke can start close beside it.
      if(isAutoPick()) return rightOn(state.shapes[autoIdx], p, touch) ? autoIdx : on;
      var tol = 8 * canvas.width / Math.max(canvas.getBoundingClientRect().width, 1);
      var idx = selection.slice().sort(function(a, b){ return a - b; });
      var j = hitShape(ctx, idx.map(function(i){ return state.shapes[i]; }), p, unitFor(W, H), tol);
      if(j < 0) return on;
      var mine = idx[j];
      if(on >= 0 && rightOn(state.shapes[on], p, touch) && (on > mine || !rightOn(state.shapes[mine], p, touch))) return on;
      return mine;
    }
    function copySelected(){
      var picks = pickedShapes();
      if(!picks.length) return;
      clip = { shapes: JSON.stringify(picks), u: unitFor(W, H), mm: opts.mmPerPx > 0 ? opts.mmPerPx : 0 };
      clipPastes = 0;
      setStatus(picks.length > 1 ? picks.length + "個をコピーしました" : "コピーしました");
      syncBar();
    }
    // The copies go on top, offset from the originals, and are picked so they can be moved at once.
    function pasteClip(){
      if(!clip || tool === "crop") return;
      commitPending();
      var list = JSON.parse(clip.shapes);
      var u = unitFor(W, H), k = u / clip.u, f = 1;
      // From one blank (白紙) to another (v1.0.135): the same size on paper, so text pasted from a 大 blank
      // onto a 小 one stays 10.5 (before, it shrank with the picture to about 3.8).
      if(clip.mm > 0 && opts.mmPerPx > 0){ k = clip.mm / opts.mmPerPx; f = k * clip.u / u; }
      clipPastes++;
      var off = 20 * clipPastes * canvas.width / Math.max(canvas.getBoundingClientRect().width, 1);
      // Copies of a 一体化 group are one group of their own, not joined to the originals (v1.0.137).
      var gmap = {}, gnext = nextGroup();
      list.forEach(function(s){
        if(s.group){ if(!gmap[s.group]){ gmap[s.group] = gnext++; } s.group = gmap[s.group]; }
        if(Math.abs(k - 1) > 1e-6){ scaleShape(s, k); }
        if(Math.abs(f - 1) > 1e-6){ scaleSizes(s, f); }
        moveShape(s, off, off);
      });
      keepInView(list);
      snapshot();
      var first = state.shapes.length;
      list.forEach(function(s){ state.shapes.push(s); });
      if(tool === "poly"){ tool = "move"; }   // picking does not work while 折れ線 is chosen
      selection = list.map(function(s, j){ return first + j; });
      draw(); syncBar();
    }
    // 重なり順 (v1.0.120): which of the four would change anything for the picked shapes.
    function orderable(picks){
      var same = function(list){ return list.every(function(s, i){ return s === state.shapes[i]; }); };
      var up = !!picks.length && !same(reorderShapes(state.shapes, picks, "front"));
      var down = !!picks.length && !same(reorderShapes(state.shapes, picks, "back"));
      return { front:up, forward:up, backward:down, back:down };
    }
    // Whether two shapes cover each other (their dotted frames meet), for 前面へ / 背面へ.
    function overlaps(a, b){
      var u = unitFor(W, H), px = canvas.width / Math.max(canvas.getBoundingClientRect().width, 1);
      var p = shapeBox(ctx, a, u), q = shapeBox(ctx, b, u), pa = framePad(a, px), pb = framePad(b, px);
      return p.x - pa <= q.x + q.w + pb && q.x - pb <= p.x + p.w + pa && p.y - pa <= q.y + q.h + pb && q.y - pb <= p.y + p.h + pa;
    }
    // Moves the picked shapes in the order they are painted in; they stay picked (the thing just drawn too).
    function reorder(how){
      var picks = pickedShapes();
      if(!orderable(picks)[how]) return;
      var auto = isAutoPick() ? state.shapes[autoIdx] : null;
      var list = reorderShapes(state.shapes, picks, how, overlaps);
      snapshot();
      state.shapes = list;
      selection = picks.map(function(s){ return list.indexOf(s); });
      if(auto){ autoIdx = list.indexOf(auto); }
      hover = -1;
      setStatus({ front:"最前面へ移動しました", forward:"前面へ移動しました", backward:"背面へ移動しました", back:"最背面へ移動しました" }[how]);
      draw(); syncBar();
    }
    // The right-click menu at screen point (x, y) for the picked shapes.
    function openMenu(x, y){
      closeMenu();
      var can = orderable(pickedShapes()), cg = groupable(pickedShapes());
      menu = doc.createElement("div");
      menu.className = "imged-menu";
      menu.innerHTML = ORDERS.map(function(o){
        var key = o[3].replace(/^.*（(.*)）$/, "$1");
        return '<button type="button" data-order="'+o[0]+'"'+(can[o[0]] ? "" : " disabled")+'><span class="imged-menu-mark">'+o[1]+'</span>'+o[2]+'<span class="imged-menu-key">'+key+'</span></button>';
      }).join("") +
        // 一体化 (v1.0.137)
        '<div class="imged-menu-sep"></div>' +
        '<button type="button" data-group="on"'+(cg.group ? "" : " disabled")+'><span class="imged-menu-mark">⛓</span>一体化<span class="imged-menu-key">Ctrl+G</span></button>' +
        '<button type="button" data-group="off"'+(cg.ungroup ? "" : " disabled")+'><span class="imged-menu-mark">✂</span>一体化を解除<span class="imged-menu-key">Ctrl+Shift+G</span></button>';
      root.appendChild(menu);
      // Kept inside the window: opened up or to the left when it would run off the edge.
      var r = menu.getBoundingClientRect(), vw = hwin.innerWidth, vh = hwin.innerHeight;
      menu.style.left = Math.max(4, x + r.width > vw - 4 ? x - r.width : x) + "px";
      menu.style.top = Math.max(4, y + r.height > vh - 4 ? y - r.height : y) + "px";
      menu.addEventListener("click", function(e){
        var b = e.target.closest("button");
        if(!b || b.disabled) return;
        closeMenu();
        if(b.hasAttribute("data-group")){ setGroup(b.getAttribute("data-group") === "on"); return; }
        reorder(b.getAttribute("data-order"));
      });
    }
    function closeMenu(){ if(menu){ menu.remove(); menu = null; } }
    // A press anywhere but on the menu, or the window losing focus, closes it.
    function menuAway(e){ if(menu && !menu.contains(e.target)){ closeMenu(); } }
    doc.addEventListener("pointerdown", menuAway, true);
    hwin.addEventListener("blur", closeMenu);
    // Picks shape i alone (-1: nothing), with the rest of its 一体化 group.
    function select(i){ selection = i >= 0 ? withGroup(i) : []; autoIdx = -1; }
    // Ctrl+click: adds shape i (and its group) to the picked ones, or takes them out if it is already picked.
    function togglePick(i){
      var members = withGroup(i);
      if(isPicked(i)){ selection = selection.filter(function(j){ return members.indexOf(j) < 0; }); }
      else { members.forEach(function(j){ if(selection.indexOf(j) < 0){ selection.push(j); } }); }
    }
    // 一体化 (v1.0.137): shapes made one share a number in "group". Picking one of them picks them all.
    function withGroup(i){
      var g = state.shapes[i] && state.shapes[i].group;
      if(!g) return [i];
      var out = [];
      state.shapes.forEach(function(s, j){ if(s.group === g){ out.push(j); } });
      return out;
    }
    function nextGroup(){
      var n = 0;
      state.shapes.forEach(function(s){ if(s.group > n){ n = s.group; } });
      return n + 1;
    }
    // Whether the picked shapes can be made one (two or more, not one group already), or parted.
    function groupable(picks){
      var g = picks.length ? picks[0].group : 0;
      return { group: picks.length >= 2 && !(g && picks.every(function(s){ return s.group === g; })),
               ungroup: picks.some(function(s){ return !!s.group; }) };
    }
    // 一体化 (on) or 一体化を解除: the picked shapes stay picked. Picked groups made one with others become one group.
    function setGroup(on){
      var picks = pickedShapes(), can = groupable(picks);
      if(!(on ? can.group : can.ungroup)) return;
      snapshot();
      var g = on ? nextGroup() : 0;
      picks.forEach(function(s){ if(g){ s.group = g; } else { delete s.group; } });
      autoIdx = -1;
      setStatus(on ? picks.length + "個を一体化しました" : "一体化を解除しました");
      draw(); syncBar();
    }

    function commitText(){
      if(!textBox) return;
      var box = textBox;
      textBox = null;
      var text = box.el.value.replace(/\s+$/, "");
      var runs = colsToRuns(box.cols, text.length, box.color);
      box.el.remove();
      box.mirror.remove();
      if(box.orig){
        // Rewriting drawn text (v1.0.51): the same text object keeps its place, colour and width;
        // emptied, it is removed. It stays picked, so it can be moved or recoloured at once.
        var i = state.shapes.indexOf(box.orig);
        var same = text === box.orig.text && box.color === box.orig.color && box.fontSize === (box.orig.fontSize || FONT[box.orig.size])
          && box.thick === textThick(box.orig) && JSON.stringify(runs) === JSON.stringify(box.orig.runs || [])
          && JSON.stringify(box.edge) === JSON.stringify(box.orig.edge) && box.underline === !!box.orig.underline;
        if(i >= 0 && !same){
          snapshot();
          if(text){
            state.shapes[i] = Object.assign({}, box.orig, { text:text, fontSize:box.fontSize, color:box.color, thick:box.thick });
            if(runs.length){ state.shapes[i].runs = runs; } else { delete state.shapes[i].runs; }
            if(box.edge !== undefined){ state.shapes[i].edge = box.edge; }
            if(box.underline){ state.shapes[i].underline = true; } else { delete state.shapes[i].underline; }
            select(i);
          }
          else { state.shapes.splice(i, 1); select(-1); }
        } else if(i >= 0){ select(i); }
        draw();
        syncBar();
        return;
      }
      if(text){
        snapshot();
        var t = { type:"text", x:box.x, y:box.y, text:text, color:box.color, fontSize:box.fontSize, thick:box.thick };
        if(box.wrap){ t.wrap = box.wrap; }
        if(runs.length){ t.runs = runs; }
        t.edge = box.edge;
        if(box.underline){ t.underline = true; }
        state.shapes.push(t);
        autoPick();
        if(tool === "text" && !keepTool){ tool = "move"; }   // one at a time unless started with Shift (v1.0.84)
        draw();
        syncBar();
      }
    }
    // A text box at screen point (cx, cy) for picture point p. With wrap (picture pixels) the
    // box has that width and wraps like the finished text; without, it grows with the text.
    // orig: drawn text being rewritten (double-click); the box starts with its text, colour and size.
    function openTextBox(cx, cy, p, wrap, orig){
      commitText();
      var el = doc.createElement("textarea");
      el.className = "imged-text";
      var rect = canvas.getBoundingClientRect();
      var srect = stage.getBoundingClientRect();
      var scale = rect.width / canvas.width;
      var size0 = orig ? (orig.fontSize || FONT[orig.size]) : newFont();
      var fs = size0 * unitFor(W, H) * scale;
      el.style.left = (cx - srect.left) + "px";
      el.style.top = (cy - srect.top) + "px";
      // Wrapping text is typed at its real size, so it breaks where the finished text will.
      el.style.fontSize = (wrap ? Math.max(fs, 6) : Math.max(fs, 12)) + "px";
      // The box's own letters are invisible (only the cursor and the chosen part show); a copy of the
      // text on top of it (mirror) shows each letter in its colour (v1.0.88).
      el.style.color = "transparent";
      el.style.caretColor = orig ? orig.color : color;
      var thick0 = orig ? textThick(orig) : size;
      el.style.fontWeight = orig ? textWeight(orig) : textWeightFor(thick0);
      el.rows = 1;
      if(wrap){ el.style.minWidth = "0"; el.style.width = (wrap * scale) + "px"; el.setAttribute("wrap", "soft"); }
      else { el.setAttribute("wrap", "off"); }
      if(orig){ el.value = orig.text; }
      var mirror = doc.createElement("div");
      mirror.className = "imged-text imged-text-mirror" + (wrap ? " wrap" : "");
      stage.appendChild(el);
      stage.appendChild(mirror);
      textBox = { el:el, mirror:mirror, x:p.x, y:p.y, wrap:wrap || 0, fit:fit, orig:orig || null, fontSize:size0, color: orig ? orig.color : color, thick:thick0,
                  cols: orig ? runsToCols(orig.runs, orig.text.length) : [],
                  edge: orig ? orig.edge : edgeValue(nextEdge),   // edge: undefined for text from before v1.0.89
                  underline: orig ? !!orig.underline : underMode };
      var shown = el.value;   // the text as it was at the last input, to see what an input changed
      function fit(){
        el.style.height = "auto";
        el.style.height = el.scrollHeight + "px";
        if(!wrap){ el.style.width = "auto"; el.style.width = Math.max(120, el.scrollWidth + 4) + "px"; }
        paintMirror();
      }
      // The mirror takes the box's place, size and font, and shows the letters in runs of one colour.
      function paintMirror(){
        var cs = hwin.getComputedStyle(el);
        ["boxSizing", "left", "top", "width", "height", "fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing", "wordSpacing",
         "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
         "marginTop", "marginLeft", "textIndent", "tabSize"].forEach(function(k){ mirror.style[k] = cs[k]; });
        var box = textBox && textBox.el === el ? textBox : null;
        if(!box) return;
        var v = el.value, cols = box.cols, i = 0, j;
        // The edge as the finished text will have it (its width in screen pixels).
        var ew = edgeWidth({ thick:box.thick }, box.fontSize * unitFor(W, H)) * canvas.getBoundingClientRect().width / canvas.width;
        mirror.textContent = "";
        while(i < v.length){
          for(j = i + 1; j < v.length && cols[j] === cols[i]; j++){}
          var span = doc.createElement("span");
          span.style.color = cols[i] || box.color;
          if(box.underline){ span.style.textDecoration = "underline"; }
          var ec = edgeColor(box.edge, cols[i] || box.color);
          if(ec){ span.style.webkitTextStroke = ew + "px " + ec; span.style.paintOrder = "stroke fill"; }
          span.textContent = v.slice(i, j);
          mirror.appendChild(span);
          i = j;
        }
        el.style.caretColor = box.color;
      }
      // Letters typed take the colour of the letters they replace, or of the letter before them.
      function trackInput(){
        var v = el.value, cols = textBox.cols, p = 0, q = 0, n = Math.min(v.length, shown.length);
        while(p < n && v[p] === shown[p]){ p++; }
        while(q < n - p && v[v.length - 1 - q] === shown[shown.length - 1 - q]){ q++; }
        var removed = shown.length - p - q, added = v.length - p - q;
        var c = removed > 0 ? cols[p] : p > 0 ? cols[p - 1] : cols[0];
        var mid = [];
        for(var k = 0; k < added; k++){ mid.push(c || null); }
        cols.splice.apply(cols, [p, removed].concat(mid));
        shown = v;
      }
      // Enter starts a new line; Ctrl+Enter or a click elsewhere finishes; Esc throws it away.
      el.addEventListener("keydown", function(ev){
        ev.stopPropagation();
        if(ev.key === "Enter" && (ev.ctrlKey || ev.metaKey) && !ev.isComposing){ ev.preventDefault(); commitText(); }
        if(ev.key === "Escape"){
          ev.preventDefault();
          textBox = null;
          el.remove();
          mirror.remove();
          // Rewriting: the text goes back as it was, still picked.
          if(orig){ select(state.shapes.indexOf(orig)); draw(); syncBar(); }
        }
      });
      el.addEventListener("input", function(){ trackInput(); fit(); });
      fit();
      el.addEventListener("blur", function(ev){
        // Choosing a font size or a thickness while typing keeps the box open and changes it.
        if(ev.relatedTarget === fontSel || ev.relatedTarget === widthSel || ev.relatedTarget === edgeSel) return;
        // Only this box: by the time the timer runs, a click may already have opened the next one (v1.0.86).
        setTimeout(function(){ if(textBox && textBox.el === el){ commitText(); } }, 0);
      });
      // Rewriting starts with all of the text chosen: typing replaces it, a click or an arrow key edits part of it.
      // It is opened by a double-click, after the clicks, so it can take the keyboard at once.
      if(orig){ el.focus(); el.select(); }
      setTimeout(function(){ if(doc.activeElement !== el){ el.focus(); } }, 0);
    }
    // Double-click on drawn text (any tool but トリミング): rewrite it in place (v1.0.51). The text is
    // hidden from the picture while its box is open (see draw), so only the box shows.
    function editText(i){
      var s = state.shapes[i];
      if(!s || s.type !== "text") return false;
      commitPending();
      dragMove = null;
      hover = -1;
      select(-1);
      var rect = canvas.getBoundingClientRect(), scale = rect.width / canvas.width, v = state.crop;
      // The box's padding and border (.imged-text: 2px 4px + 1px) are moved back, so its letters sit where the drawn ones were.
      openTextBox(rect.left + (s.x - v.x) * scale - 5, rect.top + (s.y - v.y) * scale - 3, { x:s.x, y:s.y }, s.wrap || 0, s);
      draw();
      syncBar();
      return true;
    }
    canvas.addEventListener("dblclick", function(e){
      if(tool === "crop" || poly || e.ctrlKey || e.metaKey) return;
      // The first click of a double-click has picked the text. If it has not (a polyline was just
      // finished with this double-click, say), the double-click was not aimed at the text.
      var q = toImage(e, true);
      // Drawing tools draw on the text instead of picking it (点 v1.0.65, the others v1.0.72). With 点 and ペン the
      // clicks may have put a dot or a dab (or two) on it: take them back and rewrite the text. 直線・矢印・四角・丸
      // leave nothing after a click. 折れ線: a polyline just finished with this double-click was the aim, not the text.
      // Since v1.0.84 the first click of a double-click with 点 or ペン puts a dot or a dab and goes back to
      // 選択・移動, so the takeback below runs with 選択・移動 too, but only when such clicks were just made.
      if(tool !== "text"){
        if(Date.now() - polySaved < 600) return;
        // The clicks picked the text (v1.0.80): rewrite it, as with 選択・移動.
        var pi = hitAt(q);
        if(isPicked(pi) && state.shapes[pi].type === "text"){ editText(pi); e.preventDefault(); return; }
        var n = state.shapes.length, k = 0, now = Date.now();
        while(k < clickDots.length && k < history.length && clickDots[clickDots.length - 1 - k].s === state.shapes[n - 1 - k]
              && now - clickDots[clickDots.length - 1 - k].t < 600){ k++; }
        if(tool === "move" && !k) return;
        for(var t = n - 1 - k; t >= 0; t--){
          if(state.shapes[t].type === "text" && rightOn(state.shapes[t], q)){
            clickDots = [];
            while(k--){ restore(history.pop()); }
            editText(t);
            e.preventDefault();
            return;
          }
        }
        return;
      }
      var i = hitAt(q);
      if(isPicked(i) && editText(i)){ e.preventDefault(); }
    });

    function finishPoly(closed){
      if(!poly) return;
      var s = poly;
      poly = null; polyHover = null; lastClick = null;
      if(s.points.length >= 2){
        if(closed){ s.closed = true; delete s.head; }   // a closed one has no ends for heads
        snapshot();
        state.shapes.push(s);
        autoPick();
        polySaved = Date.now();
        if(tool === "poly" && !keepTool){ tool = "move"; }   // one at a time unless started with Shift (v1.0.84)
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
        keepTool = e.shiftKey;
        var p0 = toImage(e);
        poly = { type:"poly", color:color, size:size, points:[[p0.x, p0.y]] };
        setHeads(poly, nextHeads.poly);
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

    // Right-click (v1.0.81): picks the shape under the pointer with any tool, as 選択・移動 does with a left click
    // (nothing there: lets go). The drawing tools keep the left button for drawing, on top of shapes too.
    // v1.0.120: on a shape it also shows the 重なり順 menu. On a picked shape (even one under another shape)
    // the picked ones stay picked, so the menu acts on all of them.
    function contextPick(e){
      e.preventDefault();
      menuArmed = false;
      if(tool === "crop" || poly || dragMove || current || textDraft || marquee) return;
      if(textBox && textBox.orig){ commitText(); return; }
      commitText();
      var q = toImage(e, true), tol = 8 * canvas.width / Math.max(canvas.getBoundingClientRect().width, 1);
      // A shape right under the pointer wins over a picked one it is only near or inside (a dot in a picked box).
      var i = hitAt(q), onPicked = isPicked(i) || (selection.length > 0 && !(i >= 0 && rightOn(state.shapes[i], q))
        && hitShape(ctx, pickedShapes(), q, unitFor(W, H), tol) >= 0);
      if(!onPicked){ select(i); }
      menuArmed = selection.length > 0;
      hover = -1;
      draw(); syncBar();
    }
    // The menu opens on the contextmenu event, after the button is let go (on Windows), so letting go
    // does not land on it.
    canvas.addEventListener("contextmenu", function(e){
      e.preventDefault();
      if(menuArmed && pickedShapes().length){ openMenu(e.clientX, e.clientY); }
      menuArmed = false;
    });
    canvas.addEventListener("pointerdown", function(e){
      if(e.button === 2){ contextPick(e); return; }
      if(e.button !== 0) return;
      // The presses below call preventDefault, which keeps the focus where it was: after choosing a
      // font size, the arrow keys and Delete would still go to that box instead of the picked shapes.
      if(doc.activeElement === fontSel){ fontSel.blur(); }
      if(doc.activeElement === widthSel){ widthSel.blur(); }
      if(doc.activeElement === dotSel){ dotSel.blur(); }
      // A click on the picture while drawn text is being rewritten only finishes it, with any tool
      // (preventDefault keeps the box from losing focus, so its own blur would not do it).
      if(textBox && textBox.orig){ e.preventDefault(); commitText(); return; }
      var p = toImage(e), q = toImage(e, true);
      // Ctrl+click on a drawn shape adds it to the picked ones (or takes it out), whatever the
      // tool; it never draws. Not while cropping or building a polyline.
      if((e.ctrlKey || e.metaKey) && tool !== "crop" && !poly){
        e.preventDefault();
        commitText();
        var ci = hitAt(q);
        if(ci >= 0){ togglePick(ci); hover = -1; draw(); syncBar(); }
        return;
      }
      // Picked shapes: the handles of a single one resize it and a body moves them all, whatever the tool.
      if(pickedShapes().length){
        var h = handleAt(q), on = pressAt(q, e.pointerType === "touch");
        if(h || isPicked(on)){
          if(tool === "dot"){ keepTool = e.shiftKey; }   // this click may place the next dot (see endStroke, v1.0.85)
          e.preventDefault(); commitText(); startDrag(e, q, h, h ? -1 : on); return;
        }
      }
      if(tool === "move"){
        e.preventDefault();
        commitText();
        var i = hitAt(q);
        select(i);
        draw(); syncBar();
        // Measured after the bar is updated, in case that moved the picture.
        if(i >= 0){ startDrag(e, toImage(e, true), null); }
        // On an empty spot a drag draws a box: the shapes wholly inside it get picked (v1.0.80).
        else { canvas.setPointerCapture(e.pointerId); marquee = { x1:q.x, y1:q.y, x2:q.x, y2:q.y }; }
        return;
      }
      if(tool === "poly" && poly){ onPolyDown(e); return; }
      if(tool === "crop"){ commitText(); canvas.setPointerCapture(e.pointerId); cropDraft = { x1:p.x, y1:p.y, x2:p.x, y2:p.y }; return; }
      var hit = pickAt(q, e.pointerType === "touch");
      // A press elsewhere lets go of the picked shapes and draws at once (v1.0.82), like common drawing programs,
      // so every click with 点 places a dot. (v1.0.79〜1.0.81: such a click only let go, and dots in a row
      // needed one click, then two, by turns.) Enter still lets go without drawing.
      if(selection.length){ select(-1); draw(); syncBar(); }
      if(tool === "poly"){ onPolyDown(e); return; }   // 折れ線's first point goes on shapes too (v1.0.72)
      if(tool === "text"){
        e.preventDefault();
        // A click while typing only finishes the text.
        if(textBox){ commitText(); return; }
        // A click on drawn text picks it (and can drag it); anywhere else, other shapes too, starts new text.
        if(hit >= 0){ select(hit); draw(); syncBar(); startDrag(e, q, null); return; }
        canvas.setPointerCapture(e.pointerId);
        textDraft = { x1:p.x, y1:p.y, x2:p.x, y2:p.y, cx:e.clientX, cy:e.clientY };
        keepTool = e.shiftKey;
        return;
      }
      commitText();
      canvas.setPointerCapture(e.pointerId);
      current = tool === "pen" ? { type:"pen", color:color, size:size, points:[[p.x, p.y]] }
        : tool === "dot" ? { type:"dot", color:color, dotSize:dotSize, x:p.x, y:p.y }   // follows the pointer until let go
        : { type:tool, color:color, size:size, x1:p.x, y1:p.y, x2:p.x, y2:p.y };
      if(tool === "ellipse"){ current.cx = p.x; current.cy = p.y; }
      if((tool === "rect" || tool === "ellipse") && fillMode){ current.fill = true; }
      if(nextHeads[tool]){ setHeads(current, nextHeads[tool]); }
      keepTool = e.shiftKey;
      draw();
    });
    canvas.addEventListener("pointermove", function(e){
      if(poly){ polyHover = polyPoint(e); lastRaw = { e:{ clientX:e.clientX, clientY:e.clientY } }; draw(); return; }
      if(marquee){ var mq = toImage(e, true); marquee.x2 = mq.x; marquee.y2 = mq.y; draw(); return; }
      if(textDraft){
        var tp = toImage(e);
        textDraft.x2 = tp.x; textDraft.y2 = tp.y;
        draw();
        return;
      }
      if(!dragMove && !current && !cropDraft && tool !== "crop"){
        // While drawn text is being rewritten, a click anywhere only finishes it: no hand, no frame
        // (the frame would outline the hidden text under its box).
        if(textBox && textBox.orig){
          canvas.style.cursor = "";
          if(hover !== -1){ hover = -1; draw(); }
          return;
        }
        // Over a handle or a shape: show what a press there would do (a hand: a click picks it).
        var hq = toImage(e, true), hh = handleAt(hq), hi = pressAt(hq);
        canvas.style.cursor = hh ? HANDLE_CURSOR[hh]
          : hi >= 0 ? (isPicked(hi) ? "move" : "pointer")
          : (tool === "move" ? "default" : "");
        var nh = hh ? -1 : hi;
        if(nh !== hover){ hover = nh; draw(); }
        return;
      }
      if(dragMove){
        var q = toImage(e, true), idx = dragMove.idx;
        // Undone or deleted mid-drag (that also lets go of the picked shapes).
        if(selection.join() !== idx.join() || !idx.every(function(i){ return state.shapes[i]; })){ dragMove = null; return; }
        var dx = q.x - dragMove.start.x, dy = q.y - dragMove.start.y;
        if(!dragMove.moved){
          if(!dx && !dy) return;
          snapshot();
          dragMove.moved = true;
        }
        var moved = dragMove.orig.map(function(j){ return JSON.parse(j); });
        if(dragMove.handle){
          var px = canvas.width / Math.max(canvas.getBoundingClientRect().width, 1);
          moved[0] = resizeShape(ctx, moved[0], dragMove.handle, dx, dy, unitFor(W, H), e.shiftKey, 6 * px);
        } else {
          moved.forEach(function(s){ moveShape(s, dx, dy); });
          keepInView(moved);
        }
        idx.forEach(function(i, j){ state.shapes[i] = moved[j]; });
        draw();
        return;
      }
      if(!current && !cropDraft) return;
      var p = toImage(e);
      lastRaw = { p:p };
      if(cropDraft){ cropDraft.x2 = p.x; cropDraft.y2 = p.y; }
      else if(current.type === "pen"){ current.points.push([p.x, p.y]); }
      else if(current.type === "dot"){ current.x = p.x; current.y = p.y; }
      else { setEnd(current, p, e.shiftKey); }
      draw();
    });
    canvas.addEventListener("pointerleave", function(){
      if(hover >= 0){ hover = -1; draw(); }
      if(poly && polyHover){ polyHover = null; draw(); }
    });
    // Pressing or releasing Shift mid-drag updates the shape without moving the mouse.
    function onShift(e){
      if(e.key !== "Shift" || !lastRaw) return;
      if(current && lastRaw.p && current.type !== "pen" && current.type !== "dot"){ setEnd(current, lastRaw.p, e.shiftKey); draw(); }
      else if(poly && lastRaw.e){ polyHover = polyPoint({ clientX:lastRaw.e.clientX, clientY:lastRaw.e.clientY, shiftKey:e.shiftKey }); draw(); }
    }
    doc.addEventListener("keydown", onShift);
    doc.addEventListener("keyup", onShift);
    function endStroke(e){
      if(marquee){
        var mr = norm(marquee), mu = unitFor(W, H);
        marquee = null;
        if(mr.w > 2 || mr.h > 2){
          selection = [];
          state.shapes.forEach(function(s, i){
            var b = shapeBox(ctx, s, mu);
            if(b.x >= mr.x && b.y >= mr.y && b.x + b.w <= mr.x + mr.w && b.y + b.h <= mr.y + mr.h){ selection.push(i); }
          });
          // A 一体化 group is picked only when the whole of it is inside (v1.0.137).
          var inside = selection;
          selection = inside.filter(function(i){ return withGroup(i).every(function(j){ return inside.indexOf(j) >= 0; }); });
        }
        draw(); syncBar();
        return;
      }
      if(dragMove){
        // A click (no drag) on one of several picked shapes leaves only that one picked.
        var d = dragMove;
        dragMove = null;
        if(!d.moved && d.clickOn >= 0 && selection.length > 1 && selection.join() === d.idx.join()){ select(d.clickOn); }
        // A click (no drag) on the thing just drawn lets go of it (v1.0.79). With 点 it also places the next dot
        // there (v1.0.82), so every click with 点 places one, even on a big dot just placed.
        if(!d.moved && d.auto){
          select(-1);
          if(tool === "dot"){
            var nd = { type:"dot", color:color, dotSize:dotSize, x:Math.min(Math.max(d.start.x, 0), W), y:Math.min(Math.max(d.start.y, 0), H) };
            snapshot(); state.shapes.push(nd);
            clickDots = clickDots.slice(-1).concat([{ s:nd, t:Date.now() }]);
            autoPick();
            if(!keepTool){ tool = "move"; }   // one at a time unless this click was made with Shift (v1.0.85)
          }
        }
        draw(); syncBar();
        return;
      }
      if(textDraft){
        // A drag sideways made a box: the text wraps at its width. A click: plain text there.
        var t = textDraft;
        textDraft = null;
        var wide = e && Math.abs(e.clientX - t.cx) > 12;
        if(wide){
          openTextBox(Math.min(t.cx, e.clientX), Math.min(t.cy, e.clientY), { x:Math.min(t.x1, t.x2), y:Math.min(t.y1, t.y2) }, Math.abs(t.x2 - t.x1));
        } else {
          openTextBox(t.cx, t.cy, { x:t.x1, y:t.y1 }, 0);
        }
        draw();
        return;
      }
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
        delete s.cx; delete s.cy;
        var big = s.type === "pen" || s.type === "dot" || Math.abs(s.x2 - s.x1) > minSize || Math.abs(s.y2 - s.y1) > minSize;
        if(big){
          snapshot(); state.shapes.push(s);
          // A dot, or a pen stroke no bigger than a click (6 screen pixels), may be half of a double-click on text.
          var sb = shapeBox(ctx, s, unitFor(W, H)), spx = canvas.width / Math.max(canvas.getBoundingClientRect().width, 1);
          var dab = s.type === "dot" || (s.type === "pen" && sb.w <= 6 * spx && sb.h <= 6 * spx);
          clickDots = dab ? clickDots.slice(-1).concat([{ s:s, t:Date.now() }]) : [];
          autoPick();
          // Drawn one at a time: the tool goes back to 選択・移動, so a click elsewhere does not draw another
          // (v1.0.83, ペン and 点 too v1.0.84). Started with Shift held, the tool stays for the next one.
          if(SHAPE_TOOLS.indexOf(s.type) >= 0 && tool === s.type && !keepTool){ tool = "move"; }
        }
      }
      draw();
      syncBar();
    }
    canvas.addEventListener("pointerup", endStroke);
    canvas.addEventListener("pointercancel", endStroke);

    // While text is being typed or rewritten, pressing a colour must not take the focus from its box
    // (that would finish it in the old colour, and the colour would only go to the next text).
    root.querySelector(".imged-bar").addEventListener("mousedown", function(e){
      if(textBox && e.target.closest('[data-color], [data-edge], [data-act="edge"], [data-act="underline"]')){ e.preventDefault(); }
    });
    root.querySelector(".imged-bar").addEventListener("click", function(e){
      var b = e.target.closest("button");
      if(!b) return;
      // A colour chosen while typing goes to that text (v1.0.52); for new text it is also the
      // colour of the texts after it, as before.
      // With part of the text chosen in the box, only those letters take the colour (v1.0.88);
      // with nothing or all of it chosen, the whole text does.
      if(textBox && b.hasAttribute("data-color")){
        var tc = b.getAttribute("data-color"), a = textBox.el.selectionStart, z = textBox.el.selectionEnd;
        if(a < z && !(a === 0 && z >= textBox.el.value.replace(/\s+$/, "").length)){
          for(var k = a; k < z; k++){ textBox.cols[k] = tc === textBox.color ? null : tc; }
        } else {
          textBox.color = tc;
          textBox.cols = textBox.cols.map(function(){ return null; });   // the whole text: one colour again
          if(!textBox.orig){ color = textBox.color; }
        }
        textBox.fit();
        textBox.el.focus();
        syncBar();
        return;
      }
      // A colour applies to a polyline in progress instead of ending it (the 太さ slider too, see below).
      if(poly && b.hasAttribute("data-color")){
        color = poly.color = b.getAttribute("data-color");
        draw(); syncBar();
        return;
      }
      // 文字の縁 (v1.0.89): on / off, or a colour for it (which also turns it on)
      if(b.getAttribute("data-act") === "edge"){
        var turnOn = !edgeBtn.classList.contains("on");
        changeEdge(function(x){ return { on:turnOn, color:x.color, alpha:x.alpha }; });
        return;
      }
      if(b.hasAttribute("data-edge")){
        var ecv = b.getAttribute("data-edge");
        changeEdge(function(x){ return { on:true, color:ecv, alpha:x.alpha }; });
        return;
      }
      // 下線 (v1.0.110): the text being typed (for new text also the texts after it), else the picked texts, else the next text
      if(b.getAttribute("data-act") === "underline"){
        if(textBox){
          textBox.underline = !textBox.underline;
          if(!textBox.orig){ underMode = textBox.underline; }
          textBox.fit();
          textBox.el.focus();
        } else {
          var uts = pickedShapes().filter(function(s){ return s.type === "text"; });
          if(uts.length){
            var uon = !uts.every(function(s){ return s.underline; });
            if(isAutoPick()){ underMode = uon; }
            snapshot();
            uts.forEach(function(s){ if(uon){ s.underline = true; } else { delete s.underline; } });
          } else { underMode = !underMode; }
          draw();
        }
        syncBar();
        return;
      }
      // Any other button finishes text being rewritten first (it stays picked).
      if(textBox && textBox.orig){ commitText(); }
      // 重なり順 (v1.0.120)
      if(b.hasAttribute("data-order")){ reorder(b.getAttribute("data-order")); return; }
      // 一体化 (v1.0.137)
      if(b.getAttribute("data-act") === "group" || b.getAttribute("data-act") === "ungroup"){ setGroup(b.getAttribute("data-act") === "group"); return; }
      // A colour changes the picked shapes (the 太さ slider too, see below).
      var picks = pickedShapes();
      if(picks.length && b.hasAttribute("data-color")){
        var val = b.getAttribute("data-color");
        if(isAutoPick()){ color = val; }   // the thing just drawn: the next ones get the colour too
        // Picked text becomes one colour, letters coloured on their own too (v1.0.88).
        var targets = picks.filter(function(s){ return s.color !== val || s.runs; });
        if(targets.length){ snapshot(); targets.forEach(function(s){ s.color = val; delete s.runs; }); }
        draw(); syncBar();
        return;
      }
      // 塗りつぶし: picked □ ○ are all filled, or all unfilled when every one was filled already
      if(b.getAttribute("data-act") === "fill"){
        var boxes = picks.filter(function(s){ return s.type === "rect" || s.type === "ellipse"; });
        if(boxes.length){
          var on = !boxes.every(function(s){ return s.fill; });
          if(isAutoPick()){ fillMode = on; }   // the □ ○ just drawn: the next ones too
          snapshot();
          boxes.forEach(function(s){ if(on){ s.fill = true; } else { delete s.fill; } });
        } else {
          fillMode = !fillMode;              // the next □ ○ drawn
        }
        draw(); syncBar();
        return;
      }
      // 矢印 ← 始点 / 終点 → (v1.0.139): the same for the head at one end of pen strokes and arrows; the other end stays as it is
      if(b.hasAttribute("data-head")){
        var k = +b.getAttribute("data-head");
        var headed = picks.filter(hasHeads);
        if(headed.length){
          var hon = !headed.every(function(s){ return headsOf(s)[k]; }), hauto = isAutoPick();
          snapshot();
          headed.forEach(function(s){
            var h = headsOf(s); h[k] = hon; setHeads(s, h);
            if(hauto){ nextHeads[s.type] = h.slice(); }   // the one just drawn: the next ones too
          });
        } else if(nextHeads[tool]){
          nextHeads[tool][k] = !nextHeads[tool][k];
          if(poly){ setHeads(poly, nextHeads.poly); }   // a polyline being built shows it at once (v1.0.140)
        }
        draw(); syncBar();
        return;
      }
      var prevTool = tool;
      commitPending();
      if(b.hasAttribute("data-tool")){
        // The tool already chosen, pressed again, lets go of it: back to 選択・移動 (v1.0.86).
        var nt = b.getAttribute("data-tool");
        tool = nt === prevTool && nt !== "move" ? "move" : nt;
        selection = []; draw();
      }
      if(b.hasAttribute("data-color")){ color = b.getAttribute("data-color"); }
      var act = b.getAttribute("data-act");
      if(act === "undo" && history.length){ restore(history.pop()); selection = []; draw(); }
      if(act === "clear" && state.shapes.length){ snapshot(); state.shapes = []; selection = []; draw(); }
      if(act === "uncrop"){ snapshot(); state.crop = Object.assign({}, full); draw(); }
      if(act === "guides"){ showGuides = !showGuides; rememberGuides(showGuides); if(!showGuides){ hideGuides(); } }
      if(act === "copy"){ copySelected(); return; }
      if(act === "paste"){ pasteClip(); return; }
      syncBar();
    });

    fontSel.addEventListener("change", function(){
      if(!fontSel.value) return;   // "–" (picked texts of different sizes)
      var texts = pickedShapes().filter(function(s){ return s.type === "text"; });
      if(texts.length){
        var pt = Number(fontSel.value), v = fontUnit(pt);
        var targets = texts.filter(function(s){ return fontPt(s.fontSize || FONT[s.size]) !== pt; });
        if(isAutoPick()){ newPt = pt; rememberFontPt(pt); }   // the text just written: the next texts too
        if(targets.length){ snapshot(); targets.forEach(function(s){ s.fontSize = v; }); }
        draw(); syncBar();
        return;
      }
      // While rewriting drawn text, the size is that text's own; the size for new text stays as it was.
      if(!(textBox && textBox.orig)){
        newPt = Number(fontSel.value);
        rememberFontPt(newPt);
      }
      if(textBox){
        textBox.fontSize = fontUnit(Number(fontSel.value));
        var scale = canvas.getBoundingClientRect().width / canvas.width;
        textBox.el.style.fontSize = Math.max(textBox.fontSize * unitFor(W, H) * scale, textBox.wrap ? 6 : 12) + "px";
        textBox.fit();
        textBox.el.focus();
      }
    });

    // 太さ (v1.0.74): the slider changes, as it moves, the picked lines and texts, or the text being typed,
    // or a polyline in progress; and (except while rewriting drawn text) the thickness of the next things.
    widthSel.addEventListener("input", function(){
      var w = posToWidth(Number(widthSel.value));
      widthVal.textContent = widthLabel(w);
      var targets = pickedShapes().filter(function(s){ return s.type !== "dot"; });
      if(targets.length){
        if(!widthEdit){ snapshot(); widthEdit = true; }
        targets.forEach(function(s){ if(s.type === "text"){ s.thick = w; } else { s.size = w; } });
        if(isAutoPick()){ size = w; rememberWidth(w); }   // the thing just drawn: the next ones too
        draw();
        return;
      }
      if(textBox){
        textBox.thick = w;
        if(!(textBox.orig && typeof textBox.orig.bold === "boolean")){ textBox.el.style.fontWeight = textWeightFor(w); textBox.fit(); }
        if(textBox.orig) return;
      }
      size = w;
      rememberWidth(w);
      if(poly){ poly.size = w; draw(); }
    });
    // Let go (or a key press): the move is done. Typing goes on in the text box.
    widthSel.addEventListener("change", function(){
      widthEdit = false;
      syncBar();
      if(textBox){ textBox.el.focus(); }
    });

    // 点の大きさ: the slider changes, as it moves, the picked dots, and the next dot's size (remembered for next
    // time). A size set on a picked dot carries on to the next dots too (v1.0.76; before, only the picked dots changed).
    dotSel.addEventListener("input", function(){
      var v = posToDot(Number(dotSel.value));
      dotVal.textContent = String(v);
      dotSize = v;
      rememberDotSize(v);
      var dots = pickedShapes().filter(function(s){ return s.type === "dot"; });
      if(dots.length){
        if(!dotEdit){ snapshot(); dotEdit = true; }
        dots.forEach(function(s){ s.dotSize = v; });
        draw();
      }
    });
    dotSel.addEventListener("change", function(){ dotEdit = false; syncBar(); });

    // 文字の縁 (v1.0.89): f turns an edge setting { on, color, alpha } into the new one. It changes the text being
    // typed (new text: the next texts' too), or the picked texts (the text just written: the next texts' too),
    // or else the next text's. Settings for the next text are remembered for next time.
    function changeEdge(f, sliding){
      var fill = function(x){ return { on:x.on, color:x.color || nextEdge.color, alpha:x.alpha || nextEdge.alpha }; };
      var setNext = function(x){ nextEdge = x; rememberEdge(x); };
      if(textBox){
        var nb = f(fill(edgeSetting(textBox.edge, textBox.color)));
        textBox.edge = edgeValue(nb);
        if(!textBox.orig){ setNext(nb); }
        textBox.fit();
        if(!sliding){ textBox.el.focus(); }
        syncBar();
        return;
      }
      var texts = pickedShapes().filter(function(s){ return s.type === "text"; });
      if(texts.length){
        if(!sliding){ snapshot(); } else if(!edgeEdit){ snapshot(); edgeEdit = true; }
        texts.forEach(function(s){ s.edge = edgeValue(f(fill(edgeSetting(s.edge, s.color)))); });
        if(isAutoPick()){ setNext(f(fill(edgeSetting(texts[0].edge, texts[0].color)))); }
        draw();
        if(!sliding){ syncBar(); }
        return;
      }
      setNext(f(nextEdge));
      if(!sliding){ syncBar(); }
    }
    // 濃さ: moving it also turns the edge on.
    edgeSel.addEventListener("input", function(){
      var a = Number(edgeSel.value) / 100;
      edgeVal.textContent = edgeSel.value + "%";
      edgeBtn.classList.add("on");
      edgeBtn.textContent = "縁あり";
      changeEdge(function(x){ return { on:true, color:x.color, alpha:a }; }, true);
    });
    edgeSel.addEventListener("change", function(){
      edgeEdit = false;
      syncBar();
      if(textBox){ textBox.el.focus(); }
    });

    var done = false;
    var askResolve = null;   // the 保存しますか？ question over the picture, while it is shown
    function close(result, keepWindow){
      if(done) return;
      done = true;
      if(askResolve){ askResolve("stay"); }
      hwin.removeEventListener("resize", fit);
      hwin.removeEventListener("blur", closeMenu);
      doc.removeEventListener("pointerdown", menuAway, true);
      doc.removeEventListener("keydown", onKey, true);
      doc.removeEventListener("keydown", onShift);
      doc.removeEventListener("keyup", onShift);
      if(ro){ ro.disconnect(); }
      if(host.popup){
        winState = null;
        if(keepWindow){ root.remove(); }
        else if(!host.popup.closed){ host.popup.close(); }
      } else {
        root.remove();
      }
      resolve(result);
    }
    function changed(){ return JSON.stringify(state) !== initial || !!textBox || !!poly; }
    // ✕ 閉じる: the same as キャンセル, after asking if something was drawn (since the last 反映).
    function askClose(){
      commitPending();
      if(JSON.stringify(state) !== initial && !hwin.confirm("書き込みを反映せずに閉じますか？")) return;
      close(null);
    }
    root.querySelector(".imged-close").addEventListener("click", askClose);
    // The separate window's own ✕: the same question; closing it otherwise counts as キャンセル.
    var ro = null;
    if(host.popup){
      winState = {
        w: host.popup, key: opts.key || null, cancel: function(){ close(null); }, changed: changed,
        apply: doApply, ask: askSwitch, release: function(){ close(null, true); }
      };
      hwin.addEventListener("beforeunload", function(e){
        if(done || !changed()) return;
        e.preventDefault();
        e.returnValue = "";
        setTimeout(function(){
          if(!done && hwin.confirm("書き込みを反映せずに閉じますか？")){ close(null); }
        }, 0);
      });
      hwin.addEventListener("pagehide", function(){ close(null); });
      // The style sheets load after the editor is built, and the window can be resized or
      // maximised on another display: fit the picture whenever the stage changes size.
      if(hwin.ResizeObserver){ ro = new hwin.ResizeObserver(fit); ro.observe(stage); }
    }
    function isEmpty(){
      return !state.shapes.length && state.crop.x === 0 && state.crop.y === 0 && state.crop.w === W && state.crop.h === H;
    }
    root.querySelector(".imged-foot").addEventListener("click", function(e){
      var b = e.target.closest("button");
      if(!b) return;
      var act = b.getAttribute("data-act");
      if(act === "cancel"){ if(keepOpen){ askClose(); } else { close(null); } return; }
      if(act === "reset"){ commitPending(); snapshot(); selection = []; state.shapes = []; state.crop = Object.assign({}, full); draw(); syncBar(); return; }
      if(act === "save"){ doApply().catch(function(){}); }
    });
    // What 書き込みを反映 does. Resolves once applied (or when there is nothing to apply); rejects when it
    // could not be applied.
    function doApply(){
      commitPending();
      if(applying) return Promise.reject();
      if(JSON.stringify(state) === initial){
        if(keepOpen){ setStatus("反映していない書き込みはありません"); } else { close(null); }
        return Promise.resolve();
      }
      if(isEmpty()){ return finish({ empty:true }); }
      var out = doc.createElement("canvas");
      out.width = state.crop.w;
      out.height = state.crop.h;
      paint(out.getContext("2d"), img, state.crop, state.shapes, null);
      var crop = JSON.parse(JSON.stringify(state.crop)), shapes = JSON.parse(JSON.stringify(state.shapes));
      return new Promise(function(resolveBlob, rejectBlob){
        out.toBlob(function(blob){
          finish({ empty:false, crop:crop, shapes:shapes, blob:blob }).then(resolveBlob, rejectBlob);
        }, "image/png");
      });
    }
    // Over the picture: another picture was chosen while this one has drawing not yet applied.
    function askSwitch(){
      commitPending();
      if(askResolve){ askResolve("stay"); }   // asked again meanwhile: only the latest choice counts
      return new Promise(function(resolveAsk){
        var ov = doc.createElement("div");
        ov.className = "imged-ask";
        ov.innerHTML =
          '<div class="imged-ask-box">' +
            '<p class="imged-ask-title">前の画像の書き込みを保存しますか？</p>' +
            '<p class="imged-ask-sub">この画像には、まだ反映していない書き込みがあります。次の画像に切り替える前に、どうしますか？</p>' +
            '<div class="imged-ask-btns">' +
              '<button type="button" class="btn btn-primary btn-small" data-ans="apply">保存して次の画像へ</button>' +
              '<button type="button" class="btn btn-ghost btn-small" data-ans="discard">保存しないで次の画像へ</button>' +
              '<button type="button" class="btn btn-ghost btn-small" data-ans="stay">戻る（この画像を続ける）</button>' +
            '</div>' +
          '</div>';
        root.appendChild(ov);
        askResolve = function(ans){ askResolve = null; ov.remove(); resolveAsk(ans); };
        ov.addEventListener("click", function(e){
          var b = e.target.closest("button");
          if(b && askResolve){ askResolve(b.getAttribute("data-ans")); }
        });
      });
    }
    function setStatus(text){ statusEl.textContent = text; }
    // Overlay / no onApply: 反映 closes. keepOpen: hand it over and stay open; what was applied
    // becomes the new starting point, so closing afterwards asks only about later drawing.
    function finish(result){
      if(!keepOpen){ close(result); return Promise.resolve(); }
      var applied = JSON.stringify(state);
      applying = true;
      saveBtn.disabled = true;
      setStatus("反映しています…");
      return Promise.resolve().then(function(){ return opts.onApply(result); }).then(function(){
        applying = false;
        saveBtn.disabled = false;
        if(done) return;
        initial = applied;
        setStatus(JSON.stringify(state) === applied ? "反映しました（続けて書き込めます）" : "反映しました（その後の書き込みはまだ反映していません）");
      }, function(err){
        applying = false;
        saveBtn.disabled = false;
        if(!done){ setStatus("反映できませんでした"); }
        throw err;
      });
    }

    function onKey(e){
      if(menu && e.key === "Escape"){ e.preventDefault(); closeMenu(); return; }
      closeMenu();
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
      var picks = pickedShapes();
      // 重なり順 (v1.0.120): Ctrl+] 前面へ, Ctrl+[ 背面へ, with Shift 最前面へ / 最背面へ ("}" "{" with Shift on most keyboards)
      if((e.ctrlKey || e.metaKey) && !e.altKey && picks.length){
        var ord = { "]":"forward", "[":"backward", "}":"front", "{":"back" }[e.key];
        if(ord && e.shiftKey && ord === "forward"){ ord = "front"; }
        if(ord && e.shiftKey && ord === "backward"){ ord = "back"; }
        if(ord){ e.preventDefault(); reorder(ord); return; }
        // 一体化 (v1.0.137): Ctrl+G, and with Shift 一体化を解除
        if(e.key.toLowerCase() === "g"){ e.preventDefault(); setGroup(!e.shiftKey); return; }
      }
      if((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey){
        var k = e.key.toLowerCase();
        if(k === "c" && picks.length){ e.preventDefault(); copySelected(); return; }
        if(k === "v" && clip && tool !== "crop"){ e.preventDefault(); pasteClip(); return; }
        // Ctrl+A (v1.0.80): pick every shape.
        if(k === "a" && tool !== "crop" && !poly && state.shapes.length){
          e.preventDefault();
          selection = state.shapes.map(function(s, i){ return i; });
          autoIdx = -1;
          draw(); syncBar();
          return;
        }
      }
      if(picks.length && e.target !== fontSel && e.target !== dotSel && e.target !== widthSel && e.target !== edgeSel){
        if(e.key === "Delete" || e.key === "Backspace"){
          e.preventDefault();
          snapshot();
          state.shapes = state.shapes.filter(function(s, i){ return !isPicked(i); });
          selection = [];
          draw(); syncBar();
          return;
        }
        var dir = { ArrowLeft:[-1,0], ArrowRight:[1,0], ArrowUp:[0,-1], ArrowDown:[0,1] }[e.key];
        if(dir){
          e.preventDefault();
          // One screen pixel per press (ten with Shift); a run of presses is one undo step.
          var step = (e.shiftKey ? 10 : 1) * canvas.width / Math.max(canvas.getBoundingClientRect().width, 1);
          var now = Date.now();
          if(now - lastNudge > 800){ snapshot(); }
          lastNudge = now;
          picks.forEach(function(s){ moveShape(s, dir[0] * step, dir[1] * step); });
          keepInView(picks);
          draw();
          return;
        }
        // Enter (v1.0.79) lets go too: the way to finish the thing just drawn and picked.
        if(e.key === "Escape" || e.key === "Enter"){ e.preventDefault(); select(-1); draw(); syncBar(); return; }
      }
      if((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z"){
        e.preventDefault();
        if(history.length){ restore(history.pop()); selection = []; draw(); syncBar(); }
      } else if(e.key === "Escape"){
        e.preventDefault();
        if(keepOpen){ askClose(); } else { close(null); }
      }
    }
    doc.addEventListener("keydown", onKey, true);
    hwin.addEventListener("resize", fit);

    syncBar();
    draw();
    fit();
    if(host.popup){ try { hwin.focus(); } catch(e){} }
  }

  window.ImageEditor = { open: open, isOpen: isOpen, hasUnapplied: hasUnapplied, closeWindow: closeWindow };
})();
