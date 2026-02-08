# WebGate Proxy

A full-featured web proxy with URL rewriting, resource proxying, header stripping, and cookie handling.

## Quick Start

1. Make sure you have Node.js 14+ installed
2. Run: \`npm start\`
3. Open http://localhost:3000 in your browser

## GitHub Codespace Setup

1. Create a new Codespace or upload these files
2. Open the terminal
3. Run: \`npm start\`
4. The Codespace will provide a forwarded URL - open it in your browser

## Environment Variables

- \`PORT\` - Server port (default: 3000)

## Features

- Full URL rewriting for HTML, CSS, and JavaScript
- Security header stripping (CSP, X-Frame-Options, etc.)
- Cookie proxying between client and target sites
- User-Agent rotation
- Support for GET and POST requests
- Form submission proxying
- Dynamic URL rewriting via MutationObserver
- Fetch/XHR interception for API calls
- SRI integrity attribute removal
- Gzip/Deflate/Brotli decompression
- Inline style URL rewriting
- Srcset attribute handling
- Meta refresh redirect proxying

## How It Works

1. The proxy fetches the target page server-side
2. All URLs in the HTML/CSS are rewritten to go through the proxy
3. A client-side script is injected to intercept navigation, form submissions, and API calls
4. Security headers that would block framing/loading are removed
5. Cookies are stored server-side and forwarded with requests

## Files

- \`server.js\` - The complete proxy server (single file, no folders needed)
- \`package.json\` - Node.js package configuration
- \`README.md\` - This file

## Notes

- This is a single-file server with zero dependencies (uses only Node.js built-in modules)
- No folders needed - all 3 files go in the same directory
- Works on any platform that supports Node.js 14+
- The PORT environment variable is automatically set by most hosting platforms
