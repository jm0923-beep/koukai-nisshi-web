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
//
// Annotations are kept as data, not burned into the original:
//   crop   { x, y, w, h }                  in original-image pixels
//   shapes [{ type, color, size, ... }]    in original-image pixels
//     text: fontSize (units of longest side/1000); older data has only size;
//           wrap (optional, v1.0.47): width to wrap at, in original-image pixels
//     poly: points [[x,y]...], closed
//     rect / ellipse: fill (optional, v1.0.56): the inside is painted in the line's colour
//     dot (v1.0.56): x, y (centre), dotSize (diameter, same unit as fontSize); no size (thickness)
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
    { v:"#E53935", n:"赤" }, { v:"#FDD835", n:"黄" }, { v:"#1E88E5", n:"青" },
    { v:"#43A047", n:"緑" }, { v:"#FFFFFF", n:"白" }, { v:"#111111", n:"黒" }
  ];
  var TOOLS = [
    ["move","✥","選択・移動"], ["pen","✎","ペン"], ["poly","⋀","折れ線"], ["line","／","直線"], ["arrow","→","矢印"], ["rect","□","四角"],
    ["ellipse","○","丸"], ["dot","●","点"], ["text","A","文字"], ["crop","⌗","トリミング"]
  ];
  var SIZES = [["xs","極細"], ["s","細"], ["m","中"], ["l","太"]];
  var LINE = { xs:1.5, s:3, m:6, l:10 };
  var FONT = { s:28, m:44, l:64 };   // fallback for text saved before fontSize existed
  // Font sizes as numbers (v1.0.40), in the same unit as before: longest side / 1000, so on a
  // picture shown about 1000 pixels wide the number is roughly the letter height in pixels.
  // Includes every value the old named list (極小〜超特大) could save.
  var FONT_SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 22, 24, 28, 32, 36, 40, 44, 48, 56, 64, 72, 88, 96, 120];
  var FONT_DEFAULT = 12;
  // The last size chosen, used as the next default. A new key since v1.0.45, when the
  // default became 12, so a size remembered from before starts again at 12.
  var FONT_KEY = "imged-font-size-2";
  function savedFontSize(){
    try {
      var v = Number(window.localStorage.getItem(FONT_KEY));
      return FONT_SIZES.indexOf(v) >= 0 ? v : FONT_DEFAULT;
    } catch(e){ return FONT_DEFAULT; }
  }
  function rememberFontSize(v){ try { window.localStorage.setItem(FONT_KEY, String(v)); } catch(e){} }
  // Dots (v1.0.56): filled circles. Their size is the diameter in the same unit as font sizes, chosen
  // from numbers like the font size; the last one chosen is the next default.
  var DOT_SIZES = [4, 6, 8, 10, 12, 14, 16, 20, 24, 28, 32, 40, 48, 64];
  var DOT_DEFAULT = 12, DOT_KEY = "imged-dot-size";
  function savedDotSize(){
    try {
      var v = Number(window.localStorage.getItem(DOT_KEY));
      return DOT_SIZES.indexOf(v) >= 0 ? v : DOT_DEFAULT;
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
  function contrastFor(hex){
    var n = parseInt(hex.slice(1), 16);
    var lum = (0.299*((n>>16)&255) + 0.587*((n>>8)&255) + 0.114*(n&255)) / 255;
    return lum > 0.6 ? "rgba(0,0,0,0.85)" : "rgba(255,255,255,0.9)";
  }
  // Moves the end point of a drag shape to p. With Shift, rect/ellipse become
  // square/circle and line/arrow snap to 45-degree steps.
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
    if(s.type === "rect"){
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
  // ctx.font must already be the text's font.
  function textLines(ctx, s){
    var paras = String(s.text).split("\n");
    if(!s.wrap) return paras;
    var out = [];
    paras.forEach(function(para){
      var line = "";
      Array.from(para).forEach(function(ch){
        if(line && ctx.measureText(line + ch).width > s.wrap){ out.push(line); line = ch; }
        else { line += ch; }
      });
      out.push(line);
    });
    return out;
  }
  // The box a shape covers, for hit-testing text and drawing the selection frame.
  function shapeBox(ctx, s, u){
    if(s.type === "text"){
      var fs = textFont(s, u), lines, w = 0;
      ctx.save();
      ctx.font = "bold " + fs + "px " + FONT_FAMILY;
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
      var w = noLine(s) ? 0 : (LINE[s.size] || LINE.m) * u / 2;
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
  //   rect, pen, polyline: the opposite side stays; corners with Shift keep the proportions.
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
        ctx.beginPath();
        ctx.moveTo(s.x1, s.y1);
        ctx.lineTo(s.x2, s.y2);
        ctx.stroke();
        break;
      case "arrow":
        var a = Math.atan2(s.y2 - s.y1, s.x2 - s.x1);
        var len = Math.max(ctx.lineWidth * 4, 14 * u);
        // The shaft stops at the base of the head (v1.0.44): drawn to the tip, its round end
        // and its width stuck out past the point and the sides of the triangle on thick arrows.
        var back = len * Math.cos(0.45);
        var total = Math.sqrt(Math.pow(s.x2 - s.x1, 2) + Math.pow(s.y2 - s.y1, 2));
        if(total > back){
          ctx.beginPath();
          ctx.moveTo(s.x1, s.y1);
          ctx.lineTo(s.x2 - back * Math.cos(a), s.y2 - back * Math.sin(a));
          ctx.stroke();
        }
        ctx.beginPath();
        ctx.moveTo(s.x2, s.y2);
        ctx.lineTo(s.x2 - len*Math.cos(a - 0.45), s.y2 - len*Math.sin(a - 0.45));
        ctx.lineTo(s.x2 - len*Math.cos(a + 0.45), s.y2 - len*Math.sin(a + 0.45));
        ctx.closePath();
        ctx.fill();
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
      case "dot":
        ctx.beginPath();
        ctx.arc(s.x, s.y, Math.max(dotR(s, u), 0.5), 0, Math.PI*2);
        ctx.fill();
        break;
      case "text":
        var fs = (s.fontSize || FONT[s.size]) * u;
        ctx.font = "bold " + fs + "px " + FONT_FAMILY;
        ctx.textBaseline = "top";
        ctx.lineWidth = Math.max(fs / 7, 1);
        ctx.strokeStyle = contrastFor(s.color);
        textLines(ctx, s).forEach(function(line, idx){
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

  function open(opts){
    if(opts.separateWindow && isOpen()){
      try { winState.w.focus(); } catch(e){}
      return Promise.resolve(null);
    }
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
    var tool = "pen", color = COLORS[0].v, size = "xs", fontSize = savedFontSize();
    var dotSize = savedDotSize(), fillMode = false;   // the next dot's size; whether the next □ ○ is filled (v1.0.56)
    var current = null;      // shape being drawn
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
    var pickCandidate = null;  // { i, x, y }: a drawing tool pressed on shape i (-1: let go of the picked one); a click without a drag picks it
    var textDraft = null;    // { x1, y1, x2, y2, cx, cy, letGo } while pressing / dragging with 文字

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
        '<div class="imged-group imged-sizes"><span class="imged-label">太さ</span>' + SIZES.map(function(s){
          return '<button type="button" class="imged-size" data-size="'+s[0]+'">'+s[1]+'</button>';
        }).join("") +
          '<button type="button" class="imged-size imged-fill" data-act="fill" title="四角と丸の中を塗りつぶす（選んだ四角・丸にも使えます）">■ 塗りつぶし</button>' +
        '</div>' +
        '<div class="imged-group imged-fonts"><span class="imged-label">文字の大きさ</span>' +
          '<select class="imged-font">' + FONT_SIZES.map(function(f){
            return '<option value="'+f+'">'+f+'</option>';
          }).join("") + '</select>' +
        '</div>' +
        '<div class="imged-group imged-dots"><span class="imged-label">点の大きさ</span>' +
          '<select class="imged-dot">' + DOT_SIZES.map(function(f){
            return '<option value="'+f+'">'+f+'</option>';
          }).join("") + '</select>' +
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
    var dotSel = root.querySelector(".imged-dot"), fillBtn = root.querySelector('[data-act="fill"]');

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
        ctx.strokeRect(tb.x, tb.y, tb.w, Math.max(tb.h, fontSize * unitFor(W, H) * 1.25));
        ctx.restore();
      }
      var hv = !dragMove && !isPicked(hover) && tool !== "crop" ? state.shapes[hover] : null;
      if(hv){
        // A faint frame around the shape a click would pick.
        var hb = shapeBox(ctx, hv, unitFor(W, H)), hp = framePad(hv, px);
        ctx.save();
        ctx.translate(-view.x, -view.y);
        ctx.lineWidth = 1.5 * px;
        ctx.setLineDash([4 * px, 4 * px]);
        ctx.strokeStyle = "rgba(203,163,95,0.9)";
        ctx.strokeRect(hb.x - hp, hb.y - hp, hb.w + hp*2, hb.h + hp*2);
        ctx.restore();
      }
      var picks = pickedShapes(), sel = selectedShape();
      if(picks.length || (current && current.type === "ellipse")){
        ctx.save();
        ctx.translate(-view.x, -view.y);
        ctx.lineWidth = 1.5 * px;
        if(picks.length){
          // A dotted frame around each picked shape. Handles only when one is picked (resizing
          // works on one shape); a picked line alone shows just its two ends.
          picks.forEach(function(s){
            if(sel && (s.type === "line" || s.type === "arrow")) return;
            var b = shapeBox(ctx, s, unitFor(W, H)), pad = framePad(s, px);
            ctx.lineDashOffset = 0;
            ctx.setLineDash([6 * px, 4 * px]);
            ctx.strokeStyle = "#FFFFFF";
            ctx.strokeRect(b.x - pad, b.y - pad, b.w + pad*2, b.h + pad*2);
            ctx.lineDashOffset = 5 * px;
            ctx.strokeStyle = "#111111";
            ctx.strokeRect(b.x - pad, b.y - pad, b.w + pad*2, b.h + pad*2);
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
      // share it); the settings for drawing new things (color, size, fontSize) stay as they were.
      var picks = pickedShapes(), move = tool === "move";
      var texts = picks.filter(function(s){ return s.type === "text"; });
      var lines = picks.filter(function(s){ return !noLine(s); });
      var dots = picks.filter(function(s){ return s.type === "dot"; });
      var boxes = picks.filter(function(s){ return s.type === "rect" || s.type === "ellipse"; });
      function common(list, f){ var v = list.length ? f(list[0]) : null; return list.every(function(s){ return f(s) === v; }) ? v : null; }
      var showColor = picks.length ? common(picks, function(s){ return s.color; }) : color;
      var showSize = picks.length ? common(lines, function(s){ return s.size; }) : (move ? null : size);
      // Picked texts of different sizes show "–": a number already shown could not be chosen again
      // (no change event), so they could not all be set to it.
      var showFont = texts.length ? common(texts, function(s){ return s.fontSize || FONT[s.size]; }) : fontSize;
      // Drawn text open for rewriting (double-click): the bar shows that text's colour and size.
      var rewriting = !!(textBox && textBox.orig);
      if(textBox){ showColor = textBox.color; }
      if(rewriting){ showFont = textBox.fontSize; }
      Array.prototype.forEach.call(root.querySelectorAll(".imged-tool"), function(b){ b.classList.toggle("on", b.getAttribute("data-tool") === tool); });
      Array.prototype.forEach.call(root.querySelectorAll(".imged-color"), function(b){ b.classList.toggle("on", b.getAttribute("data-color") === showColor); });
      Array.prototype.forEach.call(root.querySelectorAll(".imged-size[data-size]"), function(b){
        b.classList.toggle("on", b.getAttribute("data-size") === showSize);
        b.disabled = picks.length ? !lines.length : move || tool === "dot";
      });
      // 塗りつぶし (v1.0.56): with □ ○ picked it shows / switches theirs, with the □ ○ tools the next shape's
      fillBtn.classList.toggle("on", boxes.length ? boxes.every(function(s){ return s.fill; }) : (!picks.length && fillMode && (tool === "rect" || tool === "ellipse")));
      fillBtn.disabled = picks.length ? !boxes.length : !(tool === "rect" || tool === "ellipse");
      fontSel.disabled = rewriting ? false : picks.length ? !texts.length : move;
      // 点の大きさ: the picked dots' size ("–" when they differ), or the next dot's
      var showDot = dots.length ? common(dots, function(s){ return s.dotSize || DOT_DEFAULT; }) : dotSize;
      var dblank = dotSel.querySelector('option[value=""]');
      if(showDot === null && !dblank){
        dblank = doc.createElement("option"); dblank.value = ""; dblank.textContent = "–";
        dotSel.insertBefore(dblank, dotSel.firstChild);
      } else if(showDot !== null && dblank){ dblank.remove(); }
      if(showDot !== null && !dotSel.querySelector('option[value="'+showDot+'"]')){
        // a size made by dragging a corner is not in the list: show its own number
        var od = doc.createElement("option");
        od.value = od.textContent = String(showDot);
        var nd = Array.prototype.filter.call(dotSel.options, function(x){ return Number(x.value) > showDot; })[0];
        dotSel.insertBefore(od, nd || null);
      }
      dotSel.value = showDot === null ? "" : String(showDot);
      dotSel.disabled = picks.length ? !dots.length : tool !== "dot";
      root.querySelector(".imged-dots").hidden = tool === "crop";
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
      var picked = picks.length > 1
        ? picks.length + "個を選んでいます：ドラッグか矢印キー（Shiftで大きく）でまとめて移動。色・太さ・文字の大きさは選んだものがまとめて変わります。Ctrl+クリックで追加・外す、Ctrl+C／Ctrl+Vでコピー・貼り付け、Deleteで削除、Escで選択を外す"
        : "選んだ書き込み：ドラッグか矢印キー（Shiftで大きく）で移動、□や○で大きさ（Shiftで比を保つ。文字の左右の□は折り返しの幅）。色・太さ・大きさ・塗りつぶしはこの書き込みだけ変わります。文字はダブルクリックで書き換え。Ctrl+クリックでほかの書き込みも選べます。Ctrl+C／Ctrl+Vでコピー・貼り付け、Deleteで削除、Escで選択を外す";
      hint.textContent = rewriting
        ? "文字を書き換えています（大きさと色はそのまま）：Enterで改行、Ctrl+Enterかほかの場所をクリックで確定、Escで元のまま。全部消して確定すると、その文字を削除します"
        : picks.length ? picked : {
        move:"動かしたい線・丸・文字などをクリックして選びます（Ctrl+クリックで複数。ほかの道具のときも、描いたものはクリックで選べます）。文字はダブルクリックで書き換えられます",
        pen:"ドラッグして自由に描きます（描いたものはクリックで選べます）",
        poly: poly
          ? "クリックで点を追加します。ダブルクリックかEnterで終了、始点をクリックすると閉じた図形になります（Ctrl+Zで1点戻す、Escで取り消し）"
          : "クリックするたびに点を打ち、線をつないでいきます（Shiftで水平・垂直・45°）。描いたものの上をクリックすると、そのものを選びます",
        line:"始点から終点までドラッグします（Shiftで水平・垂直・45°）。描いたものはクリックで選べます",
        arrow:"矢印の根元から先端までドラッグします（Shiftで水平・垂直・45°）。描いたものはクリックで選べます",
        rect:"対角線の方向にドラッグします（Shiftで正方形）。「■ 塗りつぶし」で中を塗れます。描いたものはクリックで選べます",
        ellipse:"円の中心にしたい場所から外へドラッグします（Shiftで真円）。「■ 塗りつぶし」で中を塗れます。描いたものはクリックで選べます",
        dot:"クリックした所に塗りつぶした点を置きます（押したまま動かすと、離した所に置きます）。大きさは「点の大きさ」で選びます。描いたものはクリックで選べます",
        text:"クリックした所に入力します。横にドラッグして枠を作ると、その幅で折り返します。Enterで改行、Ctrl+Enterかほかの場所をクリックで確定（Escで取り消し）。描いたものの上をクリックすると、そのものを選びます。書いた文字はダブルクリックで書き換え",
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
    function framePad(s, px){ return noLine(s) ? 4 * px : 6 * px + (LINE[s.size] || LINE.m) * unitFor(W, H) / 2; }
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
    // Starts dragging the picked shapes: a body moves them all, a handle resizes the one picked.
    // clickOn: the shape pressed; a click on it without a drag leaves only it picked.
    function startDrag(e, q, handle, clickOn){
      hover = -1;
      canvas.setPointerCapture(e.pointerId);
      dragMove = { start: q, idx: selection.slice(), orig: selection.map(function(i){ return JSON.stringify(state.shapes[i]); }),
                   moved: false, handle: handle || null, clickOn: clickOn === undefined ? -1 : clickOn };
    }
    function hitAt(p){
      var tol = 8 * canvas.width / Math.max(canvas.getBoundingClientRect().width, 1);
      return hitShape(ctx, state.shapes, p, unitFor(W, H), tol);
    }
    function copySelected(){
      var picks = pickedShapes();
      if(!picks.length) return;
      clip = { shapes: JSON.stringify(picks), u: unitFor(W, H) };
      clipPastes = 0;
      setStatus(picks.length > 1 ? picks.length + "個をコピーしました" : "コピーしました");
      syncBar();
    }
    // The copies go on top, offset from the originals, and are picked so they can be moved at once.
    function pasteClip(){
      if(!clip || tool === "crop") return;
      commitPending();
      var list = JSON.parse(clip.shapes);
      var k = unitFor(W, H) / clip.u;
      clipPastes++;
      var off = 20 * clipPastes * canvas.width / Math.max(canvas.getBoundingClientRect().width, 1);
      list.forEach(function(s){
        if(Math.abs(k - 1) > 1e-6){ scaleShape(s, k); }
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
    // Picks shape i alone (-1: nothing).
    function select(i){ selection = i >= 0 ? [i] : []; }
    // Ctrl+click: adds shape i to the picked ones, or takes it out if it is already picked.
    function togglePick(i){
      var at = selection.indexOf(i);
      if(at >= 0){ selection.splice(at, 1); } else { selection.push(i); }
    }

    function commitText(){
      if(!textBox) return;
      var box = textBox;
      textBox = null;
      var text = box.el.value.replace(/\s+$/, "");
      box.el.remove();
      if(box.orig){
        // Rewriting drawn text (v1.0.51): the same text object keeps its place, colour and width;
        // emptied, it is removed. It stays picked, so it can be moved or recoloured at once.
        var i = state.shapes.indexOf(box.orig);
        var same = text === box.orig.text && box.color === box.orig.color && box.fontSize === (box.orig.fontSize || FONT[box.orig.size]);
        if(i >= 0 && !same){
          snapshot();
          if(text){ state.shapes[i] = Object.assign({}, box.orig, { text:text, fontSize:box.fontSize, color:box.color }); select(i); }
          else { state.shapes.splice(i, 1); select(-1); }
        } else if(i >= 0){ select(i); }
        draw();
        syncBar();
        return;
      }
      if(text){
        snapshot();
        var t = { type:"text", x:box.x, y:box.y, text:text, color:box.color, size:size, fontSize:box.fontSize };
        if(box.wrap){ t.wrap = box.wrap; }
        state.shapes.push(t);
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
      var size0 = orig ? (orig.fontSize || FONT[orig.size]) : fontSize;
      var fs = size0 * unitFor(W, H) * scale;
      el.style.left = (cx - srect.left) + "px";
      el.style.top = (cy - srect.top) + "px";
      // Wrapping text is typed at its real size, so it breaks where the finished text will.
      el.style.fontSize = (wrap ? Math.max(fs, 6) : Math.max(fs, 12)) + "px";
      el.style.color = orig ? orig.color : color;
      el.rows = 1;
      if(wrap){ el.style.minWidth = "0"; el.style.width = (wrap * scale) + "px"; el.setAttribute("wrap", "soft"); }
      else { el.setAttribute("wrap", "off"); }
      if(orig){ el.value = orig.text; }
      stage.appendChild(el);
      textBox = { el:el, x:p.x, y:p.y, wrap:wrap || 0, fit:fit, orig:orig || null, fontSize:size0, color: orig ? orig.color : color };
      function fit(){
        el.style.height = "auto";
        el.style.height = el.scrollHeight + "px";
        if(!wrap){ el.style.width = "auto"; el.style.width = Math.max(120, el.scrollWidth + 4) + "px"; }
      }
      // Enter starts a new line; Ctrl+Enter or a click elsewhere finishes; Esc throws it away.
      el.addEventListener("keydown", function(ev){
        ev.stopPropagation();
        if(ev.key === "Enter" && (ev.ctrlKey || ev.metaKey) && !ev.isComposing){ ev.preventDefault(); commitText(); }
        if(ev.key === "Escape"){
          ev.preventDefault();
          textBox = null;
          el.remove();
          // Rewriting: the text goes back as it was, still picked.
          if(orig){ select(state.shapes.indexOf(orig)); draw(); syncBar(); }
        }
      });
      el.addEventListener("input", fit);
      fit();
      el.addEventListener("blur", function(ev){
        // Choosing a font size while typing keeps the box open and resizes it.
        if(ev.relatedTarget === fontSel) return;
        setTimeout(commitText, 0);
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
      var i = hitAt(toImage(e, true));
      if(isPicked(i) && editText(i)){ e.preventDefault(); }
    });

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
      // The presses below call preventDefault, which keeps the focus where it was: after choosing a
      // font size, the arrow keys and Delete would still go to that box instead of the picked shapes.
      if(doc.activeElement === fontSel){ fontSel.blur(); }
      if(doc.activeElement === dotSel){ dotSel.blur(); }
      // A click on the picture while drawn text is being rewritten only finishes it, with any tool
      // (preventDefault keeps the box from losing focus, so its own blur would not do it).
      if(textBox && textBox.orig){ e.preventDefault(); commitText(); return; }
      var p = toImage(e), q = toImage(e, true);
      pickCandidate = null;
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
        var h = handleAt(q), on = hitAt(q);
        if(h || isPicked(on)){ e.preventDefault(); commitText(); startDrag(e, q, h, h ? -1 : on); return; }
      }
      if(tool === "move"){
        e.preventDefault();
        var i = hitAt(q);
        select(i);
        draw(); syncBar();
        // Measured after the bar is updated, in case that moved the picture.
        if(i >= 0){ startDrag(e, toImage(e, true), null); }
        return;
      }
      if(tool === "poly" && poly){ onPolyDown(e); return; }
      if(tool === "crop"){ commitText(); canvas.setPointerCapture(e.pointerId); cropDraft = { x1:p.x, y1:p.y, x2:p.x, y2:p.y }; return; }
      var hit = hitAt(q);
      // A click on an empty spot while something is picked only lets go of it (a drag still draws).
      var hadPick = selection.length > 0;
      if(hadPick){ selection = []; draw(); syncBar(); }
      if(tool === "poly"){
        // 折れ線 is built by clicks, so before its first point a click on a shape picks it
        // and a click on an empty spot while something is picked only lets go.
        if(hit >= 0){ e.preventDefault(); select(hit); draw(); syncBar(); startDrag(e, q, null); return; }
        if(hadPick){ e.preventDefault(); return; }
        onPolyDown(e);
        return;
      }
      if(tool === "text"){
        e.preventDefault();
        // A click while typing only finishes the text.
        if(textBox){ commitText(); return; }
        // A click on a drawn shape picks it (and can drag it); anywhere else starts new text.
        if(hit >= 0){ select(hit); draw(); syncBar(); startDrag(e, q, null); return; }
        canvas.setPointerCapture(e.pointerId);
        textDraft = { x1:p.x, y1:p.y, x2:p.x, y2:p.y, cx:e.clientX, cy:e.clientY, letGo:hadPick };
        return;
      }
      commitText();
      canvas.setPointerCapture(e.pointerId);
      if(hit >= 0 || hadPick){ pickCandidate = { i:hit, x:e.clientX, y:e.clientY }; }
      current = tool === "pen" ? { type:"pen", color:color, size:size, points:[[p.x, p.y]] }
        : tool === "dot" ? { type:"dot", color:color, dotSize:dotSize, x:p.x, y:p.y }   // follows the pointer until let go
        : { type:tool, color:color, size:size, x1:p.x, y1:p.y, x2:p.x, y2:p.y };
      if(tool === "ellipse"){ current.cx = p.x; current.cy = p.y; }
      if((tool === "rect" || tool === "ellipse") && fillMode){ current.fill = true; }
      draw();
    });
    canvas.addEventListener("pointermove", function(e){
      if(poly){ polyHover = polyPoint(e); lastRaw = { e:{ clientX:e.clientX, clientY:e.clientY } }; draw(); return; }
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
        var hq = toImage(e, true), hh = handleAt(hq), hi = hitAt(hq);
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
      if(dragMove){
        // A click (no drag) on one of several picked shapes leaves only that one picked.
        var d = dragMove;
        dragMove = null;
        if(!d.moved && d.clickOn >= 0 && selection.length > 1 && selection.join() === d.idx.join()){ select(d.clickOn); }
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
        } else if(!t.letGo){
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
        // Pressed on a drawn shape and let go without dragging: pick that shape instead.
        // A hand can move a few pixels while clicking; a shape too small to keep counts as a click too.
        var c = pickCandidate;
        if(c && e && ((Math.abs(e.clientX - c.x) < 6 && Math.abs(e.clientY - c.y) < 6) || !big)){ select(c.i); }
        else if(big){ snapshot(); state.shapes.push(s); }
      }
      pickCandidate = null;
      draw();
      syncBar();
    }
    canvas.addEventListener("pointerup", endStroke);
    canvas.addEventListener("pointercancel", endStroke);

    // While text is being typed or rewritten, pressing a colour must not take the focus from its box
    // (that would finish it in the old colour, and the colour would only go to the next text).
    root.querySelector(".imged-bar").addEventListener("mousedown", function(e){
      if(textBox && e.target.closest("[data-color]")){ e.preventDefault(); }
    });
    root.querySelector(".imged-bar").addEventListener("click", function(e){
      var b = e.target.closest("button");
      if(!b) return;
      // A colour chosen while typing goes to that text (v1.0.52); for new text it is also the
      // colour of the texts after it, as before.
      if(textBox && b.hasAttribute("data-color")){
        textBox.color = b.getAttribute("data-color");
        textBox.el.style.color = textBox.color;
        if(!textBox.orig){ color = textBox.color; }
        textBox.el.focus();
        syncBar();
        return;
      }
      // Colour and thickness apply to a polyline in progress instead of ending it.
      if(poly && (b.hasAttribute("data-color") || b.hasAttribute("data-size"))){
        if(b.hasAttribute("data-color")){ color = poly.color = b.getAttribute("data-color"); }
        if(b.hasAttribute("data-size")){ size = poly.size = b.getAttribute("data-size"); }
        draw(); syncBar();
        return;
      }
      // Any other button finishes text being rewritten first (it stays picked).
      if(textBox && textBox.orig){ commitText(); }
      // Colour and thickness change the picked shapes (thickness: all but text).
      var picks = pickedShapes();
      if(picks.length && (b.hasAttribute("data-color") || b.hasAttribute("data-size"))){
        var key = b.hasAttribute("data-color") ? "color" : "size";
        var val = b.getAttribute("data-" + key);
        var targets = picks.filter(function(s){ return (key === "color" || !noLine(s)) && s[key] !== val; });
        if(targets.length){ snapshot(); targets.forEach(function(s){ s[key] = val; }); }
        draw(); syncBar();
        return;
      }
      // 塗りつぶし: picked □ ○ are all filled, or all unfilled when every one was filled already
      if(b.getAttribute("data-act") === "fill"){
        var boxes = picks.filter(function(s){ return s.type === "rect" || s.type === "ellipse"; });
        if(boxes.length){
          var on = !boxes.every(function(s){ return s.fill; });
          snapshot();
          boxes.forEach(function(s){ if(on){ s.fill = true; } else { delete s.fill; } });
        } else {
          fillMode = !fillMode;              // the next □ ○ drawn
        }
        draw(); syncBar();
        return;
      }
      commitPending();
      if(b.hasAttribute("data-tool")){ tool = b.getAttribute("data-tool"); selection = []; draw(); }
      if(b.hasAttribute("data-color")){ color = b.getAttribute("data-color"); }
      if(b.hasAttribute("data-size")){ size = b.getAttribute("data-size"); }
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
        var v = Number(fontSel.value);
        var targets = texts.filter(function(s){ return s.fontSize !== v; });
        if(targets.length){ snapshot(); targets.forEach(function(s){ s.fontSize = v; }); }
        draw(); syncBar();
        return;
      }
      // While rewriting drawn text, the size is that text's own; the size for new text stays as it was.
      if(!(textBox && textBox.orig)){
        fontSize = Number(fontSel.value);
        rememberFontSize(fontSize);
      }
      if(textBox){
        textBox.fontSize = Number(fontSel.value);
        var scale = canvas.getBoundingClientRect().width / canvas.width;
        textBox.el.style.fontSize = Math.max(textBox.fontSize * unitFor(W, H) * scale, textBox.wrap ? 6 : 12) + "px";
        textBox.fit();
        textBox.el.focus();
      }
    });

    // 点の大きさ: the picked dots, or the next dot (remembered for next time)
    dotSel.addEventListener("change", function(){
      if(!dotSel.value) return;    // "–" (picked dots of different sizes)
      var v = Number(dotSel.value);
      var dots = pickedShapes().filter(function(s){ return s.type === "dot"; });
      if(dots.length){
        var targets = dots.filter(function(s){ return s.dotSize !== v; });
        if(targets.length){ snapshot(); targets.forEach(function(s){ s.dotSize = v; }); }
      } else {
        dotSize = v;
        rememberDotSize(v);
      }
      draw(); syncBar();
    });

    var done = false;
    function close(result){
      if(done) return;
      done = true;
      hwin.removeEventListener("resize", fit);
      doc.removeEventListener("keydown", onKey, true);
      doc.removeEventListener("keydown", onShift);
      doc.removeEventListener("keyup", onShift);
      if(ro){ ro.disconnect(); }
      if(host.popup){
        winState = null;
        if(!host.popup.closed){ host.popup.close(); }
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
      winState = { w: host.popup, cancel: function(){ close(null); }, changed: changed };
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
      if(act === "save"){
        commitPending();
        if(applying) return;
        if(JSON.stringify(state) === initial){
          if(keepOpen){ setStatus("反映していない書き込みはありません"); } else { close(null); }
          return;
        }
        if(isEmpty()){ finish({ empty:true }); return; }
        var out = doc.createElement("canvas");
        out.width = state.crop.w;
        out.height = state.crop.h;
        paint(out.getContext("2d"), img, state.crop, state.shapes, null);
        var crop = JSON.parse(JSON.stringify(state.crop)), shapes = JSON.parse(JSON.stringify(state.shapes));
        out.toBlob(function(blob){
          finish({ empty:false, crop:crop, shapes:shapes, blob:blob });
        }, "image/png");
      }
    });
    function setStatus(text){ statusEl.textContent = text; }
    // Overlay / no onApply: 反映 closes. keepOpen: hand it over and stay open; what was applied
    // becomes the new starting point, so closing afterwards asks only about later drawing.
    function finish(result){
      if(!keepOpen){ close(result); return; }
      var applied = JSON.stringify(state);
      applying = true;
      saveBtn.disabled = true;
      setStatus("反映しています…");
      Promise.resolve().then(function(){ return opts.onApply(result); }).then(function(){
        applying = false;
        saveBtn.disabled = false;
        if(done) return;
        initial = applied;
        setStatus(JSON.stringify(state) === applied ? "反映しました（続けて書き込めます）" : "反映しました（その後の書き込みはまだ反映していません）");
      }, function(){
        applying = false;
        saveBtn.disabled = false;
        if(!done){ setStatus("反映できませんでした"); }
      });
    }

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
      var picks = pickedShapes();
      if((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey){
        var k = e.key.toLowerCase();
        if(k === "c" && picks.length){ e.preventDefault(); copySelected(); return; }
        if(k === "v" && clip && tool !== "crop"){ e.preventDefault(); pasteClip(); return; }
      }
      if(picks.length && e.target !== fontSel && e.target !== dotSel){
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
        if(e.key === "Escape"){ e.preventDefault(); selection = []; draw(); syncBar(); return; }
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
