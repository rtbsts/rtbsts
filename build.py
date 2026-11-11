#!/usr/bin/env python3
"""
Rita Bastos — site generator.

Reads the content from content/ (one JSON file per case study, plus about.json and
settings.json — these are the files the CMS edits) and the original images from
originals/, and builds the finished site in dist/ (the folder that gets published).
Optimised images are kept in optimised/ so they are only processed once.

Usage:
    python3 build.py            # builds the site (only reprocesses new/changed images)
    python3 build.py --clean    # deletes dist/ and rebuilds everything

Requirements: Python 3.9+ and the packages in requirements.txt
(pip install -r requirements.txt). ffmpeg is bundled through imageio-ffmpeg.
"""
from __future__ import annotations

import argparse
import base64
import datetime as dt
import html
import hashlib
import json
import re
import os
import shutil
import subprocess
import sys
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

try:
    from PIL import Image, ImageOps
except ImportError:  # pragma: no cover
    sys.exit("Pillow is missing. Install it with:  pip install Pillow")

ROOT = Path(__file__).resolve().parent
CONTENT_DIR = ROOT / "content"
ORIGINALS = ROOT / "originals"
ASSETS = ROOT / "assets"
DIST = ROOT / "dist"
IMG_OUT = ROOT / "optimised"                 # processed images (kept between builds)
CACHE_FILE = IMG_OUT / "cache.json"


def _ffmpeg() -> str:
    exe = shutil.which("ffmpeg")
    if exe:
        return exe
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except ImportError:
        sys.exit("ffmpeg is missing. Install it with:  pip install imageio-ffmpeg")

WIDTHS = [640, 1280, 1920, 2560]   # widths generated (never larger than the original)
WEBP_QUALITY = 90   # WebP quality (0–100); 90 = virtually no visible loss
VIMEO_PARAMS = "loop=1&autopause=0&muted=1&autoplay=1&color=ffffff&title=0&byline=0&portrait=0&dnt=1"

esc = html.escape


# --------------------------------------------------------------------------- #
#  Images
# --------------------------------------------------------------------------- #
def _out_stem(rel: str) -> Path:
    p = Path(rel)
    return IMG_OUT / p.parent / p.stem


def _process_still(rel: str) -> dict:
    src = ORIGINALS / rel
    stem = _out_stem(rel)
    stem.parent.mkdir(parents=True, exist_ok=True)
    with Image.open(src) as im:
        im = ImageOps.exif_transpose(im)
        if im.mode not in ("RGB", "RGBA"):
            im = im.convert("RGBA" if "transparency" in im.info else "RGB")
        w, h = im.size
        color = im.convert("RGB").resize((1, 1), Image.LANCZOS).getpixel((0, 0))
        widths = sorted({min(x, w) for x in WIDTHS if x < w} | {min(w, WIDTHS[-1])})
        lossless_like = src.suffix.lower() == ".png"
        for tw in widths:
            out = stem.parent / f"{stem.name}-{tw}.webp"
            th = round(h * tw / w)
            frame = im if tw == w else im.resize((tw, th), Image.LANCZOS)
            frame.save(out, "WEBP", quality=96 if lossless_like else WEBP_QUALITY, method=6)
    return {
        "type": "image",
        "w": w if w <= WIDTHS[-1] else WIDTHS[-1],
        "h": h if w <= WIDTHS[-1] else round(h * WIDTHS[-1] / w),
        "widths": widths,
        "color": "#%02x%02x%02x" % color,
        "base": str(Path("img") / Path(rel).parent / Path(rel).stem),
    }


