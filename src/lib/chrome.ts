/**
 * Site chrome — THE single source of truth for the shared shell: design tokens,
 * the nav (wordmark + GitHub star badge), the footer, and the common atoms
 * (frame-guides, container, breadcrumb, section headers, code blocks, kv lists,
 * the favicon page header). Consumed BOTH by the Astro layout (Base.astro, via
 * `set:html`) and by the worker-rendered surface page (worker/surface-page.ts,
 * as a string). One copy → no drift between the static pages and the SSR'd ones.
 *
 * Pure strings only — must stay importable by the Cloudflare Worker, so no Astro,
 * no React, and no `github.ts` (its top-level `await` would run in the worker).
 */

export const REPO_URL = "https://github.com/UsefulSoftwareCo/integrationsdotsh";

/** PostHog project token for the integrations.sh project (public by design —
 * it can only ingest, not read). Server-side events in the worker use the
 * POSTHOG_KEY secret, which must hold this same token. */
export const POSTHOG_TOKEN = "phc_n2pqszLvoefgiTmM9mhXUgx9hX8K5ESw7Wh2NmR83ftb";

/**
 * Client analytics — the official posthog-js loader, pointed at our own
 * `/_i/*` worker route (first-party proxy → not eaten by tracker blockers;
 * see worker/index.ts). Skipped on localhost so dev sessions stay out of the
 * data. Emitted as a real inline <script> by every consumer (set:html-injected
 * scripts don't run), same as FOOTER_JS.
 */
export const ANALYTICS_JS =
  `!function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host.replace(".i.posthog.com","-assets.i.posthog.com")+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+".people (stub)"},o="init capture register register_once register_for_session unregister unregister_for_session getFeatureFlag getFeatureFlagResult isFeatureEnabled reloadFeatureFlags updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures on onFeatureFlags onSessionId getSurveys getActiveMatchingSurveys renderSurvey canRenderSurvey getNextSurveyStep identify setPersonProperties group resetGroups setPersonPropertiesForFlags resetPersonPropertiesForFlags setGroupPropertiesForFlags resetGroupPropertiesForFlags reset get_distinct_id getGroups get_session_id get_session_replay_url alias set_config startSessionRecording stopSessionRecording sessionRecordingStarted captureException loadToolbar get_property getSessionProperty createPersonProfile opt_in_capturing opt_out_capturing has_opted_in_capturing has_opted_out_capturing clear_opt_in_out_capturing debug".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);` +
  `if(!/^(localhost$|127\\.|0\\.0\\.0\\.0$)/.test(location.hostname))posthog.init("${POSTHOG_TOKEN}",{api_host:"/_i",ui_host:"https://us.posthog.com",defaults:"2026-05-30"});`;

/** Compact star count, e.g. 1234 -> "1.2k". Mirrors github.ts.formatStars. */
export const formatStars = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : String(n));

/** `<head>` font preloads + Geist stylesheet. */
export const FONT_HEAD = `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Geist:wght@300;400;500;600&family=Geist+Mono:wght@400;500&display=swap" rel="stylesheet">`;

const STAR_SVG = `<svg class="ghstar-ico" width="13" height="13" viewBox="0 0 16 16" aria-hidden="true"><path fill="#e3b341" d="M8 .25a.75.75 0 0 1 .673.418l1.882 3.815 4.21.612a.75.75 0 0 1 .416 1.279l-3.046 2.97.719 4.192a.75.75 0 0 1-1.088.791L8 12.347l-3.766 1.98a.75.75 0 0 1-1.088-.79l.72-4.194L.818 6.374a.75.75 0 0 1 .416-1.28l4.21-.611L7.327.668A.75.75 0 0 1 8 .25z"/></svg>`;

/** The top nav, with the live star count baked in (null = omit the count). */
export const navHtml = (stars: number | null): string =>
  `<nav class="site"><div class="container"><a class="wordmark" href="/">integrations.sh</a>` +
  `<a class="ghstar" href="${REPO_URL}" target="_blank" rel="noopener">${STAR_SVG}<span>star on github</span>` +
  `${stars != null ? `<span class="ghstar-n">${formatStars(stars)}</span>` : ""}</a></div></nav>`;

