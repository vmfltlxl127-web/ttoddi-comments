import os, json, urllib.request, urllib.parse, sys, time
T=os.environ['IG_TOKEN'].strip()
u='https://graph.facebook.com/v23.0/17841404405169869/media?'+urllib.parse.urlencode({'fields':'id,caption,timestamp,thumbnail_url,media_url,media_type','limit':30,'access_token':T})
d=json.load(urllib.request.urlopen(u))['data']
os.makedirs('c',exist_ok=True)
for m in d:
    url=m.get('thumbnail_url') or m.get('media_url')
    if url: urllib.request.urlretrieve(url,f"c/{m['id']}.jpg")
eng=sys.argv[1]
if eng=='easy':
    import easyocr; r=easyocr.Reader(['ko','en'],gpu=False)
    def run(p): return [(b,t,c) for b,t,c in r.readtext(p)]
else:
    from paddleocr import PaddleOCR; r=PaddleOCR(lang='korean',use_doc_orientation_classify=False,use_doc_unwarping=False,use_textline_orientation=False)
    def run(p):
        res=r.predict(p)[0]; return list(zip(res['rec_polys'],res['rec_texts'],res['rec_scores']))
for m in d:
    p=f"c/{m['id']}.jpg"
    if not os.path.exists(p): continue
    t0=time.time(); out=run(p)
    items=[]
    for b,t,c in out:
        ys=[pt[1] for pt in b]; h=max(ys)-min(ys); items.append((round(float(h)),round(float(min(ys))),t,round(float(c),2)))
    print(f"### {m['id']} {m['timestamp'][:10]} | {(m.get('caption') or '')[:30]!r} ({time.time()-t0:.1f}s)")
    for it in sorted(items,key=lambda x:x[1]): print('   ',it)