def _process_gif(rel: str) -> dict:
    """Animated GIF -> looping MP4 video (much lighter) + WebP poster."""
    src = ORIGINALS / rel
    stem = _out_stem(rel)
    stem.parent.mkdir(parents=True, exist_ok=True)
    with Image.open(src) as im:
        w, h = im.size
        first = im.convert("RGB")
        color = first.resize((1, 1), Image.LANCZOS).getpixel((0, 0))
        poster_w = min(w, 1280)
        first.resize((poster_w, round(h * poster_w / w)), Image.LANCZOS).save(
            stem.parent / f"{stem.name}-poster.webp", "WEBP", quality=WEBP_QUALITY, method=6
        )
    mp4 = stem.parent / f"{stem.name}.mp4"
    subprocess.run(
        [
            _ffmpeg(), "-y", "-loglevel", "error", "-i", str(src),
            "-movflags", "+faststart", "-pix_fmt", "yuv420p",
            "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-an", str(mp4),
        ],
        check=True,
    )
    return {
        "type": "video",
        "w": w,
        "h": h,
        "color": "#%02x%02x%02x" % color,
        "base": str(Path("img") / Path(rel).parent / Path(rel).stem),
    }


VIDEO_EXT = (".mp4", ".mov", ".m4v", ".webm")


def _process_video(rel: str) -> dict:
    """Self-hosted video (MP4/MOV/WebM) -> optimised H.264 MP4 (max. 1920px) + WebP poster."""
    src = ORIGINALS / rel
    stem = _out_stem(rel)
    stem.parent.mkdir(parents=True, exist_ok=True)
    mp4 = stem.parent / f"{stem.name}.mp4"
    subprocess.run(
        [_ffmpeg(), "-y", "-loglevel", "error", "-i", str(src),
         "-vf", "scale='min(1920,iw)':-2", "-c:v", "libx264", "-preset", "veryfast", "-crf", "24",
         "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", str(mp4)],
        check=True,
    )
    poster = stem.parent / f"{stem.name}-poster.webp"
    subprocess.run(
        [_ffmpeg(), "-y", "-loglevel", "error", "-ss", "0.5", "-i", str(mp4), "-frames:v", "1",
         "-vf", "scale='min(1280,iw)':-2", str(poster)],
        check=True,
    )
    with Image.open(poster) as im:
        color = im.convert("RGB").resize((1, 1), Image.LANCZOS).getpixel((0, 0))
    info = subprocess.run([_ffmpeg(), "-i", str(mp4)], capture_output=True, text=True).stderr
    m = re.search(r"Video:.*?(\d{2,5})x(\d{2,5})", info)
    w, h = (int(m.group(1)), int(m.group(2))) if m else (1920, 1080)
    return {"type": "video", "w": w, "h": h, "color": "#%02x%02x%02x" % color,
            "base": str(Path("img") / Path(rel).parent / Path(rel).stem)}


def _process(rel: str) -> tuple[str, dict]:
    if rel.lower().endswith(VIDEO_EXT):
        return rel, _process_video(rel)
    if rel.lower().endswith(".gif"):
        return rel, _process_gif(rel)
    return rel, _process_still(rel)


def _hash(path: Path) -> str:
    h = hashlib.sha1()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def process_images(paths: set[str]) -> dict:
    IMG_OUT.mkdir(exist_ok=True)
    cache = {}
    if CACHE_FILE.exists():
        cache = json.loads(CACHE_FILE.read_text())
    todo = []
    for rel in sorted(paths):
        src = ORIGINALS / rel
        if not src.exists():
            sys.exit(f"Missing image: originals/{rel}")
        key = _hash(src)
        entry = cache.get(rel)
        produced = entry and (IMG_OUT / Path(entry["base"]).relative_to("img")).with_name(
            Path(entry["base"]).name + (".mp4" if entry["type"] == "video" else f"-{entry['widths'][-1]}.webp")).exists()
        if entry and entry.get("key") == key and produced:
            continue
        todo.append(rel)
    if todo:
        print(f"Optimising {len(todo)} images…")
        with ProcessPoolExecutor() as pool:
            for rel, meta in pool.map(_process, todo):
                meta["key"] = _hash(ORIGINALS / rel)
                cache[rel] = meta
                print("  ✓", rel)
    CACHE_FILE.write_text(json.dumps(cache, indent=1, ensure_ascii=False))
    return cache


