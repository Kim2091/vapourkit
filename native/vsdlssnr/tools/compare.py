import sys
import numpy as np

a = np.load(sys.argv[1])
b = np.load(sys.argv[2])
ha, hb = a["hashes"], b["hashes"]
n = min(len(ha), len(hb))
same = int((ha[:n] == hb[:n]).sum())
print(f"frames compared: {n}   identical hashes: {same}   differing: {n - same}")
if same != n:
    bad = [i for i in range(n) if ha[i] != hb[i]]
    print(f"  first differing frame indices: {bad[:10]}")
for k in a.files:
    if k == "hashes" or k not in b.files:
        continue
    x, y = a[k], b[k]
    eq = np.array_equal(x, y)
    print(f"  {k}: np.array_equal={eq}"
          + ("" if eq else f"  maxabs={np.nanmax(np.abs(x.astype(np.float64)-y.astype(np.float64))):.6g}"
                           f"  ndiff={int((x!=y).sum())}/{x.size}"))
