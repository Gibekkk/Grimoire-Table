import re, json, difflib, clean
from classes_def import C, ORDER, RES, SUBRES, ASI, steps
RANGES={'barbarian':(49,56),'bard':(57,67),'cleric':(67,76),'druid':(77,88),'fighter':(89,98),'monk':(99,106),'paladin':(107,116),'ranger':(117,126),'rogue':(127,136),'sorcerer':(137,149),'warlock':(150,163),'wizard':(164,176)}
raw=open('txt/phb-cols.txt').read().split('\n')
# index lines with page numbers
L=[]; page=0
for l in raw:
    m=re.match(r"@@PAGE (\d+)",l)
    if m: page=int(m.group(1)); continue
    if l.startswith('@@COL'): continue
    L.append((page,l))
def nk(s): return re.sub(r"[^a-z]","",s.lower())
HEAD=re.compile(r"^\s*L\s?E\s?V\s?E\s?L\s?([0-9lIO\]]+)\s?:\s*(.+)$")
heads=[]
for i,(p,l) in enumerate(L):
    m=HEAD.match(l)
    if m:
        lv=m.group(1).replace('l','1').replace('I','1').replace('O','0').replace(']','1')
        try: lv=int(lv)
        except: continue
        heads.append(dict(i=i,page=p,level=lv,key=nk(m.group(2)),text=m.group(2)))
def capsish(s):
    s=s.strip(); letters=[c for c in s if c.isalpha()]
    return len(letters)>=4 and sum(c.isupper() for c in letters)/len(letters)>0.85
def find_section(name,lo,hi):
    best=None
    for i,(p,l) in enumerate(L):
        if lo<=p<=hi and capsish(l) and not HEAD.match(l):
            r=difflib.SequenceMatcher(None,nk(l),nk(name)).ratio()
            if r>0.8 and (not best or r>best[1]): best=(i,r)
    return best[0] if best else None
FOOT=re.compile(r"(CHAPTER|C HAPTER|CH APTER)\s*3|^\s*\d{1,3}\s*$|^\s*[|:;.,'\"_~\-•·]+\s*$")
def take(i,maxchars=2600):
    out=[]
    j=i+1
    while j<len(L):
        p,l=L[j]
        if HEAD.match(l): break
        if capsish(l) and len(l.strip())>6 and not l.strip().endswith('.') and j>i+2:
            # section title (subclass / table) ends the feature
            break
        if not FOOT.search(l): out.append(l)
        if sum(len(x) for x in out)>maxchars: break
        j+=1
    t=clean.clean('\n'.join(out))
    t=re.sub(r"\n{2,}","\n",t).strip()
    t=re.sub(r"(?<![.:!?\"”])\n(?=[a-z(])"," ",t)
    t=re.sub(r"[ \t]{2,}"," ",t)
    return t
def match(name,level,lo,hi,start_i=0,end_i=None):
    best=None
    for h in heads:
        if not(lo<=h['page']<=hi) or h['i']<start_i or (end_i and h['i']>=end_i): continue
        r=difflib.SequenceMatcher(None,h['key'],nk(name)).ratio()
        if h['level']==level: r+=0.15
        if r>0.85 and (not best or r>best[1]): best=(h,r)
    return best[0] if best else None
