"""Asset geometry regressions, using synthetic source pixels (no downloads required)."""
import importlib.util
from pathlib import Path
import unittest

from PIL import Image

spec = importlib.util.spec_from_file_location('world_assets', Path(__file__).with_name('build-world-assets.py'))
world = importlib.util.module_from_spec(spec)
spec.loader.exec_module(world)


class PeopleFramesTest(unittest.TestCase):
    def test_child_keeps_head_feet_and_square_proportions(self):
        child = Image.new('RGBA', (16, 16), 'navy')
        child.putpixel((6, 0), (255, 0, 0, 255))
        child.putpixel((9, 15), (0, 255, 0, 255))
        result = world.person_frame(child, 16)
        self.assertEqual(result.size, (32, 64))
        self.assertEqual(result.getbbox(), (0, 32, 32, 64))
        self.assertEqual(result.getpixel((12, 32)), (255, 0, 0, 255))
        self.assertEqual(result.getpixel((19, 63)), (0, 255, 0, 255))

    def test_adult_preserves_every_source_row(self):
        adult = Image.new('RGBA', (16, 32))
        for y in range(32):
            for x in range(16):
                adult.putpixel((x, y), (x, y, 255, 255))
        result = world.person_frame(adult, 32)
        for y in range(64):
            for x in range(32):
                self.assertEqual(result.getpixel((x, y)), adult.getpixel((x // 2, y // 2)))

    def test_shared_baseline_preserves_walk_frame_height(self):
        frame = Image.new('RGBA', (16, 32))
        frame.paste('red', (3, 7, 13, 29))
        self.assertEqual(world.person_frame(frame, 30).getbbox(), (6, 18, 26, 62))

    def test_right_facing_mirrors_without_cropping(self):
        child = Image.new('RGBA', (16, 16))
        child.putpixel((0, 0), (255, 0, 0, 255))
        self.assertEqual(world.person_frame(child, 16, True).getbbox(), (30, 32, 32, 34))


if __name__ == '__main__':
    unittest.main()
