/**
 * Junk Journal — pretext text-reflow demo
 *
 * HOW PRETEXT WORKS (the short version):
 * ──────────────────────────────────────
 * The browser's layout engine is powerful but slow for dynamic text:
 * reading a DOM element's measured size (getBoundingClientRect, offsetHeight)
 * forces a "layout reflow" — the browser has to synchronously recalculate
 * the entire page's geometry. On heavy pages this can take 10–100ms.
 *
 * pretext avoids this by measuring text through the *Canvas* font engine:
 *   const ctx = document.createElement('canvas').getContext('2d');
 *   ctx.font = '16px Georgia';
 *   ctx.measureText('hello').width  // fast — no reflow!
 *
 * It does this once per unique (text, font) pair, caches the measurements,
 * then does all subsequent layout as pure arithmetic. The result: 0.09ms per
 * layout pass on 500 paragraphs, at 120fps, with zero DOM reflow.
 *
 * The feature we exploit here: layoutNextLineRange() accepts a *per-line*
 * max-width. By narrowing the width on lines that overlap an image, text
 * automatically flows around the image — in real time as you drag.
 */

import {
  prepareWithSegments,   // one-time analysis: measure glyphs, segment Unicode
  layoutNextLineRange,   // given cursor + width → range of text for this line
  materializeLineRange,  // given range → { text } string for rendering
} from '@chenglou/pretext';

// ── CANVAS DIMENSIONS ────────────────────────────────────────────
const CW = 960;
const CH = 680;

const LINE_H    = 26;
const BODY_FONT = '16px Georgia, serif';

// ── CONTENT ZONE ─────────────────────────────────────────────────
const PAD   = 52;
const CON_X = PAD;
const CON_Y = PAD;
const CON_W = CW - PAD * 2;
const CON_H = CH - PAD * 2;

// ── STATE ────────────────────────────────────────────────────────
let journalText   = '';
let canvasImages  = [];  // { id, img, x, y, w, h }
let strokes       = [];  // { pts:[{x,y}], color, lineW }
let sidebarImages = [];  // { id, img }  (upload library)

let mode      = 'write'; // 'write' | 'draw'
let drawColor = '#1a0800';
let brushSize = 2;

// Transient interaction state
let draggingImg   = null;   // canvasImages entry being dragged
let dragOff       = {x:0, y:0};
let drawingStroke = null;   // stroke being drawn this frame
let hasFocus      = false;  // hidden textarea focused?
let showCursor    = true;   // blinks on/off
let cursorTimer   = null;

let selectedImg  = null;   // image showing resize/delete handles
let resizingImg  = null;
let resizeCorner = null;   // 'tl'|'tr'|'bl'|'br'
let resizeFixed  = null;   // fixed opposite corner {x,y} at resize start

// pretext: cache the prepared object so we only re-measure glyphs
// when the text actually changes. The layout loop runs every render
// (cheap arithmetic) but glyph measurement runs at most once per keystroke.
let _preparedText = null;
let _preparedFor  = null;

function getPrepared() {
  if (journalText !== _preparedFor) {
    /**
     * prepareWithSegments(text, font)
     * ─────────────────────────────────
     * Does the expensive one-time work:
     *   1. Tokenises text into Unicode grapheme clusters (handles emoji,
     *      CJK, Arabic, Hindi, etc. correctly)
     *   2. Measures each cluster's advance width via canvas.measureText()
     *   3. Finds legal line-break opportunities (UAX #14)
     *   4. Returns an opaque handle we pass to layoutNextLineRange()
     *
     * Why prepareWithSegments vs plain prepare()?
     *   prepare() only supports the simple layout() call that returns a
     *   total height. prepareWithSegments() enables the iterator API
     *   (layoutNextLineRange) that lets us vary width line-by-line —
     *   which is exactly how we reflow text around images.
     */
    _preparedText = prepareWithSegments(journalText, BODY_FONT);
    _preparedFor  = journalText;
  }
  return _preparedText;
}

// ── DOM ──────────────────────────────────────────────────────────
const canvas = document.getElementById('canvas');
const ctx    = canvas.getContext('2d');
canvas.width  = CW;
canvas.height = CH;
canvas.style.cursor = 'text';

