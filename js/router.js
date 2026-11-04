const routes = []; // { pattern: RegExp, keys: string[], view: { render, unmount } }
let currentUnmount = null;
let rootEl = null;
let listening = false;
let routeToken = 0;

export function initRouter(root) {
  rootEl = root;
  if (!listening) { listening = true; window.addEventListener("hashchange", handleRoute); }
  handleRoute();
}

export function registerRoute(path, view) {
  const keys = [];
  const pattern = new RegExp("^" + path.replace(/:[^/]+/g, (m) => {
    keys.push(m.slice(1));
    return "([^/]+)";
  }) + "$");
  routes.push({ pattern, keys, view });
}

export function navigate(hash) {
  if (location.hash === `#${hash}`) { handleRoute(); return; }
  location.hash = hash;
}

function currentPath() {
  return (location.hash || "#/dashboard").slice(1) || "/dashboard";
}

async function handleRoute() {
  const path = currentPath();
  const token = ++routeToken;
  if (currentUnmount) { try { currentUnmount(); } catch (e) { /* noop */ } currentUnmount = null; }

  for (const route of routes) {
    const match = path.match(route.pattern);
    if (match) {
      const params = {};
      route.keys.forEach((k, i) => { params[k] = decodeURIComponent(match[i + 1]); });
      // Render into a fresh container so a slow, superseded render (user clicked
      // elsewhere while it was loading) can't paint into the new page.
      rootEl.innerHTML = "";
      const host = document.createElement("div");
      host.className = "route-host";
      rootEl.appendChild(host);
      let result;
      try { result = await route.view.render(host, params); }
      catch (e) {
        console.error(e);
        if (token === routeToken) host.innerHTML = `<div class="empty-state"><h3>Something went wrong</h3><p>${String(e.message || e).replace(/</g, "&lt;")}</p></div>`;
      }
      if (token !== routeToken) { if (typeof result === "function") { try { result(); } catch { /* noop */ } } host.remove(); return; }
      if (typeof result === "function") currentUnmount = result;
      rootEl.closest(".main")?.scrollTo?.(0, 0);
      window.scrollTo(0, 0);
      return;
    }
  }
  navigate("/dashboard");
}
