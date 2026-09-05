"""
Checks the shipped Color Grade template against the JavaScript reference.

The unit tests compare a hand-written mirror of this template's expression
building against gradePixel(). That mirror can drift from the template itself
without anything failing, which is the one gap those tests cannot close. This
runs the real .vkfilter through real VapourSynth and compares the pixels.

Driven by electron/gradeAgreement.integration.test.ts; run it directly with:

  python scripts/verify_grade.py <reference.json> <Color Grade.vkfilter>
"""
import json, re, sys, warnings
warnings.filterwarnings('ignore')
import vapoursynth as vs
core = vs.core

ref = json.load(open(sys.argv[1], encoding='utf-8'))
v, pixels, expected = ref['values'], ref['pixels'], ref['expected']

# Read the shipped template and fill in its {{variables}} exactly as the
# script generator does.
raw = open(sys.argv[2], encoding='utf-8').read()
code = raw.split('code = """', 1)[1].split('"""', 1)[0]

subs = {}
for ball in ('lift', 'gamma', 'gain', 'offset'):
    for ch in ('r', 'g', 'b', 'm'):
        subs[f'{ball}_{ch}'] = v[ball][ch]
for name in ('temperature','tint','contrast','pivot','saturation','hue','brightness'):
    subs[name] = v[name]
code = re.sub(r'\{\{\s*(\w+)\s*\}\}', lambda m: repr(float(subs[m.group(1)])), code)

# One pixel per column, as RGBS so nothing quantises.
W, H = len(pixels), 1
blank = core.std.BlankClip(width=W, height=H, format=vs.RGBS, length=1, color=[0,0,0])

def fill(n, f):
    out = f.copy()
    for plane in range(3):
        arr = out[plane]
        for x, px in enumerate(pixels):
            arr[0, x] = px[plane]
    return out

clip = core.std.ModifyFrame(blank, blank, fill)
scope = {'clip': clip, 'core': core, 'vs': vs}
exec(code, scope)
frame = scope['clip'].get_frame(0)

worst = 0.0
for x, px in enumerate(pixels):
    got = [float(frame[p][0, x]) for p in range(3)]
    want = expected[x]
    for c in range(3):
        worst = max(worst, abs(got[c] - want[c]))
    print(f"  {str(px):24} -> {[round(g,6) for g in got]}   ref {[round(w,6) for w in want]}")

print(f"\nworst absolute difference: {worst:.3e}")
print("AGREE" if worst < 2e-6 else "DISAGREE")
