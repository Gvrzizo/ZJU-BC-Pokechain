#!/usr/bin/env python3
"""构建 GBA 原作 overworld 素材包（瓦片集 + 人物行走图 + manifest.json）。

数据源：pret/pokeemerald（GBA《宝可梦 绿宝石》反编译工程）
  `data/tilesets/**`                       原作瓦片集（16×16 metatile）
  `graphics/object_events/pics/people/**`  原作 NPC / 主角行走图（16×32 帧）

原作资源是「索引色 PNG + JASC 调色板 + metatiles.bin」的二进制格式，浏览器不能直接用；
本脚本把它们解码成 RGBA PNG，并把 16×16 瓦片整数放大 2× 成 32×32（与前端 TILE=32 对齐）：

  metatiles.bin 的 16 位条目 = [tile index 0-9][hflip 10][vflip 11][palette 12-15]
  四个 8×8 子块拼成 16×16 metatile；上层（条目 4-7）按 palette index 0 抠透明后叠在下层上，palette 里的洋红占位色 (255,0,255) 同样视为透明。

产物（frontend/public/assets/vendor/world/，该目录在 .gitignore 内，版权素材不入库）：
  nature.png town.png cave.png interior.png sky-pillar.png lava.png   瓦片集（单行，32×32/格）
  sprites/*.png   引擎直接可用的贴图（hero 96×128；NPC 32×32 单帧）
  npc/*.png       原作 9 帧行走图（16×32/帧 ×2 放大），留给支持走动的引擎
  manifest.json   素材清单，格式见 frontend/src/game/world-assets.ts（前端地图引擎的契约）

用法：
    python3 tools/build-world-assets.py [--out public/assets/vendor/world] [--cache /tmp/...]

依赖：Pillow（`pip install pillow`）。
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.request

from PIL import Image

BASE = 'https://raw.githubusercontent.com/pret/pokeemerald/master'

TILESETS = {
    'general': 'data/tilesets/primary/general',
    'petalburg': 'data/tilesets/secondary/petalburg',
    'cave': 'data/tilesets/secondary/cave',
    'pokemon_center': 'data/tilesets/secondary/pokemon_center',
    'house': 'data/tilesets/secondary/brendans_mays_house',
    'pacifidlog': 'data/tilesets/secondary/pacifidlog',
    'mirage_tower': 'data/tilesets/secondary/mirage_tower',
    'lavaridge': 'data/tilesets/secondary/lavaridge',
}
PALETTE_COUNT = 16
PEOPLE_DIR = 'graphics/object_events/pics/people'

NATIVE_TILE = 16
TILE = 32  # 前端 TILE（world-assets.ts / maps/tiles.ts）

# ─────────────────────────────────────────────── 瓦片集定义
# 每格：(格名, 瓦片集, 原作 metatile id)；格名重复时用后缀区分，顺序即 PNG 里的列号。
SHEETS: dict[str, list[tuple[str, str, int]]] = {
    'nature': [
        ('grass', 'general', 1),
        ('tall-grass', 'general', 13),
        ('flower', 'general', 4),
        ('path', 'general', 465),
        ('path-edge', 'general', 464),
        ('sand', 'general', 292),
        ('sand-desert', 'general', 113),
        ('dirt', 'general', 473),
        ('tree', 'general', 469),
        ('tree-b', 'general', 468),
        ('tree-c', 'general', 477),
        ('tree-d', 'general', 476),
        ('rock', 'general', 213),
        ('rock-b', 'general', 214),
        ('water', 'general', 217),
        ('deep-water', 'general', 368),
        ('shore', 'general', 291),
        ('shore-b', 'general', 293),
        ('shore-c', 'general', 289),
        ('pond-edge', 'general', 200),
        ('pond-edge-b', 'general', 201),
        ('pond-edge-c', 'general', 202),
        ('cave-entrance', 'general', 167),
        ('sign', 'general', 27),
        ('ledge-a', 'general', 466),
        ('ledge-b', 'general', 462),
        ('ledge-c', 'general', 463),
        ('ledge-d', 'general', 481),
        ('ledge-e', 'general', 482),
        ('ledge-f', 'general', 480),
    ],
    'town': [
        ('path', 'general', 465),
        ('path-edge', 'general', 464),
        ('grass', 'general', 1),
        ('tall-grass', 'general', 13),
        ('flower', 'general', 4),
        ('sand', 'general', 113),
        ('tree', 'general', 469),
        ('tree-b', 'general', 468),
        ('water', 'general', 217),
        ('deep-water', 'general', 368),
        ('pc-roof', 'general', 81),
        ('pc-roof-b', 'general', 80),
        ('pc-roof-c', 'general', 82),
        ('pc-roof-d', 'general', 83),
        ('pc-roof-top', 'general', 73),
        ('pc-roof-top-b', 'general', 72),
        ('pc-wall', 'general', 99),
        ('pc-wall-b', 'general', 98),
        ('pc-wall-c', 'general', 97),
        ('pc-wall-d', 'general', 96),
        ('pc-sign', 'general', 3),
        ('mart-roof', 'general', 49),
        ('mart-roof-b', 'general', 48),
        ('mart-roof-c', 'general', 50),
        ('mart-roof-d', 'general', 51),
        ('mart-roof-top', 'general', 41),
        ('mart-roof-top-b', 'general', 40),
        ('mart-wall', 'general', 66),
        ('mart-wall-b', 'general', 67),
        ('mart-wall-c', 'general', 65),
        ('sign', 'general', 27),
        ('door', 'petalburg', 584),
        ('door-b', 'general', 26),
        ('doormat', 'petalburg', 513),
        ('house-roof', 'petalburg', 529),
        ('house-roof-b', 'petalburg', 528),
        ('house-roof-c', 'petalburg', 530),
        ('house-roof-d', 'petalburg', 537),
        ('house-roof-e', 'petalburg', 536),
        ('house-roof-f', 'petalburg', 538),
        ('house-roof-edge', 'petalburg', 524),
        ('house-roof-edge-b', 'petalburg', 525),
        ('house-wall', 'petalburg', 545),
        ('house-wall-b', 'petalburg', 546),
        ('house-wall-c', 'petalburg', 553),
        ('house-wall-d', 'petalburg', 554),
        ('house-wall-e', 'petalburg', 560),
        ('house-wall-f', 'petalburg', 562),
        ('house-wall-g', 'petalburg', 568),
        ('house-wall-h', 'petalburg', 570),
        ('house-wall-i', 'petalburg', 576),
        ('floor', 'house', 517),
        ('floor-b', 'house', 518),
        ('floor-c', 'house', 519),
        ('floor-d', 'house', 523),
        ('floor-e', 'pokemon_center', 542),
        ('floor-f', 'pokemon_center', 560),
        ('wall', 'house', 525),
        ('wall-b', 'house', 526),
        ('wall-c', 'pokemon_center', 554),
        ('window', 'house', 524),
        ('counter', 'pokemon_center', 515),
        ('counter-b', 'pokemon_center', 516),
        ('shelf', 'pokemon_center', 557),
        ('shelf-b', 'pokemon_center', 558),
        ('stairs', 'house', 528),
        ('carpet', 'house', 549),
        ('plant', 'house', 546),
        ('plant-b', 'house', 548),
        ('plant-c', 'house', 551),
        ('pc-machine', 'pokemon_center', 550),
    ],
    'cave': [
        ('cave-floor', 'cave', 529),
        ('cave-floor-b', 'cave', 547),
        ('cave-floor-c', 'cave', 548),
        ('cave-floor-d', 'cave', 602),
        ('cave-floor-e', 'cave', 600),
        ('cave-wall', 'cave', 537),
        ('cave-wall-b', 'cave', 513),
        ('cave-wall-c', 'cave', 521),
        ('cave-wall-d', 'cave', 528),
        ('cave-wall-e', 'cave', 530),
        ('cave-wall-f', 'cave', 539),
        ('cave-wall-g', 'cave', 540),
        ('cave-gate', 'cave', 567),
        ('cave-door', 'cave', 532),
        ('rock', 'cave', 515),
        ('rock-b', 'cave', 538),
        ('rock-c', 'cave', 551),
        ('rock-d', 'cave', 520),
        ('rock-e', 'cave', 543),
        ('rock-f', 'cave', 514),
        ('rock-g', 'cave', 536),
        ('rock-h', 'cave', 571),
        ('rock-i', 'cave', 592),
        ('ladder', 'cave', 575),
        ('ladder-b', 'cave', 601),
        ('ladder-c', 'cave', 573),
        ('ladder-d', 'cave', 574),
        ('sign', 'general', 27),
        ('water', 'general', 368),
    ],
    'interior': [
        ('floor', 'house', 517),
        ('floor-b', 'house', 518),
        ('floor-c', 'house', 519),
        ('floor-d', 'house', 523),
        ('floor-e', 'house', 530),
        ('floor-f', 'house', 533),
        ('floor-g', 'pokemon_center', 542),
        ('floor-h', 'pokemon_center', 560),
        ('floor-i', 'pokemon_center', 563),
        ('wall', 'house', 525),
        ('wall-b', 'house', 526),
        ('wall-c', 'pokemon_center', 554),
        ('window', 'house', 524),
        ('counter', 'pokemon_center', 515),
        ('counter-b', 'pokemon_center', 516),
        ('shelf', 'pokemon_center', 557),
        ('shelf-b', 'pokemon_center', 558),
        ('stairs', 'house', 528),
        ('carpet', 'house', 549),
        ('plant', 'house', 546),
        ('plant-b', 'house', 548),
        ('plant-c', 'house', 551),
        ('pc-machine', 'pokemon_center', 550),
        ('door', 'pokemon_center', 546),
        ('door-b', 'petalburg', 584),
    ],
    'sky-pillar': [
        ('pillar-floor', 'pacifidlog', 559),
        ('pillar-floor-b', 'pacifidlog', 551),
        ('pillar-floor-c', 'pacifidlog', 573),
        ('pillar-floor-d', 'pacifidlog', 579),
        ('pillar-wall', 'pacifidlog', 576),
        ('pillar-wall-b', 'pacifidlog', 568),
        ('pillar-wall-c', 'pacifidlog', 570),
        ('pillar-wall-d', 'pacifidlog', 578),
        ('pillar', 'pacifidlog', 564),
        ('pillar-b', 'pacifidlog', 565),
        ('stairs', 'pacifidlog', 580),
        ('door', 'pacifidlog', 572),
        ('altar', 'pacifidlog', 577),
        ('rubble', 'pacifidlog', 543),
        ('rubble-b', 'pacifidlog', 527),
        ('rubble-c', 'pacifidlog', 519),
        ('rubble-d', 'pacifidlog', 589),
        ('hole', 'pacifidlog', 566),
    ],
    'lava': [
        # 火山岩 / 岩浆 / 火山灰：只用原作里**底部层不透明**的格子，
        # 否则 Mt Chimney 那批「留空当背景」的瓦片会把地图画出一堆窟窿。
        ('lava-rock', 'lavaridge', 788),      # 深色火山岩
        ('lava-rock-b', 'lavaridge', 789),
        ('lava-rock-c', 'lavaridge', 776),    # 火山岩砖地（底）
        ('lava-rock-d', 'lavaridge', 777),
        ('lava-rock-e', 'lavaridge', 810),    # 暗红岩壁
        ('lava-rock-f', 'lavaridge', 811),
        ('lava-rock-g', 'lavaridge', 818),    # 橙红岩壁
        ('ash', 'lavaridge', 784),            # 火山灰地
        ('ash-b', 'lavaridge', 785),
        ('lava', 'lavaridge', 701),           # 岩浆
        ('lava-b', 'lavaridge', 804),         # 岩浆边（岩石包边）
        ('lava-c', 'lavaridge', 805),
        ('lava-d', 'lavaridge', 806),
        ('lava-e', 'lavaridge', 807),
        ('altar', 'cave', 567),               # 石台（借用洞窟石门）
        ('cave-door', 'general', 167),
        ('sign', 'general', 27),
    ],
}

# 生物群系 → 瓦片集（world-assets.ts 的 BiomeId）
BIOMES: dict[str, list[str]] = {
    'nature': ['grass', 'forest', 'mid', 'north', 'coast', 'island', 'birth'],
    'town': ['town'],
    'cave': ['cave', 'ruins', 'seafloor'],
    'sky-pillar': ['tower'],
    'lava': ['volcano', 'magma'],
    'interior': [],  # 室内瓦片：当前地图列表没有室内 biome，留给后续室内地图
}

# 地图引擎语义（maps/tiles.ts 的 TILE_SEMANTICS）→ 本瓦片集里的格名
ENGINE_TILES: dict[str, dict[str, str]] = {
    'nature': {
        'grass': 'grass', 'tallGrass': 'tall-grass', 'flower': 'flower', 'path': 'path',
        'sand': 'sand', 'tree': 'tree', 'rock': 'rock', 'water': 'water',
        'deepWater': 'deep-water', 'altar': 'cave-entrance', 'door': 'cave-entrance',
        'stairs': 'cave-entrance', 'sign': 'sign', 'gravel': 'dirt', 'floor': 'sand-desert',
    },
    'town': {
        'grass': 'grass', 'tallGrass': 'tall-grass', 'flower': 'flower', 'path': 'path',
        'sand': 'sand', 'tree': 'tree', 'water': 'water', 'deepWater': 'deep-water',
        'rock': 'rock-b',
        'roof': 'house-roof', 'wall': 'house-wall', 'door': 'door', 'sign': 'sign',
        'floor': 'floor', 'carpet': 'carpet', 'counter': 'counter', 'stairs': 'stairs',
    },
    'cave': {
        'gravel': 'cave-floor', 'floor': 'cave-floor-b', 'wall': 'cave-wall',
        'rock': 'rock', 'door': 'cave-door', 'altar': 'cave-gate', 'water': 'water',
        'stairs': 'ladder', 'sign': 'sign',
    },
    'interior': {
        'floor': 'floor', 'wall': 'wall', 'counter': 'counter', 'door': 'door',
        'stairs': 'stairs', 'carpet': 'carpet',
    },
    'sky-pillar': {
        'floor': 'pillar-floor', 'wall': 'pillar-wall', 'pillar': 'pillar', 'stairs': 'stairs',
        'door': 'door', 'altar': 'altar', 'rock': 'rubble', 'gravel': 'pillar-floor-b',
    },
    'lava': {
        'floor': 'lava-rock-c', 'wall': 'lava-rock-e', 'lava': 'lava', 'ash': 'ash',
        'gravel': 'ash-b', 'altar': 'altar', 'door': 'cave-door', 'sign': 'sign',
    },
}

# ─────────────────────────────────────────────── 人物行走图
# 引擎 NPC 名字（maps/npcs.ts 的 NPC_SPRITES）→ 原作文件名；前者是 BootScene 实际会用的
ENGINE_NPC: dict[str, str] = {
    'nurse': 'nurse.png',
    'clerk': 'mart_employee.png',
    'elder': 'expert_m.png',
    'kid': 'little_boy.png',
    'scientist': 'scientist_1.png',
    'hiker': 'hiker.png',
    'sailor': 'sailor.png',
    'bug-catcher': 'bug_catcher.png',
}

# 额外 NPC 行走图（原作 9 帧，存 npc/ 备用/给支持走动的引擎）
EXTRA_NPC: dict[str, str] = {
    'boy': 'boy_1.png',
    'girl': 'girl_1.png',
    'man': 'man_1.png',
    'woman': 'woman_1.png',
    'old-man': 'old_man.png',
    'granny': 'old_woman.png',
    'camper': 'camper.png',
    'fisherman': 'fisherman.png',
    'mom': 'mom.png',
    'prof-birch': 'prof_birch.png',
}

HEROES = {
    'hero': 'ruby_sapphire_brendan/walking.png',
    'hero-may': 'ruby_sapphire_may/walking.png',
}

# 标准 9 帧行走图帧序（pokeemerald src/data/object_events/object_event_anims.h）
# 前端瓦片语义名（= src/game/maps/tiles.ts 的 TILE_SEMANTICS，顺序即程序化瓦片集的列号）
SEMANTIC_NAMES = [
    'grass', 'tallGrass', 'flower', 'path', 'sand', 'ash', 'gravel', 'tree', 'rock',
    'water', 'deepWater', 'plank', 'wall', 'roof', 'floor', 'carpet', 'counter', 'door',
    'stairs', 'sign', 'lava', 'altar', 'pillar',
]

STANDARD_FRAME_ORDER = [
    'face-south', 'face-north', 'face-west',
    'walk-south-a', 'walk-south-b', 'walk-north-a', 'walk-north-b', 'walk-west-a', 'walk-west-b',
]
# 引擎主角表几何：3 列（站立/迈步A/迈步B）× 4 行（下/上/左/右），32×32/帧
HERO_ROWS = [
    ('down', [0, 3, 4]),
    ('up', [1, 5, 6]),
    ('left', [2, 7, 8]),
    ('right', None),  # None = 镜像左向
]


def fetch(rel_path: str, cache: str) -> str:
    dst = os.path.join(cache, rel_path.replace('/', '__'))
    if not os.path.exists(dst):
        os.makedirs(os.path.dirname(dst) or cache, exist_ok=True)
        with urllib.request.urlopen(f'{BASE}/{rel_path}') as resp, open(dst, 'wb') as fh:
            fh.write(resp.read())
    return dst


def load_palette(path: str) -> list[tuple[int, int, int, int]]:
    with open(path) as fh:
        lines = [ln.strip() for ln in fh if ln.strip()]
    cols = []
    for ln in lines[3:3 + PALETTE_COUNT]:
        r, g, b = (int(x) for x in ln.split()[:3])
        cols.append((r, g, b, 255))
    while len(cols) < PALETTE_COUNT:
        cols.append((0, 0, 0, 0))
    return cols


class Tileset:
    """原作瓦片集：解码 metatiles.bin 成 16×16 RGBA metatile。"""

    def __init__(self, key: str, cache: str):
        self.key = key
        root = TILESETS[key]
        self.secondary = root.startswith('data/tilesets/secondary')
        self.indices = Image.open(fetch(f'{root}/tiles.png', cache))
        if self.indices.mode != 'P':
            raise RuntimeError(f'{key}/tiles.png 不是索引色 PNG')
        with open(fetch(f'{root}/metatiles.bin', cache), 'rb') as fh:
            raw = fh.read()
        self.metatiles = [raw[i * 16:(i + 1) * 16] for i in range(len(raw) // 16)]
        self.palettes = [
            load_palette(fetch(f'{root}/palettes/{i:02d}.pal', cache)) for i in range(PALETTE_COUNT)
        ]
        self.cols = self.indices.width // 8
        self.rows = self.indices.height // 8
        self._px = self.indices.load()

    def _block(self, index: int, hflip: bool, vflip: bool):
        if not (0 <= index < self.cols * self.rows):
            return None
        ty, tx = divmod(index, self.cols)
        return [
            [self._px[tx * 8 + (7 - x if hflip else x), ty * 8 + (7 - y if vflip else y)] for x in range(8)]
            for y in range(8)
        ]

    def render(self, metatile_id: int) -> Image.Image:
        # 地图里的 metatile id：< 512 属于 primary 瓦片集，≥ 512 属于 secondary（索引要减 512）
        index = metatile_id - 512 if (self.secondary and metatile_id >= 512) else metatile_id
        entry = self.metatiles[index]
        out = Image.new('RGBA', (NATIVE_TILE, NATIVE_TILE), (0, 0, 0, 0))
        px = out.load()
        for layer in (0, 1):
            for q in range(4):
                off = (layer * 4 + q) * 2
                value = entry[off] | (entry[off + 1] << 8)
                palette = self.palettes[(value >> 12) & 0xF]
                tile_index = value & 0x3FF
                # secondary 瓦片集的瓦片编号从 512 起（primary 占 0-511），本图内部编号要减回去
                if self.secondary and tile_index >= 512:
                    tile_index -= 512
                block = self._block(tile_index, bool((value >> 10) & 1), bool((value >> 11) & 1))
                if block is None:
                    continue
                oy, ox = (q // 2) * 8, (q % 2) * 8
                for y in range(8):
                    for x in range(8):
                        idx = block[y][x]
                        if layer == 1 and idx == 0:
                            continue  # 上层 palette index 0 = 透明
                        color = palette[idx]
                        if color[:3] == (255, 0, 255):
                            continue  # 原作 palette 里的洋红占位色 = 抠空（两层都当透明）
                        px[ox + x, oy + y] = color
        return out


def build_sheet(name: str, cache: str, out_dir: str) -> dict:
    spec = SHEETS[name]
    cache_ts: dict[str, Tileset] = {}
    tiles: list[tuple[str, str, int, Image.Image]] = []
    for semantic, ts_key, metatile in spec:
        ts = cache_ts.get(ts_key) or cache_ts.setdefault(ts_key, Tileset(ts_key, cache))
        tiles.append((semantic, ts_key, metatile, ts.render(metatile)))

    strip = Image.new('RGBA', (len(tiles) * TILE, TILE), (0, 0, 0, 0))
    semantics: dict[str, list[dict]] = {}
    by_name: dict[str, int] = {}
    for i, (semantic, ts_key, metatile, img) in enumerate(tiles):
        strip.paste(img.resize((TILE, TILE), Image.NEAREST), (i * TILE, 0))
        by_name[semantic] = i
        semantics.setdefault(semantic, []).append({
            'index': i,
            'x': i * TILE,
            'y': 0,
            'source': {'tileset': ts_key, 'metatile': metatile, 'nativeSize': NATIVE_TILE},
        })
    strip.save(os.path.join(out_dir, f'{name}.png'))

    engine = {}
    for tile_id, slot in ENGINE_TILES.get(name, {}).items():
        if slot in by_name:
            engine[tile_id] = by_name[slot]
    return {
        'biomes': BIOMES[name],
        'image': f'{name}.png',
        'columns': len(tiles),
        'rows': 1,
        'tileSize': TILE,
        'nativeTileSize': NATIVE_TILE,
        'tileCount': len(tiles),
        'imageSize': {'width': strip.width, 'height': strip.height},
        'tiles': engine,
        'semantics': semantics,
    }


def frame_image(sheet: Image.Image, frame: int) -> Image.Image:
    """取 16×32 的行走帧，palette index 0 视为透明。"""
    idx = sheet.crop((frame * NATIVE_TILE, 0, (frame + 1) * NATIVE_TILE, sheet.height))
    pixels = idx.load()
    out = Image.new('RGBA', (NATIVE_TILE, sheet.height), (0, 0, 0, 0))
    rgb = idx.convert('RGB').load()
    for y in range(sheet.height):
        for x in range(NATIVE_TILE):
            if pixels[x, y] != 0:
                out.putpixel((x, y), rgb[x, y] + (255,))
    return out


def pixels(img: Image.Image) -> list:
    getter = getattr(img, 'get_flattened_data', None) or img.getdata
    return list(getter())


def sample_axis(img: Image.Image, size: int, axis: int) -> Image.Image:
    """等间距抽掉一行/一列，把该轴压到 size（保持像素锐利，不做插值）。"""
    length = img.height if axis == 1 else img.width
    keep = [min(length - 1, round(i * length / size)) for i in range(size)]
    data = pixels(img)
    w, h = img.size
    if axis == 1:
        out = Image.new('RGBA', (w, size))
        out.putdata([data[y * w + x] for y in keep for x in range(w)])
        return out
    out = Image.new('RGBA', (size, h))
    out.putdata([data[y * w + x] for y in range(h) for x in keep])
    return out


def fit_tile(img: Image.Image, size: int = TILE) -> Image.Image:
    """把人物帧压进 size×size：内容裁边 → 2× 放大 → 超出的行/列等间距抽掉（保持像素锐利）→ 底部居中。"""
    bbox = img.getbbox()
    if bbox is None:
        return Image.new('RGBA', (size, size), (0, 0, 0, 0))
    crop = img.crop(bbox)
    big = crop.resize((crop.width * 2, crop.height * 2), Image.NEAREST)
    if big.height > size:
        big = sample_axis(big, size, axis=1)
    if big.width > size:
        big = sample_axis(big, size, axis=0)
    canvas = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    canvas.paste(big, ((size - big.width) // 2, size - big.height))
    return canvas


def build_sprites(cache: str, out_dir: str) -> tuple[list[dict], dict[str, list[dict]], dict[str, dict]]:
    sprite_dir = os.path.join(out_dir, 'sprites')
    npc_dir = os.path.join(out_dir, 'npc')
    os.makedirs(sprite_dir, exist_ok=True)
    os.makedirs(npc_dir, exist_ok=True)

    sprites: list[dict] = []
    sheets_meta: dict[str, list[dict]] = {}
    npc_detail: dict[str, dict] = {}

    # 主角：3 列 × 4 行 32×32（引擎 hero 行走图几何），右向 = 左向镜像
    for hero_name, src in HEROES.items():
        path = fetch(f'{PEOPLE_DIR}/{src}', cache)
        sheet = Image.open(path)
        frames = [frame_image(sheet, i) for i in range(9)]
        out = Image.new('RGBA', (TILE * 3, TILE * 4), (0, 0, 0, 0))
        for row, (dir_name, plan) in enumerate(HERO_ROWS):
            cols = plan if plan is not None else [2, 7, 8]
            for col, frame in enumerate(cols):
                img = fit_tile(frames[frame])
                if plan is None:
                    img = img.transpose(Image.FLIP_LEFT_RIGHT)
                out.paste(img, (col * TILE, row * TILE))
        out.save(os.path.join(sprite_dir, f'{hero_name}.png'))
        sprites.append({
            'name': hero_name,
            'image': f'sprites/{hero_name}.png',
            'frameWidth': TILE,
            'frameHeight': TILE,
            'source': {'repo': 'pret/pokeemerald', 'path': f'{PEOPLE_DIR}/{src}'},
            'columns': 3,
            'rows': 4,
            'frameOrder': {
                'rows': ['down', 'up', 'left', 'right'],
                'columns': ['stand', 'step-a', 'step-b'],
            },
            'nativeSize': {'width': NATIVE_TILE, 'height': 32},
            'note': '原作 16×32 行走帧按 2× 压到 32×32（超出部分等间距抽行），可直接替换引擎 hero 贴图',
        })

    # NPC：引擎贴图 key 用 32×32 单帧（踩格站立），同时导出原作 9 帧行走图到 npc/
    for engine_name, src in ENGINE_NPC.items():
        path = fetch(f'{PEOPLE_DIR}/{src}', cache)
        sheet = Image.open(path)
        standby = fit_tile(frame_image(sheet, 0))
        standby.save(os.path.join(sprite_dir, f'{engine_name}.png'))
        sprites.append({
            'name': engine_name,
            'image': f'sprites/{engine_name}.png',
            'frameWidth': TILE,
            'frameHeight': TILE,
            'source': {'repo': 'pret/pokeemerald', 'path': f'{PEOPLE_DIR}/{src}'},
            'frameCount': 1,
            'nativeSize': {'width': NATIVE_TILE, 'height': sheet.height},
            'note': '原作第 0 帧（面朝下站立）压到 32×32；完整 9 帧行走图见 npc/',
        })

    for npc_name, src in {**ENGINE_NPC, **EXTRA_NPC}.items():
        path = fetch(f'{PEOPLE_DIR}/{src}', cache)
        sheet = Image.open(path)
        frames = sheet.width // NATIVE_TILE
        out = Image.new('RGBA', (NATIVE_TILE * 2 * frames, sheet.height * 2), (0, 0, 0, 0))
        for i in range(frames):
            out.paste(frame_image(sheet, i).resize((NATIVE_TILE * 2, sheet.height * 2), Image.NEAREST),
                      (i * NATIVE_TILE * 2, 0))
        out.save(os.path.join(npc_dir, f'{npc_name}.png'))
        meta = {
            'file': f'npc/{npc_name}.png',
            'source': {'repo': 'pret/pokeemerald', 'path': f'{PEOPLE_DIR}/{src}'},
            'frameSize': {'width': NATIVE_TILE * 2, 'height': sheet.height * 2},
            'frameCount': frames,
            'frameOrder': STANDARD_FRAME_ORDER[:frames],
            'walkable': frames >= 9,
            'note': '原作 16×32 行走帧 2× 放大；东向 = 西向水平镜像',
        }
        sheets_meta.setdefault('files', []).append(meta)
        npc_detail[npc_name] = meta

    return sprites, sheets_meta, npc_detail


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default=os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'public', 'assets', 'vendor', 'world'))
    ap.add_argument('--cache', default=os.environ.get('POKECHAIN_WORLD_CACHE', '/tmp/pokechain-world-build'))
    args = ap.parse_args()

    out_dir = os.path.abspath(args.out)
    os.makedirs(out_dir, exist_ok=True)

    tilesets = []
    for name in SHEETS:
        print(f'[sheet] {name} ...', flush=True)
        tilesets.append(build_sheet(name, args.cache, out_dir))

    print('[sprites] ...', flush=True)
    sprites, npc_sheets, npc_detail = build_sprites(args.cache, out_dir)

    manifest = {
        'version': 1,
        'tileSize': TILE,
        'nativeTileSize': NATIVE_TILE,
        'scale': TILE // NATIVE_TILE,
        'generatedBy': 'frontend/tools/build-world-assets.py',
        '$comment': 'GBA 原作 overworld 素材清单（pret/pokeemerald 解码后 2× 放大），仅课程演示用；'
                    '版权归 Nintendo / GAME FREAK / The Pokémon Company。勿手改，改生成脚本后重跑。',
        'source': {
            'repo': 'https://github.com/pret/pokeemerald',
            'tilesetRoot': 'data/tilesets',
            'npcRoot': PEOPLE_DIR,
            'license': '© Nintendo / GAME FREAK / The Pokémon Company —— 非商用，仅课程演示',
        },
        'tilesets': tilesets,
        'sprites': sprites,
        'npcSheets': npc_sheets,
        'npc': {
            'dir': 'npc',
            'files': list(npc_detail.values()),
            'eastFacing': 'hflip of face-west / walk-west frames',
        },
        'tilesetIndex': {
            'layout': '单行横向排列，列号 = 该文件里第 n 个瓦片；tiles 给引擎语义 → 列号，semantics 给全部格子的像素位置',
            'semanticNames': SEMANTIC_NAMES,
            'extraNames': [
                'pc-roof', 'pc-wall', 'mart-roof', 'mart-wall', 'sign', 'shore', 'ledge', 'cave-floor',
                'cave-wall', 'cave-gate', 'cave-entrance', 'ladder', 'pillar-floor', 'pillar-wall',
                'rubble', 'lava-rock', 'volcanic-floor', 'doormat', 'house-roof', 'house-wall',
                'window', 'shelf', 'plant', 'pc-machine',
            ],
        },
        'proceduralFallback': {
            'generator': 'src/game/world-textures.ts（BootScene 先程序化生成，再用本清单的瓦片按语义叠加）',
            'textureKeyPattern': 'world-tiles:<biome>',
            'tileSize': TILE,
            'layout': '单行横向排列，贴图帧 index = semanticNames 顺序（maps/tiles.ts 的 TILE_SEMANTICS），'
                      '缺映射的语义保持程序化那一格',
            'semanticNames': SEMANTIC_NAMES,
            'biomes': ['town', 'grass', 'forest', 'mid', 'cave', 'coast', 'north', 'volcano',
                       'tower', 'seafloor', 'magma', 'ruins', 'island', 'birth'],
        },
    }

    with open(os.path.join(out_dir, 'manifest.json'), 'w') as fh:
        json.dump(manifest, fh, ensure_ascii=False, indent=2)
        fh.write('\n')

    total = sum(t['tileCount'] for t in tilesets)
    print(f'完成：{len(tilesets)} 个瓦片集 / {total} 格瓦片 / {len(sprites)} 张贴图 → {out_dir}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
