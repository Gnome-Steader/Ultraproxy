# 🌐 UltraProxy

A high-stability, full-featured web proxy with a smooth, modern UI.  
Browse any site — fully rendered with images, CSS, and JavaScript intact.

---

## ✨ Features

- 🔒 Full URL rewriting — HTML, CSS, JS, fetch, XHR, WebSocket
- 🖼️ Images, fonts, and stylesheets preserved
- 🦆 DuckDuckGo search by default (Google also supported)
- 🏠 Home button — always returns to launcher
- 📦 Download & Rehost button — zero-folder ZIP
- 🚫 No "localhost refused to connect" in the proxy frame
- 🚫 No "No URL provided" errors
- 🚫 No infinite reload loops
- 🚫 No broken Wikipedia layout / CSS
- ✅ Clean URL display in the proxy bar (shows `example.com/path`, not internal routes)
- ✅ Works on GitHub Codespaces, Replit, Glitch, Railway, Render, any VPS

---

## 🚀 Quick Start (GitHub Codespaces)

1. Upload or clone this project to a Codespace (or repo).
2. Open the terminal.
3. Install dependencies:
   ```bash
   npm install
   ```
4. Start the server:
   ```bash
   node server.js
   ```
5. Codespaces will detect port **3000** automatically and show a **"Open in Browser"** button. Click it!

> **Tip:** In Codespaces, go to the **Ports** tab and set port 3000 to **Public** so others can access your proxy.

---

## 🌍 Rehosting on Any Platform

### Replit
1. Create a new **Node.js** repl.
2. Upload `server.js`, `index.html`, `package.json` (no folders needed).
3. Click **Run** — Replit installs dependencies and starts automatically.

### Glitch
1. Create a new project → **Import from GitHub** or upload files.
2. Glitch auto-runs `npm start`.

### Railway / Render / Fly.io
1. Connect your repo or upload files.
2. Set start command to: `node server.js`
3. Set port to: `3000` (or use `PORT` env variable — server reads it automatically).

### Any Linux VPS
```bash
# Install Node.js (if not already installed)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install project dependencies
npm install

# Run (with pm2 for persistence)
npm install -g pm2
pm2 start server.js --name ultraproxy
pm2 save
```

---

## 📁 File Structure

```
ultraproxy.zip
├── server.js      ← Node.js Express proxy backend
├── index.html     ← Frontend UI (all CSS + JS inline)
├── package.json   ← Dependencies
└── README.md      ← This file
```

**Zero folders. Zero nesting. Maximum simplicity.**

---

## 🔧 Configuration

| Environment Variable | Default | Description                         |
|----------------------|---------|-------------------------------------|
| `PORT`               | `3000`  | Port the server listens on          |

Set a custom port:
```bash
PORT=8080 node server.js
```

---

## 🌐 How It Works

1. You enter a URL or search term in the UI.
2. The frontend sends the request to `/proxy/<target-url>`.
3. The server fetches the page, rewrites all URLs, strips hostile headers (CSP, X-Frame-Options), and returns the modified HTML.
4. Injected JavaScript in the page intercepts `fetch`, `XHR`, `pushState`, and `window.open` to ensure all requests stay proxied.
5. The UI listens for `postMessage` from the iframe to keep the URL bar updated with the clean target URL.

---

## 🐛 Troubleshooting

| Problem | Solution |
|--------|---------|
| `npm install` fails | Ensure Node.js ≥ 16 is installed: `node --version` |
| Port already in use | Change port: `PORT=8080 node server.js` |
| Site loads blank | Some SPAs need a moment — try clicking reload |
| Images not loading | Check browser console — some CDNs block hotlinking |
| Site detects proxy | Some sites actively block proxies (Cloudflare, etc.) |
| Download zip 404 | Ensure all 4 files are in the same directory as `server.js` |

---

## 📦 Regenerate the ZIP

The **Download & Rehost** button at the top-right downloads a fresh ZIP containing all 4 files, ready to unzip and run anywhere — no folders, no extra steps.

---

## 📄 License

MIT — free to use, modify, and redistribute.
