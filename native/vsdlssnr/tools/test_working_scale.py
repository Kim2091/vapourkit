"""Exercise the shipped template with real VS resizing and a controlled NR stand-in.

Run with data/vapoursynth-portable/python.exe native/vsdlssnr/tools/test_working_scale.py.
No NVIDIA runtime is needed for these reconstruction tests.
"""
import ast
from pathlib import Path
from types import SimpleNamespace
import tomllib
import unittest

import numpy as np
import vapoursynth as vs


core = vs.core
TEMPLATE = Path(__file__).resolve().parents[3] / "include/plugins/plugin_filters/DLSS Neural Uplift.vkfilter"
DEFINITION = tomllib.loads(TEMPLATE.read_text(encoding="utf-8"))
CODE = DEFINITION["code"]
for name, declaration in DEFINITION["variables"].items():
    CODE = CODE.replace("{{" + name + "}}", repr(declaration["default"]))


def run_template(source, scale=1.0, enhance=None, use_akarin=False):
    tree = ast.parse(CODE)
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(
            isinstance(target, ast.Name) and target.id == "working_scale"
            for target in node.targets
        ):
            node.value = ast.Constant(scale)
    calls = []

    def nr(clip, **kwargs):
        calls.append((clip.width, clip.height, kwargs))
        return enhance(clip) if enhance else clip

    context = dict(
        clip=source, vs=vs, default_matrix="709", default_transfer="709",
        core=SimpleNamespace(resize=core.resize, std=core.std,
                             dlssnr=SimpleNamespace(Enhance=nr)),
    )
    if use_akarin:
        context["core"].akarin = core.akarin
    exec(compile(ast.fix_missing_locations(tree), str(TEMPLATE), "exec"), context)
    return context["clip"], calls


def pixels(clip, n=0):
    with clip.get_frame(n) as frame:
        return np.stack([np.asarray(frame[p]).copy() for p in range(3)])


def textured(width=128, height=72):
    base = core.std.BlankClip(width=width, height=height, length=3, format=vs.RGBS)
    rng = np.random.default_rng(27)
    data = rng.uniform(0.1, 0.9, (3, height, width)).astype(np.float32)

    def fill(n, f):
        result = f.copy()
        for p in range(3):
            np.copyto(np.asarray(result[p]), data[p])
        return result

    return core.std.ModifyFrame(base, base, fill)


class WorkingScaleTests(unittest.TestCase):
    def test_no_edit_preserves_full_resolution_texture(self):
        source = textured(129, 73)
        for scale in (1.0, 0.75, 0.5, 0.25):
            with self.subTest(scale=scale):
                output, calls = run_template(source, scale)
                self.assertEqual((output.width, output.height), (129, 73))
                self.assertEqual(output.num_frames, source.num_frames)
                np.testing.assert_allclose(pixels(output), pixels(source), atol=2e-6, rtol=0)
                if scale < 1:
                    self.assertEqual(calls[0][0] % 2, 0)
                    self.assertEqual(calls[0][1] % 2, 0)
                    self.assertLess(calls[0][0], source.width)
                self.assertEqual(calls[0][2]["auto_motion"], 1)

    def test_full_scale_returns_model_output(self):
        source = textured()
        effect = lambda clip: core.std.Expr(clip, "x 0.7 *")
        output, _ = run_template(source, enhance=effect)
        np.testing.assert_allclose(pixels(output), pixels(effect(source)), atol=2e-6, rtol=0)

    def test_signed_model_edit_is_added_without_blurring_source(self):
        source = textured()
        for delta in (-0.05, 0.05):
            output, _ = run_template(source, 0.5, lambda clip: core.std.Expr(clip, f"x {delta} +"))
            np.testing.assert_allclose(pixels(output), pixels(source) + delta, atol=2e-6, rtol=0)

    def test_shared_limit_preserves_edit_direction_at_gamut_boundary(self):
        source = core.std.BlankClip(width=128, height=72, format=vs.RGBS,
                                   color=[0.9, 0.3, 0.5])
        output, _ = run_template(source, 0.5, lambda clip: core.std.Expr(
            clip, ["x 0.2 +", "x 0.1 +", "x 0.2 -"]))
        # Red can accept only half the edit; green and blue must use the same factor.
        np.testing.assert_allclose(pixels(output)[:, 0, 0], [1.0, 0.35, 0.4], atol=2e-6)

    def test_yuv_format_and_colour_properties_survive(self):
        source = core.std.BlankClip(width=128, height=72, format=vs.YUV420P10,
                                   color=[400, 512, 512], length=3)
        source = core.std.SetFrameProps(source, _Matrix=vs.MATRIX_BT709,
                                       _Transfer=vs.TRANSFER_BT709, _Range=vs.RANGE_LIMITED)
        output, _ = run_template(source, 0.5)
        self.assertEqual(output.format.id, source.format.id)
        with output.get_frame(2) as frame:
            self.assertEqual(frame.props["_Matrix"], vs.MATRIX_BT709)
            self.assertEqual(frame.props["_Transfer"], vs.TRANSFER_BT709)
            self.assertEqual(frame.props["_Range"], vs.RANGE_LIMITED)
            self.assertLessEqual(abs(int(np.asarray(frame[0])[0, 0]) - 400), 1)

    def test_invalid_scales_fail_before_inference(self):
        for scale in (0, 0.24, 1.01, float("nan"), float("inf")):
            with self.subTest(scale=scale), self.assertRaisesRegex(ValueError, "working_scale"):
                run_template(textured(), scale)

    @unittest.skipUnless(hasattr(core, "akarin"), "optional akarin plugin is not installed")
    def test_akarin_and_standard_composition_agree(self):
        source = textured(129, 73)
        effect = lambda clip: core.std.Expr(clip, ["x 0.6 +", "x 0.4 -", "x 0.2 +"])
        standard, _ = run_template(source, 0.5, effect)
        optimized, _ = run_template(source, 0.5, effect, use_akarin=True)
        np.testing.assert_allclose(pixels(optimized), pixels(standard), atol=2e-6, rtol=0)


if __name__ == "__main__":
    unittest.main()
