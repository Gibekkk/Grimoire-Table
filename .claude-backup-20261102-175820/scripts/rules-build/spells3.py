import re, json, difflib, clean
from canon_spells import CANON
blocks=json.load(open('spell_blocks.json'))
names=[n for n,_ in CANON]; lvl_of=dict(CANON)
found={b['name'] for b in blocks}
missing=sorted(n for n in names if n not in found)
HDR=re.compile(r"^\s*(Leve\s?l\s*[0-9lIJ/]\s*\S.*\(|.*C\s?a\s?n\s?t\s?r\s?i\s?p\s*\()",re.M)
# split blocks that swallowed a missing spell
newb=[]
for bi,b in enumerate(blocks):
    nxtname=blocks[bi+1]['name'] if bi+1<len(blocks) else 'zzzz'
    ls=b['raw'].split('\n')
    idx=[i for i,l in enumerate(ls) if HDR.match(l)]
    if len(idx)>1:
        cand=[m for m in missing if b['name']<m<nxtname]
        nm=min(cand) if cand else None
        cut=idx[1]
        # walk back over heading lines
        while cut>0 and ls[cut-1].strip() and not ls[cut-1].strip().endswith('.'): cut-=1
        newb.append(dict(name=b['name'],level=b['level'],raw='\n'.join(ls[:cut])))
        if nm: newb.append(dict(name=nm,level=lvl_of[nm],raw='\n'.join(ls[cut:]))); missing.remove(nm)
        print('split',b['name'],'->',nm)
    else: newb.append(b)
blocks=newb
CLASSES=['Artificer','Bard','Cleric','Druid','Paladin','Ranger','Sorcerer','Warlock','Wizard']
SCHOOLS=['Abjuration','Conjuration','Divination','Enchantment','Evocation','Illusion','Necromancy','Transmutation']
DT='Acid|Bludgeoning|Cold|Fire|Force|Lightning|Necrotic|Piercing|Poison|Psychic|Radiant|Slashing|Thunder'
def fixdigits(s):
    s=re.sub(r"\b([0-9lIO]{1,2})\s?d\s?([0-9lIO]{1,2})\b",lambda m: m.group(1).replace('l','1').replace('I','1').replace('O','0')+'d'+m.group(2).replace('l','1').replace('I','1').replace('O','0'),s)
    s=re.sub(r"\b[Ss]d(\d)",r"5d\1",s); s=re.sub(r"\b[lI]\s?d(\d)",r"1d\1",s); s=re.sub(r"\b[lI](\d)d(\d)",r"1\1d\2",s)
    s=re.sub(r"\b(\d+)\s?d\s?(\d+)\b",r"\1d\2",s); s=re.sub(r"\bl0\b","10",s)
    return s