// The hidden textarea is the canonical text input surface. The browser
// handles IME, clipboard, keyboard shortcuts, undo history, etc. for free.
// We just read .value and re-render the canvas.
//
// IMPORTANT: the element must be on-screen (not at top:-9999px) or some
// browsers refuse to give it focus. We keep it at top:0 left:0 as a 1×1px
// invisible sliver so focus() reliably works.
const input = document.createElement('textarea');
input.setAttribute('aria-hidden', 'true');
input.setAttribute('tabindex', '-1');
input.setAttribute('autocomplete', 'off');
input.setAttribute('autocorrect', 'off');
input.setAttribute('autocapitalize', 'off');
input.setAttribute('spellcheck', 'false');
input.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;padding:0;margin:0;border:0;outline:0;resize:none;background:transparent;color:transparent;overflow:hidden;';
document.body.appendChild(input);

// ── GEOMETRY HELPERS ─────────────────────────────────────────────
function canvasPos(e) {
  // Canvas may be CSS-scaled (width: min(760px, …)), so we must convert
  // client coordinates to internal canvas coordinates.
  const r = canvas.getBoundingClientRect();
  return {
    x: (e.clientX - r.left) * (CW / r.width),
    y: (e.clientY - r.top)  * (CH / r.height),
  };
}

function imgAt(x, y) {
  // Hit-test in reverse order (topmost image drawn last = highest z-index)
  for (let i = canvasImages.length - 1; i >= 0; i--) {
    const im = canvasImages[i];
    if (x >= im.x && x <= im.x + im.w && y >= im.y && y <= im.y + im.h) return im;
  }
  return null;
}

const HANDLE_R = 6;  // corner handle radius (canvas px)
const DELETE_R = 8;  // delete button radius (canvas px)

function cornersOf(im) {
  return [
    { id: 'tl', x: im.x,        y: im.y,        cursor: 'nw-resize' },
    { id: 'tr', x: im.x + im.w, y: im.y,        cursor: 'ne-resize' },
    { id: 'bl', x: im.x,        y: im.y + im.h, cursor: 'sw-resize' },
    { id: 'br', x: im.x + im.w, y: im.y + im.h, cursor: 'se-resize' },
  ];
}

function handleAt(px, py) {
  if (!selectedImg) return null;
  for (const c of cornersOf(selectedImg))
    if (Math.abs(px - c.x) <= HANDLE_R * 2 && Math.abs(py - c.y) <= HANDLE_R * 2) return c;
  return null;
}

function isOverDelete(px, py, im) {
  return Math.hypot(px - (im.x + im.w), py - im.y) <= DELETE_R * 2;
}

// ── PRETEXT LINE-WIDTH ORACLE ─────────────────────────────────────
/**
 * lineLayout(y)  →  Array<{ x, w }>
 * ────────────────────────────────────
 * Returns every text slot available on this line — the gaps between
 * (and around) all obstacles: placed images and freehand strokes.
 * pretext fills each slot left-to-right, so text flows on BOTH sides
 * of an obstacle automatically.
 */
