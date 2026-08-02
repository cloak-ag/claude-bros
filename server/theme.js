/**
 * Design tokens shared by every page the relay serves. Kept in one place so the
 * board and the reference cannot drift apart. Values are the validated palette:
 * categorical slots for agent identity, reserved status colours for verdicts.
 */
export const THEME_CSS = `
  :root {
    color-scheme: light dark;
    --surface:#fcfcfb; --plane:#f9f9f7;
    --ink:#0b0b0b; --ink-2:#52514e; --muted:#898781;
    --line:#e1e0d9; --rule:#c3c2b7; --ring:rgba(11,11,11,.10);
    --series-1:#2a78d6; --series-2:#eb6834; --series-3:#1baf7a;
    --series-4:#eda100; --series-5:#e87ba4; --series-6:#008300;
    --good:#0ca30c; --warning:#fab219; --serious:#ec835a; --critical:#d03b3b;
    --track:#e1e0d9;
    --mono: ui-monospace,SFMono-Regular,Menlo,"Cascadia Mono",monospace;
    --sans: system-ui,-apple-system,"Segoe UI",sans-serif;
  }
  @media (prefers-color-scheme: dark) {
    :root:where(:not([data-theme="light"])) {
      --surface:#1a1a19; --plane:#0d0d0d;
      --ink:#fff; --ink-2:#c3c2b7; --muted:#898781;
      --line:#2c2c2a; --rule:#383835; --ring:rgba(255,255,255,.10);
      --series-1:#3987e5; --series-2:#d95926; --series-3:#199e70;
      --series-4:#c98500; --series-5:#d55181; --series-6:#008300;
      --track:#2c2c2a;
    }
  }
  :root[data-theme="dark"] {
    --surface:#1a1a19; --plane:#0d0d0d;
    --ink:#fff; --ink-2:#c3c2b7; --muted:#898781;
    --line:#2c2c2a; --rule:#383835; --ring:rgba(255,255,255,.10);
    --series-1:#3987e5; --series-2:#d95926; --series-3:#199e70;
    --series-4:#c98500; --series-5:#d55181; --series-6:#008300;
    --track:#2c2c2a;
  }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--plane); color:var(--ink); font:14px/1.55 var(--sans); }
  code, .mono { font-family:var(--mono); }
  a { color:var(--series-1); }
  section { background:var(--surface); border:1px solid var(--line); border-radius:12px;
            padding:16px 18px; min-width:0; margin-bottom:18px; }
  h2 { font-size:11px; text-transform:uppercase; letter-spacing:.09em; color:var(--muted);
       margin:0 0 12px; font-weight:600; }
  .muted { color:var(--muted); font-size:12px; }
  .pill { display:inline-flex; align-items:center; gap:4px; font-size:11px; font-family:var(--mono);
          padding:1px 7px; border-radius:999px; border:1px solid var(--ring); white-space:nowrap; }
  .pill.clean,.pill.good      { color:var(--good); border-color:var(--good); }
  .pill.partial,.pill.medium  { color:var(--warning); border-color:var(--warning); }
  .pill.suspicious,.pill.high { color:var(--serious); border-color:var(--serious); }
  .pill.vulnerable,.pill.critical { color:var(--critical); border-color:var(--critical); }
  .pill.skipped,.pill.info,.pill.low,.pill.reviewed { color:var(--muted); }
`;

/** The tab strip shared by the board and the reference. */
export const nav = (active, query) => `
<div class="tabs">
  <a class="tab${active === 'board' ? ' on' : ''}" href="/${query}">Board</a>
  <a class="tab${active === 'graph' ? ' on' : ''}" href="/graph${query}">Graph</a>
  <a class="tab${active === 'help' ? ' on' : ''}" href="/help${query}">Reference</a>
</div>`;

export const NAV_CSS = `
  /* Header rules live here so the board and the reference share one header. */
  h1 { font-size:15px; margin:0; font-weight:600; letter-spacing:-.01em; }
  h1 .room { font-family:var(--mono); color:var(--ink-2); font-weight:500; }
  .head { display:flex; align-items:center; gap:14px; flex-wrap:wrap;
          position:sticky; top:0; z-index:5; margin:0 -24px 18px; padding:14px 24px;
          background:color-mix(in srgb, var(--plane) 88%, transparent);
          backdrop-filter:blur(8px); border-bottom:1px solid var(--line); }
  .head .when { color:var(--muted); font-size:12px; margin-left:auto; font-variant-numeric:tabular-nums; }
  .tabs { display:flex; gap:4px; }
  .tab { display:inline-block; padding:5px 12px; border-radius:999px; text-decoration:none;
         font-size:12px; font-weight:600; color:var(--muted); border:1px solid transparent; }
  .tab:hover { color:var(--ink); }
  .tab.on { color:var(--ink); background:var(--surface); border-color:var(--line); }
`;