# --------------------------------------------------------------------------- #
#  HTML components
# --------------------------------------------------------------------------- #
class Ctx:
    def __init__(self, data: dict, media: dict):
        self.data = data
        self.media = media
        self.site = data["site"]
        self.year = dt.date.today().year


def srcset(meta: dict) -> str:
    return ", ".join(f"{meta['base']}-{w}.webp {w}w" for w in meta["widths"])


def picture(ctx: Ctx, rel: str, sizes: str, alt: str = "", eager: bool = False,
            portrait: str | None = None, cls: str = "") -> str:
    """Returns <picture>/<video> with srcset, dimensions and placeholder colour."""
    meta = ctx.media[rel]
    loading = 'fetchpriority="high"' if eager else 'loading="lazy"'
    if meta["type"] == "video":
        return (
            f'<video class="media__el {cls}" data-src="{meta["base"]}.mp4" '
            f'poster="{meta["base"]}-poster.webp" width="{meta["w"]}" height="{meta["h"]}" '
            f'muted loop playsinline preload="none" aria-label="{esc(alt)}"></video>'
        )
    source = ""
    if portrait:
        pm = ctx.media[portrait]
        source = (f'<source media="(orientation: portrait)" srcset="{srcset(pm)}" sizes="{sizes}" '
                  f'width="{pm["w"]}" height="{pm["h"]}">')
    return (
        f'<picture>{source}<img class="media__el {cls}" src="{meta["base"]}-{meta["widths"][0]}.webp" '
        f'srcset="{srcset(meta)}" sizes="{sizes}" width="{meta["w"]}" height="{meta["h"]}" '
        f'alt="{esc(alt)}" decoding="async" {loading}></picture>'
    )


def media_block(ctx: Ctx, rel: str, sizes: str, alt: str, eager=False, portrait=None, extra="") -> str:
    color = ctx.media[rel]["color"]
    return (f'<div class="media {extra}" data-color="{color}" data-reveal="media">'
            f'{picture(ctx, rel, sizes, alt, eager, portrait)}</div>')


DOT = '<span class="dot" aria-hidden="true"></span>'


def head(ctx: Ctx, title: str, description: str, body_class: str, og_image: str | None = None) -> str:
    s = ctx.site
    robots = "index, follow" if s.get("allowIndexing", True) else "noindex, nofollow"
    full_title = s["name"] if title == s["name"] else f"{title} — {s['name']}"
    og = ""
    if og_image:
        meta = ctx.media[og_image]
        if meta["type"] == "image":
            og = f'<meta property="og:image" content="{meta["base"]}-{meta["widths"][min(1, len(meta["widths"]) - 1)]}.webp">'
    theme = "#000000" if "page-about" in body_class else "#ffffff"
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; img-src 'self' data:; media-src 'self'; font-src 'self'; style-src 'self'; script-src 'self'; frame-src https://player.vimeo.com; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'none'; upgrade-insecure-requests">
<meta name="referrer" content="strict-origin-when-cross-origin">
<title>{esc(full_title)}</title>
<meta name="description" content="{esc(description)}">
<meta name="robots" content="{robots}">
<meta name="theme-color" content="{theme}">
<meta name="format-detection" content="telephone=no">
<meta property="og:type" content="website">
<meta property="og:title" content="{esc(full_title)}">
<meta property="og:description" content="{esc(description)}">
{og}
<link rel="icon" type="image/png" href="favicon.png">
<link rel="preload" href="assets/fonts/PPNeueMontreal-Regular.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="assets/css/main.css">
<script src="assets/js/boot.js"></script>
<script src="assets/js/vendor/lenis.min.js" defer></script>
<script src="assets/js/main.js" defer></script>
<script src="assets/js/edge.js" defer></script>
</head>
<body class="{body_class}">
<a class="skip" href="#main">Skip to content</a>
{loader(ctx)}
<div class="cursor" aria-hidden="true"><span class="cursor__label"></span></div>
"""


def loader(ctx: Ctx) -> str:
    letters = "".join(
        f'<span class="loader__char" data-i="{i}">{esc(c) if c != " " else "&nbsp;"}</span>'
        for i, c in enumerate(ctx.site["name"])
    )
    # data-i is turned into --i by the JS (the CSP does not allow inline styles)
    return f"""<div class="loader" aria-hidden="true">
  <div class="loader__name">{letters}</div>
  <div class="loader__bar"><span class="loader__progress"></span></div>
  <div class="loader__count"><span class="loader__num">0</span></div>
