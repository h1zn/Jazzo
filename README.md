<h1 align="center">Jazzo</h1>

<p align="center">
  An open-source clone of <b>Jazz Jackrabbit 2</b> for the browser and for Android phones and tablets,<br>
  with network play for up to five players.
</p>

<p align="center">
  <img alt="Platforms: Web and Android" src="https://img.shields.io/badge/platforms-web%20%7C%20android-2ea44f">
  <img alt="Version 1.7.1" src="https://img.shields.io/badge/version-1.7.1-blue">
  <img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-lightgrey">
</p>

<p align="center">
  <img src="Game.png" alt="Jazzo title screen" width="49%">
  <img src="Game1.png" alt="Jazzo gameplay in the castle level" width="49%">
</p>

## About

Jazzo is a clone of Jazz Jackrabbit 2, the 1998 platformer by Epic MegaGames,
rebuilt from the ground up and released as open source. The engine is plain
JavaScript with no build step: it runs in any modern browser, and the same
game is packaged as an Android app.

It reads the original game's own files (levels, tile sets, animations, music
and films), so it plays the classic episodes and community level packs, and it
adds its own levels, a party mode and a modern renderer on top.

## Highlights

- **Classic levels**: reads `.j2l` levels and `.j2t` tile sets from version
  1.20 up to The Secret Files and JJ2+, straight from folders or `.zip` packs,
  with parallax layers, animated tiles and pixel-exact collision masks.
- **Three heroes**: Jazz, Spaz and Lori, each with their own moves, plus all
  nine weapons, shields, the airboard, the frog and bird morphs, and ten bosses.
- **Nine new levels** built for exploring in every direction, each with three
  stars to earn, secret areas, a bonus room and checkpoints.
- **Films and music**: plays the `.j2v` intro and ending films, `.j2b` and
  tracker music (`.xm`, `.mod`, `.it`, `.s3m`) through libopenmpt.
- **JJ2+ scripts**: a small interpreter runs the common parts of `.j2as`
  level scripts.
- **Six languages**: English, German, French, Spanish, Italian and Dutch.
- **Saves and scores**: eight save slots, a top-ten table, three difficulty
  levels and continues.

## Android

Jazzo is also an Android app for phones and tablets (Android 8 and up), with
the full game on board and sharp graphics on any screen:

- Draws at up to **4K**, always on a whole number of the screen's own pixels,
  so nothing is scaled twice on its way to the display.
- **GPU effects** (WebGL2): a choice of upscaler (sharp pixels, smooth, HD
  smooth or a CRT monitor look) and a glow on lights, lava, gems and explosions.
- **Touch controls** with a floating stick, plus gamepad and keyboard support.
- **Hosts network games itself**: the phone runs the party server, and keeps
  hosting when the app is in the background.

The APK is built from the `android/` folder (JDK 17 and the Android SDK):

```bash
cd android
./gradlew assembleRelease
```

## Network mode

Party mode puts up to five players in one game, on a local network or over the
internet:

- **Four game types**: Treasure Hunt, Battle, Capture the Flag and Race.
- **No addresses to type on Wi-Fi**: phones find hosts on the network by
  themselves; rooms have a 4-letter code and an optional password.
- **Any mix of devices**: computers join from a browser, phones from the app.
- **Survives a dropped connection**: a guest who loses Wi-Fi keeps their place
  for a minute and rejoins with their gems, hearts and score.
- **Split screen** for two players on the same computer.

The game server and the party relay are one small program with no
dependencies:

```bash
python serve.py 8870 --lan     # your local network
python serve.py --public       # a server on the internet
```

## Enhancements

What Jazzo adds to the original game:

| Area | Enhancement |
| --- | --- |
| Graphics | 360p to 4K rendering, GPU upscalers, CRT mode and bloom glow |
| Smoothness | Game logic at a fixed 71 ticks a second, drawing interpolated to the screen's refresh rate |
| Platforms | Runs in the browser and as an Android app, with no installation on a computer |
| Controls | Touch controls, gamepads, and every key rebindable with up to three keys per action |
| Multiplayer | Five players, hearts, party items, the airboard, reconnection and phone hosting |
| Levels | Nine new levels with stars, secrets, score combos and bonus rooms |
| Level packs | Packs load straight from `.zip` files, borrow missing tile sets from each other, and broken maps are detected and hidden |
| Tools | Scripts that check every level is completable and every classic map loads |

## Built with Rea

Jazzo was cloned using the **Rea** concept, on our **Rea Platform**. The Rea
Platform is not public yet; we will publish it later.

## Getting started

You need Python 3 (standard library only) and a modern browser.

```bash
git clone https://github.com/h1zn/Jazzo.git
cd Jazzo
python serve.py 8770
```

Then open <http://localhost:8770/>. On Windows you can double-click `play.bat`
instead, or `party.bat` to host a network game.

### Game data

This repository contains the Jazzo engine. It does **not** contain the art,
sounds, music or levels of Jazz Jackrabbit 2, which belong to Epic Games, and
the game needs them to run. Supply them from your own copy of the game:

| Folder | What goes in it |
| --- | --- |
| `assets/` | Sprite sheets, tile sets, fonts and sound samples. The atlas `.json` files are here; `tools/j2a.py`, `tools/build_sprites.py`, `tools/build_font.py` and `tools/build_blocks.py` cut the images and sounds. |
| `Levels/` | Level packs: folders or `.zip` files holding `.j2l` levels and their `.j2t` tile sets. |
| `Soundtracks/` | Recorded music tracks. |

The Android launcher icon is left out for the same reason: add your own before
building the app.

## Documentation

The full manual is in [docs/MANUAL.md](docs/MANUAL.md): controls, saving and
difficulty, party mode rules, the level list, classic level support and the
project layout.

## Project layout

```
index.html, style.css   the page
src/                    the game engine (JavaScript modules)
src/jj2/                readers for the original game's level, tile set and script files
android/                the Android app and its party server
serve.py                web server and party relay
tools/                  asset cutters and level checkers
vendor/chiptune3/       libopenmpt player for tracker music
docs/                   the manual
```

## Credits

- Jazz Jackrabbit 2 was created by Epic MegaGames. Jazzo is a fan project and
  is not affiliated with or endorsed by Epic Games.
- File formats and boss behaviour follow the research of
  [Jazz² Resurrection](https://github.com/deathkiller/jazz2-native).
- Tracker music plays through
  [chiptune3](vendor/chiptune3/README.txt) and libopenmpt.

## License

Jazzo's own code is released under the [MIT License](LICENSE). The bundled
libraries in `vendor/` keep their own licenses. Jazz Jackrabbit 2 and its
characters, art, sounds, music and levels are the property of Epic Games and
are not covered by this license.
