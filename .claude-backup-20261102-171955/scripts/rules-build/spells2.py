import re, json, difflib, clean
from canon_spells import CANON
t=open('txt/phb-cols.txt').read()
body=t[t.find('@@PAGE 238'):t.find('@@PAGE 343')]
lines=body.split('\n')
def nk(s): return re.sub(r"[^a-z]","",s.lower())
canon_keys={nk(n):(n,l) for n,l in CANON}
def capsish(l):
    s=l.strip()
    letters=[c for c in s if c.isalpha()]
    if len(letters)<3: return False
    up=sum(c.isupper() for c in letters)/len(letters)
    return up>0.7 and not s.startswith('@@') and 'CHAPTER' not in s.replace(' ','').upper()
hits=[]
used=set()
i=0
while i<len(lines):
    l=lines[i]
    if capsish(l):
        cands=[(nk(l),1)]
        if i+1<len(lines) and capsish(lines[i+1]): cands.append((nk(l)+nk(lines[i+1]),2))
        best=None
        for key,span in cands:
            m=difflib.get_close_matches(key,canon_keys.keys(),1,0.82)
            if m:
                r=difflib.SequenceMatcher(None,key,m[0]).ratio()
                if not best or r>best[2]: best=(m[0],span,r)
        if best:
            # require a Level/Cantrip/Casting line soon after
            look='\n'.join(lines[i+best[1]:i+best[1]+12])
            if re.search(r"(Level|Cantrip|asting|Time)",look):
                hits.append((i,best[1],canon_keys[best[0]]))
                i+=best[1]; continue
    i+=1
found={h[2][0] for h in hits}
missing=[n for n,l in CANON if n not in found]
dups=[n for n in found if sum(1 for h in hits if h[2][0]==n)>1]
print(len(hits),'missing',missing,'dups',dups)
CLASSES=['Bard','Cleric','Druid','Paladin','Ranger','Sorcerer','Warlock','Wizard']
out=[]
for k,(i,span,(name,lvl)) in enumerate(hits):
    end=hits[k+1][0] if k+1<len(hits) else len(lines)
    block=[l for l in lines[i+span:end] if not l.startswith('@@') and not re.fullmatch(r"\s*\d{1,3}\s*",l) and not re.search(r"CHAPTER\s*7",l.replace(' ',''),re.I)]
    out.append(dict(name=name,level=lvl,raw='\n'.join(block)))
json.dump(out,open('spell_blocks.json','w'),indent=1)
