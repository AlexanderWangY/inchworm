"""End-to-end test: run a throwaway Zotero with Inchworm and drive the PDF reader.

Uses a brand-new profile and data directory (your real library is never
touched), installs the plugin from this checkout via a proxy file, opens a
generated two-column PDF and presses keys through the plugin's listeners.

    python3 test/e2e/run_e2e.py [--workdir DIR] [--keep-open] [--pdf PATH]

Screenshots land in <workdir>/shots.
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, HERE)

from make_pdf import build  # noqa: E402
from marionette import Marionette  # noqa: E402

PLUGIN_ID = "inchworm@alexawang"
HELPER_ID = "inchworm-e2e-helper@alexawang"
DEFAULT_ZOTERO = "/Applications/Zotero.app/Contents/MacOS/zotero"

results = []


def check(name, ok, detail=""):
    results.append((name, bool(ok)))
    mark = "PASS" if ok else "FAIL"
    print(f"[{mark}] {name}" + (f"  — {detail}" if detail else ""), flush=True)
    return ok


def make_profile(workdir, port, xpi=None):
    profile = os.path.join(workdir, "profile")
    data = os.path.join(workdir, "data")
    os.makedirs(os.path.join(profile, "extensions"), exist_ok=True)
    os.makedirs(data, exist_ok=True)
    if xpi:
        shutil.copy(xpi, os.path.join(profile, "extensions", PLUGIN_ID + ".xpi"))
    else:
        with open(os.path.join(profile, "extensions", PLUGIN_ID), "w") as f:
            f.write(ROOT)
    with open(os.path.join(profile, "extensions", HELPER_ID), "w") as f:
        f.write(os.path.join(HERE, "helper-plugin"))
    prefs = {
        "marionette.port": port,
        "extensions.zotero.dataDir": data,
        "extensions.zotero.useDataDir": True,
        "extensions.zotero.httpServer.enabled": False,
        "extensions.zotero.sync.autoSync": False,
        "extensions.zotero.autoRecognizeFiles": False,
        "extensions.zotero.automaticScraperUpdates": False,
        "extensions.zotero.firstRunGuidance": False,
        "extensions.zotero.retractions.enabled": False,
        "app.update.enabled": False,
        "app.update.auto": False,
        "extensions.update.enabled": False,
        "extensions.autoDisableScopes": 0,
        "extensions.enabledScopes": 15,
        "xpinstall.signatures.required": False,
        "datareporting.policy.dataSubmissionEnabled": False,
        # A background test window throttles CSS transitions, which would
        # freeze the cursor mid-glide in screenshots and geometry checks
        "extensions.inchworm.animate": False,
        "extensions.inchworm.welcomed": True,
    }
    with open(os.path.join(profile, "user.js"), "w") as f:
        for key, value in prefs.items():
            f.write(f"user_pref({json.dumps(key)}, {json.dumps(value)});\n")
    return profile, data


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--workdir")
    ap.add_argument("--zotero", default=DEFAULT_ZOTERO)
    ap.add_argument("--port", type=int, default=28282)
    ap.add_argument("--pdf", help="also report the lines Inchworm finds in this real PDF")
    ap.add_argument("--xpi", help="install this built .xpi instead of loading the source folder")
    ap.add_argument("--keep-open", action="store_true")
    args = ap.parse_args()

    workdir = args.workdir or tempfile.mkdtemp(prefix="inchworm-e2e-")
    os.makedirs(workdir, exist_ok=True)
    # Zotero can't import attachments when the storage path passes ~255 chars
    if len(os.path.join(workdir, "data/storage/XXXXXXXX/inchworm-test.pdf")) > 240:
        sys.exit("--workdir path is too long for Zotero's attachment storage; use a shorter one")
    shots = os.path.join(workdir, "shots")
    os.makedirs(shots, exist_ok=True)
    profile, data = make_profile(workdir, args.port, args.xpi and os.path.abspath(args.xpi))
    pdf = os.path.join(workdir, "inchworm-test.pdf")
    with open(pdf, "wb") as f:
        f.write(build())
    print(f"workdir: {workdir}", flush=True)

    log = open(os.path.join(workdir, "zotero.log"), "w")
    proc = subprocess.Popen(
        [args.zotero, "-profile", profile, "-no-remote", "-marionette", "-remote-allow-system-access"],
        stdout=log, stderr=subprocess.STDOUT)
    m = None
    try:
        m = Marionette(port=args.port)
        m.start_chrome_session()
        run_checks(m, pdf, shots, args.pdf)
    finally:
        failed = [name for name, ok in results if not ok]
        print(f"\n{len(results) - len(failed)}/{len(results)} checks passed", flush=True)
        if failed:
            print("failed: " + ", ".join(failed))
        if not args.keep_open:
            if m:
                m.quit()
            try:
                proc.wait(timeout=20)
            except subprocess.TimeoutExpired:
                proc.kill()
        log.close()
    sys.exit(1 if [r for r in results if not r[1]] else 0)


def run_checks(m, pdf, shots, real_pdf):
    info = m.js("""
        await Zotero.uiReadyPromise;
        let t0 = Date.now();
        while (!Zotero.Inchworm && Date.now() - t0 < 20000) await Zotero.Promise.delay(200);
        return { version: Zotero.version, loaded: !!Zotero.Inchworm };
    """)
    check("plugin loads", info["loaded"], f"Zotero {info['version']}")
    if not info["loaded"]:
        return

    opened = m.js("""
        let [path] = arguments;
        let item = await Zotero.Attachments.importFromFile({ file: Zotero.File.pathToFile(path), libraryID: Zotero.Libraries.userLibraryID });
        let reader = await Zotero.Reader.open(item.id);
        await reader._initPromise;
        let t0 = Date.now();
        while (!(Zotero.Inchworm.state(item.id) || []).length && Date.now() - t0 < 30000) {
            await Zotero.Promise.delay(200);
        }
        await Zotero.Promise.delay(1500);  // let pages render and processed data arrive
        return { itemID: item.id, state: Zotero.Inchworm.state(item.id) };
    """, pdf)
    item_id = opened["itemID"]
    check("attaches to the PDF view", opened["state"], json.dumps(opened["state"]))

    def press(*keys):
        return m.js("return Zotero.Inchworm.press(arguments[0], arguments[1]);", item_id, list(keys))

    def lines(page):
        return m.js("return Zotero.Inchworm.lines(arguments[0], arguments[1]);", item_id, page)

    def aligned(item=None):
        return overlay_alignment(m, item or item_id)

    page1 = lines(0)
    print("page 1 lines (first 6):", page1[:6])
    print("page 1 lines (last 3):", page1[-3:])
    tags = [l.split("]")[0] + "]" for l in page1 if l.startswith("[")]
    expected = [f"[1L{n:02d}]" for n in range(1, 41)] + [f"[1R{n:02d}]" for n in range(1, 41)]
    check("lines come out in reading order (left column, then right)", tags == expected,
          f"{len(tags)} tagged lines")
    check("running head and page number are skipped", not any("running head" in l for l in page1)
          and page1[-1].startswith("[1R40]"), f"first={page1[0]!r} last={page1[-1]!r}")

    s = press("j")
    cur = s["cursor"]
    check("first j shows the cursor on the top visible line", s["shown"] and cur and s["overlay"],
          json.dumps(cur))
    start = cur["lineIndex"]
    s = press("j", "j", "j")
    check("j moves down one line at a time", s["cursor"]["lineIndex"] == start + 3, s["cursor"]["text"])
    s = press("k")
    check("k moves up", s["cursor"]["lineIndex"] == start + 2, s["cursor"]["text"])
    s = press("5", "j")
    check("counts work (5j)", s["cursor"]["lineIndex"] == start + 7, s["cursor"]["text"])
    m.screenshot(os.path.join(shots, "1-highlight.png"))
    a = aligned()
    check("highlight sits on the cursor line's text", a["ok"], json.dumps(a["texts"]))

    s = press("G")
    check("G goes to the last line", s["cursor"]["text"].startswith("[3R40]"), s["cursor"]["text"])
    s = press("g", "g")
    check("gg goes to the first line", s["cursor"]["pageIndex"] == 0 and s["cursor"]["lineIndex"] == 0,
          s["cursor"]["text"])
    s = press("'", "'")
    check("'' jumps back", s["cursor"]["text"].startswith("[3R40]"), s["cursor"]["text"])
    s = press("2", "G")
    check("2G goes to page 2", s["cursor"]["text"].startswith("[2L01]"), s["cursor"]["text"])
    s = press("}")
    check("} goes to the next paragraph", s["cursor"]["text"].startswith("[2L09]"), s["cursor"]["text"])
    s = press("}", "}")
    check("}} skips two more", s["cursor"]["text"].startswith("[2L25]"), s["cursor"]["text"])
    s = press("{")
    check("{ goes back a paragraph", s["cursor"]["text"].startswith("[2L17]"), s["cursor"]["text"])
    s = press("j", "{")
    check("{ from mid-paragraph goes to its start", s["cursor"]["text"].startswith("[2L17]"), s["cursor"]["text"])

    # Column and page boundaries
    s = press("g", "g")
    idx = next(i for i, l in enumerate(page1) if l.startswith("[1L40]"))
    s = press(*list(str(idx)), "j")
    check("reach the bottom of the left column", s["cursor"]["text"].startswith("[1L40]"), s["cursor"]["text"])
    s = press("j")
    check("j continues at the top of the right column", s["cursor"]["text"].startswith("[1R01]"),
          s["cursor"]["text"])
    s = press("3", "9", "j")
    check("bottom of page 1", s["cursor"]["text"].startswith("[1R40]"), s["cursor"]["text"])
    s = press("j")
    check("j crosses to the next page (skipping footer/header)", s["cursor"]["text"].startswith("[2L01]"),
          s["cursor"]["text"])
    m.screenshot(os.path.join(shots, "2-page-boundary.png"))
    s = press("k")
    check("k crosses back to the previous page", s["cursor"]["text"].startswith("[1R40]"), s["cursor"]["text"])

    s = press("z", "z")
    check("zz keeps the cursor", s["cursor"]["text"].startswith("[1R40]"))
    s = press("H")
    h = s["cursor"]["text"]
    s = press("L")
    l_ = s["cursor"]["text"]
    check("H and L pick different on-screen lines", h != l_, f"H={h[:7]} L={l_[:7]}")

    # Bookmarks
    s = press("2", "G", "}")
    s = press("m", "a")
    s = press("g", "g")
    s = press("'", "a")
    check("m a / ' a round-trips", s["cursor"]["text"].startswith("[2L09]"), s["cursor"]["text"])
    s = press("G", "m", "B")
    s = press("g", "g", "'", "B")
    check("global mark B jumps within the same paper", s["cursor"]["text"].startswith("[3R40]"),
          s["cursor"]["text"])
    s = press("'", "q")
    check("unset mark is harmless", s["cursor"]["text"].startswith("[3R40]"))
    marks = m.js("""
        await Zotero.Inchworm.flushMarks();
        return await IOUtils.readJSON(Zotero.Inchworm.marksPath);
    """)
    item_marks = next(iter(marks["items"].values()))["marks"]
    check("marks.json has a, B, ' and \"", "a" in item_marks and "B" in marks["global"]
          and "'" in item_marks and '"' in item_marks, ", ".join(sorted(item_marks)))

    # Second keys of sequences must not reach Zotero (h is Zotero's hand tool)
    tool = m.js("""
        let id = arguments[0];
        let reader = Zotero.Reader._readers.find(r => r.itemID === id && !r._isTabClosed);
        let before = reader._internalReader._state.tool.type;
        await Zotero.Inchworm.press(id, ['m', 'h']);
        let after = reader._internalReader._state.tool.type;
        await Zotero.Inchworm.flushMarks();
        let marks = await IOUtils.readJSON(Zotero.Inchworm.marksPath);
        let item = Zotero.Items.get(id);
        return { before, after, hasH: !!marks.items[item.libraryID + '/' + item.key].marks.h };
    """, item_id)
    check("m h sets bookmark h without toggling Zotero's hand tool",
          tool["before"] == tool["after"] and tool["hasH"], json.dumps(tool))
    first = press("g", "g")
    s = press("g", "j")
    check("an unfinished prefix gives way to the next key (g then j)",
          s["cursor"]["lineIndex"] == first["cursor"]["lineIndex"] + 1, s["cursor"]["text"])
    big = m.js("""
        let t0 = Date.now();
        let s = await Zotero.Inchworm.press(arguments[0], [...'99999999', '}']);
        return { ms: Date.now() - t0, text: s.cursor.text };
    """, item_id)
    check("a huge count finishes quickly (capped at 4 digits)", big["ms"] < 15000 and big["text"].startswith("[3R"),
          f"{big['ms']} ms, {big['text'][:7]}")
    press("G")

    # Escape hides, j brings it back in place
    s = press("Escape")
    check("Escape hides the cursor", not s["shown"] and not s["overlay"])
    s = press("j")
    check("j after Escape shows it again without moving", s["shown"] and s["cursor"]["text"].startswith("[3R40]"),
          s["cursor"]["text"])

    # Zoom: pdf.js re-renders pages, the overlay must come back
    z = m.js("""
        let reader = Zotero.Reader._readers.find(r => r.itemID === arguments[0]);
        let app = reader._internalReader._primaryView._iframeWindow.PDFViewerApplication;
        app.pdfViewer.currentScaleValue = '1.7';
        await Zotero.Promise.delay(2000);
        return Zotero.Inchworm.state(arguments[0])[0];
    """, item_id)
    check("overlay survives a zoom re-render", z["overlay"] and z["overlay"]["page"] == "3",
          json.dumps(z["overlay"]))
    # Zooming can scroll the line off screen (then j/k would re-anchor), so bring it back first
    s = press("z", "z", "k", "k")
    check("still moves after zooming", s["cursor"]["text"].startswith("[3R38]"), s["cursor"]["text"])

    # Focus on the reader's toolbar/sidebar document instead of the page
    outer = m.js("""
        let id = arguments[0];
        let reader = Zotero.Reader._readers.find(r => r.itemID === id && !r._isTabClosed);
        let before = Zotero.Inchworm.state(id)[0].cursor;
        let w = reader._iframeWindow;
        w.document.body.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'k', bubbles: true, cancelable: true }));
        await Zotero.Promise.delay(400);
        return { before, after: Zotero.Inchworm.state(id)[0].cursor };
    """, item_id)
    check("keys also work from the reader toolbar/sidebar", outer["after"]["lineIndex"] == outer["before"]["lineIndex"] - 1,
          f"{outer['before']['text'][:7]} -> {outer['after']['text'][:7]}")

    # Line styles
    for style in ("underline", "focus", "both", "highlight"):
        m.js("Zotero.Prefs.set('extensions.inchworm.style', arguments[0], true);", style)
        time.sleep(0.3)
        m.screenshot(os.path.join(shots, f"3-style-{style}.png"))
    css = m.js("""
        Zotero.Prefs.set('extensions.inchworm.style', 'underline', true);
        let reader = Zotero.Reader._readers.find(r => r.itemID === arguments[0]);
        let doc = reader._internalReader._primaryView._iframeWindow.document;
        let el = doc.querySelector('.inchworm-line');
        let out = { underline: el.style.borderBottom };
        Zotero.Prefs.set('extensions.inchworm.style', 'highlight', true);
        out.highlight = el.style.backgroundColor;
        return out;
    """, item_id)
    check("style pref restyles the live overlay", css["underline"].startswith("2px solid") and "rgba" in css["highlight"],
          json.dumps(css))

    # Toolbar button and menu
    menu = m.js("""
        let reader = Zotero.Reader._readers.find(r => r.itemID === arguments[0]);
        let btn = reader._iframeWindow.document.querySelector('.inchworm-toolbar-button');
        if (!btn) return { button: false };
        btn.click();
        await Zotero.Promise.delay(600);
        let popup = document.getElementById('inchworm-menu');
        let labels = popup ? Array.from(popup.querySelectorAll(':scope > menuitem, :scope > menu')).map(x => x.getAttribute('label')) : [];
        let state = popup && popup.state;
        return { button: true, state, labels };
    """, item_id)
    check("toolbar button exists", menu["button"])
    check("bookmark menu opens and lists bookmarks", menu.get("state") == "open"
          and any(l.startswith("a ") for l in menu.get("labels", [])), json.dumps(menu.get("labels")))
    m.screenshot(os.path.join(shots, "4-menu.png"))
    # Wait for the menu to be fully gone: an open menu swallows key presses
    m.js("""
        document.getElementById('inchworm-menu')?.hidePopup();
        let t0 = Date.now();
        while (document.getElementById('inchworm-menu') && Date.now() - t0 < 5000) await Zotero.Promise.delay(50);
    """)

    # Help overlay
    m.js("return Zotero.Inchworm.press(arguments[0], ['?']);", item_id)
    m.screenshot(os.path.join(shots, "5-help.png"))
    help_open = m.js("""
        let reader = Zotero.Reader._readers.find(r => r.itemID === arguments[0]);
        let doc = reader._internalReader._primaryView._iframeWindow.document;
        let help = doc.querySelector('.inchworm-help');
        if (!help) return false;
        let r = help.getBoundingClientRect();
        let hit = doc.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return !!(hit && hit.closest('.inchworm-help'));
    """, item_id)
    check("? shows the key help, drawn above the page", help_open)
    m.js("return Zotero.Inchworm.press(arguments[0], ['?']);", item_id)

    # Preferences pane
    prefs = m.js("""
        Zotero.Utilities.Internal.openPreferences('zotero-prefpane-inchworm');
        let win, t0 = Date.now();
        while (Date.now() - t0 < 15000) {
            win = Services.wm.getMostRecentWindow('zotero:pref');
            if (win && win.document.getElementById('inchworm-style')) break;
            await Zotero.Promise.delay(200);
        }
        let doc = win && win.document;
        let menu = doc && doc.getElementById('inchworm-style');
        if (!menu) return { found: false };
        await Zotero.Promise.delay(300);
        let out = { found: true, value: menu.value, color: doc.getElementById('inchworm-color').value };
        menu.value = 'underline';
        menu.dispatchEvent(new win.Event('command'));
        out.prefAfter = Zotero.Prefs.get('extensions.inchworm.style', true);
        Zotero.Prefs.set('extensions.inchworm.style', 'highlight', true);
        win.close();
        return out;
    """)
    check("preferences pane loads and edits prefs", prefs.get("found") and prefs.get("value") == "highlight"
          and prefs.get("prefAfter") == "underline", json.dumps(prefs))

    # Close and reopen: '" (last position) is remembered
    reopened = m.js("""
        let id = arguments[0];
        let reader = Zotero.Reader._readers.find(r => r.itemID === id);
        let before = Zotero.Inchworm.state(id)[0].cursor.text;
        Zotero_Tabs.close(reader.tabID);
        await Zotero.Promise.delay(1000);
        let again = await Zotero.Reader.open(id);
        await again._initPromise;
        let t0 = Date.now();
        while (!(Zotero.Inchworm.state(id) || []).length && Date.now() - t0 < 30000) await Zotero.Promise.delay(200);
        await Zotero.Promise.delay(1500);
        let s = await Zotero.Inchworm.press(id, ["'", '"']);
        return { before, after: s.cursor && s.cursor.text };
    """, item_id)
    check("'\" resumes where the cursor was after reopening", reopened["after"] == reopened["before"],
          json.dumps(reopened))
    m.screenshot(os.path.join(shots, "6-reopened.png"))

    if real_pdf:
        real = m.js("""
            let item = await Zotero.Attachments.importFromFile({ file: Zotero.File.pathToFile(arguments[0]), libraryID: Zotero.Libraries.userLibraryID });
            let reader = await Zotero.Reader.open(item.id);
            await reader._initPromise;
            let t0 = Date.now();
            while (!(Zotero.Inchworm.state(item.id) || []).length && Date.now() - t0 < 30000) await Zotero.Promise.delay(200);
            await Zotero.Promise.delay(2500);
            let s1 = await Zotero.Inchworm.press(item.id, ['j', '1', '5', 'j']);
            return { itemID: item.id, page0: await Zotero.Inchworm.lines(item.id, 0), page1: await Zotero.Inchworm.lines(item.id, 1), cursor: s1.cursor };
        """, os.path.abspath(real_pdf))
        print("\nreal PDF, page 1:")
        for line in real["page0"]:
            print("   ", line[:110])
        print("real PDF, page 2 (first 25):")
        for line in real["page1"][:25]:
            print("   ", line[:110])
        print("cursor after j 15j:", real["cursor"])
        m.screenshot(os.path.join(shots, "7-real-pdf.png"))
        a = overlay_alignment(m, real["itemID"])
        check("real PDF: highlight sits on the cursor line's text", a["ok"], json.dumps(a["texts"]))

        # Global bookmark set in one paper, jumped to from another
        cross = m.js("""
            let [realID, testID] = arguments;
            let s = await Zotero.Inchworm.press(realID, ['m', 'C']);
            let target = s.cursor.text;
            await Zotero.Inchworm.press(realID, ['G']);  // move away so the jump has to bring it back
            let testReader = Zotero.Reader._readers.find(r => r.itemID === testID && !r._isTabClosed);
            Zotero_Tabs.select(testReader.tabID);
            await Zotero.Promise.delay(500);
            await Zotero.Inchworm.press(testID, ["'", 'C']);
            let t0 = Date.now(), now = null;
            while (Date.now() - t0 < 10000) {
                let r = Zotero.Reader.getByTabID(Zotero_Tabs.selectedID);
                now = r && r.itemID === realID && (Zotero.Inchworm.state(realID) || [])[0];
                if (now && now.cursor && now.cursor.text === target) break;
                await Zotero.Promise.delay(200);
            }
            return { target, selected: Zotero.Reader.getByTabID(Zotero_Tabs.selectedID)?.itemID === realID, now: now && now.cursor };
        """, real["itemID"], item_id)
        check("global bookmark C jumps to the other paper", cross["selected"] and cross["now"]
              and cross["now"]["text"] == cross["target"], json.dumps(cross))


def overlay_alignment(m, item_id):
    """Which pdf.js text-layer spans have their centre inside the highlight box?"""
    return m.js(r"""
        let id = arguments[0];
        let reader = Zotero.Reader._readers.find(r => r.itemID === id && !r._isTabClosed);
        let doc = reader._internalReader._primaryView._iframeWindow.document;
        let state = Zotero.Inchworm.state(id)[0];
        let el = doc.querySelector('.inchworm-line');
        if (!el || !state.cursor) return { ok: false, texts: ['no overlay'] };
        // give pdf.js a moment to render the text layer of a newly visible page
        let t0 = Date.now();
        while (!el.parentNode.querySelector('.textLayer span') && Date.now() - t0 < 3000) await Zotero.Promise.delay(100);
        let box = el.getBoundingClientRect();
        let texts = [];
        for (let span of el.parentNode.querySelectorAll('.textLayer span')) {
            if (!span.textContent.trim() || span.children.length) continue;
            let b = span.getBoundingClientRect();
            let cx = (b.left + b.right) / 2, cy = (b.top + b.bottom) / 2;
            if (cy > box.top && cy < box.bottom && cx > box.left && cx < box.right) texts.push(span.textContent);
        }
        let norm = t => t.normalize('NFKC').replace(/[\s\u00ad-]+/g, '');
        let line = norm(state.cursor.text);
        let ok = texts.length > 0 && texts.every(t => line.includes(norm(t)));
        return { ok, texts, line: state.cursor.text };
    """, item_id)


if __name__ == "__main__":
    main()
