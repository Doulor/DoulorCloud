from PIL import Image
import numpy as np

def solid_rect_scan(path, dark_mode):
    im=Image.open(path).convert("RGB")
    a=np.array(im).astype(int)
    H,W,_=a.shape
    print(f"\n=== {path.split(chr(92))[-1]} {W}x{H} ===")
    # sample page bg at several margin points below header
    for pt in [(10,100),(10,2000),(1090,2000),(550,3000),(10,3600)]:
        print(" bg sample", pt, a[pt[1],pt[0]])
    if dark_mode:
        alien=(a[:,:,0]>235)&(a[:,:,1]>235)&(a[:,:,2]>235)
    else:
        alien=(a[:,:,0]<45)&(a[:,:,1]<45)&(a[:,:,2]<55)
    # find SOLID rectangles: per row, longest run of alien pixels
    rows_alien_frac = alien.mean(axis=1)
    y0=73  # skip browser chrome
    # solid = row where some contiguous alien run > 300px
    def longest_run(row):
        best=cur=0; bestend=0; s=0
        for i,v in enumerate(row):
            if v:
                if cur==0: s=i
                cur+=1
                if cur>best: best=cur; bestend=i
            else: cur=0
        return best, bestend-best+1 if best else 0
    rectrows=[]
    for y in range(y0,H):
        if rows_alien_frac[y]>0.15:
            lr,start=longest_run(alien[y])
            if lr>250: rectrows.append((y,start,lr))
    # group consecutive rows
    groups=[]
    for y,s,l in rectrows:
        if groups and y-groups[-1][-1][0]<=2: groups[-1].append((y,s,l))
        else: groups.append([(y,s,l)])
    print(f" SOLID alien rects (contiguous run>250px):")
    for g in groups:
        ys=[r[0] for r in g]; ss=[r[1] for r in g]; ls=[r[2] for r in g]
        print(f"  rows {ys[0]}-{ys[-1]} h={ys[-1]-ys[0]+1}: x~{min(ss)}..{max(s+l for s,l in zip(ss,ls))} maxrun={max(ls)}")

solid_rect_scan(r"C:\Users\Doulor\AppData\Local\Temp\gh2-light.png", False)
solid_rect_scan(r"C:\Users\Doulor\AppData\Local\Temp\gh2-dark.png", True)