/** Small up-chevron affordance for the footer toggle (rotates on expand). */
const CHEV_SVG = `<svg class="sf-chev" width="11" height="11" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 10l4-4 4 4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

/**
 * The footer — a compact, fixed bar docked to the bottom of the viewport that
 * auto-hides on scroll-down / reveals on scroll-up, and expands on click to show
 * secondary links. Concept ported from AnswerOverflow's CompactStickyFooter,
 * restyled to the registry-grade minimal language. Behavior lives in FOOTER_JS
 * (set:html-injected scripts don't run, so each consumer emits it as a real
 * inline <script>); styles live in GLOBAL_CSS under "compact sticky footer".
 */
export const footerHtml = (): string =>
  `<footer id="sfooter" class="sf"><div class="container">` +
  `<div class="sf-bar" role="button" tabindex="0" aria-controls="sf-panel" aria-expanded="false" aria-label="Toggle footer links">` +
  `<span class="sf-mark">integrations.sh</span>` +
  `<span class="sf-toggle"><span class="sf-more"><span class="sf-more-a">more</span><span class="sf-more-b">less</span></span>${CHEV_SVG}</span>` +
  `</div>` +
  `<div class="sf-panel" id="sf-panel"><div class="sf-panel-clip"><div class="sf-panel-inner">` +
  `<p class="sf-tag">Services your agent can reach — official APIs, GraphQL endpoints, and MCP servers, with structured credential facts.</p>` +
  `<nav class="sf-links" aria-label="Footer"><a href="/">registry</a><a href="/integrations.sh/">connect your agent</a><a href="${REPO_URL}" target="_blank" rel="noopener">github</a></nav>` +
  `</div></div></div>` +
  `</div></footer>`;

/**
 * Footer behavior — vanilla, framework-free (must run in both the Astro layout
 * and the worker-SSR'd page). Toggles `.sf-open` on click/keyboard, and adds
 * `.sf-hidden` when scrolling down past a threshold (reveals on scroll-up).
 *
 * The hide/show logic runs DIRECTLY in the scroll handler — deliberately not
 * wrapped in requestAnimationFrame, since rAF is throttled/paused in some
 * embedded preview surfaces, which would silently freeze the auto-hide while
 * scrolling. The work is cheap (one scrollY read + an occasional class toggle),
 * so a direct passive handler is fine. The footer is always revealed at the very
 * top and within ~one footer-height of the page bottom, so a long infinite-scroll
 * list still ends on a visible footer.
 */
export const FOOTER_JS = `(function(){var f=document.getElementById("sfooter");if(!f)return;var bar=f.querySelector(".sf-bar"),lastY=window.scrollY,open=false;function set(v){open=v;f.classList.toggle("sf-open",v);bar.setAttribute("aria-expanded",String(v));}bar.addEventListener("click",function(){set(!open);});bar.addEventListener("keydown",function(e){if(e.key==="Enter"||e.key===" "){e.preventDefault();set(!open);}});function update(){var y=window.scrollY,d=document.documentElement,atEdge=(y<=8)||((y+window.innerHeight)>=(d.scrollHeight-96));if(!atEdge&&y>lastY&&y>120){f.classList.add("sf-hidden");if(open)set(false);}else if(atEdge||y<lastY){f.classList.remove("sf-hidden");}lastY=y;}window.addEventListener("scroll",update,{passive:true});update();})();`;

/** The global stylesheet shared by every page (static + SSR'd). */
export const GLOBAL_CSS = `
:root {
  --gray-1000: #0a0a0a; --gray-900: #111; --gray-700: #333; --gray-500: #666; --gray-400: #888;
  --gray-300: #999; --gray-200: #d4d4d4; --gray-100: #eaeaea; --gray-50: #f5f5f5; --gray-25: #fafafa; --white: #fff;
  --font-sans: "Geist", -apple-system, BlinkMacSystemFont, sans-serif;
  --font-mono: "Geist Mono", ui-monospace, "SF Mono", Menlo, monospace;
  --container: 1100px; color-scheme: light dark;
}
@media (prefers-color-scheme: dark) {
  :root {
    --gray-1000: #ededed; --gray-900: #ededed; --gray-700: #c4c4c4; --gray-500: #9a9a9a; --gray-400: #7a7a7a;
    --gray-300: #5c5c5c; --gray-200: #333333; --gray-100: #1f1f1f; --gray-50: #1a1a1a; --gray-25: #141414; --white: #0a0a0a;
  }
}
*, *::before, *::after { box-sizing: border-box; }
html { scrollbar-gutter: stable; }
html, body { margin: 0; padding: 0; }
body { background: var(--white); color: var(--gray-900); font: 400 15px/1.55 var(--font-sans); -webkit-font-smoothing: antialiased; min-height: 100vh; display: flex; flex-direction: column; }
a { color: inherit; }
::selection { background: #dbeafe; color: #0a0a0a; }
@media (prefers-color-scheme: dark) { ::selection { background: #2e4a6e; color: #ededed; } }

.frame-guides { position: fixed; inset: 0; pointer-events: none; z-index: 0; }
.frame-guides::before, .frame-guides::after { content: ""; position: absolute; top: 0; bottom: 0; width: 1px; background: var(--gray-100); }
.frame-guides::before { left: calc(50% - var(--container) / 2); }
.frame-guides::after { right: calc(50% - var(--container) / 2); }
@media (max-width: 1140px) { .frame-guides { display: none; } }
.container { max-width: var(--container); margin: 0 auto; padding: 0 40px; position: relative; z-index: 1; }

nav.site { border-bottom: 1px solid var(--gray-100); background: var(--white); position: relative; z-index: 2; }
nav.site .container { height: 64px; display: flex; align-items: center; gap: 32px; }
.wordmark { font-family: var(--font-mono); font-size: 14px; font-weight: 500; color: var(--gray-1000); text-decoration: none; white-space: nowrap; }
.ghstar { margin-left: auto; display: inline-flex; align-items: center; gap: 7px; font-family: var(--font-mono); font-size: 12.5px; color: var(--gray-500); text-decoration: none; border: 1px solid var(--gray-200); border-radius: 7px; padding: 5px 11px; transition: color 0.12s, border-color 0.12s; }
.ghstar:hover { color: var(--gray-1000); border-color: var(--gray-400); }
.ghstar-ico { flex-shrink: 0; }
.ghstar-n { font-variant-numeric: tabular-nums; color: var(--gray-400); padding-left: 8px; border-left: 1px solid var(--gray-200); }

main { flex: 1 0 auto; padding-bottom: 96px; }

/* compact sticky footer — fixed to the bottom, auto-hides on scroll-down /
   reveals on scroll-up, click to expand. Concept from AnswerOverflow's
   CompactStickyFooter, restyled minimal. Behavior in chrome.ts FOOTER_JS. */
footer.sf { position: fixed; left: 0; right: 0; bottom: 0; z-index: 30; border-top: 1px solid var(--gray-100); background: var(--white); transform: translateY(0); transition: transform 0.3s cubic-bezier(0.22, 1, 0.36, 1); }
footer.sf.sf-hidden { transform: translateY(100%); transition-duration: 0.2s; }
.sf-bar { height: 46px; display: flex; align-items: center; justify-content: space-between; gap: 24px; cursor: pointer; font-family: var(--font-mono); font-size: 12px; color: var(--gray-400); -webkit-user-select: none; user-select: none; }
.sf-bar:focus-visible { outline: 2px solid var(--gray-300); outline-offset: -4px; border-radius: 4px; }
.sf-mark { color: var(--gray-400); }
.sf-toggle { display: inline-flex; align-items: center; gap: 7px; transition: color 0.15s; }
.sf-bar:hover .sf-toggle { color: var(--gray-1000); }
.sf-chev { transition: transform 0.15s ease; }
footer.sf.sf-open .sf-chev { transform: rotate(180deg); }
.sf-more-b { display: none; }
footer.sf.sf-open .sf-more-a { display: none; }
footer.sf.sf-open .sf-more-b { display: inline; }
.sf-panel { display: grid; grid-template-rows: 0fr; opacity: 0; transition: grid-template-rows 0.3s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.3s ease; }
footer.sf.sf-open .sf-panel { grid-template-rows: 1fr; opacity: 1; }
.sf-panel-clip { overflow: hidden; }
.sf-panel-inner { padding: 14px 0 18px; border-top: 1px solid var(--gray-100); }
.sf-tag { margin: 0 0 12px; font-size: 13px; line-height: 1.55; color: var(--gray-500); max-width: 540px; }
.sf-links { display: flex; flex-wrap: wrap; gap: 9px 22px; font-family: var(--font-mono); font-size: 12px; }
.sf-links a { color: var(--gray-400); text-decoration: none; transition: color 0.12s; }
.sf-links a:hover { color: var(--gray-1000); }
@media (prefers-reduced-motion: reduce) { footer.sf, .sf-chev, .sf-panel { transition: none; } }

/* shared atoms */
.sec-label { font-family: var(--font-mono); font-size: 11px; font-weight: 500; letter-spacing: 0.08em; text-transform: uppercase; color: var(--gray-400); }
.sec-header { display: flex; align-items: baseline; justify-content: space-between; padding-bottom: 12px; border-bottom: 1px solid var(--gray-100); }
.sec-note { font-family: var(--font-mono); font-size: 11px; color: var(--gray-400); }
.crumb { padding: 28px 0 0; font-family: var(--font-mono); font-size: 12px; color: var(--gray-400); }
.crumb a { color: var(--gray-400); text-decoration: none; }
.crumb a:hover { color: var(--gray-1000); }
.crumb .sep { margin: 0 6px; color: var(--gray-200); }
code { font-family: var(--font-mono); font-size: 0.88em; }
.code-block { background: var(--gray-25); border: 1px solid var(--gray-100); border-radius: 6px; padding: 13px 16px; overflow-x: auto; font-family: var(--font-mono); font-size: 12.5px; line-height: 1.65; color: var(--gray-700); margin: 0; }

/* favicon page header (domain + surface detail) */
.head { padding: 24px 0 0; display: flex; align-items: flex-start; gap: 16px; max-width: 760px; }
.favicon { position: relative; width: 40px; height: 40px; border: 1px solid var(--gray-100); border-radius: 8px; display: grid; place-items: center; background: var(--white); flex-shrink: 0; margin-top: 2px; }
.fav-letter { position: absolute; inset: 0; display: grid; place-items: center; font-weight: 600; color: var(--gray-400); }
.favicon img { position: relative; z-index: 1; border-radius: 4px; background: var(--white); }
.head h1 { font-size: 28px; font-weight: 600; letter-spacing: -0.03em; line-height: 1.2; margin: 0; word-break: break-word; }
.head .meta { margin: 6px 0 0; font-family: var(--font-mono); font-size: 12px; color: var(--gray-400); display: flex; align-items: center; gap: 9px; flex-wrap: wrap; }

/* key/value detail list */
dl.kv { display: grid; grid-template-columns: max-content 1fr; gap: 10px 28px; margin: 18px 0 0; font-size: 14px; }
dl.kv dt { color: var(--gray-400); font-family: var(--font-mono); font-size: 12.5px; }
dl.kv dd { margin: 0; min-width: 0; word-break: break-all; }
dl.kv a { text-decoration: underline; text-underline-offset: 2px; }
dl.kv a:hover { color: var(--gray-500); }
dl.kv code { background: var(--gray-50); padding: 1px 6px; border-radius: 3px; font-size: 12.5px; }

/* markdown (marked output / setup prose) */
.md { line-height: 1.65; }
.md > :first-child { margin-top: 0; }
.md > :last-child { margin-bottom: 0; }
.md p { margin: 0 0 0.8em; }
.md a { color: var(--gray-1000); text-decoration: underline; text-underline-offset: 2px; }
.md a:hover { color: var(--gray-500); }
.md code { background: var(--gray-50); padding: 1px 5px; border-radius: 3px; font-size: 0.86em; }
.md pre { background: var(--gray-25); border: 1px solid var(--gray-100); padding: 13px 16px; border-radius: 6px; overflow: auto; font-size: 12.5px; line-height: 1.65; margin: 0.9em 0; }
.md pre code { background: transparent; padding: 0; }
.md ul, .md ol { padding-left: 1.3em; margin: 0 0 0.8em; }
.md strong { color: var(--gray-1000); }
`;