</div>"""


def header(ctx: Ctx, current: str) -> str:
    def link(href, label, key, cls):
        cur = ' aria-current="page"' if key == current else ""
        return f'<a class="nav__link {cls}" href="{href}"{cur}><span class="nav__text" data-text="{label}">{label}</span></a>'
    return f"""<header class="header">
  <nav class="nav" aria-label="Main">
    {link("index.html", ctx.site["name"], "home", "nav__link--home")}
    {link("work.html", "Work", "work", "nav__link--work")}
    {link("playground.html", esc(ctx.data["playground"]["title"]), "playground", "nav__link--playground") if ctx.data["playground"]["items"] else ""}
    {link("about.html", "About", "about", "nav__link--about")}
  </nav>
</header>"""


def footer(ctx: Ctx) -> str:
    start = ctx.site.get("copyrightStart", ctx.year)
    years = f"{start}–{ctx.year}" if ctx.year > start else str(ctx.year)
    return f"""<footer class="footer">
  <p>© {years}, {esc(ctx.site["name"].upper())}, ALL RIGHTS RESERVED</p>
  <button class="to-top" type="button" aria-label="Back to top">{DOT}</button>
</footer>
</body>
</html>
"""


def meta_row(p: dict, heading="h2", link: str | None = None) -> str:
    title = esc(p["title"])
    if link:
        title = f'<a href="{link}">{title}</a>'
    cats = "".join(f"<li>{esc(c)}</li>" for c in p["categories"])
    credits = "<br>".join(esc(c) for c in p["credits"])
    return f"""<div class="meta" data-reveal="up">
      <{heading} class="meta__title">{title}</{heading}>
      <ul class="meta__cats">{cats}</ul>
      <p class="meta__credits">{credits}</p>
      {DOT}
    </div>"""


def page_link(p: dict) -> str | None:
    return None if p.get("comingSoon") else f"project-{p['slug']}.html"


# --------------------------------------------------------------------------- #
#  Pages
# --------------------------------------------------------------------------- #
def page_index(ctx: Ctx) -> str:
    items = []
    for i, p in enumerate(ctx.data["projects"]):
        href = page_link(p)
        media = media_block(ctx, p["cover"], "100vw", p["title"], eager=i == 0,
                            portrait=p.get("coverPortrait"), extra="media--banner")
        cursor = "View" if href else "Soon"
        wrapped = (f'<a class="project__link" href="{href}" data-cursor="{cursor}" aria-label="{esc(p["title"])}">{media}</a>'
                   if href else f'<div class="project__link is-soon" data-cursor="{cursor}">{media}</div>')
        items.append(f"""<article class="project{' is-soon' if not href else ''}">
    {wrapped}
    {meta_row(p, link=href)}
  </article>""")
    return (head(ctx, ctx.site["name"], ctx.site["description"], "page-home", ctx.data["projects"][0]["cover"])
            + header(ctx, "home")
            + f'<main id="main" class="main home">\n  <h1 class="sr-only">{esc(ctx.site["name"])} — Selected work</h1>\n  '
            + "\n  ".join(items) + "\n</main>\n" + footer(ctx))


def hover_image(ctx: Ctx, p: dict) -> str | None:
    """Image shown on hover on the Work page: 'thumbHover' in the JSON,
    or else the first gallery image that differs from the thumbnail."""
    if p.get("thumbHover"):
        return p["thumbHover"]
    for row in p.get("gallery", []):
        for r in (row if isinstance(row, list) else [row]):
            if isinstance(r, str) and r != p["thumb"] and ctx.media[r]["type"] == "image":
                return r
    return None


def page_work(ctx: Ctx) -> str:
    cards = []
    sizes = "(orientation: portrait) 50vw, 33vw"
    for p in ctx.data["projects"]:
        href = page_link(p)
        hov = hover_image(ctx, p) if href else None
        hover_html = ""
        if hov:
            hover_html = (f'<span class="card__hover" aria-hidden="true">'
                          f'{picture(ctx, hov, sizes, "")}</span>')
        meta = ctx.media[p["thumb"]]
        media = (f'<div class="media media--thumb" data-color="{meta["color"]}" data-reveal="media">'
                 f'{picture(ctx, p["thumb"], sizes, p["title"])}{hover_html}</div>')
        cats = "".join(f"<li>{esc(c)}</li>" for c in p["categories"])
        title = esc(p["title"])
        inner = f"""{media}
      <div class="card__meta">
        <h2 class="card__title"><span class="card__roll"><span class="card__roll-in" data-text="{title}">{title}</span></span><span class="card__arrow" aria-hidden="true">→</span></h2>
        <ul class="card__cats">{cats}</ul>
      </div>"""
        if href:
            cards.append(f'<li class="card"><a class="card__link" href="{href}" data-cursor="View">{inner}</a></li>')
        else:
            cards.append(f'<li class="card is-soon"><div class="card__link" data-cursor="Soon">{inner}</div></li>')
    return (head(ctx, "Work", "Selected work by " + ctx.site["name"] + ": branding, packaging, editorial design and art direction.", "page-work", ctx.data["projects"][0]["thumb"])
            + header(ctx, "work")
            + '<main id="main" class="main work">\n  <h1 class="sr-only">Work</h1>\n  <ul class="grid">\n    '
            + "\n    ".join(cards) + "\n  </ul>\n</main>\n" + footer(ctx))


def _obfuscate(value: str) -> str:
    """Encodes the value so bots reading the HTML cannot harvest the email/phone."""
    return base64.b64encode(value[::-1].encode()).decode()


def page_about(ctx: Ctx) -> str:
    a, c = ctx.data["about"], ctx.data["contact"]
    def rows(items):
        return "\n".join(
            f'<li class="cv__row" data-reveal="up"><span>{esc(x[0])}</span><span>{esc(x[1])}</span><span>{esc(x[2])}</span></li>'
            for x in items)
    awards = "\n".join(f'<li data-reveal="up">/ {esc(x)}</li>' for x in a["awards"])
    email = _obfuscate(c["email"])
    phone = _obfuscate(c["phone"])
    phone_href = _obfuscate("tel:" + c["phone"].replace(" ", ""))
    return (head(ctx, "About", a["bio"][:155].rsplit(" ", 1)[0] + "…", "page-about theme-dark")
            + header(ctx, "about")
            + f"""<main id="main" class="main about">
  <h1 class="sr-only">About</h1>
  <section class="about__intro">
    <div class="about__contact" data-reveal="up">
      <p>{esc(ctx.site["name"])}<br>{esc(c["city"])}</p>
      <p>For works, collaborations or any other proposals please contact
        <a class="js-protected link" data-p="{email}" data-kind="mailto">[email protected]</a></p>
      <p>Phone number<br><a class="js-protected link" data-p="{phone}" data-h="{phone_href}">[phone protected]</a></p>
    </div>
    <p class="about__bio" data-reveal="lines">{esc(a["bio"])}</p>
  </section>

  <section class="cv">
    <h2 class="cv__label" data-reveal="up">Experience</h2>
    <ul class="cv__list">
{rows(a["experience"])}
    </ul>
  </section>

  <section class="cv">
    <h2 class="cv__label" data-reveal="up">Education</h2>
    <ul class="cv__list">
{rows(a["education"])}
    </ul>
  </section>

  <section class="cv">
    <h2 class="cv__label" data-reveal="up">Awards</h2>
    <ul class="cv__awards">
{awards}
    </ul>
  </section>
