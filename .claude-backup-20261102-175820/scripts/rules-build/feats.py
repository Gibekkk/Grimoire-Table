import re,json,difflib,clean,textfix
ORIGIN="Alert|Crafter|Healer|Lucky|Magic Initiate|Musician|Savage Attacker|Skilled|Tavern Brawler|Tough"
GENERAL="Ability Score Improvement|Actor|Athlete|Charger|Chef|Crossbow Expert|Crusher|Defensive Duelist|Dual Wielder|Durable|Elemental Adept|Fey-Touched|Grappler|Great Weapon Master|Heavily Armored|Heavy Armor Master|Inspiring Leader|Keen Mind|Lightly Armored|Mage Slayer|Martial Weapon Training|Medium Armor Master|Moderately Armored|Mounted Combatant|Observant|Piercer|Poisoner|Polearm Master|Resilient|Ritual Caster|Sentinel|Shadow-Touched|Sharpshooter|Shield Master|Skill Expert|Skulker|Slasher|Speedy|Spell Sniper|Telekinetic|Telepathic|War Caster|Weapon Master"
FS="Archery|Blind Fighting|Defense|Dueling|Great Weapon Fighting|Interception|Protection|Thrown Weapon Fighting|Two-Weapon Fighting|Unarmed Fighting"
EPIC="Boon of Combat Prowess|Boon of Dimensional Travel|Boon of Energy Resistance|Boon of Fate|Boon of Fortitude|Boon of Irresistible Offense|Boon of Recovery|Boon of Skill|Boon of Speed|Boon of Spell Recall|Boon of the Night Spirit|Boon of Truesight"
CAT={**{n:'origin' for n in ORIGIN.split('|')},**{n:'general' for n in GENERAL.split('|')},**{n:'fighting-style' for n in FS.split('|')},**{n:'epic-boon' for n in EPIC.split('|')}}
t=open('txt/phb-cols.txt').read()
seg=t[t.find('@@PAGE 199'):t.find('@@PAGE 211')]
lines=[l for l in seg.split('\n') if not l.startswith('@@')]
def nk(s): return re.sub(r"[^a-z]","",s.lower())
keys={nk(n):n for n in CAT}
hdr=[i for i,l in enumerate(lines) if re.search(r"(Origin|General|Fighting Style|Epic Boon) Feat",l)]
found=[]
for i in hdr:
    for j in range(i-1,max(i-5,-1),-1):
        s=lines[j].strip()
        if not s: continue
        m=difflib.get_close_matches(nk(s),keys.keys(),1,0.7)
        if m: found.append((j,i,keys[m[0]])); break
names=[f[2] for f in found]
print(len(found),'missing',[n for n in CAT if n not in names],'dups',[n for n in set(names) if names.count(n)>1])
out=[]
for k,(j,i,name) in enumerate(found):
    end=found[k+1][0] if k+1<len(found) else len(lines)
    head=lines[i]
    b=i+1
    if '(' in head and ')' not in head:
        while b<end and ')' not in head: head+=' '+lines[b].strip(); b+=1
    prereq=re.search(r"\((?:Pre\S*\s?requisite|Prereq\S*)\s*:\s*(.*?)\)",clean.clean(head))
    body=[l for l in lines[b:end] if not re.search(r"CHAPTER\s*5|^\s*\d{1,3}\s*$",l.replace(' ','')) ]
    desc=textfix.fix(clean.clean('\n'.join(body)))
    desc=re.sub(r"\n{2,}","\n",desc)
    out.append(dict(name=name,prereq=prereq.group(1).strip() if prereq else None,desc=desc))
json.dump(out,open('feats_raw.json','w'),indent=1,ensure_ascii=False)
