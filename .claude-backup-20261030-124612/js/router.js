const routes = []; // { pattern: RegExp, keys: string[], view: { render, unmount } }
let currentUnmount = null;
let rootEl = null;

export function initRouter(root) {
  rootEl = root;
  window.addEventListener("hashchange", handleRoute);
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
  if (currentUnmount) { try { currentUnmount(); } catch (e) { /* noop */ } currentUnmount = null; }

  for (const route of routes) {
    const match = path.match(route.pattern);
    if (match) {
      const params = {};
      route.keys.forEach((k, i) => { params[k] = decodeURIComponent(match[i + 1]); });
      rootEl.innerHTML = "";
      const result = await route.view.render(rootEl, params);
      if (typeof result === "function") currentUnmount = result;
      window.scrollTo(0, 0);
      return;
    }
  }
  navigate("/dashboard");
}
