# yoinks-Leech

> # ⚡ FORK NOTICE
> **yoinks-Leech** is an independent fork of the original [yoinks](https://github.com/pablostanley/yoinks) created by [Pablo Stanley](https://github.com/pablostanley).
>
> **Disclaimer:** This project builds upon the original work by adding an embedded HTTP streaming server, token-masked download links, ephemeral session isolation, and quota protections. This fork is maintained independently and is not affiliated with, sponsored by, or endorsed by the original author. This software is provided strictly for personal archiving and educational purposes; users are responsible for complying with the terms of service of any media platforms and respecting creators' rights.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
  <img src="assets/logo-light.svg" alt="yoinks-Leech" width="288">
</picture>

**yoinks-Leech** — yoink any video. paste. yoink. done. Now supercharged with local masked streaming and ephemeral session management.

Download videos from YouTube, X/Twitter, Instagram, Threads, TikTok and 1,800+ other sites — right from your terminal. Paste a url, pick a resolution (or audio-only mp3), done. No popups, no fake download buttons, no sketchy redirects.

<img src="assets/home.png" alt="yoinks home screen — paste a link and hit yoink" width="100%">

## ✨ What's New in yoinks-Leech

Beyond the original interactive terminal experience, **yoinks-Leech** introduces advanced privacy and media-serving capabilities:

- 🔒 **Masked Downloads**: An embedded HTTP server serves files through obfuscated, tokenized URLs (`http://127.0.0.1:4321/d/<token>`), shielding physical file paths.
- ⏱️ **Ephemeral Sessions & Auto-Cleanup**: Sessions and history records expire automatically after 72 hours (TTL), with local files cleaned up to keep your disk tidy. History is capped at 30 items.
- 📊 **Quota Protection**: Built-in 10 GB / 3-day rolling bandwidth quota tracking to prevent runaway storage usage.
- ⚡ **Local Streaming Server**: Built-in Node.js server supporting HTTP `Range` headers for instant seeking and audio/video playback in browsers and media players. Configurable via `--port`.

## Install & Setup

```sh
# Clone this repository
git clone https://github.com/BAILEYJRM/yoinks-leech.git
cd yoinks-leech

# Install dependencies and build
npm install
npm run build

# Link globally for local use
npm link
```

Requires Node 18+. Everything else (yt-dlp, ffmpeg) is fetched or bundled automatically.

## Usage

```sh
$ yoinks-leech https://youtu.be/dQw4w9WgXcQ    # straight to the format picker
$ yoinks-leech                                 # interactive prompt for a url
$ yoinks-leech --theme light                   # force light palette (auto, light, dark)
$ yoinks-leech --port 8080                     # set custom port for the masked download server
```

*(Note: the command `yoinks` is also available as an alias).*

yoinks takes over the terminal (full-screen, centered — and restores your scrollback on exit). Pick a format with ↑/↓ (or j/k, or number keys) and hit enter. `esc` goes back, `^c` quits. Or just use the mouse — the yoink button, the format list and the footer hints are all clickable, and clicking the logo takes you back home. Files are saved to `~/Downloads`, and masked local streaming URLs are served automatically.

The default `auto` theme uses your terminal's own foreground and background, so it follows light and dark terminal themes without guessing. Press `^t` or click the theme control in the footer to cycle through `auto`, `light`, and `dark` for the current session. Use `--theme auto`, `--theme light`, or `--theme dark` to choose the starting theme for one launch.

<img src="assets/download-options.png" alt="yoinks format picker — resolutions with estimated file sizes, plus audio-only mp3" width="100%">

## How it works

- **Downloader Engine**: Powered by [yt-dlp](https://github.com/yt-dlp/yt-dlp). On first run, yoinks downloads the standalone yt-dlp binary to `~/.yoinks/bin` — no Python required. If you already have yt-dlp installed, it uses yours.
- **Audio & Video Processing**: ffmpeg (needed for merging high-res streams and mp3 extraction) is detected on PATH or provided via bundled `ffmpeg-static`.
- **Terminal UI**: Built with [Ink](https://github.com/vadimdemedes/ink) — React for the terminal.
- **Masked Server & Storage**: Embedded HTTP server with token authentication, range requests, and session isolation stored locally in `~/.config/yoinks`.

## Development

```sh
npm install
npm run build        # bundle to dist/ with tsup
npm run dev          # rebuild on change
node dist/cli.js <url>
npm test             # run unit test suite
npm run typecheck
```

## Credits & License

- Original project: [yoinks](https://github.com/pablostanley/yoinks) by [Pablo Stanley](https://github.com/pablostanley).
- License: [MIT](LICENSE)

