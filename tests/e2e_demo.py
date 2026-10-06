"""End-to-end check of the app in demo mode (no Supabase needed).

Usage: python3 tests/e2e_demo.py [screenshot_dir]
Serves web/ locally, drives Chromium through the main flows, and fails on
any assertion or browser console error.
"""
import http.server
import pathlib
import socketserver
import sys
import threading
from functools import partial

from playwright.sync_api import expect, sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent / "web"
SHOTS = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else None


def serve():
    handler = partial(http.server.SimpleHTTPRequestHandler, directory=str(ROOT))
    handler.log_message = lambda *a: None
    httpd = socketserver.TCPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


def shot(page, name):
    if SHOTS:
        SHOTS.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(SHOTS / f"{name}.png"), full_page=True)


def main():
    httpd = serve()
    url = f"http://127.0.0.1:{httpd.server_address[1]}/index.html"
    errors = []
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1320, "height": 1000})
        # Fonts come from Google; offline here, so block quietly.
        page.route("**/fonts.googleapis.com/**", lambda r: r.abort())
        page.route("**/fonts.gstatic.com/**", lambda r: r.abort())
        # Force demo mode regardless of the real Supabase details in config.js
        page.route("**/config.js", lambda r: r.fulfill(
            content_type="text/javascript",
            body="export default { supabaseUrl: '', supabaseKey: '' };"))
        page.on("console", lambda m: m.type == "error" and "Failed to load resource" not in m.text and errors.append(m.text))
        page.on("requestfailed", lambda r: "fonts.g" not in r.url and errors.append(f"request failed: {r.url}"))
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(url)

        # Demo mode boots straight into tonight's seeded lineup
        expect(page.locator("#demo-banner")).to_be_visible()
        expect(page.locator(".slot")).to_have_count(2)
        expect(page.locator(".footnotes")).to_contain_text("Estimated from other episodes in this season")
        expect(page.locator(".stat-value").first).to_have_text("~10:44 PM")  # 9:00 + 53 (median) + 51
        shot(page, "01-tonight")

        # Episode picker: search, open show, next-up highlight, estimates
        page.fill("#search-input", "harbor")
        expect(page.locator(".result")).to_have_count(1)
        page.click("[data-act=open-show]")
        expect(page.locator(".picker-title")).to_have_text("Harbor Lights")
        expect(page.locator(".season.is-current")).to_have_text("S2")
        expect(page.locator(".episode.is-next")).to_contain_text("Fog Bank")
        expect(page.locator(".episode.is-watched")).to_have_count(2)
        page.click("[data-act=next-n][data-n='2']")
        expect(page.locator(".picker-foot")).to_contain_text("2 selected, ~1h 44m")
        shot(page, "02-picker")
        page.click("[data-act=add-episodes]")
        expect(page.locator(".slot")).to_have_count(4)
        page.click("[data-act=close-picker]")

        # Show with no runtimes at all: show-typical fallback footnote
        page.fill("#search-input", "orchard")
        expect(page.locator(".result-title")).to_have_text("The Quiet Orchard")
        page.click("[data-act=open-show]")
        page.click("[data-act=next-n][data-n='1']")
        page.click("[data-act=add-episodes]")
        page.click("[data-act=close-picker]")
        expect(page.locator(".footnotes")).to_contain_text("show's typical episode length")

        # Movie with no runtime: default footnote
        page.fill("#search-input", "north")
        expect(page.locator(".result-title")).to_have_text("North of Nowhere")
        page.click("[data-act=add-movie]")
        expect(page.locator(".slot")).to_have_count(6)
        expect(page.locator(".footnotes")).to_contain_text("assumed 120 min")

        # Correct a runtime by hand: estimate mark goes, "edited" appears
        last = page.locator(".slot").last
        last.locator("[data-act=edit-runtime]").click()
        page.fill(".runtime-input", "97")
        page.keyboard.press("Enter")
        expect(page.locator(".slot").last.locator(".runtime")).to_contain_text("1h 37m")
        expect(page.locator(".slot").last.locator(".runtime")).to_contain_text("edited")
        expect(page.locator(".footnotes")).not_to_contain_text("assumed 120 min")

        # Reorder: move the last item to the top
        page.locator(".slot").last.locator("[data-act=up]").click()
        expect(page.locator(".slot").nth(4).locator(".card-title")).to_have_text("North of Nowhere")

        # Remove it again
        page.locator(".slot").nth(4).locator("[data-act=remove]").click()
        expect(page.locator(".slot")).to_have_count(5)

        # Game night on another day: anchored kickoff, gap + flow after
        page.click(".day >> nth=2")
        expect(page.locator(".empty")).to_be_visible()
        page.fill("#start-time", "18:30")
        page.click("[data-tab=custom]")
        page.click("[data-act=preset][data-preset=tnf]")
        page.fill("input[name=subtitle]", "Bears at Packers")
        page.click(".custom-form button[type=submit]")
        page.click("[data-tab=search]")
        page.fill("#search-input", "harbor")
        expect(page.locator(".result-title")).to_have_text("Harbor Lights")
        page.click("[data-act=open-show]")
        page.click("[data-act=next-n][data-n='1']")
        page.click("[data-act=add-episodes]")
        page.click("[data-act=close-picker]")
        # Move the episode before the game: 6:30 + ~51m runs past 7:15 kickoff
        page.locator(".slot").nth(1).locator("[data-act=up]").click()
        expect(page.locator(".interval-clash")).to_contain_text("past kickoff")
        # Start earlier: now there's free time before kickoff
        page.fill("#start-time", "18:00")
        page.locator("#start-time").dispatch_event("change")
        expect(page.locator(".interval")).to_contain_text("free before kickoff")
        expect(page.locator(".slot-game .rail-anchor input")).to_have_value("19:15")
        expect(page.locator(".footnotes")).to_contain_text("overtime not included")
        expect(page.locator(".stat-value").first).to_have_text("~10:30 PM")
        expect(page.locator(".day.is-current .day-flag")).to_have_text("Game")
        shot(page, "03-game-night")

        # Discord preview dialog
        page.click("[data-act=discord]")
        expect(page.locator(".discord-preview")).to_contain_text("Total ~4h 8m, ends ~10:30 PM")
        shot(page, "04-discord")
        page.click(".dialog button[value=post]")
        expect(page.locator("#toast")).to_contain_text("Posted to Discord")

        # Mark watched, then progress shows in the picker
        page.click("[data-act=watched]")
        expect(page.locator("[data-act=watched]")).to_have_text("Watched")
        page.click("[data-act=open-show]")
        expect(page.locator(".picker .result-meta")).to_contain_text("Last watched S2E3")
        page.click("[data-act=close-picker]")

        # Queue tab
        page.click("[data-tab=queue]")
        expect(page.locator(".result")).to_have_count(2)

        # Phone width
        page.set_viewport_size({"width": 390, "height": 900})
        page.click(".day >> nth=0")
        expect(page.locator(".slot")).to_have_count(5)
        overflow = page.evaluate("document.documentElement.scrollWidth > window.innerWidth")
        assert not overflow, "horizontal scroll at phone width"
        shot(page, "05-phone")

        browser.close()
    httpd.shutdown()
    if errors:
        raise SystemExit("Browser errors:\n" + "\n".join(errors))
    print("E2E DEMO TESTS PASSED")


if __name__ == "__main__":
    main()