</main>
""" + footer(ctx))


def gallery(ctx: Ctx, p: dict) -> str:
    out = []
    for i, row in enumerate(p.get("gallery", [])):
        alt = f'{p["title"]} — image {i + 1}'
        if isinstance(row, str):
            out.append(f'<div class="row row--full">{media_block(ctx, row, "100vw", alt)}</div>')
        elif isinstance(row, list):
            cells = "".join(media_block(ctx, r, "50vw", alt) for r in row)
            out.append(f'<div class="row row--half">{cells}</div>')
        elif isinstance(row, dict) and "video" in row:
            out.append(f'<div class="row row--full">{media_block(ctx, row["video"], "100vw", alt + " (video)")}</div>')
        elif isinstance(row, dict) and "vimeo" in row:
            ratio = row.get("ratio", "16 / 9").replace("/", "-").replace(" ", "")
            out.append(
                f'<div class="row row--full"><div class="embed embed--{ratio}" data-reveal="media">'
                f'<iframe src="https://player.vimeo.com/video/{esc(row["vimeo"])}?{VIMEO_PARAMS.replace("&", "&amp;")}" '
                f'title="{esc(p["title"])} — video" loading="lazy" allow="autoplay; fullscreen; picture-in-picture" '
                f'referrerpolicy="strict-origin-when-cross-origin" '
                f'sandbox="allow-scripts allow-same-origin allow-presentation"></iframe></div></div>')
    return "\n    ".join(out)


def page_project(ctx: Ctx, p: dict, nxt: dict) -> str:
    text = "".join(f'<p data-reveal="lines">{esc(t)}</p>' for t in p.get("text", []))
    text_html = f'<div class="project__text">{text}</div>' if text else '<div class="project__spacer"></div>'
    desc = (p.get("text") or [p["title"] + " — " + ", ".join(p["categories"])])[0]
    desc = desc[:155].rsplit(" ", 1)[0] + "…" if len(desc) > 160 else desc
    nmeta = ctx.media[nxt["thumb"]]
    preview = picture(ctx, nxt["thumb"], "20vw", "")
    return (head(ctx, p["title"], desc, "page-project", p["cover"])
            + header(ctx, "")
            + f"""<main id="main" class="main project-page">
  <article class="project project--detail">
    {meta_row(p, heading="h1")}
    {text_html}
    {gallery(ctx, p)}
  </article>
  <nav class="next" aria-label="Next project">
    <a class="next__link" href="{page_link(nxt)}" data-cursor="Next">
      <span class="next__label">Next project</span>
      <span class="next__title">{esc(nxt["title"])}</span>
      <span class="next__preview media" data-color="{nmeta['color']}" aria-hidden="true">{preview}</span>
    </a>
  </nav>
