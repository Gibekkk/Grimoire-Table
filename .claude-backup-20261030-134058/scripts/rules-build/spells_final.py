import json, re
d=json.load(open('spells_out.json'))
by={s['name']:s for s in d}
O={
 'Darkvision':dict(school='Transmutation',classes=['druid','ranger','sorcerer','wizard']),
 'Plant Growth':dict(school='Transmutation',classes=['bard','druid','ranger'],castingTime='Action (Overgrowth) or 8 hours (Enrichment)'),
 'Sorcerous Burst':dict(school='Evocation',classes=['sorcerer']),
 'Summon Celestial':dict(school='Conjuration',classes=['cleric','paladin']),
 'Sunbeam':dict(school='Evocation',classes=['cleric','druid','sorcerer','wizard'],castingTime='Action',range='Self',components='V, S, M (a magnifying glass)',duration='Concentration, up to 1 minute',concentration=True,
   damageDice='6d8',damageType='radiant',save='con',attackRoll=False,
   description="You launch a sunbeam in a 5-foot-wide, 60-foot-long Line. Each creature in the Line makes a Constitution saving throw. On a failed save, a creature takes 6d8 Radiant damage and has the Blinded condition until the start of your next turn. On a successful save, it takes half as much damage only.\nUntil the spell ends, you can take a Magic action to create a new Line of radiance.\nFor the duration, a mote of brilliant radiance shines above you. It sheds Bright Light in a 30-foot radius and Dim Light for an additional 30 feet. This light is sunlight.",
   summary="You launch a sunbeam in a 5-foot-wide, 60-foot-long Line. Each creature in the Line makes a Constitution saving throw."),
}
O.update({
 'Sorcerous Burst':dict(O['Sorcerous Burst'],damageDice='1d8',damageType='acid/cold/fire/lightning/poison/psychic/thunder',attackRoll=True),
 'Chromatic Orb':dict(damageDice='3d8',damageType='acid/cold/fire/lightning/poison/thunder',attackRoll=True),
 'Flame Blade':dict(damageDice='3d6',damageType='fire',attackRoll=True),
 'Spiritual Weapon':dict(damageDice='1d8',damageType='force',attackRoll=True),
 'Glyph of Warding':dict(damageDice='5d8',damageType='acid/cold/fire/lightning/thunder',save='dex'),
 'Harm':dict(damageDice='14d6',damageType='necrotic',save='con'),
 'Geas':dict(damageDice='5d10',damageType='psychic'),
 'Steel Wind Strike':dict(damageDice='6d10',damageType='force',attackRoll=True),
 'Delayed Blast Fireball':dict(damageDice='12d6',damageType='fire',save='dex'),
 "Mordenkainen's Sword":dict(damageDice='4d12',damageType='force',attackRoll=True),
 "Bigby's Hand":dict(damageDice='4d8',damageType='force',attackRoll=True),
 'Conjure Minor Elementals':dict(damageDice='2d8',damageType='acid/cold/fire/lightning'),
 'Chill Touch':dict(damageDice='1d10',damageType='necrotic',attackRoll=True),
 'Eldritch Blast':dict(damageDice='1d10',damageType='force',attackRoll=True),
 'Fire Bolt':dict(damageDice='1d10',damageType='fire',attackRoll=True),
 'Prestidigitation':dict(range='10 feet'),
})
for n,o in O.items(): by[n].update(o)
for s in d:
    s['components']=re.sub(r"\s*,\s*M\s*\(",", M (",s['components']).replace("v, s","V, S")
    s['components']=re.sub(r"\bv\b","V",s['components']); s['components']=re.sub(r"\bs\b","S",s['components'])
    s['material']=bool(re.search(r"\bM\b",s['components']))
    for k in ('range','duration','castingTime'):
        s[k]=re.sub(r"\s+"," ",s[k]).strip(' ._')
    s['duration']=s['duration'].replace('Concentration ,','Concentration,')
    for k in ('range','duration','castingTime'): s[k]=re.sub(r'\b1 O\b','10',s[k])
    s['concentration']=s['duration'].lower().startswith('concentration')
    # cantrip scaling: damage of cantrip
    if s['level']==0 and s['damageDice']: s['cantripScaling']=True
d.sort(key=lambda s:(s['level'],s['name']))
assert len({s['id'] for s in d})==len(d)
json.dump(d,open('../../data/spells.json','w'),ensure_ascii=False,indent=0)
print(len(d), sum(1 for s in d if s['damageDice']), sum(1 for s in d if s['save']), sum(1 for s in d if s['attackRoll']))
for s in d:
    if s['level']==0: print(s['name'],s['damageDice'],s['damageType'],s['save'],s['attackRoll'],s['range'],'|',s['classes'])
