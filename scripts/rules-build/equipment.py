import json,re
def slug(n): return re.sub(r"[^a-z0-9]+","-",n.lower().replace("'","")).strip('-')
W=[]
def w(name,wt,dice,dtype,props,mastery,weight,cost):
    ranged=wt.endswith('Ranged')
    finesse='Finesse' in props
    ammo=re.search(r"Ammunition \([^;]+; (\w+)\)",props)
    W.append(dict(id=slug(name),name=name,weaponType=wt[0].lower()+wt[1:].replace(' ',''),category='simple' if wt.startswith('Simple') else 'martial',
        damageDice=dice,damageType=dtype,properties=[p.strip() for p in re.split(r",\s*(?![^()]*\))",props)] if props else [],
        ability='finesse' if finesse else ('dex' if ranged else 'str'),ranged=ranged,ammoType=ammo.group(1).lower() if ammo else None,mastery=mastery,weight=weight,cost=cost))
for r in [
('Club','Simple Melee','1d4','bludgeoning','Light','Slow','2 lb.','1 SP'),
('Dagger','Simple Melee','1d4','piercing','Finesse, Light, Thrown (20/60)','Nick','1 lb.','2 GP'),
('Greatclub','Simple Melee','1d8','bludgeoning','Two-Handed','Push','10 lb.','2 SP'),
('Handaxe','Simple Melee','1d6','slashing','Light, Thrown (20/60)','Vex','2 lb.','5 GP'),
('Javelin','Simple Melee','1d6','piercing','Thrown (30/120)','Slow','2 lb.','5 SP'),
('Light Hammer','Simple Melee','1d4','bludgeoning','Light, Thrown (20/60)','Nick','2 lb.','2 GP'),
('Mace','Simple Melee','1d6','bludgeoning','','Sap','4 lb.','5 GP'),
('Quarterstaff','Simple Melee','1d6','bludgeoning','Versatile (1d8)','Topple','4 lb.','2 SP'),
('Sickle','Simple Melee','1d4','slashing','Light','Nick','2 lb.','1 GP'),
('Spear','Simple Melee','1d6','piercing','Thrown (20/60), Versatile (1d8)','Sap','3 lb.','1 GP'),
('Dart','Simple Ranged','1d4','piercing','Finesse, Thrown (20/60)','Vex','1/4 lb.','5 CP'),
('Light Crossbow','Simple Ranged','1d8','piercing','Ammunition (80/320; Bolt), Loading, Two-Handed','Slow','5 lb.','25 GP'),
('Shortbow','Simple Ranged','1d6','piercing','Ammunition (80/320; Arrow), Two-Handed','Vex','2 lb.','25 GP'),
('Sling','Simple Ranged','1d4','bludgeoning','Ammunition (30/120; Bullet)','Slow','—','1 SP'),
('Battleaxe','Martial Melee','1d8','slashing','Versatile (1d10)','Topple','4 lb.','10 GP'),
('Flail','Martial Melee','1d8','bludgeoning','','Sap','2 lb.','10 GP'),
('Glaive','Martial Melee','1d10','slashing','Heavy, Reach, Two-Handed','Graze','6 lb.','20 GP'),
('Greataxe','Martial Melee','1d12','slashing','Heavy, Two-Handed','Cleave','7 lb.','30 GP'),
('Greatsword','Martial Melee','2d6','slashing','Heavy, Two-Handed','Graze','6 lb.','50 GP'),
('Halberd','Martial Melee','1d10','slashing','Heavy, Reach, Two-Handed','Cleave','6 lb.','20 GP'),
('Lance','Martial Melee','1d10','piercing','Heavy, Reach, Two-Handed (unless mounted)','Topple','6 lb.','10 GP'),
('Longsword','Martial Melee','1d8','slashing','Versatile (1d10)','Sap','3 lb.','15 GP'),
('Maul','Martial Melee','2d6','bludgeoning','Heavy, Two-Handed','Topple','10 lb.','10 GP'),
('Morningstar','Martial Melee','1d8','piercing','','Sap','4 lb.','15 GP'),
('Pike','Martial Melee','1d10','piercing','Heavy, Reach, Two-Handed','Push','18 lb.','5 GP'),
('Rapier','Martial Melee','1d8','piercing','Finesse','Vex','2 lb.','25 GP'),
('Scimitar','Martial Melee','1d6','slashing','Finesse, Light','Nick','3 lb.','25 GP'),
('Shortsword','Martial Melee','1d6','piercing','Finesse, Light','Vex','2 lb.','10 GP'),
('Trident','Martial Melee','1d8','piercing','Thrown (20/60), Versatile (1d10)','Topple','4 lb.','5 GP'),
('Warhammer','Martial Melee','1d8','bludgeoning','Versatile (1d10)','Push','5 lb.','15 GP'),
('War Pick','Martial Melee','1d8','piercing','Versatile (1d10)','Sap','2 lb.','5 GP'),
('Whip','Martial Melee','1d4','slashing','Finesse, Reach','Slow','3 lb.','2 GP'),
('Blowgun','Martial Ranged','1d1','piercing','Ammunition (25/100; Needle), Loading','Vex','1 lb.','10 GP'),
('Hand Crossbow','Martial Ranged','1d6','piercing','Ammunition (30/120; Bolt), Light, Loading','Vex','3 lb.','75 GP'),
('Heavy Crossbow','Martial Ranged','1d10','piercing','Ammunition (100/400; Bolt), Heavy, Loading, Two-Handed','Push','18 lb.','50 GP'),
('Longbow','Martial Ranged','1d8','piercing','Ammunition (150/600; Arrow), Heavy, Two-Handed','Slow','2 lb.','50 GP'),
('Musket','Martial Ranged','1d12','piercing','Ammunition (40/120; Bullet), Loading, Two-Handed','Slow','10 lb.','500 GP'),
('Pistol','Martial Ranged','1d10','piercing','Ammunition (30/90; Bullet), Loading','Vex','3 lb.','250 GP'),
]: w(*r)
A=[]
for name,t,ac,dex,strq,stealth,wt,cost in [
('Padded Armor','light',11,'full',None,True,'8 lb.','5 GP'),('Leather Armor','light',11,'full',None,False,'10 lb.','10 GP'),('Studded Leather Armor','light',12,'full',None,False,'13 lb.','45 GP'),
('Hide Armor','medium',12,'max2',None,False,'12 lb.','10 GP'),('Chain Shirt','medium',13,'max2',None,False,'20 lb.','50 GP'),('Scale Mail','medium',14,'max2',None,True,'45 lb.','50 GP'),('Breastplate','medium',14,'max2',None,False,'20 lb.','400 GP'),('Half Plate Armor','medium',15,'max2',None,True,'40 lb.','750 GP'),
('Ring Mail','heavy',14,'none',None,True,'40 lb.','30 GP'),('Chain Mail','heavy',16,'none',13,True,'55 lb.','75 GP'),('Splint Armor','heavy',17,'none',15,True,'60 lb.','200 GP'),('Plate Armor','heavy',18,'none',15,True,'65 lb.','1,500 GP'),
('Shield','shield',2,'none',None,False,'6 lb.','10 GP')]:
    A.append(dict(id=slug(name),name=name,armorType=t,baseAC=ac,dexBonus=dex,strengthRequirement=strq,stealthDisadvantage=stealth,weight=wt,cost=cost))