function lineLayout(y) {
  const lineTop = y;
  const lineBot = y + LINE_H;
  const GAP     = 10; // gap around strokes
  const IMG_GAP = 2;  // tighter gap around images

  // Collect obstacles from images using per-row alpha scanlines so text
  // hugs the actual visible edges of PNGs rather than their bounding boxes.
  const obs = [];
  for (const im of canvasImages) {
    if (lineBot <= im.y || lineTop >= im.y + im.h) continue;

    if (im.alpha) {
      const { rows, nw, nh } = im.alpha;
      const scaleX = im.w / nw;
      const scaleY = im.h / nh;
      const r0 = Math.max(0,      Math.floor((lineTop - im.y) / scaleY));
      const r1 = Math.min(nh - 1, Math.ceil ((lineBot - im.y) / scaleY));
      let lo = Infinity, hi = -Infinity;
      for (let r = r0; r <= r1; r++) {
        if (rows[r]) { lo = Math.min(lo, rows[r][0] * scaleX); hi = Math.max(hi, rows[r][1] * scaleX); }
      }
      if (lo !== Infinity) obs.push({ x: im.x + lo - IMG_GAP, right: im.x + hi + IMG_GAP });
    } else {
      obs.push({ x: im.x - IMG_GAP, right: im.x + im.w + IMG_GAP });
    }
  }

  // Collect obstacles from strokes: find separate ink intervals in this band
  // so a circle's interior stays open (left arc and right arc are distinct obstacles).
  const allStrokes = drawingStroke ? [...strokes, drawingStroke] : strokes;
  for (const s of allStrokes) {
    const ivs = [];
    for (const pt of s.pts) {
      if (pt.y + s.lineW >= lineTop && pt.y - s.lineW <= lineBot)
        ivs.push([pt.x - s.lineW, pt.x + s.lineW]);
    }
    if (ivs.length === 0) continue;
    ivs.sort((a, b) => a[0] - b[0]);
    // Merge intervals that are physically touching (within one lineWidth of each other).
    // Intervals farther apart stay separate — text can flow in the gap between them.
    const merged = [ivs[0].slice()];
    for (let i = 1; i < ivs.length; i++) {
      const last = merged[merged.length - 1];
      if (ivs[i][0] <= last[1] + s.lineW) last[1] = Math.max(last[1], ivs[i][1]);
      else merged.push(ivs[i].slice());
    }
    for (const [x, right] of merged) obs.push({ x: x - GAP, right: right + GAP });
  }

  if (obs.length === 0) return [{ x: CON_X, w: CON_W }];

  // Sort then merge overlapping obstacles
  obs.sort((a, b) => a.x - b.x);
  const merged = [{ ...obs[0] }];
  for (let i = 1; i < obs.length; i++) {
    const last = merged[merged.length - 1];
    if (obs[i].x <= last.right) last.right = Math.max(last.right, obs[i].right);
    else merged.push({ ...obs[i] });
  }

  // Build text slots from gaps between obstacles, clamped to content zone
  const slots = [];
  let cur = CON_X;
  for (const ob of merged) {
    const slotW = Math.min(ob.x, CON_X + CON_W) - cur;
    if (slotW >= 48) slots.push({ x: cur, w: slotW });
    cur = Math.max(cur, ob.right);
  }
  const tailW = CON_X + CON_W - cur;
  if (tailW >= 48) slots.push({ x: cur, w: tailW });

  return slots.length > 0 ? slots : [{ x: CON_X, w: 48 }];
}

// ── RENDER ────────────────────────────────────────────────────────
function render() {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, CW, CH);

  renderImages();
  renderJournalText();
  renderStrokes();
}

