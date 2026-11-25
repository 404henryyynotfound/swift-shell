# SwiftShell website

A zero-dependency, static marketing site for SwiftShell. It is ready to deploy to Surge as <https://swift-shell.surge.sh>.

No build step, no package install, and no external fonts or CDNs. The whole site is `index.html`, `styles.css`, `app.js`, `favicon.svg`, and `CNAME`.

## Local preview

From the **site directory**:

```sh
cd swift-shell/site
python3 -m http.server 8080
```

Then open <http://localhost:8080> in your browser. Press `Ctrl+C` in the terminal to stop the server.

## Deploy to Surge

From the **`swift-shell/` directory** (one level above `site/`):

```sh
cd swift-shell
npx surge ./site swift-shell.surge.sh
```

Surge reads the `CNAME` file inside `site/` to confirm the custom domain. The `.surgeignore` file keeps `README.md`, `.DS_Store`, `node_modules/`, `.git/`, and `*.log` out of the published site.

## Notes

- The playground in `app.js` runs a deliberately small, safe subset of SwiftShell directly in the browser. It uses a hand-written tokenizer, parser, and evaluator — no `eval`, `new Function`, network calls, or dependencies.
- Download links point to <https://github.com/404henryyynotfound/swift-shell/releases/latest>.
