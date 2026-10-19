# 🐛 Inchworm

Read papers in Zotero one line at a time, the way an inchworm gets around.

Inchworm adds a **line cursor with vim keys** to Zotero's PDF reader: press `j` / `k` to move down and up a line at a time, and the current line is highlighted or underlined. It also adds **bookmarks** (vim-style marks), so you can save your place in a paper and jump back to it later, even from another paper.

Works on Zotero 7 through 10, with PDFs. It has been tested on Zotero 10.0.1 for macOS.

## Install

1. Download `inchworm-<version>.xpi` from the [latest release](https://github.com/AlexanderWangY/inchworm/releases/latest).
2. In Zotero, open **Tools → Plugins**, click the gear menu, choose **Install Plugin From File…**, and pick the `.xpi`. You can also drag the `.xpi` onto the Plugins window.
3. Open any PDF and press `j`.

Zotero checks for new versions on its own and updates the plugin from new releases.

To build from source instead, run `./scripts/build.sh`; it writes `build/inchworm-<version>.xpi`.

## Keys

Keys work while the PDF has focus, or the reader's toolbar or sidebar. They never fire while you're typing in a text field, a comment or the search box. Inchworm sees keys before Zotero does, so the second key of a sequence (the `h` in `mh`) never also triggers a Zotero shortcut.

| Keys | What it does |
|---|---|
| `j` / `k` | next / previous line. The first press shows the cursor on the top line of the screen. |
| `5j`, `12k` | move several lines at once |
| `}` / `{` | next / previous paragraph |
| `H` `M` `L` | jump to the top / middle / bottom line on screen |
| `gg` / `G` | first / last line of the paper |
| `12G` or `12gg` | first line of page 12 |
| `zz` `zt` `zb` | scroll so the line sits in the center / top / bottom |
| `m` + `a`–`z` | bookmark the current line in this paper |
| `m` + `A`–`Z` | bookmark that works **across papers**: `'A` reopens that paper and jumps there |
| `'` + letter | jump to a bookmark (`` ` `` works too) |
| `''` | jump back to where you were before the last jump |
| `'"` | jump to where the cursor was when you last read this paper |
| `Esc` | close the help, or hide the cursor. `j`/`k` bring it back in the same place. If Zotero uses `Esc` itself (to deselect an annotation, say), the cursor stays. |
| `?` | show / hide the key help |
| click | while the cursor is showing, clicking text moves it there |

The cursor follows reading order, so in two-column papers `j` goes down the left column and then continues at the top of the right one. Running headers, footers and page numbers are skipped.

## Bookmarks

* **Keyboard:** `m` + a letter saves the current line; `'` + the letter jumps back.
* **Toolbar:** the bookmark button (next to **Aα**) opens a menu with:
  - *Bookmark this line*
  - *Where I left off*
  - a list of this paper's bookmarks and the cross-paper ones
  - a *Remove bookmark* submenu
  - *Line style* and *Keyboard shortcuts*
* Bookmarks are saved in your Zotero data directory, in `inchworm/marks.json`. They survive restarts but are **not synced** between computers. Zotero's sync server only accepts its own setting names, so plugins can't sync data that way.

## Settings

In **Zotero → Settings → Inchworm**:

* **Line style:** Highlight, Underline, Highlight + underline, or Focus (dims everything except the line)
* **Color:** the highlight or underline color
* **Keep the line:** how far from the edge the cursor stays while you scroll. 50% keeps it centered.
* **Skip running headers, footers and page numbers**
* **Clicking text moves the line cursor**

## Known limitations

* PDFs only. EPUBs and web snapshots aren't supported yet. Inchworm also steps aside while Zotero 10's Reading Mode is on.
* Text inside figures (axis labels and the like) also counts as lines. Use `}` to hop over a figure.
* Inchworm uses the reader's internal objects (`_internalReader`, `_pdfPages`), which can change between Zotero releases. `manifest.json` allows Zotero up to `10.0.*`. When Zotero 11 ships, run the tests and then raise `strict_max_version`.

## Development

```
manifest.json, bootstrap.js, prefs.js    plugin entry points
src/lines.js       pure line model: chars → lines, header/footer detection, geometry (unit tested)
src/marks.js       bookmark storage (marks.json)
src/inchworm.js    reader hooks, keys, cursor overlay, toolbar menu
content/           preferences pane and icon
test/              unit tests and the end-to-end runner
```

**How it works:**

* Zotero's PDF worker already splits each page into characters in reading order, with `lineBreakAfter` flags. That is the data the reader uses for text selection, and Inchworm turns it into lines.
* The highlight is a `div` inside the pdf.js page, positioned in percentages so it follows zoom. pdf.js empties page divs when it re-renders them, so a MutationObserver puts the highlight back.
* While the plugin runs, it exposes `Zotero.Inchworm` (`state`, `press`, `lines`) for debugging in **Tools → Developer → Run JavaScript**.

**Unit tests:**

```bash
npm test
```

**End-to-end tests** start a separate, throwaway Zotero with a temporary profile and library, then drive the reader through Marionette. Your real library isn't touched.

```bash
npm run e2e
```

* Add `--pdf path/to/paper.pdf` (after `npm run e2e --`) to also print the lines Inchworm finds in a real paper, and `--xpi build/inchworm-0.1.0.xpi` to test the packaged file instead of this folder.
* Screenshots are saved to the temporary work directory the runner prints.
* Two quirks the runner works around:
  - Marionette waits for a Firefox-only startup signal, so `test/e2e/helper-plugin` sends it.
  - Zotero can't store attachments under very long paths, so keep `--workdir` short.

**Live development without rebuilding:**

1. Quit Zotero.
2. Create a text file named `inchworm@alexawang` in your profile's `extensions/` folder, containing the absolute path of this folder.
3. Delete the `extensions.lastAppBuildId` line from the profile's `prefs.js`.
4. Start Zotero again.

## Releasing

Releases are built and published by GitHub Actions; nothing in `build/` is committed.

1. Bump `"version"` in `manifest.json`, for example to `0.2.0`, and commit it.
2. Tag that commit with the same version and push both:
   ```bash
   git tag v0.2.0
   ```
   ```bash
   git push origin main v0.2.0
   ```
3. The [Release workflow](.github/workflows/release.yml) then:
   - checks that the tag matches `manifest.json`;
   - runs the unit tests and builds the `.xpi`;
   - writes `updates.json`, the file Zotero polls (via `update_url` in `manifest.json`) to find new versions;
   - creates the GitHub release with both files attached and generated release notes.

A tag with a suffix, like `v0.2.0-beta.1`, becomes a pre-release. Zotero only reads the latest full release, so pre-releases never auto-update anyone.

When Zotero 11 ships, run the end-to-end tests against it, raise `strict_max_version` in `manifest.json`, and release a new version.

[CI](.github/workflows/ci.yml) runs the syntax checks and unit tests on every push and pull request, and attaches the built `.xpi` to the run. The end-to-end tests need a desktop Zotero, so they only run locally.
