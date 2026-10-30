import re,json,difflib,clean,textfix
t=open('txt/phb-cols.txt').read()
def section(p0,p1): return [l for l in t[t.find(f'@@PAGE {p0}\n'):t.find(f'@@PAGE {p1+1}\n')].split('\n') if not l.startswith('@@')]
def nk(s): return re.sub(r"[^a-z]","",s.lower())
def capsish(s):
    s=s.strip(); letters=[c for c in s if c.isalpha()]
    return len(letters)>=3 and sum(c.isupper() for c in letters)/len(letters)>0.8
def extract(names,p0,p1,thresh=0.8):
    lines=section(p0,p1); keys={nk(n):n for n in names}
    hits=[]
    for i,l in enumerate(lines):
        if capsish(l):
            m=difflib.get_close_matches(nk(l),keys.keys(),1,thresh)
            if m and keys[m[0]] not in [h[1] for h in hits]: hits.append((i,keys[m[0]]))
    out={}
    for k,(i,n) in enumerate(hits):
        end=hits[k+1][0] if k+1<len(hits) else min(len(lines),i+40)
        body=[l for l in lines[i+1:end] if not re.search(r"CHAPTER|^\s*\d{1,3}\s*$",l)]
        txt=textfix.fix(clean.clean('\n'.join(body)))
        txt=re.sub(r"\n{2,}","\n",txt)
        pre=None
        m=re.match(r"\s*Prerequisite\s*:\s*([^\n]*?)(?:\n|$)",txt)
        if m: pre=m.group(1).strip(); txt=txt[m.end():].strip()
        out[n]=dict(prereq=pre,desc=txt)
    return out,[n for n in names if n not in out]
INV="Agonizing Blast|Armor of Shadows|Ascendant Step|Devil's Sight|Devouring Blade|Eldritch Mind|Eldritch Smite|Eldritch Spear|Fiendish Vigor|Gaze of Two Minds|Gift of the Depths|Gift of the Protectors|Investment of the Chain Master|Lessons of the First Ones|Lifedrinker|Mask of Many Faces|Master of Myriad Forms|Misty Visions|One with Shadows|Otherworldly Leap|Pact of the Blade|Pact of the Chain|Pact of the Tome|Repelling Blast|Thirsting Blade|Visions of Distant Realms|Whispers of the Grave|Witch Sight".split('|')
inv,miss=extract(INV,153,158)
print('inv missing',miss)
META="Careful Spell|Distant Spell|Empowered Spell|Extended Spell|Heightened Spell|Quickened Spell|Seeking Spell|Subtle Spell|Transmuted Spell|Twinned Spell".split('|')
meta,miss2=extract(META,139,143)
print('meta missing',miss2)
MAN="Ambush|Bait and Switch|Commander's Strike|Commanding Presence|Disarming Attack|Distracting Strike|Evasive Footwork|Feinting Attack|Goading Attack|Lunging Attack|Maneuvering Attack|Menacing Attack|Parry|Precision Attack|Pushing Attack|Rally|Riposte|Sweeping Attack|Tactical Assessment|Trip Attack".split('|')
man,miss3=extract(MAN,92,95)
print('maneuver missing',miss3)
json.dump(dict(invocations=inv,metamagic=meta,maneuvers=man),open('options_raw.json','w'),indent=1,ensure_ascii=False)
for n in ['Agonizing Blast','Pact of the Blade','Armor of Shadows']: print(n,inv.get(n))
print(meta.get('Twinned Spell')); print(man.get('Riposte'))
