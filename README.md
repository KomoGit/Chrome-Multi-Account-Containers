# Tab Containers (Chrome)

Firefox-style multi-account containers for Chrome: each container tab gets its own cookie
jar, so you can be signed in to the same site as different people in side-by-side tabs.

## Install

1. Open `chrome://extensions`, turn on **Developer mode**.
2. **Load unpacked** → pick this `tab-containers` folder.
3. Pin the extension. It starts with the containers Personal, Work, Banking and Shopping.

## Use

- **Popup**: click a container to open a new tab in it. Use ✎ to edit, 🧹 to clear its cookies, and 🗑 to delete it (click 🧹 or 🗑 twice to confirm).
- **This tab** moves the current tab into a container and reloads it.
- **Always open *site* in** opens that site, and its subdomains, in the chosen container every time.
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
await __containers.list()                    // [{id, name, color, icon, tabs}]
await __containers.current()                 // container of this tab, or null
await __containers.open('Work', 'https://github.com/')  // move this tab + navigate
await __containers.create('Client A', 'purple', 'briefcase')
```

Pages can't delete containers or clear cookies; only the popup can. The popup checkbox
**Let AI agents & pages use containers** turns both entry points off. Note that while it's on,
any website could call the same four functions as the agent.

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
- A main-world script makes `document.cookie`, `localStorage` and `sessionStorage` container-aware. Container storage keys live in the real store under a `__mac:<id>:` prefix. The script learns the tab's container before any page script runs, from a `Server-Timing` header the rules add, so token-in-localStorage logins (JWT apps) are isolated too.

What isn't isolated:

- **IndexedDB, Cache Storage and service workers** are shared with your normal tabs.
- Normal tabs can see the `__mac:` keys in localStorage; container tabs can't see normal keys.
- In the first few ms of page load, `document.cookie` in a container tab is empty, until the container's cookies arrive. The `cookieStore` API isn't covered.
- Container cookies are sent regardless of `path`, `Secure` or `SameSite`.
- The first request of a tab that is auto-assigned or opened from a container tab can go out with normal cookies. The tab is then reloaded inside the container.

For hard isolation, such as banking or accounts that must never mix, use separate **Chrome profiles**.
Claude in Chrome can drive each profile through `list_connected_browsers` / `switch_browser`.

## Tests

Runs 16 isolation and API checks in a headless Chrome for Testing against a local server:

```bash
cd test && npm run setup && npm test
```
