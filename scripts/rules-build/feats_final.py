import json,re
from feats import CAT
raw={x['name']:x for x in json.load(open('feats_raw.json'))}
if 'Archery' in raw: raw['Archery']['desc']="You gain a +2 bonus to attack rolls you make with Ranged weapons."
MAN={
'Keen Mind':("Level 4+, Intelligence 13+","You gain the following benefits.\nAbility Score Increase. Increase your Intelligence score by 1, to a maximum of 20.\nLore Knowledge. Choose one of the following skills: Arcana, History, Investigation, Nature, or Religion. If you lack proficiency in the chosen skill, you gain proficiency in it, and if you already have proficiency in it, you gain Expertise in it.\nQuick Study. You can take the Study action as a Bonus Action."),
'Martial Weapon Training':("Level 4+","You gain the following benefits.\nAbility Score Increase. Increase your Strength or Dexterity score by 1, to a maximum of 20.\nWeapon Proficiency. You gain proficiency with Martial weapons."),
'Telepathic':("Level 4+","You gain the following benefits.\nAbility Score Increase. Increase your Intelligence, Wisdom, or Charisma score by 1, to a maximum of 20.\nTelepathic Utterance. You can speak telepathically to any creature you can see within 60 feet of yourself. Your telepathic utterances are in a language you know, and the creature understands you only if it knows that language. Your communication doesn't give the creature the ability to respond to you telepathically.\nDetect Thoughts. You always have the Detect Thoughts spell prepared. You can cast it without a spell slot or spell components, and you must finish a Long Rest before you can cast it in this way again. You can also cast it using spell slots you have of the appropriate level. Your spellcasting ability for the spell is the ability increased by this feat."),
'Blind Fighting':("Fighting Style Feature","You have Blindsight with a range of 10 feet."),
'Boon of Irresistible Offense':("Level 19+","You gain the following benefits.\nAbility Score Increase. Increase your Strength or Dexterity score by 1, to a maximum of 30.\nOvercome Defenses. The Bludgeoning, Piercing, and Slashing damage you deal always ignores Resistance.\nOverwhelming Strike. When you roll a 20 on the d20 for an attack roll, you can deal extra damage to the target equal to the ability score increased by this feat. The extra damage's type is the same as the attack's type."),
}
# structured extras: asi options, repeatable, ability prereqs, grants
ASI={'Actor':['cha'],'Athlete':['str','dex'],'Charger':['str','dex'],'Chef':['con','wis'],'Crossbow Expert':['dex'],'Crusher':['str','con'],'Defensive Duelist':['dex'],'Dual Wielder':['str','dex'],'Durable':['con'],'Elemental Adept':['int','wis','cha'],'Fey-Touched':['int','wis','cha'],'Grappler':['str','dex'],'Great Weapon Master':['str'],'Heavily Armored':['con','str'],'Heavy Armor Master':['con','str'],'Inspiring Leader':['wis','cha'],'Keen Mind':['int'],'Lightly Armored':['str','dex'],'Mage Slayer':['str','dex'],'Martial Weapon Training':['str','dex'],'Medium Armor Master':['str','dex'],'Moderately Armored':['str','dex'],'Mounted Combatant':['str','dex','wis'],'Observant':['int','wis'],'Piercer':['str','dex'],'Poisoner':['dex','int'],'Polearm Master':['str','dex'],'Resilient':['str','dex','con','int','wis','cha'],'Ritual Caster':['int','wis','cha'],'Sentinel':['str','dex'],'Shadow-Touched':['int','wis','cha'],'Sharpshooter':['dex'],'Shield Master':['str'],'Skill Expert':['str','dex','con','int','wis','cha'],'Skulker':['dex'],'Slasher':['str','dex'],'Speedy':['dex','con'],'Spell Sniper':['int','wis','cha'],'Telekinetic':['int','wis','cha'],'Telepathic':['int','wis','cha'],'War Caster':['int','wis','cha'],'Weapon Master':['str','dex']}
for n in CAT:
    if n.startswith('Boon of'):
        ASI[n]={'Boon of Irresistible Offense':['str','dex']}.get(n,['str','dex','con','int','wis','cha'])
