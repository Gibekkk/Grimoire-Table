import re,json,clean,textfix
from options import section, INV, META, MAN
raw=json.load(open('options_raw.json'))
lines=section(93,94)
text=clean.clean('\n'.join(l for l in lines if not re.search(r"CHAPTER|^\s*\d{1,3}\s*$",l)))
text=textfix.fix(text)
pos=[]
for n in MAN:
    m=re.search(re.escape(n).replace("\\ ",r"\s*")+r"\s*\.",text)
    pos.append((m.start() if m else None,n,m.end() if m else None))
found=sorted([p for p in pos if p[0] is not None])
man={}
for k,(s,n,e) in enumerate(found):
    end=found[k+1][0] if k+1<len(found) else e+700
    d=text[e:end].strip()
    d=re.split(r"\n[A-Z][A-Z ]{6,}",d)[0]
    man[n]=dict(prereq=None,desc=d)
print('maneuvers',len(man),[n for n in MAN if n not in man])
def slug(n): return re.sub(r"[^a-z0-9]+","-",n.lower().replace("'","")).strip('-')
inv=[]
IPRE={'Agonizing Blast':(2,'A Warlock cantrip that deals damage'),'Ascendant Step':(5,None),"Devil's Sight":(2,None),'Devouring Blade':(12,'Thirsting Blade invocation'),'Eldritch Smite':(5,'Pact of the Blade invocation'),'Eldritch Spear':(2,'A Warlock cantrip that deals damage'),'Fiendish Vigor':(2,None),'Gaze of Two Minds':(5,None),'Gift of the Depths':(5,None),'Gift of the Protectors':(9,'Pact of the Tome invocation'),'Investment of the Chain Master':(5,'Pact of the Chain invocation'),'Lessons of the First Ones':(2,None),'Lifedrinker':(9,'Pact of the Blade invocation'),'Mask of Many Faces':(2,None),'Master of Myriad Forms':(5,None),'Misty Visions':(2,None),'One with Shadows':(5,None),'Otherworldly Leap':(2,None),'Repelling Blast':(2,'A Warlock cantrip that deals damage'),'Thirsting Blade':(5,'Pact of the Blade invocation'),'Visions of Distant Realms':(9,None),'Whispers of the Grave':(7,None),'Witch Sight':(15,None)}
REP={'Agonizing Blast','Eldritch Spear','Lessons of the First Ones','Repelling Blast'}
for n in INV:
    r=raw['invocations'][n]; d=r['desc']
    if n in ('Agonizing Blast','Eldritch Spear','Repelling Blast') and r['prereq']:
        # text after the prereq clause belongs to the description
        m=re.match(r".*?Deals Damage\s*(.*)",r['prereq'])
        d=(m.group(1)+'\n'+d).strip() if m else d
    lvl,req=IPRE.get(n,(1,None))
    d=re.split(r"\n?[A-Z][A-Z ]{8,}",d)[0].strip()
    inv.append(dict(id=slug(n),name=n,minLevel=lvl,requires=req,repeatable=n in REP,description=d))
meta=[]
for n in META:
    d=raw['metamagic'][n]['desc']
    d=re.split(r"\s*SORCERER SPELL LIST",d)[0]
    cost=re.search(r"Cost:\s*([^\n]*?Sorcery Points?)",d)
    d=re.sub(r"Cost:\s*[^\n]*?Sorcery Points?\s*","",d).strip()
    meta.append(dict(id=slug(n),name=n,cost=cost.group(1) if cost else None,description=d))
mans=[dict(id=slug(n),name=n,description=man[n]['desc']) for n in MAN if n in man]
json.dump(dict(invocations=inv,metamagic=meta,maneuvers=mans),open('class_options.json','w'),indent=1,ensure_ascii=False)
for x in inv[:3]: print(x)
print(meta[-1]); print(mans[0])
