#!/usr/bin/env python3
"""Install pinned, unmodified Mojang Bedrock textures for the local dashboard.

Uses Python's standard library only. The source archive is cached in .local;
only PNGs and provenance/catalogue files are installed in dashboard/assets.
Run: python scripts/update-minecraft-textures.py
"""

import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import struct
import urllib.request
import zipfile


COMMIT = '15701fa9c13923f12662984c32c124327e40e3d3'
VERSION = '1.26.60.5'
ARCHIVE_SHA256 = '79d3f0f25569cdcda48014d8393f9cc2ae9527c0a6ece459821cfcd9eb442dc9'
REPOSITORY = 'https://github.com/Mojang/bedrock-samples'
ARCHIVE_URL = f'https://codeload.github.com/Mojang/bedrock-samples/zip/{COMMIT}'
PUBLIC_PREFIX = '/assets/minecraft/'
ROOT = Path(__file__).resolve().parents[1]


def sha256(content):
    return hashlib.sha256(content).hexdigest()


def jsonc(content):
    # Preserve quoted URLs and escaped quotes while removing JSONC comments.
    value = content.decode('utf-8-sig')
    value = re.sub(r'("(?:\\.|[^"\\])*")|//[^\r\n]*|/\*[\s\S]*?\*/', lambda m: m[1] if m[1] else '', value)
    return json.loads(value)