function renderImages() {
  for (const im of canvasImages) {
    const tmp = document.createElement('canvas');
    tmp.width  = im.w;
    tmp.height = im.h;
    tmp.getContext('2d').drawImage(im.img, 0, 0, im.w, im.h);

    ctx.save();
    ctx.shadowColor   = 'rgba(0,0,0,0.35)';
    ctx.shadowBlur    = 12;
    ctx.shadowOffsetX = 4;
    ctx.shadowOffsetY = 4;
    ctx.drawImage(tmp, im.x, im.y, im.w, im.h);
    ctx.restore();

    if (im !== selectedImg) continue;

    // ── Selection outline ────────────────────────────────────────
    ctx.save();
    ctx.strokeStyle = 'rgba(99,102,241,0.8)';
    ctx.lineWidth   = 1.5;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(im.x, im.y, im.w, im.h);
    ctx.setLineDash([]);

    // ── Corner resize handles ────────────────────────────────────
    for (const c of cornersOf(im)) {
      ctx.fillStyle   = '#ffffff';
      ctx.strokeStyle = '#6366f1';
      ctx.lineWidth   = 1.5;
      ctx.beginPath();
      ctx.arc(c.x, c.y, HANDLE_R, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    // ── Delete button (top-right corner) ────────────────────────
    const dx = im.x + im.w, dy = im.y;
    ctx.fillStyle = '#ef4444';
    ctx.beginPath();
    ctx.arc(dx, dy, DELETE_R, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle      = '#ffffff';
    ctx.font           = `bold ${DELETE_R * 1.4}px sans-serif`;
    ctx.textAlign      = 'center';
    ctx.textBaseline   = 'middle';
    ctx.fillText('×', dx, dy);
    ctx.textAlign      = 'left';
    ctx.textBaseline   = 'alphabetic';

    ctx.restore();
  }
}

function renderJournalText() {
  ctx.save();
  ctx.font          = BODY_FONT;
  ctx.fillStyle     = '#1a1a1a';
  ctx.textBaseline  = 'alphabetic';

  if (!journalText) {
    ctx.fillStyle = 'rgba(0,0,0,0.2)';
    ctx.font      = 'italic ' + BODY_FONT;
    ctx.fillText('Click to start writing…', CON_X, CON_Y + LINE_H);
    ctx.restore();
    return;
  }

  /**
   * ── THE PRETEXT LAYOUT LOOP ─────────────────────────────────────
   *
   * Step 1: get the prepared text handle (cached per-text-change).
   */
  const prepared = getPrepared();

  /**
   * Step 2: create a cursor at the start of the text.
   *
   * pretext's cursor is {segmentIndex, graphemeIndex}, NOT a character
   * index. This lets it handle multi-codepoint grapheme clusters
   * (e.g. 👩‍👩‍👧 is one grapheme but many code units) correctly.
   */
  let ptCursor = { segmentIndex: 0, graphemeIndex: 0 };

  let y = CON_Y;

  // ── Variables for cursor-bar rendering ──────────────────────────
  // We want to show a blinking text cursor at input.selectionStart.
  // We track how many JS string characters we've "consumed" so far.
  let charsConsumed = 0;
  let cursorBarX    = CON_X;
  let cursorBarY    = CON_Y;
  const selStart    = hasFocus ? input.selectionStart : -1;
  let cursorPlaced  = false;

  ctx.font = BODY_FONT; // re-assert after save() path

  // ── Main layout loop ─────────────────────────────────────────────
  // lineLayout returns multiple slots per line so text fills both sides
  // of any obstacle (image or stroke) simultaneously.
  outer: while (true) {
    if (y + LINE_H > CON_Y + CON_H) break;

    const slots = lineLayout(y);

    for (const slot of slots) {
      const range = layoutNextLineRange(prepared, ptCursor, slot.w);
      if (range === null) break outer;

      const line = materializeLineRange(prepared, range);
      ctx.fillStyle = '#1a1a1a';
      ctx.fillText(line.text, slot.x, y + LINE_H - 6);

      if (!cursorPlaced && selStart >= 0) {
        const lineLen = line.text.length;
        if (selStart >= charsConsumed && selStart <= charsConsumed + lineLen) {
          const offset = selStart - charsConsumed;
          cursorBarX = slot.x + ctx.measureText(line.text.slice(0, offset)).width;
          cursorBarY = y;
          cursorPlaced = true;
        }
        charsConsumed += lineLen;
      }

      ptCursor = range.end;
    }

    y += LINE_H;
  }

  // If cursor is beyond all rendered text (e.g. typing at the end)
  if (!cursorPlaced && selStart >= 0) {
    cursorBarX = lineLayout(y)[0].x;
    cursorBarY = y;
  }

  // Draw blinking cursor bar aligned with the text baseline
  if (hasFocus && showCursor) {
    ctx.fillStyle = '#8B0000';
    ctx.fillRect(cursorBarX, cursorBarY + 4, 1.5, LINE_H - 6);
  }

  ctx.restore();
}

function renderStrokes() {
  const all = drawingStroke ? [...strokes, drawingStroke] : strokes;
  for (const s of all) {
    if (s.pts.length < 2) continue;
    ctx.save();
    ctx.strokeStyle = s.color;
    ctx.lineWidth   = s.lineW;
    ctx.lineCap     = 'round';
    ctx.lineJoin    = 'round';
    ctx.beginPath();
    ctx.moveTo(s.pts[0].x, s.pts[0].y);
    for (let i = 1; i < s.pts.length; i++) {
      // Midpoint smoothing: quadratic curve through midpoints keeps strokes
      // silky even at low frame rate
      const mx = (s.pts[i - 1].x + s.pts[i].x) / 2;
      const my = (s.pts[i - 1].y + s.pts[i].y) / 2;
      ctx.quadraticCurveTo(s.pts[i - 1].x, s.pts[i - 1].y, mx, my);
    }
    ctx.lineTo(s.pts.at(-1).x, s.pts.at(-1).y);
    ctx.stroke();
    ctx.restore();
  }
}

// ── CANVAS MOUSE EVENTS ───────────────────────────────────────────
//
// Design notes:
// - mousedown on canvas starts draws or drags
// - mousemove/mouseup are attached to DOCUMENT (not canvas) so fast
//   mouse movement that leaves the canvas bounds doesn't orphan a stroke
// - e.preventDefault() on mousedown stops the browser from giving the
//   canvas element itself a "mouse focus", which would blur the textarea

canvas.addEventListener('mousedown', e => {
  e.preventDefault();

  const p = canvasPos(e);

  // Delete button on selected image
  if (selectedImg && isOverDelete(p.x, p.y, selectedImg)) {
    canvasImages = canvasImages.filter(i => i !== selectedImg);
    selectedImg  = null;
    render();
    return;
  }

  // Corner resize handles on selected image
  const handle = handleAt(p.x, p.y);
  if (handle) {
    const im = selectedImg;
    resizingImg  = im;
    resizeCorner = handle.id;
    resizeFixed  = {
      tl: { x: im.x + im.w, y: im.y + im.h },
      tr: { x: im.x,         y: im.y + im.h },
      bl: { x: im.x + im.w, y: im.y         },
      br: { x: im.x,         y: im.y         },
    }[handle.id];
    return;
  }

  // Click on image: select + start drag
  const im = imgAt(p.x, p.y);
  if (im) {
    selectedImg = im;
    draggingImg = im;
    dragOff     = { x: p.x - im.x, y: p.y - im.y };
    render();
    return;
  }

  // Click on empty canvas: deselect image
  if (selectedImg) { selectedImg = null; render(); }

  if (mode === 'draw') {
    drawingStroke = { pts: [p], color: drawColor, lineW: brushSize };
    return;
  }

  if (mode === 'write') input.focus();
});

// Attach move/up to document so strokes and image drags aren't interrupted
// by the mouse briefly leaving the canvas element.
document.addEventListener('mousemove', e => {
  const p = canvasPos(e);

  // ── Resize ───────────────────────────────────────────────────────
  if (resizingImg) {
    const im  = resizingImg;
    const MIN = 20;
    const fx  = resizeFixed.x, fy = resizeFixed.y;
    if (resizeCorner === 'br') {
      im.w = Math.max(MIN, p.x - fx);
      im.h = Math.max(MIN, p.y - fy);
    } else if (resizeCorner === 'tl') {
      im.w = Math.max(MIN, fx - p.x); im.x = fx - im.w;
      im.h = Math.max(MIN, fy - p.y); im.y = fy - im.h;
    } else if (resizeCorner === 'tr') {
      im.w = Math.max(MIN, p.x - fx);
      im.h = Math.max(MIN, fy - p.y); im.y = fy - im.h;
    } else if (resizeCorner === 'bl') {
      im.w = Math.max(MIN, fx - p.x); im.x = fx - im.w;
      im.h = Math.max(MIN, p.y - fy);
    }
    render();
    return;
  }

  if (!draggingImg && !drawingStroke) {
    if (e.target === canvas) {
      if (selectedImg && isOverDelete(p.x, p.y, selectedImg)) {
        canvas.style.cursor = 'pointer';
      } else {
        const h = handleAt(p.x, p.y);
        if (h) canvas.style.cursor = h.cursor;
        else canvas.style.cursor = imgAt(p.x, p.y) ? 'move' : (mode === 'draw' ? 'crosshair' : 'text');
      }
    }
    return;
  }

  if (draggingImg) {
    draggingImg.x = p.x - dragOff.x;
    draggingImg.y = p.y - dragOff.y;
    render();
    return;
  }

  if (drawingStroke) {
    drawingStroke.pts.push(p);
    render();
  }
});

document.addEventListener('mouseup', () => {
  if (resizingImg)   { resizingImg = null; resizeCorner = null; resizeFixed = null; render(); return; }
  if (draggingImg)   { draggingImg = null; render(); return; }
  if (drawingStroke) {
    if (drawingStroke.pts.length >= 2) strokes.push(drawingStroke);
    drawingStroke = null;
    render();
  }
});

// Right-click on a canvas image removes it
canvas.addEventListener('contextmenu', e => {
  e.preventDefault();
  const p  = canvasPos(e);
  const im = imgAt(p.x, p.y);
  if (im) {
    canvasImages = canvasImages.filter(i => i !== im);
    render();
  }
});

// ── DRAG-AND-DROP from sidebar ────────────────────────────────────
canvas.addEventListener('dragover', e => {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});

canvas.addEventListener('drop', e => {
  e.preventDefault();
  const id  = e.dataTransfer.getData('sidebar-img-id');
  const src = sidebarImages.find(s => s.id === id);
  if (!src) return;

  const p = canvasPos(e);

  // Scale image so its longest dimension is ≤ 200px
  const MAX = 200;
  const scale = Math.min(1, MAX / Math.max(src.img.naturalWidth, src.img.naturalHeight));
  const w = Math.round(src.img.naturalWidth  * scale);
  const h = Math.round(src.img.naturalHeight * scale);

  canvasImages.push({
    id: crypto.randomUUID(),
    img: src.img,
    alpha: src.alpha,
    x: p.x - w / 2,
    y: p.y - h / 2,
    w, h,
  });
  render();
});

// ── TEXT INPUT ────────────────────────────────────────────────────
input.addEventListener('input',   () => { journalText = input.value; render(); });
input.addEventListener('keyup',   () => render()); // cursor moved by arrow keys
input.addEventListener('mouseup', () => render()); // cursor moved by click in textarea

input.addEventListener('focus', () => {
  hasFocus    = true;
  showCursor  = true;
  cursorTimer = setInterval(() => { showCursor = !showCursor; render(); }, 530);
});

input.addEventListener('blur', () => {
  hasFocus = false;
  clearInterval(cursorTimer);
  render();
});

// ── TOOLBAR ───────────────────────────────────────────────────────
document.querySelectorAll('.mode-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    mode = btn.dataset.mode;
    document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    canvas.style.cursor = mode === 'draw' ? 'crosshair' : 'text';
    if (mode === 'write') input.focus();
    else input.blur();
  });
});