</main>
""" + footer(ctx))


def page_playground(ctx: Ctx) -> str:
    pg = ctx.data["playground"]
    items = []
    for n, it in enumerate(pg["items"]):
        meta = ctx.media[it["image"]]
        if meta["type"] == "video":                     # GIF/video: use its still poster here
            src = f'{meta["base"]}-poster.webp'
            img = (f'<img class="pg__img" src="{src}" width="{meta["w"]}" height="{meta["h"]}" '
                   f'alt="{esc(it["title"])}" decoding="async" loading="lazy" draggable="false">')
            full = src
        else:
            img = (f'<img class="pg__img" src="{meta["base"]}-{meta["widths"][0]}.webp" srcset="{srcset(meta)}" '
                   f'sizes="(orientation: portrait) 60vw, 30vw" width="{meta["w"]}" height="{meta["h"]}" '
                   f'alt="{esc(it["title"])}" decoding="async" loading="lazy" draggable="false">')
            full = f'{meta["base"]}-{meta["widths"][-1]}.webp'
        lines = "".join(f'<span class="pg__line">{esc(x)}</span>' for x in it["lines"])
        items.append(
            f'<li class="pg__item" data-n="{n}" data-color="{meta["color"]}">'
            f'<button class="pg__btn" type="button" data-cursor="View" data-full="{full}" '
            f'aria-label="Open {esc(it["title"])}">'
            f'<span class="pg__frame">{img}</span>'
            f'<span class="pg__cap"><span class="pg__title">{esc(it["title"])}</span>'
            f'{lines}</span></button></li>')
    title = pg["title"]
    return (head(ctx, title, f"{title} — loose images, experiments and single-image projects by {ctx.site['name']}.",
                 "page-playground", pg["items"][0]["image"] if pg["items"] else None)
            + header(ctx, "playground")
            + f"""<main id="main" class="main pg">
  <h1 class="sr-only">{esc(title)}</h1>
  <div class="pg__stage">
    <ul class="pg__items">
      {"".join(items)}
    </ul>
  </div>
  <p class="pg__hint" aria-hidden="true">Drag or scroll to explore</p>
  <div class="pg-lb" hidden>
    <figure class="pg-lb__figure"><figcaption class="pg-lb__cap"></figcaption></figure>
    <div class="pg-lb__bar">
      <span class="pg-lb__count"></span>
      <button class="pg-lb__btn" type="button" data-lb="prev">Previous</button>
      <button class="pg-lb__btn" type="button" data-lb="next">Next</button>
      <button class="pg-lb__btn" type="button" data-lb="close">Close</button>
    </div>
  </div>
