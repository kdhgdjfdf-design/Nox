# ShadowBox Nox — Troubleshooting Log

Use this checklist before changing files for a recurring GitHub Pages problem. Keep work inside this repository and use the existing branches; do not create extra branches just to test.

## GitHub Pages deploy says success, but Chrome shows old content

1. **Identify the exact page** the user opened and the exact URL linked from the previous page. Do not test only the site homepage when the issue is in a nested lesson page.
2. **Verify the repository file on the intended branch** and note its latest commit/blob SHA.
3. **Verify the workflow trigger paths.** If a changed HTML/CSS/JS asset is missing from the workflow's `on.push.paths`, a push to that file may not start a deployment.
4. **Verify the actual Actions run**: branch, head commit SHA, final status and conclusion. A green run alone is not proof that the live URL serves the expected content.
5. **Verify the deployed URL itself**, ideally by comparing a distinctive marker from the source file with the live response. If direct live inspection is unavailable, state that limitation instead of claiming the live page was verified.
6. **Rule out browser/CDN cache** by opening the exact page in Chrome Incognito and using a cache-busting query such as `?v=YYYYMMDD-shortlabel`. If the page is stale, test the nested page directly, not just the homepage.
7. **Check the Pages publishing mechanism and target** before changing settings. This repository's workflow assembles the stable `main` branch at the site root and `feature/local-smart-coach` under `/preview/`; do not confuse the root URL with the preview URL.
8. **Make the smallest justified change**, deploy, then repeat the live verification. Do not add branches or make unrelated changes as a guess.

## Known lessons from earlier sessions

- Files existing in GitHub does not prove they were included in the Pages artifact.
- A successful Actions run does not by itself prove that the live site is serving the latest version.
- When a page opens an older nested page, check both the parent page's link/version query and the nested page's own deployed content.
- For YouTube Error 153 seen when opening a local `content://` HTML file, test via the HTTPS GitHub Pages site instead; do not assume the same result from a local file.
- For a 404, first verify Pages source, deployment status, exact path and case-sensitive filename before editing application code.

## Current case — 2026-10-20

- Latest relevant Actions run: `39366924107`, commit `79a7a73b86e5fbaca305ac7f0968bdfa01daf4ad`, conclusion `success`.
- Updated repository pages: `boxing-basics-section.html` and `boxing-warmups.html`.
- The live site could not be independently fetched from the current tool environment during this check. Therefore the deployment job is verified, but live-page content is **not yet verified**.
- Next check: open the exact nested lesson URLs in Chrome Incognito with fresh `?v=` values; compare the visible page against the repository version. If it is still old, inspect the deployed artifact/Pages target and the parent link before changing more files.
