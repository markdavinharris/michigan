import asyncio, sys
from playwright.async_api import async_playwright
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        for scheme,w in (('light',1200),('dark',1200),('light',400)):
            pg = await b.new_page(viewport={'width':w,'height':900}, color_scheme=scheme)
            errs=[]; pg.on('pageerror', lambda e: errs.append(str(e))); pg.on('console', lambda m: errs.append(m.text) if m.type=='error' else None)
            html = open('dashboard.html').read()
            await pg.set_content('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head><body>'+html+'</body></html>')
            await pg.wait_for_timeout(1500)
            sw = await pg.evaluate('document.documentElement.scrollWidth'); print(scheme,w,'scrollWidth',sw, 'errors',errs)
            await pg.screenshot(path=f'shot_{scheme}_{w}.png', full_page=True)
            if scheme=='light' and w==1200:
                await pg.select_option('#scope','WAYNE'); await pg.wait_for_timeout(800)
                await pg.screenshot(path='shot_county.png', full_page=True)
                print(await pg.evaluate("document.querySelector('#kpis').innerText.slice(0,600)"))
        await b.close()
asyncio.run(main())
