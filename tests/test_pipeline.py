import sys, time
sys.path.insert(0, "/mnt/c/Users/maxde/pdf-editor")
import fitz
from pdfcore.document import Doc
OUT="/tmp/claude-1000/-home-maxdevops/4dafb280-78bb-42c5-a283-67abe006e176/scratchpad"

for kind in ("native","scan"):
    src=f"{OUT}/sample_{kind}.pdf"
    d=Doc(doc_id=kind,name=kind,src=fitz.open(src))
    t=time.time(); a=d.analyze(0); dt=time.time()-t
    print(f"\n=== {kind} === mode={a['mode']} dpi_natif={a['native_dpi']} couverture_img={a['image_coverage']} "
          f"items={len(a['items'])} analyse={dt:.1f}s")
    for it in a["items"][:14]:
        print(f"  {it['id']:9} {it['color']} {it['font_key'][:26]:26} {it['size']:5.1f}pt "
              f"score={it['font_score']:.2f} | {it['text'][:44]}")
    # edite la ligne contenant 'Dupont' et le total
    edits=[("Dupont","Client : Madame Lefevre-Argand"),("1 350","Total a payer")]
    n=0
    for needle,_ in edits:
        for it in a["items"]:
            if needle in it["text"]:
                new = it["text"].replace("Dupont","Bonnefoy").replace("1 350,00","9 876,54").replace("Monsieur","Madame")
                d.ops.append({"type":"text","page":0,"item_id":it["id"],"text":new,
                              "bbox":it["bbox"],"color":it["color"],"size":it["size"],
                              "font_key":it["font_key"],"paper":it.get("paper"),
                              "tracking":it.get("tracking",0),"left":it.get("ink_left",it["bbox"][0]),
                              "baseline":it.get("baseline"),"top":it.get("ink_top")})
                print(f"  EDIT {it['id']}: {it['text'][:34]!r} -> {new[:34]!r}"); n+=1; break
    t=time.time(); out=d.build(); dt=time.time()-t
    open(f"{OUT}/edited_{kind}.pdf","wb").write(out)
    print(f"  {n} modifs, export {dt:.1f}s, {len(out)/1024:.0f} Ko (source {len(open(src,'rb').read())/1024:.0f} Ko)")
    r=fitz.open(f"{OUT}/edited_{kind}.pdf")
    r[0].get_pixmap(dpi=150).save(f"{OUT}/edited_{kind}.png")
    print("  texte apres edition:", r[0].get_text('text').replace(chr(10),' | ')[:130])