def slug(s): return re.sub(r"[^a-z0-9]+","-",s.lower().replace("'","")).strip('-')
classes=[]; features=[]; missing=[]
for cid in ORDER:
    c=C[cid]; lo,hi=RANGES[cid]
    sub_starts=[find_section(sn,lo,hi) for sn,_ in c['subclasses']]
    first_sub=min([s for s in sub_starts if s] or [10**9])
    seen=set()
    for lvl,name in c['features']:
        fid=f"{cid}-{slug(name)}" + (f"-{lvl}" if (cid,name) in seen else "")
        seen.add((cid,name))
        h=match(name,lvl,lo,hi,0,first_sub)
        desc=take(h['i']) if h else ''
        if not h: missing.append((cid,lvl,name))
        res=RES.get((cid,name)) if fid==f"{cid}-{slug(name)}" else None
        features.append(dict(id=fid,classId=cid,subclassId=None,name=name,level=lvl,description=desc,resource=res,toggleable=bool(res)))
    subs=[]
    for k,(sn,feats) in enumerate(c['subclasses']):
        sid=slug(sn)
        st=sub_starts[k] or 0
        en=None
        later=[s for s in sub_starts[k+1:] if s]
        if later: en=min(later)
        # subclass blurb
        blurb=''
        if sub_starts[k] is not None:
            blurb=take(sub_starts[k],600).split('\n')[0][:400]
        subs.append(dict(id=sid,name=sn,description=blurb))
        for lvl,name in feats:
            h=match(name,lvl,lo,hi,st,en)
            if not h: missing.append((sn,lvl,name))
            res=SUBRES.get((sn,name))
            features.append(dict(id=f"{cid}-{sid}-{slug(name)}",classId=cid,subclassId=sid,name=name,level=lvl,description=take(h['i']) if h else '',resource=res,toggleable=bool(res)))
    cls={k:v for k,v in c.items() if k not in ('features','subclasses','equipment','columns','subclassLevels')}
    cls['id']=cid
    cls['subclasses']=subs
    cls['subclassFeatureLevels']=c['subclassLevels']
    cls['asiLevels']=c.get('asiLevels',ASI)
    cls['equipmentOptions']=[dict(id=o,text=txt,gold=g,items=[dict(category=cat,catalogId=ci,quantity=q) for cat,ci,q in items]) for o,txt,items,g in c['equipment']]
    cls['progression']=[dict(label=lab,values=vals) for lab,vals in c['columns']]
    cls['weaponMasteryCount']=(c['weaponMastery'] or [0])[0]
    cls['multiclassPrereqText']=' and '.join(a.upper() for a in c['multiclassPrereq'].get('all',[])) or ' or '.join(a.upper() for a in c['multiclassPrereq'].get('any',[]))
    # level-1 class feature summary for builder cards
    classes.append(cls)
print('missing',len(missing)); [print(' ',m) for m in missing]
empty=[f['id'] for f in features if len(f['description'])<40]
print('short desc',len(empty),empty[:40])
json.dump(classes,open('classes_out.json','w'),indent=1,ensure_ascii=False)
json.dump(features,open('features_out.json','w'),indent=1,ensure_ascii=False)
THIRD_PREP=[0,0,3,4,4,4,5,6,6,7,8,8,9,10,10,11,11,11,12,13]
import subclass_spells as SS
_spell_ids={x['id'] for x in json.load(open('../../data/spells.json'))}
for cls in classes:
    for s in cls['subclasses']:
        if s['id'] in SS.S: s['spells']=SS.resolve(SS.S[s['id']],_spell_ids)
        if s['id']=='circle-of-the-land': s['landSpells']={k:SS.resolve(v,_spell_ids) for k,v in SS.LAND.items()}
        if s['id']=='eldritch-knight': s['spellcasting']=dict(ability='int',type='third',list='wizard',cantrips=steps((3,2),(10,3)),prepared=THIRD_PREP,focus='Arcane Focus')
        if s['id']=='arcane-trickster': s['spellcasting']=dict(ability='int',type='third',list='wizard',cantrips=steps((3,3),(10,4)),prepared=THIRD_PREP,focus='Arcane Focus',fixedCantrips=['mage-hand'])
    # legacy fields kept for older code paths / Firestore consumers
    cls['startingEquipment']=[o['text'] for o in cls['equipmentOptions']]
    cls['multiclassPrereq']=C[cls['id']]['multiclassPrereq'].get('all') or C[cls['id']]['multiclassPrereq'].get('any')
    cls['multiclassPrereqMode']='all' if 'all' in C[cls['id']]['multiclassPrereq'] else 'any'
json.dump(classes,open('../../data/classes.json','w'),indent=1,ensure_ascii=False)
json.dump(features,open('../../data/class-features.json','w'),indent=0,ensure_ascii=False)