AM=[dict(id='arrows',name='Arrows (20)',ammoType='arrow',quantity=20,weight='1 lb.',cost='1 GP'),dict(id='bolts',name='Bolts (20)',ammoType='bolt',quantity=20,weight='1.5 lb.',cost='1 GP'),
    dict(id='firearm-bullets',name='Firearm Bullets (10)',ammoType='bullet',quantity=10,weight='2 lb.',cost='3 GP'),dict(id='sling-bullets',name='Sling Bullets (20)',ammoType='bullet',quantity=20,weight='1.5 lb.',cost='4 CP'),
    dict(id='needles',name='Needles (50)',ammoType='needle',quantity=50,weight='1 lb.',cost='1 GP')]
G=[]
def g(name,cost,weight,kind='gear',**kw): G.append(dict(id=kw.pop('id',slug(name)),name=name,cost=cost,weight=weight,kind=kind,**kw))
for n,c,wt,*rest in [("Acid","25 GP","1 lb."),("Alchemist's Fire","50 GP","1 lb."),("Antitoxin","50 GP","—"),("Backpack","2 GP","5 lb.",'C'),("Ball Bearings","1 GP","2 lb."),("Barrel","2 GP","70 lb.",'C'),("Basket","4 SP","2 lb.",'C'),
 ("Bedroll","1 GP","7 lb."),("Bell","1 GP","—"),("Blanket","5 SP","3 lb."),("Block and Tackle","1 GP","5 lb."),("Book","25 GP","5 lb."),("Bottle, Glass","2 GP","2 lb."),("Bucket","5 CP","2 lb.",'C'),
 ("Caltrops","1 GP","2 lb."),("Candle","1 CP","—"),("Case, Crossbow Bolt","1 GP","1 lb.",'C'),("Case, Map or Scroll","1 GP","1 lb.",'C'),("Chain","5 GP","10 lb."),("Chest","5 GP","25 lb.",'C'),("Climber's Kit","25 GP","12 lb."),
 ("Fine Clothes","15 GP","6 lb."),("Traveler's Clothes","2 GP","4 lb."),("Component Pouch","25 GP","2 lb."),("Costume","5 GP","4 lb."),("Crowbar","2 GP","5 lb."),("Flask","2 CP","1 lb."),("Grappling Hook","2 GP","4 lb."),
 ("Healer's Kit","5 GP","3 lb."),("Holy Water","25 GP","1 lb."),("Hunting Trap","5 GP","25 lb."),("Ink","10 GP","—"),("Ink Pen","2 CP","—"),("Jug","2 CP","4 lb."),("Ladder","1 SP","25 lb."),("Lamp","5 SP","1 lb."),
 ("Bullseye Lantern","10 GP","2 lb."),("Hooded Lantern","5 GP","2 lb."),("Lock","10 GP","1 lb."),("Magnifying Glass","100 GP","—"),("Manacles","2 GP","6 lb."),("Map","1 GP","—"),("Mirror","5 GP","1/2 lb."),("Net","1 GP","3 lb."),
 ("Oil","1 SP","1 lb."),("Paper","2 SP","—"),("Parchment","1 SP","—"),("Perfume","5 GP","—"),("Basic Poison","100 GP","—"),("Pole","5 CP","7 lb."),("Iron Pot","2 GP","10 lb."),("Potion of Healing","50 GP","1/2 lb."),
 ("Pouch","5 SP","1 lb.",'C'),("Quiver","1 GP","1 lb.",'C'),("Portable Ram","4 GP","35 lb."),("Rations","5 SP","2 lb."),("Robe","1 GP","4 lb."),("Rope","1 GP","5 lb."),("Sack","1 CP","1/2 lb.",'C'),("Shovel","2 GP","5 lb."),
 ("Signal Whistle","5 CP","—"),("Iron Spikes","1 GP","5 lb."),("Spyglass","1,000 GP","1 lb."),("String","1 SP","—"),("Tent","2 GP","20 lb."),("Tinderbox","5 SP","1 lb."),("Torch","1 CP","1 lb."),("Vial","1 GP","—"),("Waterskin","2 SP","5 lb.")]:
    g(n,c,wt,isContainer=bool(rest and rest[0]=='C'))
