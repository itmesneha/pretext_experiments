# Junk Journal

A canvas-based journaling app for experimenting with [@chenglou/pretext](https://github.com/chenglou/pretext) — a library that does text layout via the Canvas API, avoiding DOM reflow entirely.

## What it does

- **Write** journal entries on a landscape canvas page
- **Upload photos** and drag them onto the page — text reflows around them in real time
- **Draw** freehand on the page — text reflows around strokes too
- Text flows on **both sides** of any obstacle simultaneously

## How pretext works

The browser's layout engine triggers a reflow whenever you read geometry from the DOM (`getBoundingClientRect`, `offsetHeight`, etc.). On complex pages this can take tens of milliseconds.

pretext sidesteps this by measuring text through the Canvas font engine — `ctx.measureText()` — which is fast and reflow-free. It does this once per `(text, font)` pair, caches the results, then does all subsequent layout as pure arithmetic.

The key API used here is `layoutNextLineRange(prepared, cursor, width)`, which accepts a **per-line width**. By computing a different width for each line based on where obstacles are, text automatically flows around images and drawings without ever touching the DOM.

## Running locally

```bash
npm install
npm run dev
```

## Stack

- Vanilla JS (no framework)
- [Vite](https://vitejs.dev/)
- [@chenglou/pretext](https://github.com/chenglou/pretext)