def install(archive, output):
    with zipfile.ZipFile(archive) as source:
        base = source.namelist()[0]
        files = {}
        paths = set()
        for entry in source.infolist():
            relative = entry.filename.removeprefix(base + 'resource_pack/')
            if not re.fullmatch(r'textures/(items|blocks)/[A-Za-z0-9_./-]+\.png', relative):
                continue
            if '..' in PurePosixPath(relative).parts or entry.file_size > 512 * 1024:
                raise ValueError(f'Unexpected asset path or size: {relative}')
            content = source.read(entry)
            if content[:8] != b'\x89PNG\r\n\x1a\n':
                raise ValueError(f'Invalid PNG: {relative}')
            width, height = struct.unpack('>II', content[16:24])
            destination = output / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(content)
            paths.add(relative)
            files[relative] = {'sha256': sha256(content), 'bytes': len(content), 'width': width, 'height': height}

        def read(name):
            return jsonc(source.read(base + name))

        item_atlas = read('resource_pack/textures/item_texture.json')['texture_data']
        terrain_atlas = read('resource_pack/textures/terrain_texture.json')['texture_data']
        block_definitions = read('resource_pack/blocks.json')
        official_items = read('metadata/vanilladata_modules/mojang-items.json')['data_items']
        item_filenames = {}
        for path in sorted(paths):
            if path.startswith('textures/items/'):
                item_filenames.setdefault(PurePosixPath(path).stem, []).append(path)

        def texture_paths(value):
            if isinstance(value, str):
                path = value if value.endswith('.png') else value + '.png'
                return [path] if path in paths else []
            if isinstance(value, list):
                return [path for member in value for path in texture_paths(member)]
            if isinstance(value, dict):
                if 'path' in value:
                    return texture_paths(value['path'])
                if 'textures' in value:
                    return texture_paths(value['textures'])
            return []

        def atlas_paths(atlas, key):
            return texture_paths(atlas.get(key, {}).get('textures'))

        def entry(paths_for_item, variants=False):
            if not paths_for_item:
                return None
            result = {'src': PUBLIC_PREFIX + paths_for_item[0]}
            if variants and len(paths_for_item) > 1:
                result['variants'] = {str(index): PUBLIC_PREFIX + path for index, path in enumerate(paths_for_item)}
            return result

        def block_entry(name):
            block = block_definitions.get(name)
            if not isinstance(block, dict):
                return None
            value = block.get('carried_textures', block.get('textures'))
            keys = [value] if isinstance(value, str) else [value.get(face) for face in ['south', 'front', 'side', 'all', 'north', 'up', 'top', 'down', 'east', 'west']] if isinstance(value, dict) else []
            for key in keys:
                resolved = atlas_paths(terrain_atlas, key) if isinstance(key, str) else []
                if resolved:
                    return entry(resolved, variants=isinstance(terrain_atlas[key].get('textures'), list))
            return None

        # These names are identifiers from the received Bedrock registry, while
        # the official atlas retains older icon names. No pixels are generated.
        aliases = {
            'bow': 'bow_standby', 'crossbow': 'crossbow_standby', 'golden_apple': 'apple_golden', 'enchanted_golden_apple': 'apple_golden',
            'golden_carrot': 'carrot_golden', 'beef': 'beef_raw', 'cooked_beef': 'beef_cooked', 'porkchop': 'porkchop_raw', 'cooked_porkchop': 'porkchop_cooked',
            'chicken': 'chicken_raw', 'cooked_chicken': 'chicken_cooked', 'mutton': 'mutton_raw', 'cooked_mutton': 'mutton_cooked',
            'rabbit': 'rabbit', 'cooked_rabbit': 'rabbit_cooked', 'cod': 'fish', 'cooked_cod': 'cooked_fish', 'tropical_fish': 'clownfish',
            'book': 'book_normal', 'enchanted_book': 'book_enchanted', 'writable_book': 'book_writable', 'written_book': 'book_written',
            'totem_of_undying': 'totem', 'fire_charge': 'fireball', 'firework_rocket': 'fireworks', 'firework_star': 'fireworks_charge',
            'oak_door': 'wooden_door', 'oak_sign': 'sign', 'dark_oak_sign': 'sign_darkoak', 'crimson_sign': 'crimson_sign_item', 'warped_sign': 'warped_sign_item',
            'empty_map': 'map_empty', 'filled_map': 'map_filled', 'map': 'map_empty', 'dye': 'dye_powder',
            'potion': 'potion_bottle_drinkable', 'splash_potion': 'potion_bottle_splash', 'lingering_potion': 'potion_bottle_lingering',
            'repeater': 'repeater', 'nether_wart': 'nether_wart', 'sugar_cane': 'reeds', 'lily_pad': 'waterlily', 'grass_block': 'grass',
            'melon_slice': 'melon', 'glistering_melon_slice': 'melon_speckled', 'slime_ball': 'slimeball', 'magma_cream': 'magma_cream',
            'leather_horse_armor': 'leather_horse_armor', 'golden_horse_armor': 'gold_horse_armor', 'scute': 'turtle_shell_piece',
            'turtle_scute': 'turtle_shell_piece', 'rabbit_foot': 'rabbit_foot', 'experience_bottle': 'experience_bottle',
            'glow_ink_sac': 'dye_powder_glow', 'ink_sac': 'dye_powder_black', 'cocoa_beans': 'dye_powder_brown', 'lapis_lazuli': 'dye_powder_blue',
            'bone_meal': 'dye_powder_white', 'nether_brick': 'netherbrick', 'brick': 'brick', 'nautilus_shell': 'nautilus_shell',
            'baked_potato': 'potato_baked', 'poisonous_potato': 'potato_poisonous', 'popped_chorus_fruit': 'chorus_fruit_popped',
            'glass_bottle': 'potion_bottle_empty', 'fermented_spider_eye': 'spider_eye_fermented', 'redstone': 'redstone_dust',
            'clock': 'clock_item', 'compass': 'compass_item', 'lodestone_compass': 'lodestonecompass_item', 'iron_chain': 'chain',
            'minecart': 'minecart_normal', 'chest_minecart': 'minecart_chest', 'hopper_minecart': 'minecart_hopper',
            'tnt_minecart': 'minecart_tnt', 'command_block_minecart': 'minecart_command_block',
        }
        bucket_types = ['bucket', 'milk_bucket', 'water_bucket', 'lava_bucket', 'cod_bucket', 'salmon_bucket', 'tropical_fish_bucket', 'pufferfish_bucket', 'powder_snow_bucket', 'axolotl_bucket', 'tadpole_bucket', 'sulfur_cube_bucket']
        bucket_paths = atlas_paths(item_atlas, 'bucket')
        special = {name: entry([bucket_paths[index]]) for index, name in enumerate(bucket_types) if index < len(bucket_paths)}

        # Flattened item names must keep their own material/color texture;
        # metadata on a tool must never select another material's icon.
        colors = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray', 'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black']
        for index, color in enumerate(colors):
            beds = atlas_paths(item_atlas, 'bed')
            if index < len(beds):
                special[color + '_bed'] = entry([beds[index]])
            for suffix in ['bundle']:
                resolved = atlas_paths(item_atlas, suffix + '_' + color)
                if resolved:
                    special[color + '_' + suffix] = entry(resolved)
            dye_path = 'textures/items/dye_powder_' + ('silver' if color == 'light_gray' else color) + ('_new' if color in ['white', 'black', 'brown', 'blue'] else '') + '.png'
            if dye_path in paths:
                special[color + '_dye'] = entry([dye_path])

        boats = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'bamboo', 'cherry', 'pale_oak', 'poplar']
        for key in ['boat', 'chest_boat']:
            textures = atlas_paths(item_atlas, key)
            for index, wood in enumerate(boats):
                suffix = key.replace('boat', 'raft') if wood == 'bamboo' else key
                if index < len(textures):
                    special[wood + '_' + suffix] = entry([textures[index]])

        items = {}
        for row in official_items:
            full_name = row['name']
            name = full_name.removeprefix('minecraft:')
            value = special.get(name)
            alias = aliases.get(name, name)
            if name.endswith('_seeds'):
                alias = 'seeds_' + name.removesuffix('_seeds')
            if name.startswith('music_disc_'):
                alias = 'record_' + name.removeprefix('music_disc_')
            if name.endswith('_spawn_egg'):
                alias = 'spawn_egg_' + name.removesuffix('_spawn_egg')
            if name.endswith('_harness'):
                alias = 'harness_' + name.removesuffix('_harness')
            material_alias = alias.replace('wooden_', 'wood_').replace('golden_', 'gold_')
            if value is None:
                value = entry(atlas_paths(item_atlas, alias) or atlas_paths(item_atlas, material_alias))
            if value is None:
                filenames = item_filenames.get(alias) or item_filenames.get(material_alias) or item_filenames.get(name) or []
                value = entry(filenames) if len(filenames) == 1 else None
            if value is None:
                value = block_entry(alias) or block_entry(name) or entry(atlas_paths(terrain_atlas, alias))
            if value:
                items[full_name] = value

        # Include atlas identifiers for legacy names in older server stacks.
        # Only explicit legacy color/material arrays use raw metadata indexes.
        legacy_variants = ['wool', 'carpet', 'planks', 'log', 'log2', 'sapling', 'leaves', 'leaves2', 'sand', 'dirt', 'stained_glass', 'stained_glass_pane', 'stained_hardened_clay', 'concrete', 'concrete_powder', 'bed', 'dye', 'shulker_box']
        for name in legacy_variants:
            atlas_key = aliases.get(name, name)
            atlas = item_atlas if atlas_key in item_atlas else terrain_atlas
            value = entry(atlas_paths(atlas, atlas_key), variants=True) or block_entry(atlas_key)
            if value:
                items['minecraft:' + name] = value

        for name in list(items):
            if items[name] is None:
                del items[name]

        source_info = {
            'repository': REPOSITORY, 'commit': COMMIT, 'version': VERSION,
            'treeUrl': f'{REPOSITORY}/tree/{COMMIT}', 'archiveUrl': ARCHIVE_URL, 'archiveSha256': ARCHIVE_SHA256,
            'licenseUrl': f'{REPOSITORY}/blob/{COMMIT}/LICENSE.md', 'license': 'Minecraft EULA; (c) Mojang AB. All rights reserved.',
            'catalogues': ['resource_pack/textures/item_texture.json', 'resource_pack/textures/terrain_texture.json', 'resource_pack/blocks.json', 'metadata/vanilladata_modules/mojang-items.json']
        }
        manifest = {'version': 1, 'source': source_info, 'items': dict(sorted(items.items())), 'files': dict(sorted(files.items()))}
        output.mkdir(parents=True, exist_ok=True)
        (output / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, separators=(',', ':')) + '\n', encoding='utf-8')
        (output / 'LICENSE.md').write_bytes(source.read(base + 'LICENSE.md'))
        source_dir = output / 'source'
        source_dir.mkdir(exist_ok=True)
        for filename in source_info['catalogues']:
            (source_dir / Path(filename).name).write_bytes(source.read(base + filename))
        (output / 'NOTICE.md').write_text(
            '# Minecraft Bedrock textures\n\n'
            'Textures © Mojang AB. All rights reserved.\n\n'
            f'Source: [{REPOSITORY}]({REPOSITORY}/tree/{COMMIT}), vanilla Bedrock {VERSION}.\n\n'
            f'Pinned commit: `{COMMIT}`.\n\n'
            f'Archive SHA-256: `{ARCHIVE_SHA256}`.\n\n'
            'The PNG files in `textures/items/` and `textures/blocks/` are copied byte-for-byte from that official resource pack. '
            'Item atlas images are preferred; where the pack has no separate inventory sprite, the dashboard uses an official carried/block face texture. '
            'The manifest includes a SHA-256 hash, size, and dimensions for every installed PNG. '
            'No artwork is generated or redrawn. Unknown textures remain unavailable.\n\n'
            'These assets are subject to the [Minecraft EULA](https://www.minecraft.net/en-us/eula) and '
            '[Minecraft Usage Guidelines](https://www.minecraft.net/en-us/usage-guidelines). '
            'They are not covered by this Bot’s code license. The original source license is preserved in [LICENSE.md](LICENSE.md).\n\n'
            'This is an unofficial Minecraft Bot dashboard. It is not approved by or associated with Mojang or Microsoft.\n\n'
            'Regenerate with `python scripts/update-minecraft-textures.py`; the helper verifies the pinned source archive hash.\n', encoding='utf-8')
        official_names = {row['name'] for row in official_items}
        missing = sorted(official_names - items.keys())
        report = {'officialItemCount': len(official_names), 'mappedOfficialItems': len(official_names & items.keys()), 'manifestItems': len(items), 'pngFiles': len(files), 'pngBytes': sum(row['bytes'] for row in files.values()), 'manifestBytes': (output / 'manifest.json').stat().st_size, 'missingItems': missing}
        (output / 'coverage.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
        print(json.dumps({key: value for key, value in report.items() if key != 'missingItems'}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archive', type=Path, default=ROOT / '.local/minecraft-texture-build/bedrock-samples-15701fa9.zip')
    parser.add_argument('--output', type=Path, default=ROOT / 'dashboard/assets/minecraft')
    args = parser.parse_args()
    if not args.archive.exists():
        args.archive.parent.mkdir(parents=True, exist_ok=True)
        request = urllib.request.Request(ARCHIVE_URL, headers={'User-Agent': 'MinecraftBot-Dashboard-Textures'})
        with urllib.request.urlopen(request, timeout=120) as response, args.archive.open('wb') as destination:
            while chunk := response.read(1024 * 1024):
                destination.write(chunk)
    with args.archive.open('rb') as source:
        digest = hashlib.file_digest(source, 'sha256').hexdigest()
    if digest != ARCHIVE_SHA256:
        raise ValueError('The source archive hash does not match the pinned Mojang commit.')
    install(args.archive, args.output.resolve())


if __name__ == '__main__':
    main()
