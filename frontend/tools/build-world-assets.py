#!/usr/bin/env python3
"""Decode original Emerald metatiles and people without redrawing or squashing pixels.

Usage: python3 frontend/tools/build-world-assets.py [--source /path/to/pokeemerald]
Requires Pillow. Downloads are pinned, cached and reproducible; outputs stay in vendor/.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import time
import urllib.request

from PIL import Image

REVISION = '731ad5bfd6e6f265508d0efcca0ba42f9dcf5881'
BASE = f'https://raw.githubusercontent.com/pret/pokeemerald/{REVISION}'
ROOT = Path(__file__).resolve().parents[1]
NATIVE_TILE = 16
TILE = 32
PEOPLE_DIR = 'graphics/object_events/pics/people'
SEMANTICS = ['grass', 'tallGrass', 'flower', 'path', 'sand', 'ash', 'gravel', 'tree',
             'rock', 'water', 'deepWater', 'plank', 'wall', 'roof', 'floor', 'carpet',
             'counter', 'door', 'stairs', 'sign', 'lava', 'altar', 'pillar']
# Full metatile IDs, as used in the original map data (primary <512; secondary >=512).
# Reserved atlas slot: original boulder foreground on land, rather than its sea-rock background.
LAND_ROCK = 1024
OUTDOOR = dict(zip(SEMANTICS, [1, 13, 4, 473, 289, 113, 268, 14, LAND_ROCK, 209, 368,
                              435, 121, 73, 289, 513, 27, 167, 175, 27, 368, 36, LAND_ROCK]))
PROFILES = {
    'nature': (['grass', 'forest', 'mid', 'north', 'coast', 'island', 'birth'], 'general', 'petalburg', OUTDOOR),
    'town': (['town'], 'general', 'petalburg', {**OUTDOOR, 'roof': 73, 'wall': 98, 'door': 97}),
    'cave': (['cave', 'ruins', 'seafloor'], 'general', 'cave', {
        **OUTDOOR, 'grass': 529, 'floor': 529, 'gravel': 547, 'ash': 529, 'wall': 537,
        'rock': 515, 'door': 532, 'stairs': 573, 'altar': 630, 'pillar': 699, 'water': 659, 'lava': 868}),
    'tower': (['tower'], 'general', 'pacifidlog', {
        **OUTDOOR, 'grass': 701, 'floor': 701, 'gravel': 565, 'wall': 577,
        'rock': LAND_ROCK, 'pillar': 720, 'door': 580, 'stairs': 580, 'altar': 564}),
    'volcano': (['volcano', 'magma'], 'general', 'cave', {
        **OUTDOOR, 'grass': 811, 'floor': 811, 'gravel': 801, 'ash': 803, 'wall': 809,
        'rock': 816, 'lava': 868, 'door': 822, 'stairs': 828, 'altar': 873}),
}
NPCS = {
    'nurse': 'nurse.png', 'clerk': 'mart_employee.png', 'elder': 'expert_m.png',
    'kid': 'little_boy.png', 'scientist': 'scientist_1.png', 'hiker': 'hiker.png',
    'sailor': 'sailor.png', 'bug-catcher': 'bug_catcher.png', 'mom': 'mom.png',
}
HEROES = {'hero': 'ruby_sapphire_brendan/walking.png', 'hero-may': 'ruby_sapphire_may/walking.png'}
# Buildings preserve the exact 4x4 / 5x5 original compositions. Door offsets match maps/town.ts.
BUILDINGS = {
    'center': [[72, 73, 642, 643], [80, 81, 82, 83], [88, 89, 90, 91], [96, 97, 98, 99]],
    'shop': [[40, 41, 41, 43], [48, 49, 50, 51], [56, 57, 58, 59], [96, 65, 66, 67]],
    'house': [[520, 521, 521, 521, 522], [528, 529, 529, 529, 530],
              [536, 537, 537, 537, 538], [544, 576, 561, 562, 547], [552, 584, 569, 570, 555]],
}


class Source:
    def __init__(self, cache: Path, source: Path | None = None):
        self.cache, self.source = cache / REVISION, source

    def file(self, relative: str) -> Path:
        if self.source:
            return self.source / relative
        target = self.cache / relative
        if not target.exists():
            target.parent.mkdir(parents=True, exist_ok=True)
            for attempt in range(3):
                try:
                    with urllib.request.urlopen(f'{BASE}/{relative}', timeout=30) as response:
                        data = response.read()
                    temporary = target.with_suffix(target.suffix + '.tmp')
                    temporary.write_bytes(data)
                    temporary.replace(target)
                    break
                except OSError:
                    if attempt == 2:
                        raise
                    time.sleep(attempt + 1)
        return target


def load_palette(path: Path) -> list[tuple[int, int, int, int]]:
    lines = path.read_text().splitlines()
    return [tuple(map(int, line.split())) + (255,) for line in lines[3:19]]


class Tileset:
    def __init__(self, key: str, source: Source, primary: Tileset | None = None):
        self.primary = primary or self
        root = f'data/tilesets/{"secondary" if primary else "primary"}/{key}'
        self.indices = Image.open(source.file(f'{root}/tiles.png'))
        # Static exports need the original first animation frame too: the base bank leaves water/lava blank.
        animations = [('water', 432, 30), ('sand_water_edge', 464, 10), ('land_water_edge', 480, 10), ('flower', 508, 4)] if key == 'general' else [('lava', 416, 4)] if key == 'cave' else []
        for animation, offset, count in animations:
            frame = Image.open(source.file(f'{root}/anim/{animation}/0.png'))
            for i in range(count):
                cols = frame.width // 8
                patch = frame.crop((i % cols * 8, i // cols * 8, i % cols * 8 + 8, i // cols * 8 + 8))
                bank_cols = self.indices.width // 8
                self.indices.paste(patch, ((offset + i) % bank_cols * 8, (offset + i) // bank_cols * 8))
        self.raw = source.file(f'{root}/metatiles.bin').read_bytes()
        self.palettes = [load_palette(source.file(f'{root}/palettes/{i:02d}.pal')) for i in range(16)]
        self.count = len(self.raw) // 16
        self._rendered: dict[tuple[int, bool], Image.Image] = {}

    def render(self, mid: int, overlay_only: bool = False) -> Image.Image:
        cache_key = (mid, overlay_only)
        if cache_key in self._rendered:
            return self._rendered[cache_key]
        owner = self.primary if mid < 512 else self
        index = mid if mid < 512 else mid - 512
        if index >= owner.count:
            raise ValueError(f'Invalid metatile {mid}')
        entry = owner.raw[index * 16:(index + 1) * 16]
        out = Image.new('RGBA', (16, 16))
        for layer in ((1,) if overlay_only else (0, 1)):
            for q in range(4):
                offset = (layer * 4 + q) * 2
                value = int.from_bytes(entry[offset:offset + 2], 'little')
                ti, pi = value & 1023, value >> 12
                # Tile bank and palette bank are selected independently (fieldmap.h: 512 / 6).
                bank = self.primary if ti < 512 else self
                tile = ti if ti < 512 else ti - 512
                palette = (self.primary if pi < 6 else self).palettes[pi]
                cols = bank.indices.width // 8
                tx, ty = tile % cols * 8, tile // cols * 8
                if ty + 8 > bank.indices.height:
                    # Unused original metatiles can reference tiles absent from the bank.
                    continue
                for y in range(8):
                    for x in range(8):
                        idx = bank.indices.getpixel((tx + (7 - x if value & 1024 else x),
                                                     ty + (7 - y if value & 2048 else y)))
                        if layer == 1 and idx == 0:
                            continue
                        color = palette[idx]
                        if color[:3] != (255, 0, 255):
                            out.putpixel((q % 2 * 8 + x, q // 2 * 8 + y), color)
        self._rendered[cache_key] = out
        return out


def save_image(image: Image.Image, path: Path) -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path, optimize=True)
    return hashlib.sha256(path.read_bytes()).hexdigest()


def build_atlas(name: str, bank: Tileset, out: Path, cave: Tileset | None = None) -> dict:
    biomes, _, _, tiles = PROFILES[name]
    count = 512 + bank.count
    atlas_count = max(count, LAND_ROCK + 1)
    atlas = Image.new('RGBA', (16 * TILE, ((atlas_count + 15) // 16) * TILE))
    for mid in range(count):
        if mid < 512 and mid >= bank.primary.count:
            continue
        atlas.paste(bank.render(mid).resize((TILE, TILE), Image.Resampling.NEAREST),
                    (mid % 16 * TILE, mid // 16 * TILE))
    rock = bank.render(tiles['grass']).copy()
    rock.alpha_composite(bank.render(189, overlay_only=True))
    atlas.paste(rock.resize((TILE, TILE), Image.Resampling.NEAREST),
                (LAND_ROCK % 16 * TILE, LAND_ROCK // 16 * TILE))
    if name == 'tower' and cave:
        # Original stone-column foreground over the original tower floor; no pixel redrawing.
        for target, original in [(720, 699), (728, 707)]:
            tile = bank.render(701).copy()
            tile.alpha_composite(cave.render(original, overlay_only=True))
            atlas.paste(tile.resize((TILE, TILE), Image.Resampling.NEAREST),
                        (target % 16 * TILE, target // 16 * TILE))
    # 3x3 original transition patches, sampled by quadrant in native-map.ts.
    autotiles = {}
    if name in ('nature', 'town'):
        autotiles = {
            'path': [464, 465, 466, 472, 473, 474, 480, 481, 482],
            'sand': [280, 281, 282, 288, 289, 290, 296, 297, 298],
            'water': [200, 201, 202, 208, 209, 210, 216, 217, 218],
        }
    # Cliffs are complete directional metatiles, not interchangeable road quadrants.
    walls = ([104, 105, 106, 112, 113, 114, 120, 121, 122] if name in ('nature', 'town') else
             [568, 569, 570, 576, 577, 578, 585, 589, 586] if name == 'tower' else
             [794, 795, 796, 800, 803, 802, 808, 809, 810] if name == 'volcano' else
             [520, 521, 522, 528, 529, 530, 536, 537, 538])
    return {'biomes': biomes, 'image': f'{name}-v2.png', 'columns': 16,
            'sha256': save_image(atlas, out / f'{name}-v2.png'), 'tiles': tiles,
            'autotiles': autotiles, 'wallTiles': walls, 'nativeTileSize': 16, 'tileSize': TILE,
            'source': {'primary': PROFILES[name][1], 'secondary': PROFILES[name][2]}}


def frame_image(sheet: Image.Image, frame: int) -> Image.Image:
    # Original palette index 0 is transparent. Never drop rows to fit the walking sprite into a tile.
    indexed = sheet.crop((frame * 16, 0, (frame + 1) * 16, sheet.height))
    rgba = indexed.convert('RGBA')
    rgba.putalpha(Image.eval(indexed.convert('L') if indexed.mode != 'P' else
                            Image.frombytes('L', indexed.size, indexed.tobytes()), lambda i: 255 if i else 0))
    return rgba


def person_frame(image: Image.Image, baseline: int, flip: bool = False) -> Image.Image:
    if flip:
        image = image.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
    canvas = Image.new('RGBA', (32, 64))
    canvas.paste(image.resize((image.width * 2, image.height * 2), Image.Resampling.NEAREST),
                 (0, (32 - baseline) * 2))
    return canvas


def build_sprites(source: Source, bank: Tileset, out: Path) -> list[dict]:
    sprites = []
    def save(name: str, image: Image.Image, **meta):
        filename = f'sprites/{name.replace(":", "-")}-v2.png'
        sprites.append({'name': name, 'image': filename,
                        'frameWidth': image.width, 'frameHeight': image.height,
                        'sha256': save_image(image, out / filename), **meta})

    for name, file in {**HEROES, **NPCS}.items():
        sheet = Image.open(source.file(f'{PEOPLE_DIR}/{file}'))
        count = sheet.width // 16
        frames = [frame_image(sheet, i) for i in range(count)]
        # Shift all frames by the same bottom padding, preserving walking motion and every original row.
        baseline = max((frame.getbbox() or (0, 0, 0, 32))[3] for frame in frames)
        def scaled(index: int, flip: bool = False):
            return person_frame(frames[index], baseline, flip)
        if name in HEROES:
            image = Image.new('RGBA', (96, 256))
            for row, plan in enumerate([[0, 3, 4], [1, 5, 6], [2, 7, 8], [2, 7, 8]]):
                for col, frame in enumerate(plan):
                    image.paste(scaled(frame, row == 3), (col * 32, row * 64))
            save(name, image, frameWidth=32, frameHeight=64, columns=3, rows=4)
        else:
            # Nurse has a single facing plus healing poses; those poses are not walking directions.
            directional = count >= 9
            for facing, index, flip in [('down', 0, False), ('up', 1, False),
                                        ('left', 2, False), ('right', 2, True)]:
                save(f'{name}:{facing}', scaled(index if directional else 0, flip if directional else False))
            save(name, scaled(0))
    for name, rows in BUILDINGS.items():
        image = Image.new('RGBA', (len(rows[0]) * TILE, len(rows) * TILE))
        for y, row in enumerate(rows):
            for x, mid in enumerate(row):
                image.paste(bank.render(mid).resize((TILE, TILE), Image.Resampling.NEAREST), (x * TILE, y * TILE))
        save(f'building-{name}', image)
    return sprites


def build_battle(source: Source, out: Path) -> dict:
    root = 'graphics/battle_environment/tall_grass'
    tiles = Image.open(source.file(f'{root}/tiles.png'))
    raw = source.file(f'{root}/map.bin').read_bytes()
    palette = [tuple(map(int, line.split())) + (255,) for line in source.file(f'{root}/palette.pal').read_text().splitlines()[3:]]
    image = Image.new('RGBA', (240, 112))
    for y in range(14):
        for x in range(30):
            offset = (y * 32 + x) * 2
            value = int.from_bytes(raw[offset:offset + 2], 'little')
            ti, pi = value & 1023, value >> 12
            for py in range(8):
                for px in range(8):
                    idx = tiles.getpixel((ti % 16 * 8 + (7 - px if value & 1024 else px),
                                          ti // 16 * 8 + (7 - py if value & 2048 else py)))
                    image.putpixel((x * 8 + px, y * 8 + py), palette[(pi - 2) * 16 + idx if pi >= 2 else idx])
    file = 'sprites/battle-grass-v2.png'
    return {'name': 'battle-grass', 'image': file, 'frameWidth': 240, 'frameHeight': 112,
            'sha256': save_image(image, out / file)}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', type=Path, default=ROOT / 'public/assets/vendor/world')
    parser.add_argument('--cache', type=Path, default=Path.home() / '.cache/pokechain-world')
    parser.add_argument('--source', type=Path, help='Optional local checkout of the pinned pret/pokeemerald revision')
    args = parser.parse_args()
    source = Source(args.cache, args.source)
    primary = Tileset('general', source)
    banks = {}
    tilesets = []
    for name, (_, _, secondary, _) in PROFILES.items():
        print(f'[atlas] {name}', flush=True)
        bank = banks.setdefault(secondary, None)
        if bank is None:
            bank = banks[secondary] = Tileset(secondary, source, primary)
        tilesets.append(build_atlas(name, bank, args.out, banks.get('cave')))
    print('[sprites] original people + complete buildings', flush=True)
    sprites = build_sprites(source, banks['petalburg'], args.out)
    sprites.append(build_battle(source, args.out))
    manifest = {'version': 2, 'tileSize': TILE, 'nativeTileSize': 16,
                'source': {'repo': 'https://github.com/pret/pokeemerald', 'revision': REVISION},
                'generatedBy': 'frontend/tools/build-world-assets.py',
                'tilesets': tilesets, 'sprites': sprites}
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
    print(f'Done: {len(tilesets)} atlases / {len(sprites)} sprites → {args.out}')


if __name__ == '__main__':
    main()
