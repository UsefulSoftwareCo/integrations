/** PostHog project token for the integrations.sh project (public by design —
 * it can only ingest, not read). Server-side events in the worker use the
 * POSTHOG_KEY secret, which must hold this same token. */
export const POSTHOG_TOKEN = "phc_n2pqszLvoefgiTmM9mhXUgx9hX8K5ESw7Wh2NmR83ftb";

/**
 * Client analytics — the official posthog-js loader, pointed at our own
 * `/_i/*` worker route (first-party proxy → not eaten by tracker blockers;
 * see worker/entry.ts). Skipped on localhost so dev sessions stay out of the
 * data. Inlined by Base.astro (`is:inline set:html` — the loader is upstream
 * minified JS, not something to hand-maintain as markup).
 */
export const ANALYTICS_JS =
  `!function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host.replace(".i.posthog.com","-assets.i.posthog.com")+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+".people (stub)"},o="init capture register register_once register_for_session unregister unregister_for_session getFeatureFlag getFeatureFlagResult isFeatureEnabled reloadFeatureFlags updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures on onFeatureFlags onSessionId getSurveys getActiveMatchingSurveys renderSurvey canRenderSurvey getNextSurveyStep identify setPersonProperties group resetGroups setPersonPropertiesForFlags resetPersonPropertiesForFlags setGroupPropertiesForFlags resetGroupPropertiesForFlags reset get_distinct_id getGroups get_session_id get_session_replay_url alias set_config startSessionRecording stopSessionRecording sessionRecordingStarted captureException loadToolbar get_property getSessionProperty createPersonProfile opt_in_capturing opt_out_capturing has_opted_in_capturing has_opted_out_capturing clear_opt_in_out_capturing debug".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);` +
  `if(!/^(localhost$|127\\.|0\\.0\\.0\\.0$)/.test(location.hostname))posthog.init("${POSTHOG_TOKEN}",{api_host:"/_i",ui_host:"https://us.posthog.com",defaults:"2026-05-30"});`;
