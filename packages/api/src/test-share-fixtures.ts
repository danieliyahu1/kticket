// Constants shared by the shareable-page tests. Kept dependency-free so pure
// unit tests (HTML rendering, sitemap text) do not pull in the app harness.

export const PREVIEW_ORIGIN = "https://kticket.example.com";

/** A production-shaped shell: generic metadata, the SPA mount, and its script. */
export const SPA_SHELL_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="description" content="generic description" />
    <title>kticket</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/assets/app.js"></script>
  </body>
</html>
`;
