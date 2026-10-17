# Fonts

No font files are bundled and nothing is fetched at runtime (the venue LAN has no internet).
The UI uses the stacks in `src/index.css`:

- Text: "IBM Plex Sans", "Helvetica Neue", Helvetica, Arial, sans-serif
- Numbers, hashes, ids, code: "IBM Plex Mono", ui-monospace, Menlo, Consolas, monospace

If IBM Plex is installed on the presenting machine it is used; otherwise the system grotesk and monospace apply.
To self-host later: download IBM Plex Sans/Mono 400 and 600 woff2 from https://github.com/IBM/plex
(SIL Open Font License 1.1), put them in this folder, and add `@font-face` rules to `src/index.css`
with `src: url("/fonts/<file>.woff2") format("woff2")` and `font-display: swap`.