REPEAT={'Ability Score Improvement','Elemental Adept','Magic Initiate','Ritual Caster' if False else 'x','Boon of Energy Resistance' if False else 'y'}
REPEAT={'Ability Score Improvement','Elemental Adept','Magic Initiate','Skilled'}
def slug(n): return re.sub(r"[^a-z0-9]+","-",n.lower().replace("'","")).strip('-')
def prereq_struct(p):
    if not p: return None
    out={'text':p}
    m=re.search(r"Level\s*(\d+)",p.replace(' +','+'))
    if m: out['level']=int(m.group(1))
    abil=re.findall(r"(Strength|Dexterity|Constitution|Intelligence|Wisdom|Charisma)",p)
    if abil: out['abilitiesAny']=[a[:3].lower() for a in abil]; out['abilityMin']=13
    if re.search(r"Spellcasting|Pact Magic",p): out['spellcasting']=True
    for arm in ('Light Armor','Medium Armor','Heavy Armor','Shield'):
        if arm+' Training' in p or arm in p: out['armor']=arm.split()[0].lower()
    if 'Fighting Style' in p: out['fightingStyle']=True
    return out
PRE_FIX={'Charger':'Level 4+, Strength or Dexterity 13+','Grappler':'Level 4+, Strength or Dexterity 13+','Inspiring Leader':'Level 4+, Wisdom or Charisma 13+','Mounted Combatant':'Level 4+','Defensive Duelist':'Level 4+, Dexterity 13+','Dual Wielder':'Level 4+, Strength or Dexterity 13+','Elemental Adept':'Level 4+, Spellcasting or Pact Magic Feature','Heavily Armored':'Level 4+, Medium Armor Training','Heavy Armor Master':'Level 4+, Heavy Armor Training','Medium Armor Master':'Level 4+, Medium Armor Training','Moderately Armored':'Level 4+, Light Armor Training','Observant':'Level 4+, Intelligence or Wisdom 13+','Piercer':'Level 4+, Strength or Dexterity 13+','Polearm Master':'Level 4+, Strength or Dexterity 13+','Ritual Caster':'Level 4+, Intelligence, Wisdom, or Charisma 13+','Sentinel':'Level 4+, Strength or Dexterity 13+','Slasher':'Level 4+, Strength or Dexterity 13+','Speedy':'Level 4+, Dexterity or Constitution 13+','Spell Sniper':'Level 4+, Spellcasting or Pact Magic Feature','War Caster':'Level 4+, Spellcasting or Pact Magic Feature','Shield Master':'Level 4+, Shield Training','Skulker':'Level 4+, Dexterity 13+','Sharpshooter':'Level 4+, Dexterity 13+','Crossbow Expert':'Level 4+, Dexterity 13+','Athlete':'Level 4+, Strength or Dexterity 13+','Actor':'Level 4+, Charisma 13+','Crusher':'Level 4+, Strength or Constitution 13+','Great Weapon Master':'Level 4+, Strength 13+','Keen Mind':'Level 4+, Intelligence 13+','Mage Slayer':'Level 4+','Poisoner':'Level 4+','Weapon Master':'Level 4+','Boon of Spell Recall':'Level 19+, Spellcasting Feature'}
out=[]
for n,cat in CAT.items():
    if n in MAN: pre,desc=MAN[n]
    else: pre,desc=raw[n]['prereq'],raw[n]['desc']
    pre=PRE_FIX.get(n,pre)
    if cat=='general' and not pre: pre='Level 4+'
    if cat=='epic-boon' and not pre: pre='Level 19+'
    if cat=='fighting-style': pre='Fighting Style Feature'
    desc=re.sub(r"\s*[A-Z ]{6,}[^.\n]*Feat \(Prerequisite[^)]*\).*$","",desc,flags=re.S) if cat=='fighting-style' else desc
    desc=desc.replace('toO Hit','to 0 Hit').replace('2d4and','2d4 and').replace('thed20roll','the d20 roll')
    sents=re.split(r"(?<=[.!?])\s",desc.replace('\n',' ').replace('You gain the following benefits. ',''))
    f=dict(id=slug(n),name=n,category=cat,prerequisite=prereq_struct(pre),repeatable=n in REPEAT,summary=' '.join(sents[:2])[:300],description=desc)
    if n in ASI: f['asi']=dict(abilities=ASI[n],amount=1,max=30 if cat=='epic-boon' else 20)
    if n=='Ability Score Improvement': f['asi']=dict(abilities=['str','dex','con','int','wis','cha'],mode='twoOrOneOne',max=20)
    if n=='Skilled': f['grants']=dict(skillOrToolChoices=3)
    if n=='Magic Initiate': f['grants']=dict(spellList=['cleric','druid','wizard'],cantrips=2,level1=1)
    if n=='Musician': f['grants']=dict(instrumentChoices=3)
    if n=='Crafter': f['grants']=dict(artisanToolChoices=3)
    if n=='Tough': f['grants']=dict(hpPerLevel=2)
    if n=='Alert': f['grants']=dict(initiativePb=True)
    out.append(f)
json.dump(out,open('../../data/feats.json','w'),indent=0,ensure_ascii=False)
print(len(out))