for n,c,wt in [("Arcane Focus","10 GP","1 lb."),("Druidic Focus","1 GP","—"),("Holy Symbol","5 GP","1 lb."),("Spellbook","50 GP","3 lb.")]: g(n,c,wt,'focus')
PACKS={"Burglar's Pack":("16 GP","42 lb.",[('backpack',1),('ball-bearings',1),('bell',1),('candle',10),('crowbar',1),('hooded-lantern',1),('oil',7),('rations',5),('rope',1),('tinderbox',1),('waterskin',1)]),
"Diplomat's Pack":("39 GP","39 lb.",[('chest',1),('fine-clothes',1),('ink',1),('ink-pen',5),('lamp',1),('case-map-or-scroll',2),('oil',4),('paper',5),('parchment',5),('perfume',1),('tinderbox',1)]),
"Dungeoneer's Pack":("12 GP","55 lb.",[('backpack',1),('caltrops',1),('crowbar',1),('oil',2),('rations',10),('rope',1),('tinderbox',1),('torch',10),('waterskin',1)]),
"Entertainer's Pack":("40 GP","58.5 lb.",[('backpack',1),('bedroll',1),('bell',1),('bullseye-lantern',1),('costume',3),('mirror',1),('oil',8),('rations',9),('tinderbox',1),('waterskin',1)]),
"Explorer's Pack":("10 GP","55 lb.",[('backpack',1),('bedroll',1),('oil',2),('rations',10),('rope',1),('tinderbox',1),('torch',10),('waterskin',1)]),
"Priest's Pack":("33 GP","29 lb.",[('backpack',1),('blanket',1),('holy-water',1),('lamp',1),('rations',7),('robe',1),('tinderbox',1)]),
"Scholar's Pack":("40 GP","22 lb.",[('backpack',1),('book',1),('ink',1),('ink-pen',1),('lamp',1),('oil',10),('parchment',10),('tinderbox',1)])}
for n,(c,wt,contents) in PACKS.items(): g(n,c,wt,'pack',contents=[dict(catalogId=i,quantity=q) for i,q in contents])
TOOLS=[]
def tool(n,c,wt,cat): TOOLS.append(dict(id=slug(n),name=n,cost=c,weight=wt,kind='tool',toolCategory=cat))
for n,c,wt in [("Alchemist's Supplies","50 GP","8 lb."),("Brewer's Supplies","20 GP","9 lb."),("Calligrapher's Supplies","10 GP","5 lb."),("Carpenter's Tools","8 GP","6 lb."),("Cartographer's Tools","15 GP","6 lb."),("Cobbler's Tools","5 GP","5 lb."),("Cook's Utensils","1 GP","8 lb."),("Glassblower's Tools","30 GP","5 lb."),("Jeweler's Tools","25 GP","2 lb."),("Leatherworker's Tools","5 GP","5 lb."),("Mason's Tools","10 GP","8 lb."),("Painter's Supplies","10 GP","5 lb."),("Potter's Tools","10 GP","3 lb."),("Smith's Tools","20 GP","8 lb."),("Tinker's Tools","50 GP","10 lb."),("Weaver's Tools","1 GP","5 lb."),("Woodcarver's Tools","1 GP","5 lb.")]: tool(n,c,wt,'artisan')
for n,c,wt in [("Disguise Kit","25 GP","3 lb."),("Forgery Kit","15 GP","5 lb."),("Herbalism Kit","5 GP","3 lb."),("Navigator's Tools","25 GP","2 lb."),("Poisoner's Kit","50 GP","2 lb."),("Thieves' Tools","25 GP","1 lb.")]: tool(n,c,wt,'other')
for n,c,wt in [("Dice Set","1 SP","—"),("Dragonchess Set","1 GP","1/2 lb."),("Playing Cards","5 SP","—"),("Three-Dragon Ante Set","1 GP","—")]: tool(n,c,wt,'gaming')
for n,c,wt in [("Bagpipes","30 GP","6 lb."),("Drum","6 GP","3 lb."),("Dulcimer","25 GP","10 lb."),("Flute","2 GP","1 lb."),("Horn","3 GP","2 lb."),("Lute","35 GP","2 lb."),("Lyre","30 GP","2 lb."),("Pan Flute","12 GP","2 lb."),("Shawm","2 GP","1 lb."),("Viol","30 GP","1 lb.")]: tool(n,c,wt,'instrument')
# legacy ids used by older characters / starting kits
G.append(dict(id='gaming-set',name='Gaming Set (Dice)',cost='1 SP',weight='—',kind='tool',toolCategory='gaming',alias='dice-set'))
eq=dict(weapons=W,armor=A,ammo=AM,gear=G+TOOLS,tools=TOOLS)
json.dump(eq,open('../../data/equipment.json','w'),indent=0,ensure_ascii=False)
print(len(W),len(A),len(AM),len(G),len(TOOLS))
# validate references from classes/backgrounds
ids={x['id'] for x in G+TOOLS}|{'tool-choice','musical-instrument'}
import classes_def
for cid,c in classes_def.C.items():
    for o in c['equipment']:
        for cat,ci,q in o[2]:
            pool={'weapon':{x['id'] for x in W},'armor':{x['id'] for x in A},'ammo':{x['id'] for x in AM},'gear':ids}[cat]
            if ci not in pool: print('BAD',cid,cat,ci)
for b in json.load(open('../../data/backgrounds.json')):
    for i in b['equipment']['items']:
        pool={'weapon':{x['id'] for x in W},'armor':{x['id'] for x in A},'ammo':{x['id'] for x in AM},'gear':ids}[i['category']]
        if i['catalogId'] not in pool: print('BADBG',b['id'],i)
for p in PACKS.values():
    for i,q in p[2]:
        if i not in ids: print('BADPACK',i)
