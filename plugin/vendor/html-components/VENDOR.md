# Vendored: html-components / telegram

- Source: https://github.com/qwwiwi/html-components, folder `telegram/`
- Commit: `5dc5810cb7d087592cb7621c1ec610c7dfa9ec78`
- License: MIT, see `LICENSE` in this folder (copied from upstream unchanged)
- Refresh: replace `telegram/` with the upstream `telegram/` folder of the new full commit sha, drop the
  upstream test files, copy `LICENSE`, update the commit above, then run `bun test` and `tsc --noEmit` in `plugin/`

Local changes: none. Upstream test files (`*.test.js`, `*.test.mjs`) are not
copied: they run in upstream's own suite. `index.mjs` and `index.d.mts` next
to this file are the plugin's typed entry point and are not upstream files.
The runtime never fetches anything over the network: the plugin imports only
this copy.
