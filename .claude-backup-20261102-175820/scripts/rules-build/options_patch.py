# Repairs invocation texts whose OCR lost the start of the description (the
# prerequisite line swallowed it) and cleans leftovers like table headers.
import json, re
o = json.load(open('class_options.json')); raw = json.load(open('options_raw.json'))['invocations']
for x in o['invocations']:
    if len(x['description']) < 20:
        p = raw[x['name']]['prereq'] or ''
        m = re.match(r"Level\s*\d+\s*\+?\s*Warlock(?:,\s*(?:[A-Z][\w' ]*?(?:Invocation|Damage)))?\s*(.*)", p)
        x['description'] = ((m.group(1) if m else p) + ' ' + raw[x['name']]['desc']).strip()
P = {
"Gaze of Two Minds": "You can use a Bonus Action to touch a willing creature and perceive through its senses until the end of your next turn. As long as the creature is on the same plane of existence as you, you can take a Bonus Action on subsequent turns to maintain this connection, extending the duration until the end of your next turn. The connection ends if you don't maintain it in this way.\nWhile perceiving through the other creature's senses, you benefit from any special senses possessed by that creature, and you can cast spells as if you were in your space or the other creature's space if the two of you are within 60 feet of each other.",
"Gift of the Depths": "You can breathe underwater, and you gain a Swim Speed equal to your Speed.\nYou can also cast Water Breathing once without expending a spell slot. You regain the ability to cast it in this way again when you finish a Long Rest.",
"Investment of the Chain Master": "When you cast Find Familiar, you infuse the summoned familiar with a measure of your eldritch power, granting the creature the following benefits.\nAerial or Aquatic. The familiar gains either a Fly Speed or a Swim Speed (your choice) of 40 feet.\nQuick Attack. As a Bonus Action, you can command the familiar to take the Attack action.\nNecrotic or Radiant Damage. Whenever the familiar deals Bludgeoning, Piercing, or Slashing damage, you can make it deal Necrotic or Radiant damage instead.\nYour Save DC. If the familiar forces a creature to make a saving throw, it uses your spell save DC.\nResistance. When the familiar takes damage, you can take a Reaction to grant it Resistance against that damage.",
"Gift of the Protectors": "A new page appears in your Book of Shadows when you conjure it. With your permission, a creature can take an action to write its name on that page, which can contain a number of names equal to your Charisma modifier (minimum of one name).\nWhen any creature whose name is on the page is reduced to 0 Hit Points but not killed outright, the creature magically drops to 1 Hit Point instead. Once this magic is triggered, no creature can benefit from it until you finish a Long Rest.\nAs a Magic action, you can erase a name on the page by touching it.",
"Lessons of the First Ones": "You have received knowledge from an elder entity of the multiverse, allowing you to gain one Origin feat of your choice.\nRepeatable. You can gain this invocation more than once. Each time you do so, choose a different Origin feat.",
}
for x in o['invocations']:
    if x['name'] in P: x['description'] = P[x['name']]
    d = x['description']
    d = re.sub(r"^via an Attack Roll\s*", "", d); d = re.sub(r"^Level S\+ Warlock, Pact of the Blade Invocation\s*", "", d)
    d = re.split(r"\s*WARLOCK SPELL LIST", d)[0]
    d = (d.replace("Darknessboth magical and nonmagical-within", "Darkness—both magical and nonmagical—within").replace('toO Hit', 'to 0 Hit')
          .replace('1d6Necrotic', '1d6 Necrotic,').replace('cast jump', 'cast Jump').replace('can.tri p', 'cantrip').replace('withi.', 'with it.')
          .replace(' orc reate', ' or create').replace("ca n't", "can't").replace('S feet', '5 feet').replace('o r ', 'or '))
    x['description'] = d
    if x['name'] == 'Repelling Blast': x['requires'] = 'A Warlock cantrip that requires an attack roll'
json.dump(o, open('class_options.json', 'w'), indent=1, ensure_ascii=False)
print('patched', len(o['invocations']))