def slug(n): return re.sub(r"[^a-z0-9]+","-",n.lower().replace("'","")).strip('-')
out=[]
for b in blocks:
    ls=b['raw'].split('\n')
    school=None; classes=[]; hdr={}
    body_start=0
    for i,l in enumerate(ls[:14]):
        s=l.strip()
        m=HDR.match(s)
        if m and not school:
            txt=s
            if '(' in txt and ')' not in txt and i+1<len(ls): txt+=' '+ls[i+1].strip()
            sc=re.sub(r"Leve\s?l\s*\S|C\s?a\s?n\s?t\s?r\s?i\s?p|\(.*","",txt)
            mm=difflib.get_close_matches(re.sub(r"[^a-z]","",sc.lower()),[x.lower() for x in SCHOOLS],1,0.5)
            school=mm[0].capitalize() if mm else None
            inner=re.search(r"\((.*?)\)?$",txt)
            for c in re.split(r"[,;]",inner.group(1) if inner else ''):
                cm=difflib.get_close_matches(re.sub(r"[^a-z]","",c.lower()),[x.lower() for x in CLASSES],1,0.6)
                if cm: classes.append(cm[0])
            continue
        fm=re.match(r"\s*([Cc]\s?a\s?s\s?t\s?i\s?n\s?g\s*T\s?i\s?m\s?e|R\s?a\s?n\s?g\s?e|[Cc]\s?o\s?m\s?p\s?o\s?n\s?e\s?n\s?t\s?s?|D\s?u\s?r\s?a\s?t\s?i\s?o\s?n)\s*[:;]\s*(.*)",s)
        if fm:
            key=re.sub(r"\s","",fm.group(1)).lower()[:4]
            val=fm.group(2).strip()
            j=i
            if key=='cast':
                while j+1<len(ls) and not re.match(r"\s*R\s?a\s?n\s?g\s?e",ls[j+1]):
                    j+=1
                    if ls[j].strip(): val=(val[:-1] if val.endswith('-') else val+' ')+ls[j].strip()
            while j+1<len(ls) and ls[j+1].strip() and not re.match(r"\s*(Casting|casting|Range|Compo|compo|Duration)",ls[j+1]) and ((key=='comp' and val.count('(')>val.count(')')) or (key=='cast' and val.endswith(('-',',')) or 'which you take' in val and not val.endswith('.'))) :
                j+=1; val=(val[:-1] if val.endswith('-') else val+' ')+ls[j].strip()
            hdr[key]=re.sub(r'\bl ?O\b','10',re.sub(r'\bl\b','1',clean.clean(val).strip())); body_start=j+1
            if key=='dura': break
    desc=clean.clean('\n'.join(l for l in ls[body_start:] if l.strip() not in ('SPELLS','_','•')))
    desc=fixdigits(desc)
    # paragraphs: join lines; break before bold-style lead-ins
    text=re.sub(r"\n{2,}","\n\n",desc).strip()
    text=re.sub(r"(?<![.\n:])\n(?!\n)"," ",text)
    text=re.sub(r"\n(?!\n)"," ",text) if False else text
    text=re.sub(r"\s*\n\s*\n\s*","\n",text)
    text=re.sub(r" {2,}"," ",text)
    higher=None
    hm=re.search(r"(Using a Hi\S*\s?-?\s?Level Spell Slot|Cantrip Upgrade)\s*\.\s*(.*)",text,re.S)
    if hm: higher=hm.group(2).strip().replace('\n',' '); text=text[:hm.start()].strip()
    level=b['level']
    ct=hdr.get('cast','Action'); ritual=bool(re.search(r"Ritual",ct)); ct=re.sub(r"\s*or Ritual","",ct).strip()
    dur=hdr.get('dura',''); conc=dur.lower().startswith('concentration')
    comp=hdr.get('comp','')
    damage=re.search(r"(\d+d\d+(?:\s?\+\s?\d+)?)\s+("+DT+r")\s+damage",text)
    save=re.search(r"(Strength|Dexterity|Constitution|Intelligence|Wisdom|Charisma) saving throw",text)
    attack=bool(re.search(r"(ranged|melee) spell attack|spell attack",text,re.I))
    heal=re.search(r"regains? (?:a number of )?Hit Points equal to (\d+d\d+)",text) or re.search(r"regains? (\d+d\d+)",text)
    summary=' '.join(re.split(r"(?<=[.!?])\s",text.replace('\n',' '))[:2])[:300]
    out.append(dict(id=slug(b['name']),name=b['name'],level=level,school=school,classes=sorted(set(c.lower() for c in classes)),
        castingTime=ct,ritual=ritual,range=hdr.get('rang',''),components=comp,duration=dur,concentration=conc,
        damageDice=damage.group(1).replace(' ','') if damage else None,damageType=damage.group(2).lower() if damage else None,
        save=save.group(1)[:3].lower() if save else None,attackRoll=attack,healDice=heal.group(1) if heal else None,
        summary=summary,description=text,higherLevel=higher,source='PHB 2024'))
print(len(out),'missing still',missing)
bad=[s['name'] for s in out if not s['school'] or not s['classes'] or not s['range'] or not s['duration']]
print('incomplete',len(bad),bad)
json.dump(out,open('spells_out.json','w'),indent=1,ensure_ascii=False)