document.querySelectorAll('.swatch').forEach(sw => {
  sw.addEventListener('click', () => {
    drawColor = sw.dataset.color;
    document.querySelectorAll('.swatch').forEach(s => s.classList.remove('active'));
    sw.classList.add('active');
  });
});

document.querySelectorAll('.brush-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    brushSize = +btn.dataset.size;
    document.querySelectorAll('.brush-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  });
});

document.getElementById('clear-btn').addEventListener('click', () => {
  strokes = [];
  render();
});

// ── PHOTO UPLOAD ─────────────────────────────────────────────────

// Precompute per-row opaque x-ranges at natural resolution.
// lineLayout scales these to display size so text hugs the actual
// visible edges of a PNG rather than its rectangular bounding box.
function computeAlpha(img) {
  const nw = img.naturalWidth, nh = img.naturalHeight;
  const tmp = document.createElement('canvas');
  tmp.width = nw; tmp.height = nh;
  const tc = tmp.getContext('2d');
  tc.drawImage(img, 0, 0);
  const data = tc.getImageData(0, 0, nw, nh).data;
  const rows = new Array(nh).fill(null);
  for (let row = 0; row < nh; row++) {
    let lo = -1, hi = -1;
    for (let col = 0; col < nw; col++) {
      if (data[(row * nw + col) * 4 + 3] > 16) {
        if (lo === -1) lo = col;
        hi = col;
      }
    }
    if (lo !== -1) rows[row] = [lo, hi];
  }
  return { rows, nw, nh };
}

