# Tab Containers (Chrome)

Firefox-style multi-account containers for Chrome: each container tab gets its own cookie
jar, so you can be signed in to the same site as different people in side-by-side tabs.

## Install

1. Open `chrome://extensions`, turn on **Developer mode**.
2. **Load unpacked** → pick this `tab-containers` folder.
3. Pin the extension. It starts with the containers Personal, Work, Banking and Shopping.

## Use

- **Popup**: click a container to open a new tab in it. Use **Edit**, **Clear** (its cookies) and **Delete** next to it (Clear and Delete ask "Sure?" first). Want an emoji? Put it in the name, e.g. `💼 Work`.
- **Always open *site* in** moves the current tab into the chosen container right away, and opens that site and its subdomains there from then on (in tabs not already in a container).
- Container tabs are put in a colored tab group named after the container, and the toolbar badge shows the container's first letter.
- Links and popups opened from a container tab stay in that container. A plain new tab (Ctrl+T) opens with no container, as in Firefox.
- After a browser restart, tabs in container-named groups are put back into their containers and reloaded.

## AI agents (Claude in Chrome MCP)

Two ways in. Both act on the **current tab**, so the agent keeps control of the tab in its own MCP tab group.

**1. Navigate only.** Use this with the `navigate` tool:

```
https://container.invalid/?name=Work&url=https://mail.google.com/
```

- Moves the tab into `Work` and loads `url`.
- A container that doesn't exist yet is created.
- `name=none` takes the tab out of its container.
- Put `url` last; URL-encoding it is optional.

**2. JavaScript.** Use this with the `javascript_tool`, on any http(s) page:

```js
await __containers.list()                    // [{id, name, color, tabs}]
await __containers.current()                 // container of this tab, or null
await __containers.open('Work', 'https://github.com/')  // move this tab + navigate
await __containers.create('💼 Client A', 'purple')
```

This access is always on; it's what the extension is for. Pages can't delete containers or clear
cookies; only the popup can. Any website can call the same four functions as the agent.

Snippet for `CLAUDE.md`:

```md
Chrome has the "Tab Containers" extension. To browse as a separate identity, navigate the tab to
https://container.invalid/?name=<Container>&url=<target> (url last). `await __containers.list()`
in javascript_tool lists containers. Never log in to a site outside the container the user names.
```

## How it works and limits

Chrome has no per-tab cookie stores, so this extension builds them itself:

- `declarativeNetRequest` session rules, scoped to container tab IDs, replace the `Cookie` header and strip `Set-Cookie`.
- `webRequest` reads the stripped `Set-Cookie` headers into the container's jar.
- A main-world script runs before any page script. It learns the tab's container from a `Server-Timing` header the rules add, along with the container's script-visible cookies.

What each container gets on its own:

| Surface | How |
|---|---|
| Cookies (HTTP, `document.cookie`, `cookieStore`) | Own jar; header rules + script shims |
| localStorage, sessionStorage | Keys stored under a `__mac:<id>:` prefix |
| IndexedDB, Cache Storage | Database and cache names prefixed |
| BroadcastChannel, Web Locks | Channel and lock names prefixed, so logout or token-refresh sync doesn't cross containers |
| `storage` events | Other containers' changes are dropped |
| HTTP cache | Container requests revalidate, so a response cached for a normal tab is never replayed |
| Service workers, SharedWorker | Blocked in container tabs, since their requests carry no tab ID. A worker registered from a normal tab is removed before a container tab loads that origin, and normal tabs re-register it on their next visit |

Normal tabs can't see container keys, databases or caches, and their `localStorage.clear()` leaves container data alone.

Remaining limits:

- **Normal tabs can reuse responses cached by a container tab** if a site marks user-specific responses as cacheable (`private, max-age=N`). Most sites send such responses as `no-store` or `no-cache`.
- A page that creates an `about:blank` iframe and touches its storage in the same tick can reach the unscoped store.
- Container cookies are sent regardless of `path`, `Secure` or `SameSite`.
- The first request of a tab that is auto-assigned, opened from a container tab, or served by a service worker can go out unscoped. The tab is then reloaded inside the container.
- Saved passwords, permissions, HSTS and the like are browser-wide.

For hard isolation, such as banking or accounts that must never mix, use separate **Chrome profiles**.
Claude in Chrome can drive each profile through `list_connected_browsers` / `switch_browser`.

## Tests

Runs 36 isolation and API checks in a headless Chrome for Testing against a local server:

```bash
cd test && npm run setup && npm test
```
