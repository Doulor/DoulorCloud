from PIL import Image
import numpy as np

def analyze(path, is_dark):
    im = Image.open(path).convert("RGB")
    a = np.array(im)
    H, W, _ = a.shape
    print(f"\n=== {path} size={W}x{H} ===")
    # classify pixels
    if is_dark:
        pagebg = np.array([13,17,23])
        alien_dark = None
        # white rect mask: near-white
        alien = (a[:,:,0]>235)&(a[:,:,1]>235)&(a[:,:,2]>235)
        alien_name = "near-white"
    else:
        pagebg = np.array([255,255,255])
        # dark rect mask: near #0d1117 or #0a0a0a (very dark)
        alien = (a[:,:,0]<40)&(a[:,:,1]<40)&(a[:,:,2]<50)
        alien_name = "near-black"
    rows = alien.mean(axis=1)
    # find row runs where >30% of row is alien
    runs=[]
    in_run=False
    for y,v in enumerate(rows):
        if v>0.3 and not in_run:
            in_run=True; start=y
        elif v<=0.3 and in_run:
            in_run=False; runs.append((start,y-1,rows[start:y].max()))
    if in_run: runs.append((start,H-1,rows[start:].max()))
    # merge close runs
    merged=[]
    for r in runs:
        if merged and r[0]-merged[-1][1]<=3:
            merged[-1]=(merged[-1][0],r[1],max(merged[-1][2],r[2]))
        else: merged.append(r)
    print(f"{alien_name} row-runs (>30% row coverage): {merged if merged else 'NONE'}")
    # x-extents of alien pixels per run
    for (y0,y1,mx) in merged:
        sub=alien[y0:y1+1]
        cols=np.where(sub.any(axis=0))[0]
        if len(cols): print(f"  rows {y0}-{y1} (h={y1-y0+1}): x {cols.min()}..{cols.max()} w={cols.max()-cols.min()+1} peakcov={mx:.2f}")

def blocks(path):
    """Find content blocks: rows that are not uniform page bg, get x extents."""
    im=Image.open(path).convert("RGB")
    a=np.array(im).astype(int)
    H,W,_=a.shape
    bg=a[5,5]
    diff=np.abs(a-bg).sum(axis=2)
    mask=diff>30
    rowcov=mask.mean(axis=1)
    runs=[]; in_run=False
    for y,v in enumerate(rowcov):
        if v>0.02 and not in_run: in_run=True; start=y
        elif v<=0.02 and in_run: in_run=False; runs.append((start,y-1))
    if in_run: runs.append((start,H-1))
    merged=[]
    for r in runs:
        if merged and r[0]-merged[-1][1]<=8: merged[-1]=(merged[-1][0],r[1])
        else: merged.append(list(r))
    print(f"\nBlocks in {path.split(chr(92))[-1]} (bg={bg}):")
    for y0,y1 in merged:
        sub=mask[y0:y1+1]
        cols=np.where(sub.any(axis=0))[0]
        print(f"  rows {y0}-{y1} h={y1-y0+1}: x {cols.min()}..{cols.max()} w={cols.max()-cols.min()+1} cov={rowcov[y0:y1+1].mean():.2f}")

analyze(r"C:\Users\Doulor\AppData\Local\Temp\gh2-light.png", False)
analyze(r"C:\Users\Doulor\AppData\Local\Temp\gh2-dark.png", True)
blocks(r"C:\Users\Doulor\AppData\Local\Temp\gh2-light.png")
blocks(r"C:\Users\Doulor\AppData\Local\Temp\gh2-dark.png")
