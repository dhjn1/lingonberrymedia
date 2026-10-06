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


def search(page, text, expected_title):
    page.fill("#search-input", text)
    expect(page.locator(".search-results .result-title")).to_have_text(expected_title)


def main():
    httpd = serve()
    url = f"http://127.0.0.1:{httpd.server_address[1]}/index.html"
    errors = []
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1320, "height": 1000})
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

        night = page.locator("#night")
        rows = page.locator(".row")
        drawer = page.locator("#drawer")

        # Demo mode boots straight into tonight's seeded lineup
        expect(page.locator("#demo-banner")).to_be_visible()
        expect(page.locator(".tl-block")).to_have_count(2)
        expect(rows).to_have_count(2)
        expect(page.locator(".tl-foot")).to_contain_text("Estimated from other episodes in this season")
        expect(night.locator(".night-meta")).to_contain_text("~10:44 PM")  # 21:00 + 53 (median) + 51
        expect(page.locator(".tl-end")).to_have_count(1)
        shot(page, "01-tonight")

        # Episode picker in the drawer: next-up highlight, watched, estimates
        search(page, "harbor", "Harbor Lights")
        page.click(".search-results [data-act=open-show]")
        expect(drawer.locator("h2")).to_have_text("Harbor Lights")
        expect(page.locator(".search-results")).to_be_hidden()
        expect(drawer.locator(".seg-item.is-current")).to_have_text("S2")
        expect(drawer.locator(".episode", has=page.locator(".pill-berry"))).to_contain_text("Fog Bank")
        expect(drawer.locator(".episode.is-watched")).to_have_count(2)
        drawer.locator("[data-act=next-n][data-n='2']").click()
        expect(drawer.locator(".drawer-foot")).to_contain_text("2 selected, ~1h 44m")
        shot(page, "02-picker")
        drawer.locator("[data-act=add-episodes]").click()
        expect(drawer).to_be_hidden()
        expect(rows).to_have_count(4)

        # Show with no runtimes at all: show-typical fallback footnote
        search(page, "orchard", "The Quiet Orchard")
        page.click(".search-results [data-act=open-show]")
        drawer.locator("[data-act=next-n][data-n='1']").click()
        drawer.locator("[data-act=add-episodes]").click()
        expect(page.locator(".tl-foot")).to_contain_text("show's typical episode length")

        # Movie with no runtime: default footnote
        search(page, "north", "North of Nowhere")
        page.click(".search-results [data-act=add-movie]")
        expect(rows).to_have_count(6)
        expect(page.locator(".tl-foot")).to_contain_text("assumed 120 min")

        # Correct a runtime by hand: estimate mark goes, "edited" appears
        rows.last.locator("[data-act=edit-runtime]").click()
        page.fill(".runtime-input", "97")
        page.keyboard.press("Enter")
        expect(rows.last.locator(".runtime")).to_contain_text("1h 37m")
        expect(rows.last.locator(".runtime")).to_contain_text("edited")
        expect(page.locator(".tl-foot")).not_to_contain_text("assumed 120 min")

        # Reorder and remove
        rows.last.locator("[data-act=up]").click()
        expect(rows.nth(4).locator(".row-title")).to_have_text("North of Nowhere")
        rows.nth(4).locator("[data-act=remove]").click()
        expect(rows).to_have_count(5)

        # Game night on Thursday: anchored kickoff, clash, then free time
        page.locator("#week .seg-item").nth(2).click()
        expect(page.locator(".timeline-empty")).to_be_visible()
        page.fill("#start-time", "18:30")
        page.locator("#start-time").dispatch_event("change")
        page.click(".timeline-empty [data-act=open-custom]")
        expect(drawer.locator("input[name=title]")).to_have_value("NFL: Thursday Night Football")
        drawer.locator("input[name=subtitle]").fill("Bears at Packers")
        drawer.locator("button[type=submit]").click()
        expect(drawer).to_be_hidden()
        search(page, "harbor", "Harbor Lights")
        page.click(".search-results [data-act=open-show]")
        drawer.locator("[data-act=next-n][data-n='1']").click()
        drawer.locator("[data-act=add-episodes]").click()
        rows.nth(1).locator("[data-act=up]").click()  # 18:30 + 53m runs past 19:15
        expect(page.locator(".row-warn")).to_contain_text("into kickoff")
        expect(page.locator(".tl-clash")).to_have_count(1)
        page.fill("#start-time", "18:00")
        page.locator("#start-time").dispatch_event("change")
        expect(page.locator(".tl-gap")).to_contain_text("22m")
        expect(page.locator(".kickoff input")).to_have_value("19:15")
        expect(page.locator(".tl-foot")).to_contain_text("overtime not included")
        expect(night.locator(".night-meta")).to_contain_text("~10:30 PM")
        expect(page.locator("#week .seg-item.is-current .seg-dot.is-game")).to_have_count(1)
        shot(page, "03-game-night")

        # Discord preview dialog
        page.click("[data-act=discord]")
        expect(page.locator(".discord-preview")).to_contain_text("Total ~4h 8m, ends ~10:30 PM")
        shot(page, "04-discord")
        page.click("#dialog button[value=post]")
        expect(page.locator("#toast")).to_contain_text("Posted to Discord")

        # Mark watched, then progress shows in the picker
        page.click("[data-act=watched]")
        expect(page.locator("[data-act=watched]")).to_have_text("Watched")
        search(page, "harbor", "Harbor Lights")
        page.click(".search-results [data-act=open-show]")
        expect(drawer.locator(".drawer-titles")).to_contain_text("Last watched S2E3")
        drawer.locator("[data-act=close-drawer]").click()

        # Queue: add a movie and the next episode straight from the cards
        cards = page.locator(".card")
        expect(cards).to_have_count(2)
        orchard = cards.filter(has_text="The Quiet Orchard")
        expect(orchard.locator("[data-act=add-next]")).to_have_text("Add S1E1 to Thu")
        orchard.locator("[data-act=add-next]").click()
        expect(rows).to_have_count(3)
        expect(orchard.locator("[data-act=add-next]")).to_have_text("Add S1E2 to Thu")
        cards.filter(has_text="Glass Harvest").locator("[data-act=add-movie]").click()
        expect(rows).to_have_count(4)
        page.click("[data-filter=movie]")
        expect(cards).to_have_count(1)
        page.click("[data-filter=all]")

        # Phone width
        page.set_viewport_size({"width": 390, "height": 900})
        page.locator("#week .seg-item").nth(0).click()
        expect(rows).to_have_count(5)
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