</main>
<script src="assets/js/playground.js" defer></script>
</body>
</html>
""")


def page_404(ctx: Ctx) -> str:
    return (head(ctx, "Not found", "Page not found", "page-404")
            + header(ctx, "")
            + """<main id="main" class="main notfound">
  <h1 class="notfound__title" data-reveal="up">Page not found</h1>
  <p data-reveal="up"><a class="link" href="index.html">Back to the homepage</a></p>
</main>
""" + footer(ctx))


# --------------------------------------------------------------------------- #
def _media_path(value: str) -> str:
    """'/originals/namaskar/a.jpg' (as written by the CMS) -> 'namaskar/a.jpg'."""
    v = (value or "").strip().lstrip("/")
    return v[len("originals/"):] if v.startswith("originals/") else v


def load_content() -> dict:
    """Reads content/ and returns one dictionary for the page builders.
    Case studies are sorted by their 'order' field (lowest first)."""
    read = lambda p: json.loads(p.read_text(encoding="utf-8"))
    settings = read(CONTENT_DIR / "settings.json")
    about = read(CONTENT_DIR / "about.json")
    projects = []
    for f in sorted((CONTENT_DIR / "projects").glob("*.json")):
        p = read(f)
        if p.get("hidden"):
            continue
        p.setdefault("slug", f.stem)
        for k in ("cover", "coverPortrait", "thumb", "thumbHover"):
            p[k] = _media_path(p.get(k, ""))
        p["thumb"] = p["thumb"] or p["cover"]
        rows = []
        for row in p.get("gallery") or []:
            layout = row.get("layout", "full")
            img, img2 = _media_path(row.get("image", "")), _media_path(row.get("image2", ""))
            if layout == "vimeo" and row.get("vimeo"):
                vid = str(row["vimeo"]).rstrip("/").split("/")[-1]      # accepts an ID or a full link
                rows.append({"vimeo": vid, **({"ratio": row["ratio"]} if row.get("ratio") else {})})
            elif layout == "video" and row.get("video"):
                rows.append({"video": _media_path(row["video"])})
            elif layout == "pair" and img and img2:
                rows.append([img, img2])
            elif layout == "half" and img:
                rows.append([img])
            elif img:
                rows.append(img)
        p["gallery"] = rows
        p["categories"] = [c for c in p.get("categories") or [] if c]
        p["credits"] = [c for c in p.get("credits") or [] if c]
        p["text"] = [t for t in p.get("text") or [] if t and t.strip()]
        projects.append(p)
    projects.sort(key=lambda p: (p.get("order", 999), p["title"].lower()))
    cv = lambda items: [[x.get("dates", ""), x.get("place", ""), x.get("role", "")] for x in items or []]
    pg_file = CONTENT_DIR / "playground.json"
    pg = read(pg_file) if pg_file.exists() else {}
    playground = {
        "title": (pg.get("title") or "Playground").strip(),
        "intro": pg.get("intro") or "",
        "items": [{"image": _media_path(i.get("image", "")), "title": i.get("title", ""),
                   "lines": [str(i.get(k) or "").strip() for k in ("category", "credits", "photography")
                             if str(i.get(k) or "").strip()]}
                  for i in pg.get("items") or [] if i.get("image") and not i.get("hidden")],
    }
    return {
        "site": {k: v for k, v in settings.items() if k != "contact"},
        "contact": settings.get("contact", {}),
        "projects": projects,
        "playground": playground,
        "about": {"bio": about.get("bio", ""), "experience": cv(about.get("experience")),
                  "education": cv(about.get("education")), "awards": about.get("awards") or []},
    }


def collect_media(data: dict) -> set[str]:
    paths = {i["image"] for i in data["playground"]["items"]}
    for p in data["projects"]:
        for k in ("cover", "coverPortrait", "thumb", "thumbHover"):
            if p.get(k):
                paths.add(p[k])
        for row in p.get("gallery", []):
            if isinstance(row, str):
                paths.add(row)
            elif isinstance(row, list):
                paths.update(row)
            elif isinstance(row, dict) and "video" in row:
                paths.add(row["video"])
    return paths


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--clean", action="store_true", help="delete dist/ before building")
    args = ap.parse_args()

    if args.clean and DIST.exists():
        shutil.rmtree(DIST)
        CACHE_FILE.unlink(missing_ok=True)
    DIST.mkdir(exist_ok=True)

    data = load_content()
    media = process_images(collect_media(data))
    shutil.copytree(IMG_OUT, DIST / "img", dirs_exist_ok=True, ignore=shutil.ignore_patterns("cache.json"))
    ctx = Ctx(data, media)

    # static assets
    if (DIST / "assets").exists():
        shutil.rmtree(DIST / "assets")
    shutil.copytree(ASSETS, DIST / "assets", ignore=shutil.ignore_patterns("favicon.png", "server"))
    shutil.copy(ASSETS / "favicon.png", DIST / "favicon.png")
    for f in (ASSETS / "server").iterdir():
        shutil.copy(f, DIST / f.name)

    pages = {
        "index.html": page_index(ctx),
        "work.html": page_work(ctx),
        "about.html": page_about(ctx),
        **({"playground.html": page_playground(ctx)} if ctx.data["playground"]["items"] else {}),
        "404.html": page_404(ctx),
    }
    live = [p for p in data["projects"] if not p.get("comingSoon")]
    for i, p in enumerate(live):
        pages[f"project-{p['slug']}.html"] = page_project(ctx, p, live[(i + 1) % len(live)])

    # remove old pages that are no longer in the content
    for old in DIST.glob("*.html"):
        if old.name not in pages:
            old.unlink()
    for name, content in pages.items():
        (DIST / name).write_text(content, encoding="utf-8")

    # robots.txt + sitemap (if a domain is set)
    base = ctx.site.get("url", "").rstrip("/")
    robots = "User-agent: *\n" + ("Allow: /\n" if ctx.site.get("allowIndexing", True) else "Disallow: /\n")
    if base:
        robots += f"Sitemap: {base}/sitemap.xml\n"
        urls = "\n".join(f"  <url><loc>{base}/{n}</loc></url>" for n in pages if n != "404.html")
        (DIST / "sitemap.xml").write_text(
            f'<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n{urls}\n</urlset>\n')
    (DIST / "robots.txt").write_text(robots)

    print(f"Done: {len(pages)} pages in {DIST.relative_to(ROOT)}/")


if __name__ == "__main__":
    main()