document.getElementById('file-input').addEventListener('change', e => {
  [...e.target.files].forEach(file => {
    const reader = new FileReader();
    reader.onload = ev => {
      const img = new Image();
      img.onload = () => {
        const id    = crypto.randomUUID();
        const alpha = computeAlpha(img);
        sidebarImages.push({ id, img, alpha });
        addSidebarThumb(id, img);
      };
      img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
  });
  e.target.value = '';
});

function addSidebarThumb(id, img) {
  const wrap  = document.createElement('div');
  wrap.className = 'sidebar-photo';
  wrap.draggable = true;
  const thumb = document.createElement('img');
  thumb.src = img.src;
  thumb.alt = 'photo';
  wrap.appendChild(thumb);
  document.getElementById('photo-list').appendChild(wrap);

  wrap.addEventListener('dragstart', e => {
    e.dataTransfer.setData('sidebar-img-id', id);
    e.dataTransfer.effectAllowed = 'copy';
  });
}

// ── DRAWER TOGGLE ────────────────────────────────────────────────
const drawer       = document.getElementById('drawer');
const drawerToggle = document.getElementById('drawer-toggle');

function openDrawer()  { drawer.classList.add('open');    drawerToggle.style.display = 'none'; }
function closeDrawer() { drawer.classList.remove('open'); drawerToggle.style.display = ''; }

drawerToggle.addEventListener('click', e => { e.stopPropagation(); openDrawer(); });
document.getElementById('drawer-close').addEventListener('click', closeDrawer);
document.addEventListener('click', e => {
  if (drawer.classList.contains('open') &&
      !drawer.contains(e.target) &&
      e.target !== drawerToggle) closeDrawer();
});

// ── BOOT ─────────────────────────────────────────────────────────
render();
